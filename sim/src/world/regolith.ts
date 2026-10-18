// Regolith material for every terrain mesh: LOLA-derived macro albedo, a mid tile (9.7 m: blotches, decimetre craters)
// and a fine tile (1.6 m: grain, clods, centimetre craters, clasts), both baked procedurally and sampled in world space.
// Each tile is read twice (rotated, rescaled, offset) and cross-faded by a low-frequency mask so neither repeats
// visibly; detail normals and texture fade out with distance so far terrain doesn't shimmer. Fragments inside the
// finer clipmap level's footprint are discarded (see clipmap.ts), in the shadow pass too.
import * as THREE from "three";
import { bake, cached, cells, fbm, frac, hash01, hashInt, noise, type Baked, type Texel } from "../gfx/procedural";
import { craterProfile } from "./detail";

const GRAIN_TILE = 1.6; // m
const MID_TILE = 9.7; // m
// linear: average regolith, a faintly warm grey. Under the near-white Sun it shows as grey with a hint of brown (sRGB
// R/B about 1.1); the tiles below are normalised by their mean, so only this and the Sun set the hue
export const REGOLITH_TINT = new THREE.Color(0.152, 0.149, 0.144);
const MACRO_MEAN = 0.15; // linear mean of albedo.png (terrain/build.py centres it on sRGB 0.42)

const wrap = (i: number, n: number) => (i < 0 ? i + n : i >= n ? i - n : i); // a cell index at most one tile out

/**
 * Sum `feature(d, id)` over the feature points of the 3×3 cells around (u, v), placed exactly as procedural.cells places
 * them (d in cell units, id in [0, 1)). Taking every neighbour rather than the nearest point alone means a feature up to
 * a cell wide is never cut off along a cell border. Tiles like cells; (u, v) in [0, 1).
 */
export function sumCells(u: number, v: number, scale: number, seed: number, feature: (d: number, id: number) => number): number {
  const x = u * scale, y = v * scale, ix = Math.floor(x), iy = Math.floor(y);
  let sum = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = wrap(ix + i, scale), cy = wrap(iy + j, scale), h = hashInt(cx, cy, seed);
      const dx = ix + i + (h & 0xffff) / 65536 - x, dy = iy + j + (h >>> 16) / 65536 - y, d2 = dx * dx + dy * dy;
      if (d2 < 1) sum += feature(Math.sqrt(d2), hash01(cx, cy, seed + 1));
    }
  }
  return sum;
}

/**
 * Craters on a fraction `odds` of the cells of a `cellM`-metre lattice: radii skewed small (0.1 to 0.52 cells, so the
 * ejecta stays within a cell), nearly all of them old and subdued. Relief in metres.
 */
function craterlets(cellM: number, odds: number): (d: number, id: number) => number {
  return (d, id) => {
    if (id >= odds) return 0;
    const t = id / odds, R = 0.1 + 0.42 * t * t, fresh = frac(id * 31.7) ** 3, r = d / R;
    if (r >= 1.8) return 0;
    const Rm = R * cellM;
    return craterProfile(r, Rm * (0.05 + 0.15 * fresh), Rm * (0.01 + 0.04 * fresh), 0.45 - 0.3 * fresh, 1.8);
  };
}

/** Soft clods and lumps (a raised cosine up to `size` cells across) on a fraction `odds` of the cells; height 0..1. */
function lumps(odds: number, size: number): (d: number, id: number) => number {
  return (d, id) => {
    const w = size * (0.5 + 0.5 * frac(id * 9.1)) / 2;
    return id < odds && d < w ? 0.5 + 0.5 * Math.cos((Math.PI * d) / w) : 0;
  };
}

const GRAIN_CRATERS = craterlets(GRAIN_TILE / 6, 0.3), GRAIN_PITS = craterlets(GRAIN_TILE / 16, 0.22);
const GRAIN_CLODS = lumps(0.55, 1.6);
const MID_CRATERS = craterlets(MID_TILE / 8, 0.4);

/** Fine tile: grain speckle, clods, centimetre craters and small clasts; heights in metres. */
function grainTexel(u: number, v: number, o: Texel): void {
  const T = GRAIN_TILE;
  let h = 0.004 * fbm(u, v, 10, 11, 4) + 0.0008 * noise(u, v, 128, 12) + 0.0004 * noise(u, v, 256, 13);
  h += sumCells(u, v, 6, 14, GRAIN_CRATERS) + sumCells(u, v, 16, 15, GRAIN_PITS);
  h += 0.0025 * sumCells(u, v, 40, 19, GRAIN_CLODS);
  let grey = 0.47 + 0.035 * fbm(u, v, 24, 16, 3) + 0.07 * (hash01(Math.floor(u * 512), Math.floor(v * 512), 17) - 0.5);
  let ao = 1, rough = 0.97;
  // small clasts, a third of them of a darker or brighter lithology (the 3D pebbles take over above a centimetre)
  const p = cells(u, v, 36, 18);
  if (p.id > 0.8) {
    const pr = 0.1 + 0.15 * frac(p.id * 13.7), d = p.f1 / pr;
    if (d < 1) {
      const dome = Math.sqrt(1 - d * d);
      h += 0.6 * dome * pr * (T / 36);
      grey = 0.33 + 0.3 * frac(p.id * 57.3) + 0.05 * dome;
      rough = 0.85;
    } else if (d < 1.4) ao = 0.7 + 0.3 * (d - 1) / 0.4; // dust banked against it
  }
  grey *= 1 + 8 * Math.min(h, 0); // fines collect in the hollows: slightly darker
  o.r = grey * 1.02; o.g = grey; o.b = grey * 0.95;
  o.height = h; o.ao = ao; o.rough = rough;
}

