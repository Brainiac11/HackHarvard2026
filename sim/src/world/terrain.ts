// NASA LOLA terrain (built by terrain/build.py). World convention shared with hub/lunarhub/terrain.py:
//   x = col * spacing - extent/2   (+x = grid east)
//   z = row * spacing - extent/2   (row 0 = top of the source raster = grid north = -z)
//   heading_deg: 0 = north (-z), 90 = east (+x), clockwise.
// Rendering: a clipmap of nested grids around the player (clipmap.ts), filled by a worker from the same LOLA grid and
// seeded detail the physics samples, over a static full-map mesh; the worker also scatters pebbles over the finest one.
import * as THREE from "three";
import {
  cutUnder, FAR_QUADS, gridIndices, indexBuffer, levelSpacing, LEVELS, QUADS, RECENTRE, snapOrigin,
  type CutJob, type Indices, type LevelBuffers, type LevelGrid, type LevelJob, type WorkerReply, type WorkerRequest,
} from "./clipmap";
import { AO_FAR_M } from "../gfx/post";
import { Detail } from "./detail";
import { bilinear } from "./heightfield";
import { Regolith } from "./regolith";
import { Pebbles } from "./rocks";
import { pebbleCapacity } from "./scatter";

export interface TerrainMeta {
  site: string;
  site_name: string;
  grid: number;
  spacing_m: number;
  extent_m: number;
  elev_offset_m: number;
  height_range_m: number;
  coverage_fraction: number;
  corners: Record<"nw" | "ne" | "sw" | "se" | "center", { lat: number; lon: number }>;
  src: { overview_box_uv: number[] };
  provenance: { dataset: string; citation: string };
}

