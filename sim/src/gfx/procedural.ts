// Procedural textures: seeded, tileable noise baked into DataTextures at startup, so materials get colour, surface
// relief and roughness variation without shipping image assets. Coordinates are (u, v) in [0, 1) over one tile and
// `scale` is how many noise cells span the tile (an integer, so every pattern wraps seamlessly).
import * as THREE from "three";

const mod = (a: number, p: number) => ((a % p) + p) % p;

// small shaping helpers shared by the texel functions
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const frac = (x: number) => x - Math.floor(x);
/** Smoothstep: 0 below a, 1 above b, a smooth ramp between. */
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 32-bit integer hash of a lattice point. */
export function hashInt(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Lattice hash in [0, 1). */
export const hash01 = (x: number, y: number, seed: number) => hashInt(x, y, seed) / 4294967296;

const GX = new Float32Array(16), GY = new Float32Array(16);
for (let i = 0; i < 16; i++) { GX[i] = Math.cos((i / 16) * Math.PI * 2); GY[i] = Math.sin((i / 16) * Math.PI * 2); }
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** a mod p for an integer a, in [0, p) (the same value as ((a % p) + p) % p, with one division). */
const wrap = (a: number, p: number) => {
  const r = a % p;
  return r < 0 ? r + p : r;
};

/** The finish of hashInt from its combined lattice term, & 15: one of the 16 gradients, dotted with (dx, dy). */
function grad(h: number, dx: number, dy: number): number {
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h = (h ^ (h >>> 16)) & 15;
  return GX[h] * dx + GY[h] * dy;
}

/** Gradient noise in about [-1, 1], tiling over the unit square. */
export function noise(u: number, v: number, scale: number, seed = 0): number {
  // hashInt(cx, cy, seed) & 15 at the four corners, with each axis's multiply done once (the bakes' hot spot)
  const x = u * scale, y = v * scale;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const hx0 = Math.imul(wrap(ix, scale) | 0, 374761393), hx1 = Math.imul(wrap(ix + 1, scale) | 0, 374761393);
  const hs = Math.imul(seed | 0, 1274126177);
  const hy0 = Math.imul(wrap(iy, scale) | 0, 668265263) ^ hs, hy1 = Math.imul(wrap(iy + 1, scale) | 0, 668265263) ^ hs;
  const a = grad(hx0 ^ hy0, fx, fy), b = grad(hx1 ^ hy0, fx - 1, fy);
  const c = grad(hx0 ^ hy1, fx, fy - 1), d = grad(hx1 ^ hy1, fx - 1, fy - 1);
  const sx = fade(fx), sy = fade(fy);
  return 1.41 * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
}

/** Fractal noise (fBm) in about [-1, 1]; each octave doubles the frequency, so it still tiles. */
export function fbm(u: number, v: number, scale: number, seed = 0, octaves = 5, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, s = scale;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(u, v, s, seed + i * 7919);
    norm += amp;
    amp *= gain;
    s *= 2;
  }
  return sum / norm;
}

/** Ridged fractal noise in [0, 1]: sharp crests (cracks, wrinkles, crumpled foil). */
export function ridged(u: number, v: number, scale: number, seed = 0, octaves = 4): number {
  let sum = 0, amp = 0.5, norm = 0, s = scale;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(u, v, s, seed + i * 7919));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    s *= 2;
  }
  return sum / norm;
}

export interface Cell { f1: number; f2: number; id: number; cx: number; cy: number }
const _cell: Cell = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };

/**
 * Cellular (Worley) noise: distances, in cell units, from (u, v) to the nearest and second-nearest feature points
 * (one random point per cell), the nearest point's id hash in [0, 1) and its position (u, v). Tiles. The returned
 * object is reused: copy what you need before calling again.
 */
export function cells(u: number, v: number, scale: number, seed = 0): Cell {
  // compares squared distances; only the two winners pay for a square root (Math.hypot, as the distances always were)
  const x = u * scale, y = v * scale;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 81, f2 = 81, d1x = 0, d1y = 0, d2x = 0, d2y = 0, bx = 0, by = 0, px = 0, py = 0;
  for (let j = -1; j <= 1; j++) {
    const cy = wrap(iy + j, scale);
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, scale);
      const h = hashInt(cx, cy, seed);
      const fx = ix + i + (h & 0xffff) / 65536, fy = iy + j + (h >>> 16) / 65536;
      const dx = fx - x, dy = fy - y, d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; d2x = d1x; d2y = d1y; f1 = d; d1x = dx; d1y = dy; bx = cx; by = cy; px = fx; py = fy; }
      else if (d < f2) { f2 = d; d2x = dx; d2y = dy; }
    }
  }
  _cell.f1 = Math.hypot(d1x, d1y); _cell.f2 = Math.hypot(d2x, d2y); _cell.id = hash01(bx, by, seed + 1);
  _cell.cx = mod(px, scale) / scale; _cell.cy = mod(py, scale) / scale;
  return _cell;
}

