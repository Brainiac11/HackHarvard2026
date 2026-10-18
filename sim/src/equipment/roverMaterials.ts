// Rover PBR materials, baked once from tileable noise (gfx/procedural): no image assets. One texture tile spans
// TILE[name] metres; roverMesh box-projects UVs at that scale, so merged parts share one texel density. Everything
// carries some lunar dust: it greys paint and foil and dulls bare metal, which is what sells the scale.
import * as THREE from "three";
import { bake, cached, cells, clamp01, fbm, frac, hash01, mix, noise, ridged, smooth, type Baked, type Texel }
  from "../gfx/procedural";

export type RoverMaterialName =
  "aluminium" | "paint" | "foil" | "mirror" | "fabric" | "dark" | "floor" | "titanium" | "wire" | "dish";
export type RoverMaterials = Record<RoverMaterialName, THREE.MeshStandardMaterial>;

/** Metres per texture tile (box-projected parts). wire and dish use their own (lathe) UVs instead. */
export const TILE: Record<RoverMaterialName, number> = {
  aluminium: 0.3, paint: 0.5, foil: 0.35, mirror: 0.2, fabric: 0.16, dark: 0.2, floor: 0.4, titanium: 0.12,
  wire: 1, dish: 1,
};

const mod = (a: number, p: number) => ((a % p) + p) % p;