async function fetchArray(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

const HOLE_OVERLAP = 0.02; // m: a coarse level keeps drawing this far into the finer one (plus two pixels, regolith.ts)

/** One clipmap level (or the far mesh, last): its mesh, what it shows and the finer level's footprint it skips. */
interface Level {
  mesh: THREE.Mesh;
  grid: LevelGrid;
  hole: THREE.Vector4;
  morph: boolean;
  spare: LevelBuffers | null; // buffers swapped out last time, handed back to the worker to refill
  spareIndices: Indices | null; // likewise for its index buffer
}

export class Terrain {
  readonly n: number;
  readonly spacing: number;
  readonly extent: number;
  detail!: Detail;
  private readonly levels: Level[] = [];
  private regolith!: Regolith;
  private pebbles!: Pebbles;
  private pebbleSpare: Float32Array | null = null;
  private worker!: Worker;
  private inFlight = false;
  private reply: WorkerReply | null = null;
  private stale = false; // detail toggled: refill every level

  private constructor(
    readonly base: string,
    readonly meta: TerrainMeta,
    readonly height: Float32Array,
    readonly slope: Float32Array,
    readonly slopeErr: Float32Array,
    readonly cover: Uint8Array,
  ) {
    this.n = meta.grid;
    this.spacing = meta.spacing_m;
    this.extent = meta.extent_m;
  }

  static async load(site = "site04"): Promise<Terrain> {
    const base = `/terrain/${site}/`;
    const meta: TerrainMeta = await (await fetch(base + "meta.json")).json();
    const [h, s, e, c] = await Promise.all(
      ["height.f32", "slope.f32", "slperr.f32", "cover.u8"].map((f) => fetchArray(base + f)),
    );
    return new Terrain(base, meta, new Float32Array(h), new Float32Array(s), new Float32Array(e), new Uint8Array(c));
  }

  // ------------------------------------------------------------------ sampling
  /** LOLA-derived height only (m above crop minimum). */
  baseHeight(x: number, z: number): number {
    return bilinear(this.height, this.n, this.spacing, this.extent, x, z);
  }

  /** Physical surface height: LOLA + synthetic detail (if enabled). */
  heightAt(x: number, z: number): number {
    return this.baseHeight(x, z) + (this.detail ? this.detail.height(x, z) : 0);
  }

  /** The rendered ground: heightAt without the rocks (they are separate meshes). */
  groundAt(x: number, z: number): number {
    return this.baseHeight(x, z) + this.detail.height(x, z, false);
  }

  lola(x: number, z: number): { slope: number; err: number; cover: number } {
    const n = this.n;
    const c = Math.round(Math.min(Math.max((x + this.extent / 2) / this.spacing, 0), n - 1));
    const r = Math.round(Math.min(Math.max((z + this.extent / 2) / this.spacing, 0), n - 1));
    return {
      slope: bilinear(this.slope, n, this.spacing, this.extent, x, z),
      err: bilinear(this.slopeErr, n, this.spacing, this.extent, x, z), cover: this.cover[r * n + c],
    };
  }

  latlon(x: number, z: number): { lat: number; lon: number } {
    const u = (x + this.extent / 2) / this.extent, v = (z + this.extent / 2) / this.extent;
    const k = this.meta.corners;
    const unwrap = (lon: number) => k.nw.lon + ((((lon - k.nw.lon + 180) % 360) + 360) % 360) - 180;
    const lerp = (a: number, b: number, c: number, d: number) => (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    const lat = lerp(k.nw.lat, k.ne.lat, k.sw.lat, k.se.lat);
    const lon = lerp(k.nw.lon, unwrap(k.ne.lon), unwrap(k.sw.lon), unwrap(k.se.lon));
    return { lat, lon: ((lon % 360) + 360) % 360 };
  }

  inside(x: number, z: number, margin = 0): boolean {
    const h = this.extent / 2 - margin;
    return x >= -h && x <= h && z >= -h && z <= h;
  }

  /** Flattest square patch (by LOLA slope) near the centre: where the work site goes. */
  findFlatSite(size = 30, searchRadius = 350, step = 10): { x: number; z: number } {
    let best = { x: 0, z: 0, score: Infinity };
    for (let x = -searchRadius; x <= searchRadius; x += step) {
      for (let z = -searchRadius; z <= searchRadius; z += step) {
        let sum = 0, max = 0, count = 0;
        for (let dx = -size / 2; dx <= size / 2; dx += 3) {
          for (let dz = -size / 2; dz <= size / 2; dz += 3) {
            const s = this.lola(x + dx, z + dz).slope;
            sum += s; max = Math.max(max, s); count++;
          }
        }
        const score = sum / count + 0.3 * max + 0.002 * Math.hypot(x, z);
        if (score < best.score) best = { x, z, score };
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ rendering
  /** Build the meshes and wait for the worker's first fill around `site` (craters and rocks keep 30 m clear of it). */
  async build(scene: THREE.Scene, seed: number, site: { x: number; z: number }): Promise<void> {
    const exclusion = { x: site.x, z: site.z, r: 30 };
    this.detail = new Detail(seed, this.extent, exclusion);
    this.worker = new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" });
    this.worker.postMessage({
      t: "init", lola: this.height, n: this.n, spacing: this.spacing, extent: this.extent, seed, exclusion,
    } satisfies WorkerRequest);
    const first = new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        this.reply = e.data;
        resolve();
      };
      this.worker.onerror = (e) => reject(new Error(`terrain worker: ${e.message}`)); // fails the loading screen
    });

    for (let l = 0; l <= LEVELS; l++) {
      const far = l === LEVELS, quads = far ? FAR_QUADS : QUADS, spacing = levelSpacing(this.extent, l);
      const count = (quads + 1) ** 2;
      const geo = new THREE.BufferGeometry();
      const indices = indexBuffer(quads);
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.setDrawRange(0, l === 0 ? gridIndices(quads, indices) : 0); // the others are cut round their child (apply)
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute("terrainAlbedo", new THREE.BufferAttribute(new Float32Array(count), 1));
      geo.boundingSphere = new THREE.Sphere();
      this.levels.push({ mesh: new THREE.Mesh(geo), grid: { x0: NaN, z0: NaN, spacing, quads },
        hole: new THREE.Vector4(1, 1, -1, -1), morph: !far, spare: null, spareIndices: null });
    }
    const fine = this.levels[0].grid;
    this.pebbles = new Pebbles(pebbleCapacity(fine.quads * fine.spacing));
    scene.add(this.pebbles);
    this.schedule(site.x, site.z); // the worker fills while the textures bake

    const macro = new THREE.TextureLoader().load(this.base + "albedo.png");
    macro.colorSpace = THREE.SRGBColorSpace;
    macro.flipY = false; // row 0 is north (-z), which the shader samples at v = 0
    macro.anisotropy = 8;
    this.regolith = new Regolith(macro, this.extent);
    this.levels.forEach((lv, l) => {
      // Levels whose ground starts beyond AO_FAR_M from the player (their child's half-width, less how far it lags
      // behind before re-centring), where the AO term has faded to nothing, stay out of the AO pass: level 4 and the
      // far mesh, about a third of its triangles. (Level 3 starts at 56 m, where AO still has 3% of its strength.)
      const child = l > 0 ? levelSpacing(this.extent, l - 1) : 0;
      if (l > 0 && (QUADS / 2 - RECENTRE - 1) * child >= AO_FAR_M) lv.mesh.userData.skipAO = true;
      lv.mesh.material = this.regolith.material(lv.hole);
      lv.mesh.customDepthMaterial = this.regolith.depthMaterial(lv.hole);
      lv.mesh.castShadow = lv.mesh.receiveShadow = true;
      // after the other opaques (three sorts them by material otherwise, and the regolith's are made first): the
      // costliest shader then fails the depth test under the press, the rover, rocks and pebbles instead of being
      // shaded there and drawn over
      lv.mesh.renderOrder = 1;
      scene.add(lv.mesh);
    });
    await first;
    this.update(new THREE.Vector3(site.x, 0, site.z), new THREE.Vector3(site.x, 0, site.z));
  }

  /** Synthetic detail on/off (F). Physics follows at once; the meshes refill within a few frames. */
  setDetail(enabled: boolean): void {
    this.detail.enabled = enabled;
    this.regolith.setDetail(enabled);
    this.pebbles.visible = enabled;
    this.stale = true;
  }

  /**
   * Per frame: swap in finished levels and re-centre the ones the focus (the player or rover) has moved away from.
   * The viewer (camera) sets how far pebbles stay visible.
   */
  update(focus: THREE.Vector3, viewer: THREE.Vector3): void {
    if (this.reply) {
      this.apply(this.reply);
      this.reply = null;
      this.inFlight = false;
    }
    this.schedule(focus.x, focus.z);
    this.pebbles.follow(focus, viewer);
  }

  private schedule(x: number, z: number): void {
    if (this.inFlight) return; // one batch at a time keeps every level consistent with its neighbours
    const jobs: LevelJob[] = [], cuts: CutJob[] = [];
    const transfer: ArrayBuffer[] = [];
    const grids = this.levels.map((lv) => lv.grid); // where the levels will be once this batch lands
    for (let l = LEVELS; l >= 0; l--) { // coarse first, so a parent is never behind its child
      const lv = this.levels[l], g = lv.grid, s = g.spacing;
      const x0 = lv.morph ? snapOrigin(x, s, g.quads, this.extent) : -this.extent / 2;
      const z0 = lv.morph ? snapOrigin(z, s, g.quads, this.extent) : -this.extent / 2;
      const moved = !(Math.abs(x0 - g.x0) < RECENTRE * s && Math.abs(z0 - g.z0) < RECENTRE * s);
      if (!moved && !this.stale) continue;
      grids[l] = { x0, z0, spacing: s, quads: g.quads };
      jobs.push({ ...grids[l], level: l, morph: lv.morph, buffers: lv.spare ?? undefined });
      if (lv.spare) transfer.push(lv.spare.pos.buffer as ArrayBuffer, lv.spare.nrm.buffer as ArrayBuffer,
        lv.spare.alb.buffer as ArrayBuffer);
      lv.spare = null;
    }
    this.stale = false;
    if (!jobs.length) return;
    for (let l = 1; l <= LEVELS; l++) { // re-cut every level that moved or whose child did
      const lv = this.levels[l];
      if (grids[l] === lv.grid && grids[l - 1] === this.levels[l - 1].grid) continue;
      cuts.push({ level: l, quads: grids[l].quads, cut: cutUnder(grids[l], grids[l - 1]),
        indices: lv.spareIndices ?? undefined });
      if (lv.spareIndices) transfer.push(lv.spareIndices.buffer as ArrayBuffer);
      lv.spareIndices = null;
    }
    let pebbles: Float32Array | undefined;
    if (jobs.some((j) => j.level === 0) && this.pebbleSpare) {
      pebbles = this.pebbleSpare;
      transfer.push(pebbles.buffer as ArrayBuffer);
      this.pebbleSpare = null;
    }
    this.inFlight = true;
    this.worker.postMessage({ t: "build", enabled: this.detail.enabled, jobs, cuts, pebbles } satisfies WorkerRequest,
      transfer);
  }

  private apply(reply: WorkerReply): void {
    if (reply.pebbles) {
      const im = this.pebbles.instanceMatrix;
      this.pebbleSpare = im.array as Float32Array;
      im.array = reply.pebbles.matrices;
      im.clearUpdateRanges();
      im.addUpdateRange(0, reply.pebbles.count * 16);
      im.needsUpdate = true;
      this.pebbles.count = reply.pebbles.count;
    }
    for (const r of reply.results) {
      const lv = this.levels[r.level], geo = lv.mesh.geometry;
      const pos = geo.getAttribute("position") as THREE.BufferAttribute;
      const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
      const alb = geo.getAttribute("terrainAlbedo") as THREE.BufferAttribute;
      lv.spare = { pos: pos.array as Float32Array, nrm: nrm.array as Float32Array, alb: alb.array as Float32Array };
      pos.array = r.buffers.pos;
      nrm.array = r.buffers.nrm;
      alb.array = r.buffers.alb;
      pos.needsUpdate = nrm.needsUpdate = alb.needsUpdate = true;
      lv.grid = { x0: r.x0, z0: r.z0, spacing: r.spacing, quads: r.quads };
      lv.mesh.position.set(r.x0, 0, r.z0);
      const half = (r.quads * r.spacing) / 2;
      geo.boundingSphere!.center.set(half, (r.minY + r.maxY) / 2, half);
      geo.boundingSphere!.radius = Math.hypot(half, half, (r.maxY - r.minY) / 2);
      if (lv.morph) {
        const e = HOLE_OVERLAP;
        this.levels[r.level + 1].hole.set(r.x0 + e, r.z0 + e, r.x0 + 2 * half - e, r.z0 + 2 * half - e);
      }
    }
    for (const c of reply.cuts) {
      const lv = this.levels[c.level], geo = lv.mesh.geometry, index = geo.index!;
      lv.spareIndices = index.array as Indices;
      index.array = c.indices;
      index.clearUpdateRanges();
      index.addUpdateRange(0, c.count);
      index.needsUpdate = true;
      geo.setDrawRange(0, c.count);
    }
  }
}
