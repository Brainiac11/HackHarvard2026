// Synthetic fine-scale terrain detail (PLAN.md §8.3). LOLA's 5 m spacing cannot resolve rover-scale bumps, so we add
// seeded, clearly-labelled detail: fBm undulation, a power-law population of small craters (most of them old and
// subdued, a few fresh ones with sharp raised rims, bright ejecta and blocks) and rocks. Evaluated analytically so the
// wheels feel exactly what is rendered (no grid-resolution loss); a flat bucket grid keeps each lookup to a few features.

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

export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz) * 2 - 1;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A simple crater (see craterProfile). `fresh` 0..1: old craters are shallow and rounded, fresh ones deep, sharp-rimmed
 * and bright. `crest` and `reach` are in crater radii.
 */
export interface Crater { x: number; z: number; r: number; depth: number; rim: number; crest: number; reach: number; fresh: number }
/** A rock: footprint radius `r`, top `h` above the ground, yaw `rot`. */
export interface Rock { x: number; z: number; r: number; h: number; rot: number }

const CELL = 4; // bucket size (m): a lookup visits only the features overlapping its bucket
const CRATER_DENSITY = 0.02; // craters with radius >= CRATER_MIN per m² (cumulative N(>R) ∝ R^-2, near equilibrium)
const CRATER_MIN = 0.4, CRATER_MAX = 22;
const ROCK_DENSITY = 0.0025; // background rocks with r >= ROCK_MIN per m² (N(>r) ∝ r^-2.5)
const ROCK_MIN = 0.15, ROCK_MAX = 1.1;
const HALO_REACH = 4; // bright ejecta of fresh craters reach farther than their relief (crater radii)
const FRESH_HALO = 0.6; // craters fresher than this keep a visible bright halo

// crater and rock records in flat Float64Arrays (the hot loops touch no objects)
const C_X = 0, C_Z = 1, C_R = 2, C_DEPTH = 3, C_RIM = 4, C_CREST = 5, C_REACH = 6, C_FRESH = 7, C_RAYS = 8, C_PHASE = 9;
const C_STRIDE = 10;
const K_X = 0, K_Z = 1, K_R = 2, K_H = 3;
const K_STRIDE = 4;

/** Features bucketed into CELL-sized cells: for cell c, items[start[c] .. start[c + 1]) overlap it. */
interface Buckets { start: Int32Array; items: Int32Array }

export class Detail {
  enabled = true;
  readonly craters: Crater[] = [];
  readonly rocks: Rock[] = [];
  private readonly cdat: Float64Array;
  private readonly kdat: Float64Array;
  private readonly cells: number;
  private readonly half: number;
  private readonly craterBuckets: Buckets;
  private readonly rockBuckets: Buckets;