/** Value noise in [0, 1] with separate cell counts along u and v: brushed-metal streaks run along u. Tiles. */
function streaks(u: number, v: number, su: number, sv: number, seed: number): number {
  const x = u * su, y = v * sv, ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash01(mod(ix + i, su), mod(iy + j, sv), seed);
  const a = h(0, 0), b = h(1, 0), c = h(0, 1), d = h(1, 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Dust coverage 0..1: a thin film everywhere, thicker in soft drifts, with fine specks; `amount` 0 (clean) ..
 * 1 (caked). Even and low-contrast: hard-edged patches read as camouflage, not dust.
 */
function dustCover(u: number, v: number, seed: number, amount: number): number {
  const drift = smooth(0.35, 0.85, fbm(u, v, 4, seed, 5) * 0.5 + 0.5);
  const speck = smooth(0.6, 0.95, noise(u, v, 48, seed + 1) * 0.5 + 0.5);
  return clamp01(amount * (0.35 + 0.5 * drift + 0.3 * speck));
}

/** Lunar fines over a texel: grey-brown, matte, no longer metallic, and a little proud of the surface. */
function dusty(o: Texel, d: number): void {
  o.r = mix(o.r, 0.53, d);
  o.g = mix(o.g, 0.51, d);
  o.b = mix(o.b, 0.48, d);
  o.rough = mix(o.rough, 0.95, d);
  o.metal = mix(o.metal, 0.05, d);
  o.height += d * 0.15;
}

function aluminium(u: number, v: number, o: Texel): void {
  const s = streaks(u, v, 3, 128, 1) * 0.6 + streaks(u, v, 7, 64, 2) * 0.4;
  const scratch = smooth(0.9, 0.97, ridged(u, v, 5, 3, 3));
  const base = 0.72 + 0.08 * s + 0.08 * scratch;
  o.r = base; o.g = base; o.b = base * 1.02;
  o.metal = 1;
  o.rough = 0.28 + 0.12 * s + 0.15 * scratch;
  o.height = 0.15 * s - 0.3 * scratch;
  dusty(o, dustCover(u, v, 9, 0.3));
}

function paint(u: number, v: number, o: Texel): void {
  const peel = noise(u, v, 48, 4) * 0.6 + noise(u, v, 96, 5) * 0.4; // orange peel
  const grime = fbm(u, v, 4, 6, 4);
  const scuff = smooth(0.9, 0.97, ridged(u, v, 4, 7, 4));
  const c = 0.86 + 0.03 * grime - 0.12 * scuff;
  o.r = c; o.g = c; o.b = c * 0.99;
  o.rough = 0.5 + 0.1 * grime + 0.25 * scuff;
  o.metal = 0;
  o.height = 0.04 * peel - 0.25 * scuff;
  dusty(o, dustCover(u, v, 8, 0.35));
}

/** Aluminised Kapton multi-layer insulation: crumpled gold foil, quilted with tag pins. */
function foil(u: number, v: number, o: Texel): void {
  const fine = ridged(u, v, 10, 11, 4), folds = ridged(u, v, 3, 12, 3);
  const lit = 0.72 + 0.45 * (fine - 0.55) + 0.25 * (folds - 0.5);
  o.r = 0.96 * lit; o.g = 0.72 * lit; o.b = 0.32 * lit;
  o.metal = 1;
  o.rough = 0.14 + 0.24 * (1 - fine);
  o.height = 0.55 * fine + 0.9 * folds;
  o.ao = 0.75 + 0.25 * fine;
  const pin = Math.hypot(frac(u * 3) - 0.5, frac(v * 3) - 0.5);
  if (pin < 0.03) {
    o.r = 0.25; o.g = 0.2; o.b = 0.12; o.metal = 0.2; o.rough = 0.5;
    o.height = 1.6 - pin * 20;
  }
  dusty(o, dustCover(u, v, 13, 0.15) * 0.6);
}

/** Second-surface mirror radiator: 2.5 cm optical solar reflector tiles in a grout grid, specks of dust. */
function mirror(u: number, v: number, o: Texel): void {
  const n = 8, gx = frac(u * n), gy = frac(v * n);
  const seam = 1 - smooth(0.03, 0.07, Math.min(gx, 1 - gx, gy, 1 - gy));
  const id = hash01(Math.floor(u * n), Math.floor(v * n), 21);
  o.r = mix(0.93, 0.22, seam); o.g = mix(0.94, 0.22, seam); o.b = mix(0.96, 0.24, seam);
  o.metal = 1 - seam;
  o.rough = mix(0.03 + 0.05 * id, 0.7, seam);
  o.height = -seam;
  o.ao = 1 - 0.5 * seam;
  const c = cells(u, v, 40, 22);
  const speck = c.id < 0.35 ? 1 - smooth(0.04, 0.12, c.f1) : 0;
  dusty(o, Math.max(speck * 0.85, dustCover(u, v, 23, 0.12) * 0.5));
}

/** Nylon seat webbing (also reads as beta-cloth bags and belts): an over-under basket weave of 2 cm straps. */
function fabric(u: number, v: number, o: Texel): void {
  const n = 8, s = u * n, t = v * n, i = Math.floor(s), j = Math.floor(t);
  const acrossH = Math.abs(t - j - 0.5) * 2, acrossV = Math.abs(s - i - 0.5) * 2; // 0 strap centre .. 1 gap
  const W = 0.84, inH = acrossH < W, inV = acrossV < W, hOnTop = (i + j) % 2 === 0;
  const round = (a: number) => Math.sqrt(1 - (a / W) ** 2);
  const threads = (x: number) => 0.5 + 0.5 * Math.sin(x * Math.PI * 2 * 7);
  let h = 0, thread = 0.5;
  if (inH && (hOnTop || !inV)) {
    h = (hOnTop ? 0.6 : 0.35) + 0.4 * round(acrossH);
    thread = threads(t);
  } else if (inV) {
    h = (hOnTop ? 0.35 : 0.6) + 0.4 * round(acrossV);
    thread = threads(s);
  }
  const c = h > 0 ? 0.84 + 0.06 * thread + 0.04 * noise(u, v, 32, 31) : 0.3;
  o.r = c; o.g = c; o.b = c;
  o.rough = 0.88;
  o.metal = 0;
  o.height = h;
  o.ao = h > 0 ? 0.7 + 0.3 * Math.min(1, h) : 0.35;
  dusty(o, dustCover(u, v, 32, 0.28));
}

function dark(u: number, v: number, o: Texel): void {
  const n = fbm(u, v, 8, 41, 3);
  const c = 0.075 + 0.02 * n;
  o.r = c; o.g = c; o.b = c * 1.05;
  o.rough = 0.5 + 0.15 * n;
  o.metal = 0.1;
  o.height = 0.1 * n;
  dusty(o, dustCover(u, v, 42, 0.3) * 0.8);
}

/** Beaded floor panel: stiffening beads, a riveted seam, and a lot of trampled-in dust. */
function floor(u: number, v: number, o: Texel): void {
  const d = Math.abs(frac(v * 4) - 0.5) / 0.22;
  const bead = d < 1 ? Math.sqrt(1 - d * d) : 0;
  const edge = Math.min(u, 1 - u);
  const seam = 1 - smooth(0.004, 0.012, edge);
  const rivet = Math.hypot(edge - 0.03, (frac(v * 16) - 0.5) / 16) < 0.008 ? 1 : 0;
  const c = 0.68 + 0.06 * bead - 0.3 * seam;
  o.r = c; o.g = c; o.b = c * 1.02;
  o.metal = 0.9;
  o.rough = 0.42 + 0.1 * noise(u, v, 16, 52);
  o.height = bead + 0.6 * rivet - seam;
  o.ao = 0.8 + 0.2 * bead;
  dusty(o, dustCover(u, v, 51, 0.55));
}

function titanium(u: number, v: number, o: Texel): void {
  const s = streaks(u, v, 2, 64, 61);
  const c = 0.5 + 0.08 * s;
  o.r = c; o.g = c * 0.99; o.b = c * 0.96;
  o.metal = 0.9;
  o.rough = 0.36 + 0.1 * s;
  o.height = 0.2 * s;
  dusty(o, dustCover(u, v, 62, 0.45));
}

/**
 * Woven piano-wire tyre mesh: 4x4 diamond cells of two wire families in a plain over-under weave. Returns the
 * wire coverage (the alpha) and fills the texel; the holes are cut by alphaTest.
 */
function wire(u: number, v: number, o: Texel): number {
  const a = (u + v) * 4, b = (u - v) * 4; // two diagonal families, integer counts per tile so they wrap
  const da = Math.abs(frac(a) - 0.5), db = Math.abs(frac(b) - 0.5); // distance to each wire centreline
  const w = 0.13;
  // along a wire the height alternates over/under at each crossing, opposite in phase to the crossing wire
  const ka = Math.floor(a), kb = Math.floor(b);
  const ha = 0.5 * (kb % 2 === 0 ? 1 : -1) * Math.cos(Math.PI * (frac(b) - 0.5)) * (ka % 2 === 0 ? 1 : -1);
  const hb = -0.5 * (ka % 2 === 0 ? 1 : -1) * Math.cos(Math.PI * (frac(a) - 0.5)) * (kb % 2 === 0 ? 1 : -1);
  const ina = da < w ? ha + 0.4 * Math.sqrt(1 - (da / w) ** 2) : -9;
  const inb = db < w ? hb + 0.4 * Math.sqrt(1 - (db / w) ** 2) : -9;
  const h = Math.max(ina, inb);
  if (h < -1) {
    o.height = -1;
    o.r = o.g = o.b = 0.1;
    return 0;
  }
  const lit = 0.72 + 0.28 * clamp01(h + 0.5);
  o.r = 0.7 * lit; o.g = 0.7 * lit; o.b = 0.68 * lit;
  o.metal = 0.85;
  o.rough = 0.42;
  o.height = h;
  o.ao = 0.55 + 0.45 * clamp01(h + 0.5);
  dusty(o, dustCover(u, v, 71, 0.35) * 0.7);
  const edge = Math.max(da < w ? 1 - da / w : 0, db < w ? 1 - db / w : 0);
  return smooth(0, 0.35, edge);
}

/** Bake a texture whose texel function also returns an alpha (wire mesh): written into the colour map. */
function bakeWithAlpha(size: number, texel: (u: number, v: number, o: Texel) => number, depth: number): Baked {
  const alpha = new Uint8Array(size * size);
  const baked = bake(size, (u, v, o) => {
    alpha[Math.floor(v * size) * size + Math.floor(u * size)] = Math.round(texel(u, v, o) * 255);
  }, { depth });
  const data = baked.map.image.data as Uint8Array;
  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
  return baked;
}

function pbr(b: Baked, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: b.map, normalMap: b.normalMap, roughnessMap: b.ormMap, metalnessMap: b.ormMap, aoMap: b.ormMap,
    roughness: 1, metalness: 1, vertexColors: true, ...extra,
  });
}

