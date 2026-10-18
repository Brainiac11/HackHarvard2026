// Near-field terrain as a geometry clipmap: nested square grids centred on the player, each twice as coarse as the one
// inside it, so the surface is dense (about 16 cm between vertices) where synthetic detail is visible and cheap far
// away. Every level snaps to its parent's vertices and its outer band morphs into the parent's surface (exactly at the
// edge). The parent leaves out its triangles under the level but for a ring along the edge, where it discards fragments
// instead (regolith.ts), so levels meet without cracks or z-fighting, and passes that override the material (ambient
// occlusion) still see one surface. Pure maths: the terrain worker fills levels with it and the tests run it in Node.

export const LEVELS = 5; // level l has spacing map / 8192 · 2^l, i.e. LOLA spacing / 8 · 2^l (0.16 .. 2.5 m)
export const QUADS = 192; // quads per level side: level 0 is 30 m across, level 4 about 480 m
export const FAR_QUADS = 256; // the static full-map mesh beyond the levels (spacing 2 · level 4)
export const MORPH_BAND = 20; // outer band, in quads, that blends into the parent level
export const RECENTRE = 8; // re-centre a level once its snapped target has moved this many of its quads
export const OVERLAP = 1; // ring of quads a level still draws under its child's edge

export type Sampler = (x: number, z: number) => number;

/** Vertex spacing of level `level` (LEVELS: the far mesh): the map halved again and again, so lattices nest exactly. */
export const levelSpacing = (extent: number, level: number) => extent / FAR_QUADS / 2 ** (LEVELS - level);

/** A square grid of `quads`² quads with its min corner at (x0, z0). */
export interface LevelGrid { x0: number; z0: number; spacing: number; quads: number }
/** Vertex buffers of one level, positions local to its origin. */
export interface LevelBuffers { pos: Float32Array; nrm: Float32Array; alb: Float32Array }
export interface LevelJob extends LevelGrid { level: number; morph: boolean; buffers?: LevelBuffers }
export interface LevelResult extends LevelGrid { level: number; buffers: LevelBuffers; minY: number; maxY: number }
export type Indices = Uint16Array | Uint32Array;
/** Quads [i0, i1) × [j0, j1) of a level that its child draws instead. */
export interface Cut { i0: number; j0: number; i1: number; j1: number }
/** Re-index a level around its child's new footprint (into `indices` if sent). */
export interface CutJob { level: number; quads: number; cut: Cut; indices?: Indices }
export interface CutResult { level: number; indices: Indices; count: number }

export type WorkerRequest =
  | { t: "init"; lola: Float32Array; n: number; spacing: number; extent: number; seed: number;
      exclusion: { x: number; z: number; r: number } }
  | { t: "build"; enabled: boolean; jobs: LevelJob[]; cuts: CutJob[]; pebbles?: Float32Array };
/** With level 0 rebuilt, the pebbles over its square (scatter.ts), in the `pebbles` buffer if one was sent. */
export type WorkerReply = {
  t: "built"; results: LevelResult[]; cuts: CutResult[]; pebbles?: { matrices: Float32Array; count: number };
};

/**
 * Min-corner coordinate (x or z) of a level of `spacing` centred near `f`: on an even vertex of the level, i.e. on its
 * parent's vertices (the map corner is a vertex of every level), and kept inside the map.
 */
export function snapOrigin(f: number, spacing: number, quads: number, extent: number): number {
  const cells = Math.round(extent / spacing);
  const i = 2 * Math.round(((f + extent / 2) / spacing - quads / 2) / 2);
  return -extent / 2 + Math.min(Math.max(i, 0), cells - quads) * spacing;
}

/** An index buffer that holds every triangle of a level grid: 16-bit when its vertices allow. */
export const indexBuffer = (quads: number): Indices =>
  (quads + 1) ** 2 > 65535 ? new Uint32Array(quads * quads * 6) : new Uint16Array(quads * quads * 6);

/** The quads of `parent` under `child`, less a ring of OVERLAP quads along the child's edge. */
export function cutUnder(parent: LevelGrid, child: LevelGrid): Cut {
  const s = parent.spacing, size = Math.round((child.quads * child.spacing) / s);
  const i0 = Math.round((child.x0 - parent.x0) / s), j0 = Math.round((child.z0 - parent.z0) / s);
  const clamp = (v: number) => Math.min(Math.max(v, 0), parent.quads);
  return { i0: clamp(i0 + OVERLAP), j0: clamp(j0 + OVERLAP), i1: clamp(i0 + size - OVERLAP), j1: clamp(j0 + size - OVERLAP) };
}

/**
 * Write a level grid's triangle indices, but for the quads in `cut`, into `out` and return how many. Every quad is
 * split along its (i, j)-(i+1, j+1) diagonal (fillLevel relies on it).
 */
