// Drill press materials: PBR textures baked at startup with gfx/procedural (no image assets). The press geometry is
// UV-mapped in metres (drillPressModel.ts), and each texture's repeat is its tiles per metre, so texel density is
// the same on every part whatever its size.
import * as THREE from "three";
import { bake, cached, cells, fbm, mix, noise, ridged, smooth, type Baked, type Texel } from "../gfx/procedural";

type RGB = readonly [number, number, number];
const tri = (x: number) => 1 - Math.abs(2 * (x - Math.floor(x)) - 1); // 0 at integers, 1 halfway
function set(o: Texel, c: RGB, k = 1): void { o.r = c[0] * k; o.g = c[1] * k; o.b = c[2] * k; }
function blend(o: Texel, c: RGB, t: number): void { o.r = mix(o.r, c[0], t); o.g = mix(o.g, c[1], t); o.b = mix(o.b, c[2], t); }

// sRGB colours
export const PAINT_WHITE: RGB = [0.8, 0.79, 0.75];
export const PAINT_ORANGE: RGB = [0.93, 0.42, 0.1];
export const PAINT_GRAPHITE: RGB = [0.2, 0.21, 0.22];
const PRIMER: RGB = [0.5, 0.33, 0.25];
const BARE_STEEL: RGB = [0.56, 0.56, 0.57];
const DUST: RGB = [0.5, 0.48, 0.45];
const HAZARD_YELLOW: RGB = [0.95, 0.72, 0.06];
const HAZARD_BLACK: RGB = [0.05, 0.05, 0.05];

/**
 * A tileable scalar field computed on an n x n grid and read back with bilinear interpolation, so a smooth field can
 * be evaluated at a fraction of the texture's resolution.
 */