/**
 * Mid tile: albedo blotches, low lumps and decimetre craters (smaller ones are the fine tile's); B of its ORM map holds
 * the anti-tiling blend mask.
 */
function midTexel(u: number, v: number, o: Texel): void {
  let h = 0.025 * fbm(u, v, 4, 21, 5) + sumCells(u, v, 8, 22, MID_CRATERS);
  const blotch = fbm(u, v, 3, 24, 4), streak = fbm(u, v, 6, 25, 3);
  const grey = 0.47 * (1 + 0.16 * blotch + 0.05 * streak) * (1 + 1.5 * Math.min(h, 0));
  o.r = grey * (1.02 + 0.03 * blotch); o.g = grey; o.b = grey * (0.95 - 0.03 * blotch);
  o.height = h;
  o.rough = 0.95;
  o.metal = 0.5 + 0.5 * fbm(u, v, 2, 26, 3);
}

/** Mean linear colour of a baked sRGB map: tiles are normalised by it so they modulate the albedo around 1. */
function meanLinear(t: THREE.DataTexture): THREE.Vector3 {
  const d = t.image.data as Uint8Array, sum = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < d.length; i += 4) {
    c.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, THREE.SRGBColorSpace);
    sum.x += c.r; sum.y += c.g; sum.z += c.b;
  }
  return sum.divideScalar(d.length / 4);
}

const VERTEX_PARS = /* glsl */ `
attribute float terrainAlbedo;
varying vec3 vWorld;
varying float vAlbedo;
`;
const VERTEX_MAIN = /* glsl */ `
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
vAlbedo = terrainAlbedo;
`;
// the coarse level keeps drawing two pixels into the finer one's footprint: at grazing angles a pixel spans metres of
// ground, and sub-pixel rasterisation of the finer level's edge would otherwise leave cracks along it
const DISCARD = /* glsl */ `
vec2 holeMargin = 2.0 * fwidth(vWorld.xz);
if (all(greaterThan(vWorld.xz, uHole.xy + holeMargin)) && all(lessThan(vWorld.xz, uHole.zw - holeMargin))) discard;
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uMacro, uGrain, uGrainN, uGrainOrm, uMid, uMidN, uMidOrm;
uniform vec3 uGrainMean, uMidMean, uTint;
uniform vec4 uHole;
uniform float uExtent, uDetail;
varying vec3 vWorld;
varying float vAlbedo;
const mat2 ROT_A = mat2(0.7374, 0.6755, -0.6755, 0.7374);
const mat2 ROT_B = mat2(-0.4161, 0.9093, -0.9093, -0.4161);
`;