/** What `bake` asks for at each texel. Colour is sRGB 0..1 (as you would paint it); height is any unit (see depth). */
export interface Texel { r: number; g: number; b: number; height: number; rough: number; metal: number; ao: number }

export interface BakeOptions {
  /** Relief of height = 1 as a fraction of the tile width (a 0.5 m tile with 5 mm bumps: 0.01). Default 0.02. */
  depth?: number;
  /** Repeat count set on all three textures. Default 1. */
  repeat?: number;
}

/** Colour (sRGB), normal (tangent space, OpenGL +Y) and ORM (R occlusion, G roughness, B metalness) maps. */
export interface Baked { map: THREE.DataTexture; normalMap: THREE.DataTexture; ormMap: THREE.DataTexture }

function dataTexture(data: Uint8Array, size: number, srgb: boolean, repeat: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Bake a tileable material: `texel(u, v, out)` fills `out` (pre-set to mid grey, height 0, rough 1, metal 0, ao 1)
 * for each texel centre; the normal map comes from the height field's wrapped central differences.
 * Use `ormMap` as roughnessMap + metalnessMap (+ aoMap if you set ao).
 */
export function bake(size: number, texel: (u: number, v: number, out: Texel) => void, opts: BakeOptions = {}): Baked {
  const t0 = performance.now();
  const n = size * size;
  const color = new Uint8Array(n * 4), normal = new Uint8Array(n * 4), orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const out: Texel = { r: 0.5, g: 0.5, b: 0.5, height: 0, rough: 1, metal: 0, ao: 1 };
  const byte = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.r = out.g = out.b = 0.5; out.height = 0; out.rough = 1; out.metal = 0; out.ao = 1;
      texel((x + 0.5) / size, (y + 0.5) / size, out);
      const i = y * size + x, k = i * 4;
      color[k] = byte(out.r); color[k + 1] = byte(out.g); color[k + 2] = byte(out.b); color[k + 3] = 255;
      orm[k] = byte(out.ao); orm[k + 1] = byte(out.rough); orm[k + 2] = byte(out.metal); orm[k + 3] = 255;
      height[i] = out.height;
    }
  }
  const k = 0.5 * size * (opts.depth ?? 0.02); // central difference -> slope, relief relative to the tile width
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)];
      const dy = height[((y + 1) % size) * size + x] - height[((y - 1 + size) % size) * size + x];
      const nx = -dx * k, ny = -dy * k, len = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * size + x) * 4;
      normal[o] = byte(nx / len * 0.5 + 0.5); normal[o + 1] = byte(ny / len * 0.5 + 0.5);
      normal[o + 2] = byte(1 / len * 0.5 + 0.5); normal[o + 3] = 255;
    }
  }
  const repeat = opts.repeat ?? 1;
  bakeLog.push({ key: bakeKey, size, ms: performance.now() - t0 });
  return { map: dataTexture(color, size, true, repeat), normalMap: dataTexture(normal, size, false, repeat),
    ormMap: dataTexture(orm, size, false, repeat) };
}

/** Every bake so far, with the `cached` key it ran under: startup cost, read by the dev hook's stats(). */
export const bakeLog: { key: string; size: number; ms: number }[] = [];
let bakeKey = "";

const cache = new Map<string, unknown>();
/** Bake once per key: textures are shared by every material that asks for the same key. */
export function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) {
    const outer = bakeKey;
    bakeKey = key;
    try {
      cache.set(key, make());
    } finally {
      bakeKey = outer;
    }
  }
  return cache.get(key) as T;
}

/** A canvas-painted sRGB texture (labels, gauges, decals). Set `.needsUpdate = true` after repainting. */
export function canvasTexture(width: number, height: number, paint: (g: CanvasRenderingContext2D) => void):
    THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  paint(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
