import { describe, expect, it } from "vitest";
import { bake, cells, fbm, noise, ridged } from "./procedural";

describe("procedural noise", () => {
  it("tiles over the unit square", () => {
    for (const v of [0.13, 0.5, 0.91]) {
      expect(noise(0, v, 8, 3)).toBeCloseTo(noise(1, v, 8, 3), 6);
      expect(fbm(v, 0, 4, 3)).toBeCloseTo(fbm(v, 1, 4, 3), 6);
      expect(ridged(0, v, 4, 3)).toBeCloseTo(ridged(1, v, 4, 3), 6);
      expect(cells(0, v, 6, 3).f1).toBeCloseTo(cells(1, v, 6, 3).f1, 6);
    }
  });

  it("is deterministic, bounded and varies with the seed", () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const n = fbm((i * 0.137) % 1, (i * 0.071) % 1, 8, 11);
      lo = Math.min(lo, n);
      hi = Math.max(hi, n);
    }
    expect(lo).toBeGreaterThan(-1.01);
    expect(hi).toBeLessThan(1.01);
    expect(hi - lo).toBeGreaterThan(0.6);
    expect(fbm(0.3, 0.7, 8, 11)).toBe(fbm(0.3, 0.7, 8, 11));
    expect(fbm(0.3, 0.7, 8, 11)).not.toBe(fbm(0.3, 0.7, 8, 12));
  });

  it("bakes colour, a flat normal for flat height, and ORM", () => {
    const flat = bake(8, (_u, _v, o) => { o.r = 1; o.rough = 0.25; o.metal = 1; });
    const n = flat.normalMap.image.data as Uint8Array, c = flat.map.image.data as Uint8Array;
    const orm = flat.ormMap.image.data as Uint8Array;
    expect([n[0], n[1], n[2]]).toEqual([128, 128, 255]);
    expect([c[0], c[1], c[2]]).toEqual([255, 128, 128]);
    expect([orm[0], orm[1], orm[2]]).toEqual([255, 64, 255]);
    // a ramp in u tilts the normal toward -u
    const ramp = bake(16, (u, _v, o) => { o.height = Math.sin(u * Math.PI * 2); }, { depth: 0.1 });
    const r = ramp.normalMap.image.data as Uint8Array;
    expect(r[0]).toBeLessThan(128); // at u ~ 0 the height rises with u
  });
});
