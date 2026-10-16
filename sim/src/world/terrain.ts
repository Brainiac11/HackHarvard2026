// NASA LOLA terrain (built by terrain/build.py). World convention shared with hub/lunarhub/terrain.py:
//   x = col * spacing - extent/2   (+x = grid east)
//   z = row * spacing - extent/2   (row 0 = top of the source raster = grid north = -z)
//   heading_deg: 0 = north (-z), 90 = east (+x), clockwise.
import * as THREE from "three";
import { Detail } from "./detail";

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

export class Terrain {
  readonly n: number;
  readonly spacing: number;
  readonly extent: number;
  detail!: Detail;
  mesh!: THREE.Mesh;

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
  private bilinear(arr: Float32Array, x: number, z: number): number {
    const n = this.n;
    const c = Math.min(Math.max((x + this.extent / 2) / this.spacing, 0), n - 1);
    const r = Math.min(Math.max((z + this.extent / 2) / this.spacing, 0), n - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(c0 + 1, n - 1), r1 = Math.min(r0 + 1, n - 1);
    const fc = c - c0, fr = r - r0;
    const top = arr[r0 * n + c0] * (1 - fc) + arr[r0 * n + c1] * fc;
    const bot = arr[r1 * n + c0] * (1 - fc) + arr[r1 * n + c1] * fc;
    return top * (1 - fr) + bot * fr;
  }

  /** LOLA-derived height only (m above crop minimum). */
  baseHeight(x: number, z: number): number {
    return this.bilinear(this.height, x, z);
  }

  /** Physical surface height: LOLA + synthetic detail (if enabled). */
  heightAt(x: number, z: number): number {
    return this.baseHeight(x, z) + (this.detail ? this.detail.height(x, z) : 0);
  }

  lola(x: number, z: number): { slope: number; err: number; cover: number } {
    const n = this.n;
    const c = Math.round(Math.min(Math.max((x + this.extent / 2) / this.spacing, 0), n - 1));
    const r = Math.round(Math.min(Math.max((z + this.extent / 2) / this.spacing, 0), n - 1));
    return { slope: this.bilinear(this.slope, x, z), err: this.bilinear(this.slopeErr, x, z), cover: this.cover[r * n + c] };
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
  build(scene: THREE.Scene, seed: number, site: { x: number; z: number }): void {
    this.detail = new Detail(seed, this.extent, { x: site.x, z: site.z, r: 30 });
    const geo = new THREE.PlaneGeometry(this.extent, this.extent, this.n - 1, this.n - 1);
    geo.rotateX(-Math.PI / 2);
    const tex = new THREE.TextureLoader().load(this.base + "albedo.png");
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.applyHeights();
    scene.add(this.mesh);
  }

  /** (Re)write vertex heights: LOLA + crater/noise detail (rocks are separate instanced meshes). */
  applyHeights(): void {
    const pos = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = this.n;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const x = pos.getX(i), z = pos.getZ(i);
        pos.setY(i, this.height[i] + this.detail.height(x, z, false));
      }
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}
