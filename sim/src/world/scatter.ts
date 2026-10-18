// Pebbles and clasts strewn over the regolith around the player. Each 1 m world cell always holds the same stones (their
// positions, sizes and poses hash from the cell), so re-centring the patch never reshuffles them. Pure: the terrain
// worker fills the instance matrices alongside the finest clipmap level, and the tests run it in Node.
import { mulberry32, valueNoise, type Detail } from "./detail";

export const PEBBLES_PER_CELL = 6; // candidates per m², thinned by `abundance`
const MIN_R = 0.015, MAX_R = 0.1; // m: N(>r) ∝ r^-2, so most are grit and a few are fist-sized
const R_SPAN = 1 - (MIN_R / MAX_R) ** 2;
const BURIED = 1 / 3; // of each pebble's height
const TRODDEN = [2, 8]; // m from the work site: no pebbles inside the first, fewer out to the second

/** Instance capacity for a square patch `size` metres across. */
export const pebbleCapacity = (size: number) => (Math.ceil(size) + 1) ** 2 * PEBBLES_PER_CELL;

const cellSeed = (ix: number, iz: number, seed: number) =>
  (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;

/**
 * Write the pebbles in the square [x0, x0 + size] × [z0, z0 + size] into `out` as column-major 4×4 instance matrices
 * (THREE.InstancedMesh layout) for a stone model fitted to [-1, 1]³, and return how many. `abundance(x, z)` (0..1) is
 * the chance that a candidate stone is kept.
 */
export function scatterPebbles(x0: number, z0: number, size: number, seed: number,
    ground: (x: number, z: number) => number, abundance: (x: number, z: number) => number, out: Float32Array): number {
  let n = 0;
  for (let iz = Math.floor(z0); iz < z0 + size; iz++) {
    for (let ix = Math.floor(x0); ix < x0 + size; ix++) {
      const rnd = mulberry32(cellSeed(ix, iz, seed));
      for (let k = 0; k < PEBBLES_PER_CELL; k++) {
        // draw every number before deciding, so a stone never depends on which of its neighbours were kept
        const x = ix + rnd(), z = iz + rnd(), keep = rnd();
        const r = MIN_R / Math.sqrt(1 - rnd() * R_SPAN);
        const sy = r * (0.55 + 0.45 * rnd()), sz = r * (0.6 + 0.4 * rnd());
        const yaw = rnd() * Math.PI * 2, tilt = 0.5 * rnd();
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size || keep >= abundance(x, z)) continue;
        // rotation Ry(yaw) · Rx(tilt), columns scaled by the half-extents (r, sy, sz)
        const cy = Math.cos(yaw), sny = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
        const o = n++ * 16;
        out[o] = cy * r; out[o + 1] = 0; out[o + 2] = -sny * r; out[o + 3] = 0;
        out[o + 4] = sny * st * sy; out[o + 5] = ct * sy; out[o + 6] = cy * st * sy; out[o + 7] = 0;
        out[o + 8] = sny * ct * sz; out[o + 9] = -st * sz; out[o + 10] = cy * ct * sz; out[o + 11] = 0;
        out[o + 12] = x; out[o + 13] = ground(x, z) + sy * (1 - 2 * BURIED); out[o + 14] = z; out[o + 15] = 1;
      }
    }
  }
  return n;
}

/** Chance a candidate pebble is kept: clumped, thick on fresh craters' bright ejecta, thinned on the trodden work site. */
export function pebbleAbundance(detail: Detail, site: { x: number; z: number }, x: number, z: number): number {
  const t = Math.min(Math.max((Math.hypot(x - site.x, z - site.z) - TRODDEN[0]) / (TRODDEN[1] - TRODDEN[0]), 0), 1);
  const clump = 0.5 + 0.5 * valueNoise(x / 6, z / 6, 9157);
  return t * t * (3 - 2 * t) * Math.min(1, 0.15 + 0.6 * clump * clump + 2.5 * (detail.albedo(x, z) - 1));
}