const FRAGMENT_ALBEDO = /* glsl */ `
vec2 wp = vWorld.xz;
float camDist = distance(vWorld, cameraPosition);
// uDetail 0 drops the synthetic tiles, colour and relief, along with the synthetic heights (F: NASA LOLA only)
float fineFade = (1.0 - smoothstep(8.0, 45.0, camDist)) * uDetail;
float midFade = (1.0 - smoothstep(90.0, 380.0, camDist)) * uDetail;
float maskA = smoothstep(0.3, 0.7, texture(uMidOrm, wp * (1.0 / 47.0)).b);
float maskB = smoothstep(0.3, 0.7, texture(uMidOrm, ROT_B * wp * (1.0 / 31.0) + 0.5).b);
vec2 gA = wp * (1.0 / ${GRAIN_TILE.toFixed(2)}), gB = ROT_A * wp * (1.0 / ${(GRAIN_TILE * 1.37).toFixed(3)}) + vec2(0.31, 0.67);
vec2 mA = wp * (1.0 / ${MID_TILE.toFixed(2)}), mB = ROT_B * wp * (1.0 / ${(MID_TILE * 1.29).toFixed(3)}) + vec2(0.53, 0.19);
// The tiles are read only where they show (beyond their fade distance, or with F off, their weight is exactly 0, and
// far ground is where 8x anisotropic reads cost most). Inside those branches implicit derivatives are undefined, so
// the gradients are taken here and passed explicitly, which keeps the anisotropic filtering.
vec2 gAx = dFdx(gA), gAy = dFdy(gA), gBx = dFdx(gB), gBy = dFdy(gB);
vec2 mAx = dFdx(mA), mAy = dFdy(mA), mBx = dFdx(mB), mBy = dFdy(mB);
vec3 grainCol = vec3(1.0), grainOrm = vec3(1.0, 0.95, 0.0), midCol = vec3(1.0);
if (fineFade > 0.0) {
  grainCol = mix(textureGrad(uGrain, gA, gAx, gAy).rgb, textureGrad(uGrain, gB, gBx, gBy).rgb, maskA) / uGrainMean;
  grainOrm = mix(textureGrad(uGrainOrm, gA, gAx, gAy).rgb, textureGrad(uGrainOrm, gB, gBx, gBy).rgb, maskA);
}
if (midFade > 0.0) midCol = mix(textureGrad(uMid, mA, mAx, mAy).rgb, textureGrad(uMid, mB, mBx, mBy).rgb, maskB) / uMidMean;
// LOLA-derived macro albedo, kept off its finest mips: its per-pixel grain would read as blotches up close
vec2 macroUv = (wp + 0.5 * uExtent) / uExtent;
vec2 macroTexel = macroUv * vec2(textureSize(uMacro, 0));
float macroLod = max(0.5 * log2(max(dot(dFdx(macroTexel), dFdx(macroTexel)), dot(dFdy(macroTexel), dFdy(macroTexel)))), 1.5);
float macro = textureLod(uMacro, macroUv, macroLod).r / ${MACRO_MEAN.toFixed(3)};
diffuseColor.rgb *= uTint * macro * vAlbedo * mix(vec3(1.0), midCol, midFade)
  * mix(vec3(1.0), grainCol * mix(1.0, grainOrm.r, 0.7), fineFade);
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
float roughnessFactor = roughness * mix(0.95, grainOrm.g, fineFade);
`;

// detail normals in world space: the maps hold height slopes (-dh/dx, -dh/dz) per metre; rotated reads turn back
const FRAGMENT_NORMAL = /* glsl */ `
vec2 slope = vec2(0.0);
if (fineFade > 0.0) {
  vec3 gnA = textureGrad(uGrainN, gA, gAx, gAy).xyz * 2.0 - 1.0, gnB = textureGrad(uGrainN, gB, gBx, gBy).xyz * 2.0 - 1.0;
  slope += mix(gnA.xy / gnA.z, (gnB.xy / gnB.z) * ROT_A, maskA) * fineFade;
}
if (midFade > 0.0) {
  vec3 mnA = textureGrad(uMidN, mA, mAx, mAy).xyz * 2.0 - 1.0, mnB = textureGrad(uMidN, mB, mBx, mBy).xyz * 2.0 - 1.0;
  slope += mix(mnA.xy / mnA.z, (mnB.xy / mnB.z) * ROT_B, maskB) * midFade;
}
vec3 nWorld = normalize(inverseTransformDirection(normal, viewMatrix) + vec3(slope.x, 0.0, slope.y));
normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);
`;

export class Regolith {
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(macro: THREE.Texture, extent: number) {
    const grain = cached<Baked>("regolith-grain", () => bake(512, grainTexel, { depth: 1 / GRAIN_TILE }));
    const mid = cached<Baked>("regolith-mid", () => bake(256, midTexel, { depth: 1 / MID_TILE }));
    this.uniforms = {
      uMacro: { value: macro }, uExtent: { value: extent }, uTint: { value: REGOLITH_TINT }, uDetail: { value: 1 },
      uGrain: { value: grain.map }, uGrainN: { value: grain.normalMap }, uGrainOrm: { value: grain.ormMap },
      uMid: { value: mid.map }, uMidN: { value: mid.normalMap }, uMidOrm: { value: mid.ormMap },
      uGrainMean: { value: meanLinear(grain.map) }, uMidMean: { value: meanLinear(mid.map) },
    };
  }

  /** The baked small-scale tiles on or off: they are synthetic detail too. */
  setDetail(on: boolean): void {
    this.uniforms.uDetail.value = on ? 1 : 0;
  }

  /** Material for one terrain mesh; fragments inside `hole` (x0, z0, x1, z1) are discarded. */
  material(hole: THREE.Vector4): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, { uHole: { value: hole } });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
        .replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${DISCARD}`)
        .replace("#include <map_fragment>", FRAGMENT_ALBEDO)
        .replace("#include <roughnessmap_fragment>", FRAGMENT_ROUGHNESS)
        .replace("#include <normal_fragment_maps>", FRAGMENT_NORMAL);
    };
    m.customProgramCacheKey = () => "regolith";
    return m;
  }

  /** Shadow-pass material with the same hole. */
  depthMaterial(hole: THREE.Vector4): THREE.MeshDepthMaterial {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHole = { value: hole };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorld;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform vec4 uHole;\nvarying vec3 vWorld;")
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${DISCARD}`);
    };
    m.customProgramCacheKey = () => "regolith-depth";
    return m;
  }
}
