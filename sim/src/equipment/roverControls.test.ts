import { describe, expect, it } from "vitest";
import type { HandPose } from "../hand/gestures";
import { RoverModel } from "./rover";
import { RoverControls } from "./roverControls";

const DT = 1 / 120;
const keys = (...codes: string[]) => ({ held: (c: string) => codes.includes(c) });
const NO_KEYS = keys();
const tracked = (pose: HandPose) => ({ active: true, pose });

/** Drive a rover on flat ground for `seconds` with fixed keys and hand. */
function drive(c: RoverControls, r: RoverModel, seconds: number, k = NO_KEYS, hand = tracked("neutral")) {
  for (let i = 0; i < seconds * 120; i++) r.step(DT, c.update(DT, k, hand, r.v));
}

function cruising(): { c: RoverControls; r: RoverModel } {
  const c = new RoverControls(), r = new RoverModel(() => 0);
  r.reset(0, 0, 0);
  drive(c, r, 3, NO_KEYS, tracked("open"));
  return { c, r };
}

describe("rover controls", () => {
  it("an open hand ramps the throttle up and accelerates", () => {
    const c = new RoverControls();
    expect(c.update(0.1, NO_KEYS, tracked("open"), 0)).toMatchObject({ throttle: 0.25, brake: 0 });
    expect(c.command).toBe("accelerate");
    for (let i = 0; i < 10; i++) c.update(0.1, NO_KEYS, tracked("open"), 0);
    expect(c.input.throttle).toBe(1);
    const { r } = cruising();
    expect(r.v).toBeGreaterThan(2);
  });

  it("a fist brakes to a stop and never reverses", () => {
    const { c, r } = cruising();
    expect(c.update(DT, NO_KEYS, tracked("fist"), r.v)).toMatchObject({ throttle: 0, brake: 1 });
    expect(c.command).toBe("brake");
    let minV = Infinity;
    for (let i = 0; i < 120 * 5; i++) {
      r.step(DT, c.update(DT, NO_KEYS, tracked("fist"), r.v));
      minV = Math.min(minV, r.v);
    }
    expect(Math.abs(r.v)).toBeLessThan(0.02);
    expect(minV).toBeGreaterThan(-0.02);
  });

  it("a neutral hand coasts: no throttle, no brake", () => {
    const { c, r } = cruising();
    const v0 = r.v;
    expect(c.update(DT, NO_KEYS, tracked("neutral"), r.v)).toMatchObject({ throttle: 0, brake: 0 });
    expect(c.command).toBe("coast");
    drive(c, r, 1);
    expect(r.v).toBeLessThan(v0);
    expect(r.v).toBeGreaterThan(v0 - 0.1); // only rolling resistance
  });

  it("re-opening the hand ramps up from zero again", () => {
    const c = new RoverControls();
    for (let i = 0; i < 10; i++) c.update(0.1, NO_KEYS, tracked("open"), 0);
    c.update(0.1, NO_KEYS, tracked("neutral"), 0);
    expect(c.update(0.1, NO_KEYS, tracked("open"), 0).throttle).toBeCloseTo(0.25);
  });

  it("lost tracking coasts, whatever the last pose was", () => {
    const c = new RoverControls();
    for (let i = 0; i < 10; i++) c.update(0.1, NO_KEYS, tracked("open"), 1);
    expect(c.update(0.1, NO_KEYS, { active: false, pose: "open" }, 1)).toMatchObject({ throttle: 0, brake: 0 });
    expect(c.command).toBeNull();
    expect(c.update(0.1, NO_KEYS, { active: false, pose: "fist" }, 1)).toMatchObject({ throttle: 0, brake: 0 });
  });

  it("steers only from the keys, smoothly; hand roll is ignored", () => {
    const c = new RoverControls();
    const rolledHand = { active: true, pose: "open" as const, steer: 1 }; // a tracked hand rolled hard right
    for (let i = 0; i < 120; i++) c.update(DT, NO_KEYS, rolledHand, 1);
    expect(c.input.steer).toBe(0);
    expect(c.update(DT, keys("KeyD"), rolledHand, 1).steer).toBeLessThan(0.1); // smoothed, not a jump
    for (let i = 0; i < 120; i++) c.update(DT, keys("KeyD"), rolledHand, 1);
    expect(c.input.steer).toBeGreaterThan(0.99);
    for (let i = 0; i < 240; i++) c.update(DT, keys("ArrowLeft"), rolledHand, 1);
    expect(c.input.steer).toBeLessThan(-0.99);
  });

  it("W and S override the hand while held; S reverses only once stopped", () => {
    const c = new RoverControls();
    expect(c.update(DT, keys("KeyW"), tracked("fist"), 1)).toMatchObject({ throttle: 1, brake: 0 });
    expect(c.update(DT, keys("KeyS"), tracked("open"), 1)).toMatchObject({ throttle: 0, brake: 1 });
    expect(c.update(DT, keys("KeyS"), tracked("open"), 0)).toMatchObject({ throttle: -0.5, brake: 0 });
    expect(c.update(DT, keys("KeyW", "ShiftLeft"), { active: false, pose: "neutral" }, 0).boost).toBe(true);
  });
});