function field(n: number, f: (u: number, v: number) => number): (u: number, v: number) => number {
  const g = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g[y * n + x] = f((x + 0.5) / n, (y + 0.5) / n);
  return (u, v) => {
    const x = u * n - 0.5, y = v * n - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i0 = ((x0 % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((y0 % n) + n) % n, j1 = (j0 + 1) % n;
    const a = g[j0 * n + i0], b = g[j0 * n + i1], c = g[j1 * n + i0], d = g[j1 * n + i1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// The paint's wear pattern is the costly part and doesn't depend on the colour: computed once, shared by every paint.
const paintWear = (seed: number) => cached(`press:wear:${seed}`, () => ({
  chips: field(512, (u, v) => fbm(u, v, 24, seed, 4)), // ~2 cm flakes, down to millimetre specks
  zone: field(64, (u, v) => smooth(0.15, 0.4, fbm(u, v, 3, seed + 5, 3))), // the patches that took the knocks
  tone: field(64, (u, v) => fbm(u, v, 4, seed + 1, 3)),
  dust: field(64, (u, v) => smooth(0, 0.6, fbm(u, v, 3, seed + 2, 3))),
}));

/**
 * Painted cast metal: hammertone skin, a few chips down to primer and bare metal (sparse, clustered where the part
 * took knocks, so it reads as wear rather than a pattern), grime in the same patches and a film of lunar dust.
 */
export function castPaint(base: RGB, seed: number) {
  const w = paintWear(seed);
  return (u: number, v: number, o: Texel) => {
    const skin = Math.abs(noise(u, v, 128, seed + 3)), grain = noise(u, v, 256, seed + 4);
    const zone = w.zone(u, v), tone = w.tone(u, v), dust = w.dust(u, v), t = 0.46 - 0.2 * zone;
    const wear = w.chips(u, v), chip = smooth(t, t + 0.015, wear), primer = smooth(t - 0.03, t - 0.015, wear) - chip;
    set(o, base, 1 + 0.05 * tone + 0.02 * grain - 0.06 * skin - 0.08 * zone);
    blend(o, PRIMER, primer);
    blend(o, BARE_STEEL, chip);
    blend(o, DUST, (0.15 + 0.2 * zone) * dust * (1 - chip));
    o.height = 0.3 * (1 - skin) + 0.05 * grain + 0.6 * (1 - 0.5 * primer - chip);
    o.rough = mix(0.45 + 0.05 * tone + 0.1 * zone, 0.38, chip) + 0.25 * dust;
    o.metal = chip;
    o.ao = 1 - 0.15 * skin;
  };
}

/** Diagonal yellow/black safety stripes (4 pairs per tile, so they wrap), scuffed. */
export function hazardPaint(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const s = Math.sin((u + v) * 4 * Math.PI * 2);
    set(o, HAZARD_BLACK);
    blend(o, HAZARD_YELLOW, smooth(-0.12, 0.12, s));
    const chip = smooth(0.36, 0.375, fbm(u, v, 24, seed, 4));
    const dust = smooth(0, 0.6, fbm(u, v, 3, seed + 1, 3));
    const k = 1 + 0.05 * fbm(u, v, 6, seed + 2, 3);
    o.r *= k; o.g *= k; o.b *= k;
    blend(o, BARE_STEEL, chip);
    blend(o, DUST, 0.25 * dust);
    o.height = 1 - chip + 0.05 * noise(u, v, 256, seed + 3);
    o.rough = mix(0.5, 0.35, chip) + 0.2 * dust;
    o.metal = chip;
  };
}

/** Brushed steel: fine streaks along u. */
export function brushedSteel(seed: number, base = 0.62) {
  return (u: number, v: number, o: Texel) => {
    const s = 0.6 * noise(0.37, v, 512, seed) + 0.4 * noise(0.71, v, 128, seed + 1); // constant along u: streaks
    const patch = fbm(u, v, 4, seed + 2, 3);
    const k = base + 0.06 * s + 0.04 * patch;
    o.r = k; o.g = k; o.b = k * 1.02;
    o.height = 0.5 * s;
    o.rough = 0.3 + 0.08 * s - 0.06 * patch;
    o.metal = 1;
  };
}

/** Ground / polished steel (column, quill): near mirror with faint smudges. */
export function polishedSteel(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const smudge = smooth(-0.2, 0.5, fbm(u, v, 6, seed, 4));
    const k = 0.78 + 0.03 * noise(0.5, v, 256, seed + 1);
    o.r = k; o.g = k; o.b = k * 1.01;
    o.rough = 0.12 + 0.14 * smudge;
    o.metal = 1;
  };
}

/** Anodized aluminium: dyed metal with a fine satin grain. */
export function anodized(base: RGB, seed: number) {
  return (u: number, v: number, o: Texel) => {
    const g = noise(u, v, 256, seed), m = fbm(u, v, 4, seed + 1, 3);
    set(o, base, 1 + 0.04 * m + 0.03 * g);
    o.height = 0.3 * g;
    o.rough = 0.34 + 0.06 * g;
    o.metal = 1;
  };
}

/** Diamond tread plate: raised lugs in alternating diagonals, dust settled between them. */
export function diamondPlate(seed: number) {
  const N = 10; // lugs per tile
  return (u: number, v: number, o: Texel) => {
    const x = u * N, y = v * N;
    let fx = x - Math.floor(x) - 0.5, fy = y - Math.floor(y) - 0.5;
    if ((Math.floor(x) + Math.floor(y)) & 1) [fx, fy] = [fy, -fx];
    const a = (fx + fy) * Math.SQRT1_2, b = (fx - fy) * Math.SQRT1_2;
    const lug = smooth(1, 0.55, (a / 0.36) ** 2 + (b / 0.09) ** 2);
    const dust = smooth(-0.3, 0.5, fbm(u, v, 5, seed, 4)) * (1 - lug);
    const k = 0.5 + 0.12 * lug + 0.03 * noise(u, v, 128, seed + 1);
    o.r = k; o.g = k; o.b = k * 1.02;
    blend(o, DUST, 0.7 * dust);
    o.height = lug;
    o.rough = mix(0.45, 0.3, lug) + 0.4 * dust;
    o.metal = 1 - dust;
    o.ao = 0.7 + 0.3 * lug;
  };
}

/** Rubber and cable jacket. */
export function rubber(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const n = noise(u, v, 64, seed), pore = noise(u, v, 128, seed + 1);
    const k = 0.045 + 0.01 * n;
    o.r = k; o.g = k; o.b = k;
    o.height = 0.5 * Math.abs(pore);
    o.rough = 0.82 + 0.1 * n;
  };
}

/** Gold multi-layer insulation: crumpled foil. */
export function goldFoil(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const crease = ridged(u, v, 4, seed, 5), fine = ridged(u, v, 16, seed + 1, 3);
    const k = 0.6 + 0.5 * crease;
    o.r = 0.96 * k; o.g = 0.7 * k * (0.92 + 0.08 * fine); o.b = 0.3 * k;
    o.height = 0.7 * crease + 0.3 * fine;
    o.rough = 0.16 + 0.25 * (1 - crease);
    o.metal = 1;
  };
}

/** Diamond knurl (the chuck sleeve). */
export function knurl(seed: number) {
  const N = 24;
  return (u: number, v: number, o: Texel) => {
    const h = Math.min(tri((u + v) * N), tri((u - v) * N));
    const k = 0.5 + 0.18 * h + 0.03 * noise(u, v, 64, seed);
    o.r = k; o.g = k; o.b = k;
    o.height = h;
    o.rough = 0.38 - 0.1 * h;
    o.metal = 1;
    o.ao = 0.6 + 0.4 * h;
  };
}

/** Compacted regolith brick: sintered grains, a few angular lithic clasts, glass beads, faint compaction layers. */
export function regolith(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const g = cells(u, v, 160, seed);
    const grain = 1 - smooth(0, 0.6, g.f1);
    const clump = fbm(u, v, 8, seed + 1, 4);
    const k = 1 + 0.22 * (g.id - 0.5) + 0.1 * clump + 0.03 * Math.sin(v * Math.PI * 2 * 24);
    o.r = 0.52 * k; o.g = 0.49 * k; o.b = 0.45 * k;
    // clasts: the middle of a Voronoi cell (far from its edges) is an angular fragment
    const c = cells(u, v, 22, seed + 2);
    const clast = c.id < 0.16 ? smooth(0.5, 0.58, c.f2 - c.f1 + 0.08 * noise(u, v, 64, seed + 3)) : 0;
    if (clast) {
      const tone = c.id / 0.16; // anorthosite (pale) .. basalt / agglutinate (dark)
      blend(o, tone < 0.4 ? [0.72, 0.71, 0.67] : tone < 0.8 ? [0.33, 0.32, 0.31] : [0.22, 0.18, 0.15], 0.85 * clast);
    }
    const bead = cells(u, v, 64, seed + 4);
    const pit = bead.id < 0.05 ? smooth(0.16, 0.1, bead.f1) : 0;
    blend(o, [0.2, 0.17, 0.14], 0.6 * pit);
    o.height = 0.35 * grain + 0.3 * clump + 0.6 * clast - 0.5 * pit;
    o.rough = 0.95 - 0.1 * clast;
    o.ao = 0.8 + 0.2 * grain - 0.3 * pit;
  };
}