  constructor(private seed: number, extent: number, exclusion?: { x: number; z: number; r: number }) {
    const rnd = mulberry32(seed);
    this.half = extent / 2;
    this.cells = Math.ceil(extent / CELL);
    const half = extent / 2 - 10;
    const away = (x: number, z: number, margin: number) =>
      !exclusion || Math.hypot(x - exclusion.x, z - exclusion.z) > exclusion.r + margin;
    const area = (2 * half) ** 2;

    // craters: inverse-CDF sampling of the truncated power law; most are old (fresh = u^3)
    const span = 1 - (CRATER_MIN / CRATER_MAX) ** 2;
    const craterCount = Math.round(CRATER_DENSITY * area);
    const params: number[] = [];
    while (this.craters.length < craterCount) {
      const r = CRATER_MIN / Math.sqrt(1 - rnd() * span);
      const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
      const fresh = rnd() ** 3, jitter = 0.8 + 0.4 * rnd();
      const rays = 5 + Math.floor(rnd() * 7), phase = rnd() * Math.PI * 2;
      const reach = 1.6 + 0.9 * fresh;
      if (!away(x, z, r * reach)) continue;
      // depth/diameter 0.04 (degraded) .. 0.19 (fresh); rim 1-7 % of the radius
      const c = { x, z, r, depth: r * (0.08 + 0.3 * fresh) * jitter, rim: r * (0.012 + 0.06 * fresh),
        crest: 0.08 + 0.3 * (1 - fresh), reach, fresh };
      this.craters.push(c);
      params.push(x, z, r, c.depth, c.rim, c.crest, reach, fresh, rays, phase);
    }
    this.cdat = Float64Array.from(params);

    // rocks: a background population, blocks thrown out by fresh craters (bigger craters, bigger blocks), boulders
    const addRock = (x: number, z: number, r: number) => {
      if (Math.abs(x) < half && Math.abs(z) < half && away(x, z, r)) {
        this.rocks.push({ x, z, r, h: r * (0.35 + 0.45 * rnd()), rot: rnd() * Math.PI * 2 });
      }
    };
    const rockSpan = 1 - (ROCK_MIN / ROCK_MAX) ** 2.5;
    for (let i = Math.round(ROCK_DENSITY * area); i > 0; i--) {
      addRock((rnd() * 2 - 1) * half, (rnd() * 2 - 1) * half, ROCK_MIN / (1 - rnd() * rockSpan) ** (1 / 2.5));
    }
    for (const c of this.craters) {
      if (c.fresh < 0.55 || c.r < 1) continue;
      for (let i = Math.floor(c.fresh * c.r * 2.5); i > 0; i--) {
        const a = rnd() * Math.PI * 2, d = c.r * (0.75 + 1.3 * rnd() ** 2);
        addRock(c.x + Math.cos(a) * d, c.z + Math.sin(a) * d, Math.min(1.4, Math.max(ROCK_MIN, c.r * (0.02 + 0.1 * rnd() ** 2))));
      }
    }
    for (let i = 0; i < 24; i++) addRock((rnd() * 2 - 1) * half, (rnd() * 2 - 1) * half, 1.3 + 1.2 * rnd());
    this.kdat = Float64Array.from(this.rocks.flatMap((k) => [k.x, k.z, k.r, k.h]));

    const cd = this.cdat;
    this.craterBuckets = this.bucket(cd, C_STRIDE,
      (o) => cd[o + C_R] * Math.max(cd[o + C_REACH], cd[o + C_FRESH] > FRESH_HALO ? HALO_REACH : 0));
    this.rockBuckets = this.bucket(this.kdat, K_STRIDE, (o) => this.kdat[o + K_R]);
  }

