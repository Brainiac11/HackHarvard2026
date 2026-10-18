import { describe, expect, it } from "vitest";
import { craterProfile, Detail, mulberry32, valueNoise } from "./detail";

const SEED = 7, EXTENT = 1275;
const SITE = { x: -40, z: 25, r: 30 };
const detail = new Detail(SEED, EXTENT, SITE);

/** Detail.height as documented, summed over every crater and rock in order: no buckets. */
function reference(x: number, z: number, withRocks = true): number {
  const s = SEED;
  let h = 0.12 * (0.6 * valueNoise(x / 10, z / 10, s) + 0.3 * valueNoise(x / 5, z / 5, s + 1)
    + 0.1 * valueNoise(x / 2.5, z / 2.5, s + 2))
    + 0.02 * valueNoise(x / 1.2, z / 1.2, s + 3) + 0.008 * valueNoise(x / 0.55, z / 0.55, s + 4);
  for (const c of detail.craters) {
    const dx = x - c.x, dz = z - c.z, d2 = dx * dx + dz * dz, reach = c.reach * c.r;
    if (d2 < reach * reach) h += craterProfile(Math.sqrt(d2) / c.r, c.depth, c.rim, c.crest, c.reach);
  }
  if (withRocks) {
    for (const k of detail.rocks) {
      const dx = x - k.x, dz = z - k.z, q = (dx * dx + dz * dz) / (k.r * k.r);
      if (q < 1) h += k.h * Math.sqrt(1 - q);
    }
  }
  return h;
}

describe("synthetic detail", () => {
  it("bucketed lookups give exactly the brute-force sum over every feature", () => {
    const rnd = mulberry32(3);
    const points: [number, number][] = [];
    for (let i = 0; i < 400; i++) points.push([(rnd() - 0.5) * 1200, (rnd() - 0.5) * 1200]);
    // and points on crater bowls, rims and ejecta, and on rocks, where buckets matter
    for (let i = 0; i < 400; i++) {
      const c = detail.craters[Math.floor(rnd() * detail.craters.length)], a = rnd() * 6.3, d = rnd() * c.reach * c.r;
      points.push([c.x + Math.cos(a) * d, c.z + Math.sin(a) * d]);
      const k = detail.rocks[Math.floor(rnd() * detail.rocks.length)];
      points.push([k.x + (rnd() - 0.5) * 2 * k.r, k.z + (rnd() - 0.5) * 2 * k.r]);
    }
    let onFeature = 0;
    for (const [x, z] of points) {
      expect(detail.height(x, z)).toBe(reference(x, z));
      expect(detail.height(x, z, false)).toBe(reference(x, z, false));
      if (detail.height(x, z) !== reference(x, z, false)) onFeature++;
    }
    expect(onFeature).toBeGreaterThan(200);
  });

  it("is deterministic per seed and switches off cleanly", () => {
    const again = new Detail(SEED, EXTENT, SITE), other = new Detail(SEED + 1, EXTENT, SITE);
    expect(again.height(12.3, -45.6)).toBe(detail.height(12.3, -45.6));
    expect(other.height(12.3, -45.6)).not.toBe(detail.height(12.3, -45.6));
    again.enabled = false;
    expect(again.height(12.3, -45.6)).toBe(0);
    expect(again.albedo(12.3, -45.6)).toBe(1);
  });

  it("follows a power-law crater population, keeps the work site clear and has a few boulders", () => {
    const n = (r: number) => detail.craters.filter((c) => c.r > r).length;
    expect(n(0.8) / n(0.4)).toBeCloseTo(0.25, 1); // N(>R) ∝ R^-2
    expect(n(3.2) / n(0.8)).toBeCloseTo(1 / 16, 1);
    for (const c of detail.craters) expect(Math.hypot(c.x - SITE.x, c.z - SITE.z)).toBeGreaterThan(SITE.r + c.reach * c.r);
    for (const k of detail.rocks) expect(Math.hypot(k.x - SITE.x, k.z - SITE.z)).toBeGreaterThan(SITE.r + k.r);
    expect(detail.rocks.filter((k) => k.r > 1.2).length).toBeGreaterThanOrEqual(20);
    // fresh craters are rarer than old ones, and deeper for their size
    const fresh = detail.craters.filter((c) => c.fresh > 0.7), old = detail.craters.filter((c) => c.fresh < 0.1);
    expect(fresh.length).toBeLessThan(old.length / 2);
    const ratio = (cs: typeof fresh) => cs.reduce((a, c) => a + c.depth / c.r, 0) / cs.length;
    expect(ratio(fresh)).toBeGreaterThan(2 * ratio(old));
  });

  it("brightens fresh craters' ejecta only", () => {
    const c = detail.craters.find((k) => k.fresh > 0.9 && k.r > 2)!;
    expect(detail.albedo(c.x + 1.1 * c.r, c.z)).toBeGreaterThan(1.1);
    const old = detail.craters.find((k) => k.fresh < 0.05 && k.r > 2 && detail.albedo(k.x, k.z) === 1);
    expect(old).toBeDefined();
  });
});

describe("crater profile", () => {
  const depth = 1, rim = 0.2, crest = 0.1, reach = 2.2;
  const f = (r: number) => craterProfile(r, depth, rim, crest, reach);

  it("has a bowl floor, a raised rim at the radius and ejecta that dies out at its reach", () => {
    expect(f(0)).toBeCloseTo(-depth, 12);
    expect(f(1)).toBeCloseTo(rim, 12);
    expect(f(1.5)).toBeGreaterThan(0);
    expect(f(1.5)).toBeLessThan(rim);
    expect(f(reach)).toBeCloseTo(0, 12);
    expect(f(0.5)).toBeLessThan(0);
  });

  it("is continuous", () => {
    let worst = 0;
    for (let r = 0; r < reach; r += 1e-4) worst = Math.max(worst, Math.abs(f(r + 1e-4) - f(r)));
    expect(worst).toBeLessThan(1e-3);
  });
});