/** Dark vesicular basalt: crisp gas-bubble holes of mixed sizes and sparse feldspar flecks in a fine dark matrix. */
export function basalt(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const tone = fbm(u, v, 5, seed, 4), fine = noise(u, v, 256, seed + 1);
    const k = 1 + 0.1 * tone + 0.1 * fine;
    o.r = 0.17 * k; o.g = 0.17 * k; o.b = 0.18 * k;
    const xl = cells(u, v, 140, seed + 2);
    if (xl.id > 0.93) blend(o, [0.46, 0.46, 0.44], smooth(0.32, 0.18, xl.f1)); // plagioclase
    let pit = 0;
    const big = cells(u, v, 24, seed + 3);
    if (big.id < 0.25) { const r = 0.07 + big.id; pit = smooth(r, r * 0.75, big.f1); }
    const small = cells(u, v, 72, seed + 4);
    if (small.id < 0.2) pit = Math.max(pit, smooth(0.24, 0.18, small.f1));
    blend(o, [0.03, 0.03, 0.035], 0.9 * pit);
    o.height = 0.15 * tone + 0.1 * fine - pit;
    o.rough = 0.7 + 0.1 * fine + 0.2 * pit;
    o.ao = 1 - 0.6 * pit;
  };
}

/** Drill cuttings: fine powder (tinted per sample by the material colour). */
export function powder(seed: number) {
  return (u: number, v: number, o: Texel) => {
    const g = cells(u, v, 96, seed), n = fbm(u, v, 6, seed + 1, 3);
    const k = 0.62 + 0.12 * (g.id - 0.5) + 0.08 * n;
    o.r = k; o.g = k; o.b = k;
    o.height = 0.6 * (1 - smooth(0, 0.7, g.f1)) + 0.4 * n;
    o.rough = 1;
  };
}