  /** Bucket features (x, z at offsets 0, 1 of each record) by the cells their influence radius overlaps. */
  private bucket(data: Float64Array, stride: number, radius: (offset: number) => number): Buckets {
    const n = this.cells, count = data.length / stride;
    const start = new Int32Array(n * n + 1);
    const visit = (i: number, add: (cell: number) => void) => {
      const o = i * stride, x = data[o] + this.half, z = data[o + 1] + this.half, rad = radius(o);
      const c0 = Math.max(0, Math.floor((x - rad) / CELL)), c1 = Math.min(n - 1, Math.floor((x + rad) / CELL));
      const r0 = Math.max(0, Math.floor((z - rad) / CELL)), r1 = Math.min(n - 1, Math.floor((z + rad) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) add(r * n + c);
    };
    for (let i = 0; i < count; i++) visit(i, (cell) => start[cell + 1]++);
    for (let c = 0; c < n * n; c++) start[c + 1] += start[c];
    const items = new Int32Array(start[n * n]), fill = start.slice(0, n * n);
    for (let i = 0; i < count; i++) visit(i, (cell) => { items[fill[cell]++] = i; });
    return { start, items };
  }

  private cellOf(x: number, z: number): number {
    const c = Math.floor((x + this.half) / CELL), r = Math.floor((z + this.half) / CELL);
    return c < 0 || r < 0 || c >= this.cells || r >= this.cells ? -1 : r * this.cells + c;
  }

  /** Height offset (m) at (x, z). Rocks are excluded from `withRocks=false` (render mesh uses instanced rocks). */
  height(x: number, z: number, withRocks = true): number {
    if (!this.enabled) return 0;
    const s = this.seed;
    let h = 0.12 * (0.6 * valueNoise(x / 10, z / 10, s) + 0.3 * valueNoise(x / 5, z / 5, s + 1)
      + 0.1 * valueNoise(x / 2.5, z / 2.5, s + 2))
      + 0.02 * valueNoise(x / 1.2, z / 1.2, s + 3) + 0.008 * valueNoise(x / 0.55, z / 0.55, s + 4); // lumpy regolith
    const cell = this.cellOf(x, z);
    if (cell < 0) return h;
    const cd = this.cdat, cb = this.craterBuckets;
    for (let k = cb.start[cell], end = cb.start[cell + 1]; k < end; k++) {
      const o = cb.items[k] * C_STRIDE, R = cd[o + C_R];
      const dx = x - cd[o + C_X], dz = z - cd[o + C_Z];
      const d2 = dx * dx + dz * dz, reach = cd[o + C_REACH] * R;
      if (d2 < reach * reach) h += craterProfile(Math.sqrt(d2) / R, cd[o + C_DEPTH], cd[o + C_RIM], cd[o + C_CREST], cd[o + C_REACH]);
    }
    if (withRocks) {
      const kd = this.kdat, kb = this.rockBuckets;
      for (let k = kb.start[cell], end = kb.start[cell + 1]; k < end; k++) {
        const o = kb.items[k] * K_STRIDE, r = kd[o + K_R];
        const dx = x - kd[o + K_X], dz = z - kd[o + K_Z], q = (dx * dx + dz * dz) / (r * r);
        if (q < 1) h += kd[o + K_H] * Math.sqrt(1 - q);
      }
    }
    return h;
  }

  /**
   * Albedo multiplier (1 = average regolith): fresh craters excavate immature, brighter material, so they get a bright
   * floor, a halo just outside the rim and faint rays. Visual only; 1 everywhere with detail off.
   */
  albedo(x: number, z: number): number {
    if (!this.enabled) return 1;
    const cell = this.cellOf(x, z);
    if (cell < 0) return 1;
    let a = 0;
    const cd = this.cdat, cb = this.craterBuckets;
    for (let k = cb.start[cell], end = cb.start[cell + 1]; k < end; k++) {
      const o = cb.items[k] * C_STRIDE, fresh = cd[o + C_FRESH];
      if (fresh <= FRESH_HALO) continue;
      const R = cd[o + C_R], dx = x - cd[o + C_X], dz = z - cd[o + C_Z];
      const r = Math.sqrt(dx * dx + dz * dz) / R;
      if (r >= HALO_REACH) continue;
      const s = ((fresh - FRESH_HALO) / (1 - FRESH_HALO)) ** 2;
      const blanket = Math.exp(-(((r - 1.05) / 0.7) ** 2));
      const ray = r > 1 ? Math.cos(cd[o + C_RAYS] * Math.atan2(dz, dx) + cd[o + C_PHASE]) ** 8 * Math.exp((1 - r) / 1.2) : 0;
      a += s * (0.45 * blanket + 0.35 * ray + 0.15 * (1 - smoothstep(0.8, 1, r))) * (1 - smoothstep(2.8, HALO_REACH, r));
    }
    return 1 + Math.min(a, 0.8);
  }
}

/**
 * Relief of one crater at normalised radius r (distance / radius): a parabolic bowl from the floor up to the rim crest,
 * then an ejecta blanket thinning as r^-3 (McGetchin et al. 1973) and tapered to zero at `reach`. `crest` is the
 * half-width of the blend across the crest: narrow keeps fresh rims sharp, wide rounds old ones.
 */
export function craterProfile(r: number, depth: number, rim: number, crest: number, reach: number): number {
  const inner = -depth + (depth + rim) * r * r;
  if (r <= 1 - crest) return inner;
  const outer = (rim / (r * r * r)) * (1 - smoothstep(reach - 0.6, reach, r));
  return inner + (outer - inner) * smoothstep(1 - crest, 1 + crest, r);
}
