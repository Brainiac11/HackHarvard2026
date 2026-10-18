import { describe, expect, it } from "vitest";
import { Detail } from "./detail";
import { pebbleAbundance, pebbleCapacity, PEBBLES_PER_CELL, scatterPebbles } from "./scatter";

const ground = (x: number, z: number) => 3 + 0.1 * x - 0.05 * z;
const half = () => 0.5;

function scatter(x0: number, z0: number, size: number, abundance = half) {
  const out = new Float32Array(pebbleCapacity(size) * 16);
  const count = scatterPebbles(x0, z0, size, 7, ground, abundance, out);
  return { count, out };
}

describe("pebble scatter", () => {
  it("gives the same stones wherever the patch is centred", () => {
    const a = scatter(0, 0, 30), b = scatter(10.4, 4.3, 30);
    const inOverlap = ({ count, out }: ReturnType<typeof scatter>) => {
      const m = new Map<string, number[]>();
      for (let i = 0; i < count; i++) {
        const x = out[i * 16 + 12], z = out[i * 16 + 14];
        if (x >= 10.4 && x < 30 && z >= 4.3 && z < 30) m.set(`${x},${z}`, Array.from(out.subarray(i * 16, i * 16 + 16)));
      }
      return m;
    };
    const ma = inOverlap(a), mb = inOverlap(b);
    expect(ma.size).toBeGreaterThan(500);
    expect([...mb.keys()].sort()).toEqual([...ma.keys()].sort());
    for (const [k, v] of ma) expect(mb.get(k)).toEqual(v);
  });

  it("stays inside its square and capacity, thinned by abundance, a third buried", () => {
    const { count, out } = scatter(-7.5, 12.25, 29.9);
    expect(count).toBeLessThanOrEqual(pebbleCapacity(29.9));
    expect(count / (29.9 * 29.9 * PEBBLES_PER_CELL)).toBeCloseTo(0.5, 1);
    for (let i = 0; i < count; i++) {
      const o = i * 16, x = out[o + 12], z = out[o + 14];
      expect(x).toBeGreaterThanOrEqual(-7.5);
      expect(x).toBeLessThan(22.4);
      expect(z).toBeGreaterThanOrEqual(12.25);
      expect(z).toBeLessThan(42.15);
      const sy = Math.hypot(out[o + 4], out[o + 5], out[o + 6]); // the model's half-height, scaled
      expect(out[o + 13]).toBeCloseTo(ground(x, z) + sy / 3, 5);
      expect(sy).toBeGreaterThan(0.005);
      expect(sy).toBeLessThan(0.1);
    }
    expect(scatter(0, 0, 10, () => 0).count).toBe(0);
  });

  it("keeps pebbles off the trodden work site and piles them on fresh ejecta", () => {
    const site = { x: 0, z: 0, r: 30 }, detail = new Detail(7, 1275, site);
    expect(pebbleAbundance(detail, site, 1, 1)).toBe(0);
    const c = detail.craters.find((k) => k.fresh > 0.9 && k.r > 2)!;
    expect(pebbleAbundance(detail, site, c.x + 1.1 * c.r, c.z)).toBe(1);
  });
});