/**
 * The rover's materials. Textures are baked once per page and shared; metals reflect the scene's environment map (the
 * sky's sunlit-regolith bounce).
 */
export function roverMaterials(): RoverMaterials {
  const t = cached("rover.textures", () => ({
    aluminium: bake(256, aluminium, { depth: 0.004 }),
    paint: bake(256, paint, { depth: 0.002 }),
    foil: bake(512, foil, { depth: 0.012 }),
    mirror: bake(256, mirror, { depth: 0.004 }),
    fabric: bake(256, fabric, { depth: 0.02 }),
    dark: bake(128, dark, { depth: 0.004 }),
    floor: bake(256, floor, { depth: 0.012 }),
    titanium: bake(128, titanium, { depth: 0.006 }),
    wire: bakeWithAlpha(256, wire, 0.03),
  }));
  const meshed = { side: THREE.DoubleSide, alphaTest: 0.4, alphaToCoverage: true } as const;
  return {
    aluminium: pbr(t.aluminium),
    paint: pbr(t.paint),
    foil: pbr(t.foil, { normalScale: new THREE.Vector2(1.2, 1.2) }),
    mirror: pbr(t.mirror, { envMapIntensity: 1.4 }),
    fabric: pbr(t.fabric),
    dark: pbr(t.dark),
    floor: pbr(t.floor),
    titanium: pbr(t.titanium),
    wire: pbr(t.wire, { ...meshed, vertexColors: false }),
    dish: pbr(t.wire, { ...meshed, vertexColors: false, color: 0xf0d9a0 }),
  };
}
