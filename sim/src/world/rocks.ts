// Rocks and pebbles. Every stone is one of a few irregular models: an icosphere cut by random planes (fracture faces),
// roughened with noise and fitted to [-1, 1]³, then instanced with its own size, aspect and pose. The material maps a
// baked breccia texture triplanar in world space (no UVs needed), tints each stone by a hash of its position, settles
// dust on upward faces and round the base, and shrinks a stone away once it would be only a few pixels across (in the
// shadow pass too), so distant stones neither shimmer nor pop.
import * as THREE from "three";
import { mergeVertices, toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bake, cached, cells, fbm, frac, hashInt, noise, type Baked, type Texel } from "../gfx/procedural";
import { mulberry32, type Rock } from "./detail";
import { REGOLITH_TINT, sumCells } from "./regolith";

const VARIANTS = 4;
const VARIANT_SEEDS = [11, 23, 37, 41];
const PEBBLE_SEED = 101;
const HI_DETAIL = 9, LO_DETAIL = 2, PEBBLE_DETAIL = 1; // icosphere subdivisions: 2000, 180 and 80 triangles
const HI_RANGE = 30; // m from the focus: rocks this close get the detailed model
const REPARTITION = 6; // m the focus moves before the rock sets are rebuilt
const VIEWER_SLACK = 10; // m the camera may sit from the focus (rover chase cam)
const FADE = [400, 600]; // stones shrink away between these distances, in stone radii (~4 to 2.5 px at 1080p)
const PATCH_FADE = [9, 12.5]; // m from the focus: pebbles fade before the edge of the patch the worker fills
const ROCK_GROUND = 0.1, PEBBLE_GROUND = -1 / 3; // where the ground meets a stone, in model y (dust skirt)
const TILE = 0.9; // m: breccia texture repeat
const CREASE = THREE.MathUtils.degToRad(35); // sharper fracture edges than this keep split normals

/** Trilinear value noise in [-1, 1] (shapes the stones). */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (i: number, j: number, k: number) => hashInt(ix + i, hashInt(iy + j, iz + k, seed), seed) / 4294967296;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (k: number) => lerp(lerp(h(0, 0, k), h(1, 0, k), sx), lerp(h(0, 1, k), h(1, 1, k), sx), sy);
  return lerp(plane(0), plane(1), sz) * 2 - 1;
}

/**
 * An irregular stone: an icosphere fractured by random planes and roughened with noise, fitted to [-1, 1]³, with
 * normals split along the fracture edges (non-indexed).
 */
export function rockGeometry(seed: number, detail: number): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const cuts: number[] = []; // (nx, ny, nz, offset) per fracture plane
  for (let i = 7 + Math.floor(rnd() * 6); i > 0; i--) {
    const y = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - y * y);
    cuts.push(s * Math.cos(a), y, s * Math.sin(a), 0.45 + 0.4 * rnd());
  }
  const sphere = new THREE.IcosahedronGeometry(1, detail).deleteAttribute("normal").deleteAttribute("uv");
  const geo = mergeVertices(sphere);
  sphere.dispose();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1;
    for (let c = 0; c < cuts.length; c += 4) {
      const d = v.x * cuts[c] + v.y * cuts[c + 1] + v.z * cuts[c + 2];
      if (d > cuts[c + 3]) r = Math.min(r, cuts[c + 3] / d);
    }
    r *= 1 + 0.08 * noise3(v.x * 1.8, v.y * 1.8, v.z * 1.8, seed) + 0.03 * noise3(v.x * 5, v.y * 5, v.z * 5, seed + 1)
      + 0.012 * noise3(v.x * 13, v.y * 13, v.z * 13, seed + 2);
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  geo.translate(-(min.x + max.x) / 2, -(min.y + max.y) / 2, -(min.z + max.z) / 2);
  geo.scale(2 / (max.x - min.x), 2 / (max.y - min.y), 2 / (max.z - min.z));
  const creased = toCreasedNormals(geo, CREASE);
  geo.dispose();
  creased.computeBoundingBox();
  creased.computeBoundingSphere();
  return creased;
}


