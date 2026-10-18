import { describe, expect, it } from "vitest";
import {
  cutUnder, FAR_QUADS, fillLevel, gridIndices, indexBuffer, levelSpacing, LEVELS, MORPH_BAND, OVERLAP, QUADS,
  snapOrigin, type LevelBuffers, type LevelGrid,
} from "./clipmap";
import { Detail, mulberry32 } from "./detail";

const EXTENT = 1275; // site04
const detail = new Detail(7, EXTENT, { x: 0, z: 0, r: 30 });
const base = (x: number, z: number) => 40 + 6 * Math.sin(x / 37) * Math.cos(z / 53) + 0.03 * x; // smooth LOLA stand-in
const ground = (x: number, z: number) => base(x, z) + detail.height(x, z, false);
const spacingOf = (level: number) => levelSpacing(EXTENT, level);

/** Level `level` centred on (fx, fz), filled from `ground`, as the terrain worker builds it. */
function level(levelIndex: number, fx: number, fz: number): { g: LevelGrid; out: LevelBuffers } {
  const far = levelIndex === LEVELS, quads = far ? FAR_QUADS : QUADS, s = spacingOf(levelIndex);
  const g = {
    x0: far ? -EXTENT / 2 : snapOrigin(fx, s, quads, EXTENT), z0: far ? -EXTENT / 2 : snapOrigin(fz, s, quads, EXTENT),
    spacing: s, quads,
  };
  const n = (quads + 1) ** 2;
  const out = { pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), alb: new Float32Array(n) };
  fillLevel(g, !far, ground, () => 1, out);
  return { g, out };
}

/**
 * A vertex attribute (default: height) of a level's triangles at world (x, z), interpolated as the GPU does (quads
 * split along (i, j)-(i+1, j+1)).
 */
function surface({ g, out }: { g: LevelGrid; out: LevelBuffers }, x: number, z: number, arr = out.pos, comp = 1): number {
  const fx = (x - g.x0) / g.spacing, fz = (z - g.z0) / g.spacing;
  const i = Math.min(Math.floor(fx), g.quads - 1), j = Math.min(Math.floor(fz), g.quads - 1), u = fx - i, v = fz - j;
  const n = g.quads + 1, y = (a: number, b: number) => arr[((j + b) * n + i + a) * 3 + comp];
  return u > v ? y(0, 0) + (y(1, 0) - y(0, 0)) * u + (y(1, 1) - y(1, 0)) * v
    : y(0, 0) + (y(1, 1) - y(0, 1)) * u + (y(0, 1) - y(0, 0)) * v;
}

