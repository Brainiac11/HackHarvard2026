import { describe, expect, it } from "vitest";
import { DrillPress, feedCommand, PRESS } from "./drillPress";

const DT = 1 / 60;
function run(p: DrillPress, seconds: number, feed: number, until?: () => boolean): number {
  let t = 0;
  for (; t < seconds && !until?.(); t += DT) p.step(DT, feed);
  return t;
}
const regolith = (p: DrillPress) => p.samples[0];
const basalt = (p: DrillPress) => p.samples[1];
const toBasalt = (p: DrillPress) => {
  expect(p.slideTable(-1)).toBe(true);
  run(p, 2, 0);
};

describe("drill press", () => {
  it("starts home, spindle stopped, with the soft sample under the bit", () => {
    const p = new DrillPress();
    p.step(DT, 0);
    expect(p.tipY).toBe(PRESS.homeTipY);
    expect(p.motor).toBe(0);
    expect(p.telemetry(true)).toEqual({ held: true, trigger: 0, target: "soft", contact: false, hardness: 0.25,
      depth_m: 0, rate_mps: 0, stalled: false, through: false });
  });

  it("feeds freely and spins up when the quill leaves home", () => {
    const p = new DrillPress();
    run(p, 0.25, 1);
    expect(p.travel).toBeCloseTo(0.03, 2); // ~0.12 m/s
    expect(p.motor).toBeGreaterThan(0.4);
    expect(p.motor).toBeLessThan(0.6); // ~0.5 s ramp
    run(p, 0.3, 1);
    expect(p.motor).toBe(1);
    expect(p.contact).toBe(false);
    expect(p.telemetry(true).trigger).toBe(1);
  });

  it("holds the quill where it is when neither lowering nor raising", () => {
    const p = new DrillPress();
    run(p, 0.3, 1);
    const travel = p.travel;
    run(p, 1, 0);
    expect(p.travel).toBe(travel);
    expect(p.motor).toBe(1); // still off home: keeps spinning
  });

  it("meets the sample at its top face", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    expect(p.contact).toBe(true);
    expect(p.tipY).toBeCloseTo(p.top(regolith(p)), 2);
    expect(p.rate).toBeGreaterThan(0.01);
  });

  it("bores through the soft sample in 10-15 s of feeding, then reloads it once the bit is raised clear", () => {
    const p = new DrillPress();
    let breakthroughs = 0;
    p.onBreakthrough = () => breakthroughs++;
    run(p, 3, 1, () => p.contact);
    const t = run(p, 30, 1, () => regolith(p).through);
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(15);
    expect(breakthroughs).toBe(1);
    expect(p.stalled).toBe(false);
    run(p, 1, 1); // the bit runs out below the sample, spinning free
    expect(p.contact).toBe(false);
    expect(p.tipY).toBeCloseTo(PRESS.baseY - PRESS.overtravel, 3);
    expect(p.telemetry(true)).toMatchObject({ depth_m: regolith(p).height, contact: false, through: true });
    expect(breakthroughs).toBe(1);

    run(p, 0.3, -1);
    expect(regolith(p).through).toBe(true); // still inside the bore
    run(p, 2, -1);
    expect(regolith(p).depth).toBe(0);
    expect(regolith(p).through).toBe(false);
    expect(p.telemetry(true).through).toBe(false);
  });

  it("rests on the bottom of the bore while holding: still in contact, not advancing, no stall", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    run(p, 2, 1);
    const depth = regolith(p).depth;
    run(p, 5, 0);
    expect(p.contact).toBe(true);
    expect(p.rate).toBe(0);
    expect(p.stalled).toBe(false);
    expect(regolith(p).depth).toBe(depth);
  });

  it("barely advances into hard basalt and stalls only while pushing", () => {
    const p = new DrillPress();
    toBasalt(p);
    expect(p.under).toBe(basalt(p));
    run(p, 3, 1, () => p.contact);
    run(p, 1.5, 1);
    expect(p.contact).toBe(true);
    expect(p.rate).toBeGreaterThan(0);
    expect(p.rate).toBeLessThan(0.002);
    expect(p.stalled).toBe(false); // not yet: 2 s of pushing without progress
    run(p, 1, 1);
    expect(p.stalled).toBe(true);
    expect(p.telemetry(true)).toMatchObject({ target: "hard", hardness: 0.9, contact: true, stalled: true, trigger: 1 });
    run(p, 30, 1);
    expect(basalt(p).depth).toBeLessThan(0.02);
    expect(basalt(p).through).toBe(false);

    run(p, 0.1, 0); // stop pushing: the bit rests in the bore
    expect(p.contact).toBe(true);
    expect(p.stalled).toBe(false);
  });

  it("retracts to home and the spindle spins down there", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    run(p, 0.15, -1);
    expect(p.travel).toBeGreaterThan(0);
    expect(p.motor).toBe(1);
    run(p, 1, -1);
    expect(p.travel).toBe(0);
    expect(p.motor).toBeLessThan(1);
    run(p, 0.6, -1);
    expect(p.motor).toBe(0);
    expect(p.contact).toBe(false);
  });

  it("locks the table while the bit is down among the samples", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    expect(p.tableLocked).toBe(true);
    expect(p.slideTable(-1)).toBe(false);
    run(p, 3, 0);
    expect(p.under).toBe(regolith(p));
    run(p, 3, -1);
    expect(p.tableLocked).toBe(false);
    expect(p.slideTable(-1)).toBe(true);
    p.step(DT, 0);
    expect(p.under).toBeNull(); // between samples
    expect(p.telemetry(true).target).toBeNull();
    run(p, 2, 0);
    expect(p.under).toBe(basalt(p));
  });

  it("slides the other way at an end stop, so either key brings the other sample", () => {
    const p = new DrillPress();
    expect(p.slideTable(1)).toBe(true); // regolith is already at the right-hand stop
    expect(p.slot).toBe(1);
    expect(p.slideTable(-1)).toBe(true); // basalt: at the left-hand stop
    expect(p.slot).toBe(0);
    expect(p.slideTable(1)).toBe(true);
    expect(p.slideTable(1)).toBe(true);
    expect(p.slot).toBe(0);
  });

  it("keeps the bit above the samples while the table moves", () => {
    const p = new DrillPress();
    p.slideTable(-1);
    run(p, 0.5, 1);
    expect(p.under).toBeNull();
    expect(p.tipY).toBeGreaterThan(p.top(basalt(p)));
    expect(p.contact).toBe(false);
  });

  it("keeps each sample's bore when the table moves away and back", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    run(p, 3, 1);
    const depth = regolith(p).depth;
    run(p, 3, -1);
    toBasalt(p);
    expect(p.telemetry(true).depth_m).toBe(0);
    p.slideTable(1);
    run(p, 2, 0);
    expect(p.telemetry(true).depth_m).toBe(depth);
    expect(p.reset()).toBe(true);
    expect(regolith(p).depth).toBe(0);
  });

  it("won't reset the samples with the bit down in one", () => {
    const p = new DrillPress();
    run(p, 3, 1, () => p.contact);
    run(p, 30, 1, () => regolith(p).through);
    run(p, 1, 1); // below the broken-through sample
    expect(p.reset()).toBe(false);
    expect(regolith(p)).toMatchObject({ through: true, depth: regolith(p).height });
    run(p, 3, -1);
    expect(p.reset()).toBe(true);
  });

  it("reports nothing to the glove while nobody operates it", () => {
    const p = new DrillPress();
    run(p, 1, 1);
    expect(p.telemetry(false).held).toBe(false);
  });
});

describe("drill press feed command", () => {
  it("lowers on a fist, raises on an open hand, holds in between or without a tracker", () => {
    expect(feedCommand(false, false, "fist")).toBe(1);
    expect(feedCommand(false, false, "open")).toBe(-1);
    expect(feedCommand(false, false, "neutral")).toBe(0);
    expect(feedCommand(false, false, null)).toBe(0);
  });

  it("lets held keys override the hand", () => {
    expect(feedCommand(true, false, "open")).toBe(1);
    expect(feedCommand(false, true, "fist")).toBe(-1);
    expect(feedCommand(true, true, "fist")).toBe(0);
  });
});
