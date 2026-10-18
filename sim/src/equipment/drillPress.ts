// Drill press logic (PLAN.md §9.3), kept free of Three.js so it can be unit-tested. Physics-lite: the quill feeds
// freely until the bit tip meets the bottom of the bore, then advances only as fast as the material lets it:
//   rate = feed * motor * V0 * (1 - hardness)^2
// Soft regolith breaks through in about 12 s of feeding; hard basalt barely advances, so pushing on raises a stall
// (which drives the glove's stall warning).
import type { HandPose } from "../hand/gestures";

/** Machine geometry (m) in the press frame: origin on the ground under the spindle, y up. */
export const PRESS = {
  homeTipY: 1.225, // bit tip with the quill fully up
  baseY: 0.975, // bottom face of the samples (they sit on parallels, so the bit can run out below them)
  overtravel: 0.02, // how far the bit may run below a sample it has broken through
  slotPitch: 0.32, // sample spacing on the cross-slide
};

const FEED_MPS = 0.12; // free feed while lowering
const RETRACT_MPS = 0.3;
const SPIN_RAMP_S = 0.5; // spindle spin-up / spin-down
const TABLE_SLOTS_PER_S = 1.25;
const V0 = 0.025; // m/s into a material of hardness 0, at full feed and speed
const STALL_RATE = 0.002;
const STALL_AFTER_S = 2.0; // push without progress for this long before declaring a stall
const CLEAR_M = 0.005; // the bit is clear of a sample this far above its top face
const HOME_M = 1e-4;

export interface SampleSpec { name: string; label: string; kind: "soft" | "hard"; hardness: number; height: number }

// properties are simulated, not NASA measurements
export const SAMPLES: SampleSpec[] = [
  { name: "regolith", label: "Regolith brick", kind: "soft", hardness: 0.25, height: 0.16 },
  { name: "basalt", label: "Basalt core", kind: "hard", hardness: 0.9, height: 0.18 },
];

export interface Sample extends SampleSpec {
  depth: number; // bore depth (m)
  through: boolean; // broken through: a fresh sample loads once the bit is raised clear
}

export interface DrillTelemetry {
  held: boolean; trigger: number; target: "soft" | "hard" | null; contact: boolean;
  hardness: number; depth_m: number; rate_mps: number; stalled: boolean;
  through: boolean; // broken through: the bit hangs below the sample, out of contact, until it is raised
}

const approach = (x: number, target: number, step: number) =>
  x < target ? Math.min(target, x + step) : Math.max(target, x - step);

/**
 * The operator's feed command: 1 lower, -1 raise, 0 hold. Held keys win (both at once hold); otherwise the tracked
 * hand: a closed fist lowers the bit, an open hand raises it, anything in between holds. pose: null without a tracker.
 */
export function feedCommand(lower: boolean, raise: boolean, pose: HandPose | null): number {
  if (lower || raise) return lower === raise ? 0 : lower ? 1 : -1;
  return pose === "fist" ? 1 : pose === "open" ? -1 : 0;
}

export class DrillPress {
  readonly samples: Sample[];
  travel = 0; // quill travel below home (m)
  motor = 0; // spindle level 0..1: it runs whenever the quill is off its home stop
  table = 0; // cross-slide position in sample slots: sample i is under the bit at table = i
  slot = 0; // where the table is going
  feed = 0; // last command: 1 lower, 0 hold, -1 raise
  contact = false;
  rate = 0; // m/s
  stalled = false;
  private stallTime = 0;
  // lowest the tip may go above a moving table: clear of every sample, or it would cut sideways through one
  private readonly clearY: number;
  onBreakthrough: () => void = () => {};

  constructor(specs: SampleSpec[] = SAMPLES) {
    this.samples = specs.map((s) => ({ ...s, depth: 0, through: false }));
    this.clearY = Math.max(...this.samples.map((s) => this.top(s))) + CLEAR_M;
  }

  get tipY(): number { return PRESS.homeTipY - this.travel; }
  top(s: Sample): number { return PRESS.baseY + s.height; }

  /** The sample under the bit, or null while the table is moving between samples. */
  get under(): Sample | null { return this.table === this.slot ? this.samples[this.slot] : null; }

  get tableLocked(): boolean { return this.tipY < this.clearY; }

  /**
   * Slide the table left (-1) or right (+1); samples are ordered left to right, so sliding left brings the next one
   * under the bit. At an end stop it slides the only way it can: with two samples either key brings the other one.
   * Refused (false) while the bit is down among the samples.
   */
  slideTable(dir: -1 | 1): boolean {
    if (this.tableLocked) return false;
    const n = this.samples.length, to = this.slot - dir;
    this.slot = Math.min(n - 1, Math.max(0, to >= 0 && to < n ? to : this.slot + dir));
    return true;
  }

  /** feed: 1 lowers the quill, -1 raises it, 0 holds it where it is. */
  step(dt: number, feed: number): void {
    this.feed = feed;
    this.table = approach(this.table, this.slot, TABLE_SLOTS_PER_S * dt);
    const s = this.under;
    // the lowest the tip can reach right now: the bore bottom, below a sample it has broken through, or the
    // clearance plane while the table moves
    const floor = !s ? this.clearY : s.through ? PRESS.baseY - PRESS.overtravel : this.top(s) - s.depth;
    let tip = this.tipY;
    this.rate = 0;
    if (feed < 0) tip = Math.min(PRESS.homeTipY, tip - feed * RETRACT_MPS * dt);
    else if (feed > 0) {
      tip -= feed * FEED_MPS * dt;
      if (tip <= floor && s && !s.through) {
        this.rate = feed * this.motor * V0 * (1 - s.hardness) ** 2;
        s.depth = Math.min(s.height, s.depth + this.rate * dt);
        if (s.depth >= s.height) {
          s.through = true;
          this.onBreakthrough();
        }
        tip = this.top(s) - s.depth;
      } else tip = Math.max(tip, floor);
    }
    this.travel = PRESS.homeTipY - tip;
    this.motor = approach(this.motor, this.travel > HOME_M ? 1 : 0, dt / SPIN_RAMP_S);
    // contact persists while holding: the bit rests on the bottom of the bore
    this.contact = !!s && !s.through && this.motor > 0.02 && tip <= this.top(s) - s.depth + 1e-6;

    const pushing = feed > 0 && this.contact && this.motor > 0.5 && this.rate < STALL_RATE;
    this.stallTime = pushing ? this.stallTime + dt : 0;
    this.stalled = this.stallTime > STALL_AFTER_S;

    for (const x of this.samples) {
      if (x.through && tip > this.top(x) + CLEAR_M) { // the bit is clear: load a fresh sample
        x.depth = 0;
        x.through = false;
      }
    }
  }

  /** Fresh samples: refused (false) while the bit is down among them, or it would sit inside an undrilled one. */
  reset(): boolean {
    if (this.tableLocked) return false;
    for (const s of this.samples) { s.depth = 0; s.through = false; }
    return true;
  }

  /** The hub's drill schema: held = operating the press, trigger = spindle level, target = sample under the bit. */
  telemetry(held: boolean): DrillTelemetry {
    const s = this.under;
    return {
      held, trigger: this.motor, target: s ? s.kind : null, contact: this.contact,
      hardness: s ? s.hardness : 0, depth_m: s ? s.depth : 0, rate_mps: this.rate, stalled: this.stalled,
      through: s?.through ?? false,
    };
  }
}