describe("clipmap", () => {
  it("snaps every level onto its parent's vertices, inside the map, centred on the focus", () => {
    for (const f of [-600, -123.4, 0, 0.07, 77.7, 590]) {
      for (let l = 0; l < LEVELS; l++) {
        const s = spacingOf(l), x0 = snapOrigin(f, s, QUADS, EXTENT);
        const parentSteps = (x0 + EXTENT / 2) / (2 * s);
        expect(Math.abs(parentSteps - Math.round(parentSteps))).toBeLessThan(1e-9);
        expect(x0).toBeGreaterThanOrEqual(-EXTENT / 2 - 1e-9);
        expect(x0 + QUADS * s).toBeLessThanOrEqual(EXTENT / 2 + 1e-9);
        if (Math.abs(f) + (QUADS / 2 + 2) * s < EXTENT / 2) expect(Math.abs(x0 + (QUADS / 2) * s - f)).toBeLessThanOrEqual(s);
      }
    }
  });

  it("splits every quad along the same diagonal and picks 16-bit indices when they fit", () => {
    const idx = indexBuffer(2);
    expect(gridIndices(2, idx)).toBe(24);
    expect(Array.from(idx)).toEqual([0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 3, 6, 7, 3, 7, 4, 4, 7, 8, 4, 8, 5]);
    expect(indexBuffer(QUADS)).toBeInstanceOf(Uint16Array);
    expect(indexBuffer(FAR_QUADS)).toBeInstanceOf(Uint32Array);
  });

  it("leaves out a level's quads under its child but for a ring along the child's edge", () => {
    for (let l = 1; l <= LEVELS; l++) {
      const quads = l === LEVELS ? FAR_QUADS : QUADS, s = spacingOf(l);
      const parent = { x0: l === LEVELS ? -EXTENT / 2 : snapOrigin(30, s, quads, EXTENT), z0: -EXTENT / 2, spacing: s, quads };
      const cs = spacingOf(l - 1);
      const child = { x0: snapOrigin(30 + 7 * s, cs, QUADS, EXTENT), z0: snapOrigin(-EXTENT / 2 + 5, cs, QUADS, EXTENT),
        spacing: cs, quads: QUADS };
      const idx = indexBuffer(quads), count = gridIndices(quads, idx, cutUnder(parent, child));
      const drawn = new Set<number>();
      for (let k = 0; k < count; k += 6) drawn.add(idx[k]); // each quad's (i, j) corner
      const inner = (lo: number, centre: number) => // strictly inside the child, beyond the overlap ring
        centre > lo + OVERLAP * s && centre < lo + QUADS * cs - OVERLAP * s;
      let cut = 0, wrong = 0;
      for (let j = 0; j < quads; j++) {
        for (let i = 0; i < quads; i++) {
          const under = inner(child.x0, parent.x0 + (i + 0.5) * s) && inner(child.z0, parent.z0 + (j + 0.5) * s);
          if (drawn.has(j * (quads + 1) + i) === under) wrong++;
          if (under) cut++;
        }
      }
      expect(wrong).toBe(0);
      expect(cut).toBe((QUADS / 2 - 2 * OVERLAP) ** 2);
      expect(count).toBe((quads * quads - cut) * 6);
    }
  });

  it("renders the ground the physics samples to within a few centimetres around the player", () => {
    const fine = level(0, 213.4, -151.7), rnd = mulberry32(5);
    const inner = (QUADS / 2 - MORPH_BAND - 1) * fine.g.spacing; // inside the band that morphs into level 1
    const cx = fine.g.x0 + (QUADS / 2) * fine.g.spacing, cz = fine.g.z0 + (QUADS / 2) * fine.g.spacing;
    let worst = 0, sq = 0;
    const N = 20000;
    for (let k = 0; k < N; k++) {
      const x = cx + (rnd() * 2 - 1) * inner, z = cz + (rnd() * 2 - 1) * inner;
      const e = Math.abs(surface(fine, x, z) - ground(x, z));
      worst = Math.max(worst, e);
      sq += e * e;
    }
    expect(worst).toBeLessThan(0.06); // only at the sharp rims of the smallest fresh craters
    expect(Math.sqrt(sq / N)).toBeLessThan(0.003);
  });

  it("meets its parent level exactly along its edge (heights and normals), so no cracks or seams", () => {
    for (let l = 0; l < LEVELS; l++) {
      const child = level(l, 101.3, 57.9), parent = level(l + 1, 101.3, 57.9);
      const { g, out } = child, n = g.quads + 1;
      for (let t = 0; t <= g.quads; t++) {
        for (const [i, j] of [[t, 0], [t, g.quads], [0, t], [g.quads, t]]) {
          const v = j * n + i, x = g.x0 + i * g.spacing, z = g.z0 + j * g.spacing;
          expect(Math.abs(out.pos[v * 3 + 1] - surface(parent, x, z))).toBeLessThan(1e-4);
          // the parent's normals as interpolated across its triangle, before the GPU normalises them
          const p = [0, 1, 2].map((a) => surface(parent, x, z, parent.out.nrm, a)), c = [0, 1, 2].map((a) => out.nrm[v * 3 + a]);
          const len = (w: number[]) => Math.hypot(w[0], w[1], w[2]);
          for (let a = 0; a < 3; a++) expect(Math.abs(c[a] / len(c) - p[a] / len(p))).toBeLessThan(1e-6);
        }
      }
      // and inside the morph band it is the true surface again
      const mid = (g.quads / 2) * n + g.quads / 2;
      expect(out.pos[mid * 3 + 1]).toBeCloseTo(ground(g.x0 + (g.quads / 2) * g.spacing, g.z0 + (g.quads / 2) * g.spacing), 4);
    }
  });
});
