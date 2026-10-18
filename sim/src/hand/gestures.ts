// Finger curl and gestures from MediaPipe world landmarks (PLAN.md §9.5). Pure functions: unit-tested.
export type Vec3 = [number, number, number];

// joint chains per finger (thumb uses CMC->MCP->IP->TIP)
export const CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
];
export const TIPS = [4, 8, 12, 16, 20];

const sub = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]) || 1e-9;
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b)))));

/** Raw flexion per finger: sum of angles between consecutive bones (radians). ~0 straight, ~2.5-3.5 fist. */
export function rawCurls(w: number[][]): number[] {
  return CHAINS.map((chain, f) => {
    let total = 0;
    // thumb: skip the wrist->CMC bend, it's mostly abduction
    for (let i = f === 0 ? 2 : 1; i < chain.length - 1; i++) {
      total += angle(sub(w[chain[i]], w[chain[i - 1]]), sub(w[chain[i + 1]], w[chain[i]]));
    }
    return total;
  });
}

export interface CurlCalibration { open: number[]; closed: number[] }
export const DEFAULT_CALIBRATION: CurlCalibration = {
  open: [0.35, 0.3, 0.3, 0.3, 0.35],
  closed: [1.4, 3.0, 3.2, 3.2, 3.0],
};

export function normalizedCurls(w: number[][], cal: CurlCalibration = DEFAULT_CALIBRATION): number[] {
  return rawCurls(w).map((c, i) => Math.min(1, Math.max(0, (c - cal.open[i]) / Math.max(0.2, cal.closed[i] - cal.open[i]))));
}

/** Palm roll in degrees from the knuckle line (index MCP -> pinky MCP), in the image plane. 0 = level. */
export function palmRollDeg(w: number[][], hand: string): number {
  const lat = sub(w[17], w[5]);
  const deg = (Math.atan2(lat[1], lat[0]) * 180) / Math.PI; // y down
  const level = hand === "Left" ? 180 : 0; // knuckle line points the other way on a left hand
  let d = deg - level;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** MediaPipe's Left/Right call is unreliable on a gloved hand and can flip frame to frame, which would swap the
 *  glove's palm and back (and flip palmRollDeg by 180°). Keep the current label until the other one wins `switchAfter` frames in a row. */
export class HandednessFilter {
  label: string | null = null;
  private streak = 0;
  constructor(private switchAfter = 12) {}

  update(raw: string): string {
    if (this.label === null || raw === this.label) {
      this.label = raw;
      this.streak = 0;
    } else if (++this.streak >= this.switchAfter) {
      this.label = raw;
      this.streak = 0;
    }
    return this.label;
  }
}

export function hysteresis(prev: boolean, value: number, on: number, off: number): boolean {
  return prev ? value > off : value > on;
}

/** The hand as a two-way control: closed fist, open hand, or neither (in between, or changing). */
export type HandPose = "fist" | "open" | "neutral";

// Fist: mean curl of middle, ring and pinky above GRIP_ON; it holds until the mean drops below GRIP_OFF.
const GRIP_ON = 0.65, GRIP_OFF = 0.5;
// Open hand: the three straightest of index..pinky below OPEN_ON for OPEN_HOLD_S; it stays open until they pass
// OPEN_OFF. The most curled finger is ignored (a suit glove keeps one bent, usually the pinky, and the trackers lose
// it first), and so is the thumb, which the glove barely lets move. OPEN_ON sits below GRIP_OFF, so a hand relaxed
// part way out of a fist is neutral (hold the press, coast the rover) rather than open.
const OPEN_ON = 0.4, OPEN_OFF = 0.55, OPEN_HOLD_S = 0.1;

export interface Gestures { grip: boolean; openPalm: boolean; pose: HandPose; closure: number }

export class GestureState {
  grip = false;
  openPalm = false;
  pose: HandPose = "neutral";
  private openSince = -1;

  update(curls: number[], t: number): Gestures {
    const gripValue = (curls[2] + curls[3] + curls[4]) / 3;
    this.grip = hysteresis(this.grip, gripValue, GRIP_ON, GRIP_OFF);
    const fingers = curls.slice(1);
    const threeStraightest = [...fingers].sort((a, b) => a - b)[2]; // the most curled of the other three
    const straight = threeStraightest < (this.openPalm ? OPEN_OFF : OPEN_ON);
    if (!straight || this.grip) this.openSince = -1;
    else if (this.openSince < 0) this.openSince = t;
    this.openPalm = this.openSince >= 0 && t - this.openSince >= OPEN_HOLD_S;
    this.pose = this.grip ? "fist" : this.openPalm ? "open" : "neutral";
    const closure = fingers.reduce((s, c) => s + c, 0) / fingers.length; // 0 open .. 1 fist
    return { grip: this.grip, openPalm: this.openPalm, pose: this.pose, closure };
  }
}