const VESICLES = (d: number, id: number) => (id > 0.9 && d < 0.3 ? 1 - (d / 0.3) ** 2 : 0);

/** Breccia: angular clasts of other lithologies in a fine grey matrix, a few vesicles; heights in metres. */
function brecciaTexel(u: number, v: number, o: Texel): void {
  let grey = 0.5 + 0.07 * fbm(u, v, 5, 31, 3);
  let h = 0.004 * fbm(u, v, 4, 32, 3) + 0.0006 * noise(u, v, 96, 33);
  let rough = 0.86;
  // clasts are Voronoi cells shrunk away from their borders: straight edges, sharp corners
  const a = cells(u, v, 9, 34);
  if (a.id > 0.5 && a.f2 - a.f1 > 0.1) {
    grey += (frac(a.id * 17.3) - 0.45) * 0.32;
    h += 0.0012 * Math.min(1, (a.f2 - a.f1 - 0.1) * 6);
    rough = 0.74;
  } else {
    const b = cells(u, v, 29, 35);
    if (b.id > 0.55 && b.f2 - b.f1 > 0.3) grey += (frac(b.id * 7.1) - 0.5) * 0.2;
  }
  const pit = sumCells(u, v, 43, 36, VESICLES);
  h -= 0.001 * pit;
  grey *= (1 - 0.2 * pit) * (1 + 0.06 * noise(u, v, 160, 37));
  o.r = grey * 1.01; o.g = grey; o.b = grey * 0.96;
  o.height = h; o.rough = rough;
}

/** Where a stone is seen from (fade by on-screen size) and the focus its patch follows (pebbles only). */
interface StoneView { uViewer: { value: THREE.Vector3 }; uFocus: { value: THREE.Vector3 } }
const stoneView = (): StoneView => ({ uViewer: { value: new THREE.Vector3() }, uFocus: { value: new THREE.Vector3() } });

const STONE_UNIFORMS = /* glsl */ `
uniform vec3 uViewer, uFocus;
`;
const STONE_FADE = /* glsl */ `
vec3 stoneCentre = instanceMatrix[3].xyz;
float stoneFade = 1.0 - smoothstep(${FADE[0].toFixed(1)}, ${FADE[1].toFixed(1)},
  distance(stoneCentre, uViewer) / length(instanceMatrix[0].xyz));
#ifdef STONE_PATCH
stoneFade *= 1.0 - smoothstep(${PATCH_FADE[0].toFixed(1)}, ${PATCH_FADE[1].toFixed(1)}, distance(stoneCentre.xz, uFocus.xz));
#endif
transformed *= stoneFade;
`;
const STONE_VARYINGS = /* glsl */ `
varying vec3 vStoneWorld, vStoneTint;
varying float vStoneY;
`;
// lithology by a hash of the position: mostly grey breccia, some dark basalt, a few bright anorthosite blocks
const STONE_VERTEX = /* glsl */ `
vStoneWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
vStoneY = position.y;
float stoneHash = fract(sin(dot(stoneCentre.xz, vec2(12.9898, 78.233))) * 43758.5453);
vStoneTint = stoneHash < 0.2 ? vec3(0.52, 0.51, 0.5) : stoneHash > 0.92 ? vec3(1.18, 1.16, 1.1)
  : vec3(0.75 + 0.35 * fract(stoneHash * 7.0));
`;
const STONE_FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uStone, uStoneN, uStoneOrm;
uniform vec3 uDust;
`;
// triplanar in world space: each axis projection weighted by the normal; detail normals added per axis (UDN blend)
const STONE_SURFACE = /* glsl */ `
vec3 nW = inverseTransformDirection(normal, viewMatrix);
vec3 bw = pow(abs(nW), vec3(4.0));
bw /= bw.x + bw.y + bw.z;
vec3 sp = vStoneWorld * ${(1 / TILE).toFixed(4)};
vec3 tX = texture(uStoneN, sp.zy).xyz * 2.0 - 1.0, tY = texture(uStoneN, sp.xz).xyz * 2.0 - 1.0;
vec3 tZ = texture(uStoneN, sp.xy).xyz * 2.0 - 1.0;
nW = normalize(nW + bw.x * vec3(0.0, tX.y, tX.x) / tX.z + bw.y * vec3(tY.x, 0.0, tY.y) / tY.z
  + bw.z * vec3(tZ.x, tZ.y, 0.0) / tZ.z);
normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
vec3 stoneCol = texture(uStone, sp.zy).rgb * bw.x + texture(uStone, sp.xz).rgb * bw.y + texture(uStone, sp.xy).rgb * bw.z;
float stoneRough = texture(uStoneOrm, sp.zy).g * bw.x + texture(uStoneOrm, sp.xz).g * bw.y
  + texture(uStoneOrm, sp.xy).g * bw.z;
// fines settle on upward faces and are splashed up round the base, thinning upward along a ragged line
float dustLine = STONE_GROUND + 0.3 * stoneCol.g;
float dust = max(0.35 * smoothstep(0.55, 0.95, nW.y), 0.7 * (1.0 - smoothstep(dustLine - 0.1, dustLine, vStoneY)));
diffuseColor.rgb = mix(vStoneTint * stoneCol, uDust, dust);
roughnessFactor = mix(stoneRough, 1.0, dust);
`;

/** Stone material and its shadow-pass twin (same fade). `ground`: model y of the ground line; `patch`: pebbles. */
function stoneMaterials(view: StoneView, ground: number, patch: boolean): [THREE.MeshStandardMaterial, THREE.MeshDepthMaterial] {
  const tex = cached<Baked>("breccia", () => bake(384, brecciaTexel, { depth: 1 / TILE }));
  const defines: Record<string, string> = { STONE_GROUND: ground.toFixed(3) };
  if (patch) defines.STONE_PATCH = "";
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  material.defines = defines;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, view, {
      uStone: { value: tex.map }, uStoneN: { value: tex.normalMap }, uStoneOrm: { value: tex.ormMap },
      uDust: { value: REGOLITH_TINT },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${STONE_UNIFORMS}${STONE_VARYINGS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${STONE_FADE}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${STONE_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${STONE_FRAGMENT_PARS}${STONE_VARYINGS}`)
      .replace("#include <normal_fragment_maps>", STONE_SURFACE);
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.defines = defines;
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, view);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${STONE_UNIFORMS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${STONE_FADE}`);
  };
  return [material, depth];
}

/**
 * The boulders and cobbles of Detail.rocks, each seated so its top is `h` above the rendered ground and its footprint
 * about `r` (what the wheels feel), with a third to a half of it buried. Rocks near the focus use detailed models;
 * the rest, out to where they fade, a coarse one. The sets are rebuilt only when the focus has moved a few metres.
 */
export class Rocks extends THREE.Group {
  private readonly view = stoneView();
  private readonly matrices: Float32Array; // every rock's instance matrix
  private readonly xz: Float32Array;
  private readonly reach2: Float32Array; // squared distance from the focus within which a rock can still be seen
  private readonly variant: Uint8Array;
  private readonly hi: THREE.InstancedMesh[] = [];
  private readonly lo: THREE.InstancedMesh[] = [];
  private readonly centre = new THREE.Vector2(Infinity, Infinity);

  constructor(rocks: readonly Rock[], ground: (x: number, z: number) => number) {
    super();
    const n = rocks.length;
    this.matrices = new Float32Array(n * 16);
    this.xz = new Float32Array(n * 2);
    this.reach2 = new Float32Array(n);
    this.variant = new Uint8Array(n);
    const rnd = mulberry32(0x5eed);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3();
    const s = new THREE.Vector3(), perVariant = new Array<number>(VARIANTS).fill(0);
    rocks.forEach((k, i) => {
      const half = k.h * (1.1 + 0.3 * rnd()); // half-height: the rest of the rock is underground
      q.setFromEuler(e.set(0.25 * (rnd() - 0.5), k.rot, 0.25 * (rnd() - 0.5)));
      s.set(k.r, half, k.r * (0.65 + 0.35 * rnd()));
      p.set(k.x, ground(k.x, k.z) + k.h - half, k.z);
      m.compose(p, q, s).toArray(this.matrices, i * 16);
      this.xz[i * 2] = k.x;
      this.xz[i * 2 + 1] = k.z;
      this.reach2[i] = (FADE[1] * k.r + REPARTITION + VIEWER_SLACK) ** 2;
      perVariant[(this.variant[i] = Math.floor(rnd() * VARIANTS))]++;
    });
    const [material, depth] = stoneMaterials(this.view, ROCK_GROUND, false);
    for (let v = 0; v < VARIANTS; v++) {
      for (const [set, detail] of [[this.hi, HI_DETAIL], [this.lo, LO_DETAIL]] as const) {
        const mesh = new THREE.InstancedMesh(rockGeometry(VARIANT_SEEDS[v], detail), material, perVariant[v]);
        mesh.customDepthMaterial = depth;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false; // spread over the map; the vertex shader already collapses the far ones
        mesh.count = 0;
        set.push(mesh);
        this.add(mesh);
      }
    }
  }

  /** Per frame: the viewer moves the fade; the focus (player or rover) re-partitions the sets every few metres. */
  update(focus: THREE.Vector3, viewer: THREE.Vector3): void {
    this.view.uViewer.value.copy(viewer);
    if (Math.hypot(focus.x - this.centre.x, focus.z - this.centre.y) < REPARTITION) return;
    this.centre.set(focus.x, focus.z);
    for (let v = 0; v < VARIANTS; v++) this.hi[v].count = this.lo[v].count = 0;
    const src = this.matrices;
    for (let i = 0; i < this.reach2.length; i++) {
      const dx = this.xz[i * 2] - focus.x, dz = this.xz[i * 2 + 1] - focus.z, d2 = dx * dx + dz * dz;
      if (d2 > this.reach2[i]) continue;
      const mesh = (d2 < HI_RANGE * HI_RANGE ? this.hi : this.lo)[this.variant[i]];
      const dst = mesh.instanceMatrix.array as Float32Array, o = mesh.count++ * 16;
      for (let k = 0; k < 16; k++) dst[o + k] = src[i * 16 + k];
    }
    for (const mesh of this.children as THREE.InstancedMesh[]) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

/** Pebbles round the focus. The terrain worker writes their matrices (scatter.ts); they fade before the patch edge. */
export class Pebbles extends THREE.InstancedMesh {
  private readonly view: StoneView;

  constructor(capacity: number) {
    const view = stoneView();
    const [material, depth] = stoneMaterials(view, PEBBLE_GROUND, true);
    super(rockGeometry(PEBBLE_SEED, PEBBLE_DETAIL), material, capacity);
    this.view = view;
    this.customDepthMaterial = depth;
    this.castShadow = this.receiveShadow = true;
    this.frustumCulled = false;
    this.count = 0;
    // centimetre stones add no visible contact shading, and the AO pass would draw them without their size fade
    // (it replaces the material): faint dark specks where the faded pebbles 12-15 m out no longer show
    this.userData.skipAO = true;
  }

  follow(focus: THREE.Vector3, viewer: THREE.Vector3): void {
    this.view.uFocus.value.copy(focus);
    this.view.uViewer.value.copy(viewer);
  }
}