export function gridIndices(quads: number, out: Indices, cut?: Cut): number {
  const n = quads + 1;
  let k = 0;
  for (let j = 0; j < quads; j++) {
    const cutRow = cut !== undefined && j >= cut.j0 && j < cut.j1;
    for (let i = 0; i < quads; i++) {
      if (cutRow && i >= cut.i0 && i < cut.i1) continue;
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      out[k++] = a; out[k++] = c; out[k++] = d;
      out[k++] = a; out[k++] = d; out[k++] = b;
    }
  }
  return k;
}

const BORDER = 2; // extra samples around a level: normals need 1, the parent's normals 2
let H = new Float64Array(0); // true heights, (quads + 1 + 2·BORDER)² samples
let M = new Float64Array(0); // morphed heights on the same lattice
let cx = 0, cy = 0, cz = 0; // parent-normal accumulator (no allocations per vertex)

/**
 * Fill a level's buffers from `height` / `albedo`. With `morph`, the outer MORPH_BAND quads blend, heights and normals,
 * toward the parent level's surface: true heights on its vertices (the even ones here), linear along its edges and its
 * quads' (i, j)-(i+1, j+1) diagonals in between. Returns the level's height range.
 */
export function fillLevel(g: LevelGrid, morph: boolean, height: Sampler, albedo: Sampler, out: LevelBuffers):
    { minY: number; maxY: number } {
  const q = g.quads, n = q + 1, w = n + 2 * BORDER, s = g.spacing;
  if (H.length < w * w) { H = new Float64Array(w * w); M = new Float64Array(w * w); }
  const at = (i: number, j: number) => (j + BORDER) * w + i + BORDER;
  for (let j = -BORDER; j < n + BORDER; j++) {
    const z = g.z0 + j * s;
    for (let i = -BORDER; i < n + BORDER; i++) H[at(i, j)] = height(g.x0 + i * s, z);
  }
  // weight of the parent's surface: 1 on (and outside) the edge, easing to 0 across the band
  const weight = (i: number, j: number) => {
    if (!morph) return 0;
    const e = Math.min(i, j, q - i, q - j);
    if (e >= MORPH_BAND) return 0;
    const t = Math.max(e, 0) / MORPH_BAND;
    return 1 - t * t * (3 - 2 * t);
  };
  const parent = (i: number, j: number) => {
    const oi = i & 1, oj = j & 1;
    if (!oi && !oj) return H[at(i, j)];
    if (oi && !oj) return 0.5 * (H[at(i - 1, j)] + H[at(i + 1, j)]);
    if (!oi && oj) return 0.5 * (H[at(i, j - 1)] + H[at(i, j + 1)]);
    return 0.5 * (H[at(i - 1, j - 1)] + H[at(i + 1, j + 1)]);
  };
  for (let j = -1; j <= n; j++) {
    for (let i = -1; i <= n; i++) {
      const k = at(i, j), wt = weight(i, j);
      M[k] = wt > 0 ? H[k] + (parent(i, j) - H[k]) * wt : H[k];
    }
  }
  // the parent's (normalised) vertex normal at an even vertex, added into the accumulator with weight f
  const addParentNormal = (i: number, j: number, f: number) => {
    const nx = (H[at(i - 2, j)] - H[at(i + 2, j)]) / (4 * s), nz = (H[at(i, j - 2)] - H[at(i, j + 2)]) / (4 * s);
    const inv = f / Math.sqrt(nx * nx + 1 + nz * nz);
    cx += nx * inv; cy += inv; cz += nz * inv;
  };

  const { pos, nrm, alb } = out;
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = j * n + i, k = at(i, j), y = M[k];
      let nx = (M[k - 1] - M[k + 1]) / (2 * s), nz = (M[k - w] - M[k + w]) / (2 * s);
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nx *= inv; nz *= inv;
      let ny = inv;
      const wt = weight(i, j);
      if (wt > 0) {
        // interpolate the parent's normals the way the GPU does along its edges (unnormalised average)
        cx = cy = cz = 0;
        const oi = i & 1, oj = j & 1;
        if (!oi && !oj) addParentNormal(i, j, 1);
        else if (oi && !oj) { addParentNormal(i - 1, j, 0.5); addParentNormal(i + 1, j, 0.5); }
        else if (!oi && oj) { addParentNormal(i, j - 1, 0.5); addParentNormal(i, j + 1, 0.5); }
        else { addParentNormal(i - 1, j - 1, 0.5); addParentNormal(i + 1, j + 1, 0.5); }
        nx += (cx - nx) * wt; ny += (cy - ny) * wt; nz += (cz - nz) * wt;
      }
      pos[v * 3] = i * s; pos[v * 3 + 1] = y; pos[v * 3 + 2] = j * s;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
      alb[v] = albedo(g.x0 + i * s, g.z0 + j * s);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minY, maxY };
}