/** Bake a texel function once (cached by key) with `tile` metres per texture tile. */
function baked(key: string, size: number, tile: number, depth: number, texel: (u: number, v: number, o: Texel) => void): Baked {
  return cached(`press:${key}`, () => bake(size, texel, { depth, repeat: 1 / tile }));
}

function pbr(b: Baked): THREE.MeshStandardMaterial {
  // the ORM map's channels scale roughness/metalness, so their uniforms stay at 1
  return new THREE.MeshStandardMaterial({
    map: b.map, normalMap: b.normalMap, roughnessMap: b.ormMap, metalnessMap: b.ormMap, aoMap: b.ormMap,
    roughness: 1, metalness: 1,
  });
}

export interface PressMaterials {
  paint: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial; graphite: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial; brushed: THREE.MeshStandardMaterial; chrome: THREE.MeshStandardMaterial;
  blue: THREE.MeshStandardMaterial; fins: THREE.MeshStandardMaterial; rubber: THREE.MeshStandardMaterial;
  phenolic: THREE.MeshStandardMaterial; tread: THREE.MeshStandardMaterial; foil: THREE.MeshStandardMaterial;
  knurl: THREE.MeshStandardMaterial; carbide: THREE.MeshStandardMaterial; red: THREE.MeshStandardMaterial;
  yellow: THREE.MeshStandardMaterial;
  regolith: THREE.MeshStandardMaterial; basalt: THREE.MeshStandardMaterial; powder: THREE.MeshStandardMaterial;
}

/** All press materials. Metals reflect the scene's environment map (the sky's sunlit-regolith bounce). */
export function pressMaterials(): PressMaterials {
  const m: PressMaterials = {
    paint: pbr(baked("paint", 512, 0.5, 0.004, castPaint(PAINT_WHITE, 11))),
    accent: pbr(baked("accent", 512, 0.5, 0.004, castPaint(PAINT_ORANGE, 11))),
    graphite: pbr(baked("graphite", 512, 0.5, 0.004, castPaint(PAINT_GRAPHITE, 11))),
    hazard: pbr(baked("hazard", 256, 0.5, 0.003, hazardPaint(41))),
    brushed: pbr(baked("brushed", 512, 0.25, 0.002, brushedSteel(53))),
    chrome: pbr(baked("chrome", 256, 0.5, 0.001, polishedSteel(61))),
    blue: pbr(baked("blue", 256, 0.25, 0.002, anodized([0.12, 0.25, 0.55], 71))),
    fins: pbr(baked("fins", 256, 0.25, 0.002, anodized([0.5, 0.51, 0.53], 73))),
    rubber: pbr(baked("rubber", 256, 0.2, 0.003, rubber(83))),
    phenolic: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.28, metalness: 0 }),
    tread: pbr(baked("tread", 256, 0.25, 0.012, diamondPlate(97))),
    foil: pbr(baked("foil", 256, 0.4, 0.02, goldFoil(101))),
    knurl: pbr(baked("knurl", 256, 0.05, 0.03, knurl(103))),
    carbide: new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.45, metalness: 1 }),
    red: new THREE.MeshStandardMaterial({ color: 0xc01010, roughness: 0.35, metalness: 0 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0 }),
    regolith: pbr(baked("regolith", 256, 0.15, 0.006, regolith(107))),
    basalt: pbr(baked("basalt", 256, 0.15, 0.006, basalt(109))),
    powder: pbr(baked("powder", 128, 0.05, 0.01, powder(113))),
  };
  return m;
}
