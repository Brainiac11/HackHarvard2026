import { describe, expect, it } from "vitest";
import { mulberry32 } from "../world/detail";
import { RoverModel } from "./rover";

const DT = 1 / 120;
const flat = () => 0;
function bumpy(seed: number) {
  const rnd = mulberry32(seed);
  const bumps = Array.from({ length: 200 }, () => ({ x: rnd() * 200 - 100, z: rnd() * 200 - 100, r: 0.5 + rnd(), h: 0.1 + 0.3 * rnd() }));
  return (x: number, z: number) => {
    let h = 0.5 * Math.sin(x / 9) + 0.3 * Math.cos(z / 7);
    for (const b of bumps) {
      const d = Math.hypot(x - b.x, z - b.z) / b.r;
      if (d < 1) h += b.h * Math.sqrt(1 - d * d);
    }
    return h;
  };
}

describe("rover model", () => {
  it("settles at static sag on flat ground", () => {
    const r = new RoverModel(flat);
    r.reset(0, 0, 0);
    for (let i = 0; i < 600; i++) r.step(DT, { throttle: 0, brake: 0, steer: 0, boost: false });
    r.wheels.forEach((w) => expect(w.comp).toBeCloseTo((210 * 1.62) / 4 / 4000, 2));
    expect(Math.abs(r.pitch)).toBeLessThan(0.01);
    expect(r.rough).toBe(0);
  });

  it("accelerates to top speed and heads north at heading 0", () => {
    const r = new RoverModel(flat);
    r.reset(0, 0, 0);
    for (let i = 0; i < 120 * 8; i++) r.step(DT, { throttle: 1, brake: 0, steer: 0, boost: false });
    expect(r.v).toBeCloseTo(3.6, 1);
    expect(r.z).toBeLessThan(-15);
    expect(Math.abs(r.x)).toBeLessThan(0.01);
  });

  it("slows on a real uphill grade", () => {
    const hill = (_x: number, z: number) => -z * Math.tan((12 * Math.PI) / 180); // rising toward -z (north)
    const flatR = new RoverModel(flat), hillR = new RoverModel(hill);
    flatR.reset(0, 0, 0);
    hillR.reset(0, 0, 0);
    for (let i = 0; i < 240; i++) {
      flatR.step(DT, { throttle: 0.5, brake: 0, steer: 0, boost: false });
      hillR.step(DT, { throttle: 0.5, brake: 0, steer: 0, boost: false });
    }
    expect(hillR.v).toBeLessThan(flatR.v * 0.7);
  });

  it("stays stable for 60 s on rough terrain and reports roughness + impacts", () => {
    const r = new RoverModel(bumpy(3));
    let impacts = 0;
    r.onImpact = () => impacts++;
    r.reset(0, 0, 0.3);
    let maxRough = 0;
    for (let i = 0; i < 120 * 60; i++) {
      r.step(DT, { throttle: 1, brake: 0, steer: Math.sin(i / 400) * 0.5, boost: true });
      if (Math.abs(r.x) > 90 || Math.abs(r.z) > 90) r.reset(0, 0, r.heading);
      for (const v of [r.y, r.pitch, r.roll, r.v, ...r.wheels.map((w) => w.vel)]) expect(Number.isFinite(v)).toBe(true);
      maxRough = Math.max(maxRough, r.rough);
    }
    expect(Math.abs(r.pitch)).toBeLessThan(0.7);
    expect(maxRough).toBeGreaterThan(0.2);
    expect(impacts).toBeGreaterThan(0);
  });
});
