// Synthetic fine-scale terrain detail (PLAN.md §8.3). LOLA's 5 m spacing cannot resolve rover-scale
// bumps, so we add seeded, clearly-labelled detail: fBm noise, small craters and boulders.
// Evaluated analytically so the wheels feel exactly what is rendered (no grid-resolution loss).

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}

export interface Crater { x: number; z: number; r: number; depth: number }
export interface Rock { x: number; z: number; r: number; h: number; rot: number }

const CELL = 16;

export class Detail {
  enabled = true;
  readonly craters: Crater[] = [];
  readonly rocks: Rock[] = [];
  private grid = new Map<string, { craters: Crater[]; rocks: Rock[] }>();

  constructor(private seed: number, extent: number, exclusion?: { x: number; z: number; r: number }) {
    const rnd = mulberry32(seed);
    const half = extent / 2 - 10;
    const away = (x: number, z: number, margin: number) =>
      !exclusion || Math.hypot(x - exclusion.x, z - exclusion.z) > exclusion.r + margin;
    while (this.craters.length < 250) {
      const r = 1 + 5 * rnd() ** 2;
      const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
      if (away(x, z, r * 1.6)) this.craters.push({ x, z, r, depth: 0.2 * r });
    }
    while (this.rocks.length < 400) {
      const r = 0.3 + 0.9 * rnd() ** 2;
      const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
      if (away(x, z, r)) this.rocks.push({ x, z, r, h: 0.15 + 0.35 * rnd(), rot: rnd() * Math.PI * 2 });
    }
    for (const c of this.craters) this.insert(c.x, c.z, c.r * 1.6, (b) => b.craters.push(c));
    for (const k of this.rocks) this.insert(k.x, k.z, k.r, (b) => b.rocks.push(k));
  }

  private bucket(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    let b = this.grid.get(key);
    if (!b) this.grid.set(key, (b = { craters: [], rocks: [] }));
    return b;
  }

  private insert(x: number, z: number, radius: number, add: (b: { craters: Crater[]; rocks: Rock[] }) => void) {
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++)
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) add(this.bucket(cx, cz));
  }

  /** Height offset (m) at (x, z). Rocks are excluded from `withRocks=false` (render mesh uses instanced rocks). */
  height(x: number, z: number, withRocks = true): number {
    if (!this.enabled) return 0;
    let h = 0.12 * (0.6 * valueNoise(x / 10, z / 10, this.seed) + 0.3 * valueNoise(x / 5, z / 5, this.seed + 1)
      + 0.1 * valueNoise(x / 2.5, z / 2.5, this.seed + 2));
    const b = this.grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!b) return h;
    for (const c of b.craters) {
      const d = Math.hypot(x - c.x, z - c.z) / c.r;
      if (d < 1) h -= c.depth * (1 - d * d);
      if (d < 1.6) h += 0.06 * c.r * Math.exp(-(((d - 1) / 0.25) ** 2));
    }
    if (withRocks) {
      for (const k of b.rocks) {
        const d = Math.hypot(x - k.x, z - k.z) / k.r;
        if (d < 1) h += k.h * Math.sqrt(1 - d * d);
      }
    }
    return h;
  }
}
