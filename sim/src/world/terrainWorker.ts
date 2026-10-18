// Terrain worker: fills and re-indexes clipmap levels (clipmap.ts) and scatters pebbles (scatter.ts) off the main
// thread, so re-centring the near-field terrain never hitches a frame. It rebuilds the same seeded Detail as the main
// thread, so meshes match terrain.heightAt.
import {
  fillLevel, gridIndices, indexBuffer, type CutResult, type LevelResult, type WorkerReply, type WorkerRequest,
} from "./clipmap";
import { Detail } from "./detail";
import { bilinear } from "./heightfield";
import { pebbleAbundance, pebbleCapacity, scatterPebbles } from "./scatter";

const scope = self as unknown as Worker;
let detail: Detail;
let seed: number;
let ground: (x: number, z: number) => number;
let abundance: (x: number, z: number) => number;
const albedo = (x: number, z: number) => detail.albedo(x, z);

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.t === "init") {
    const { lola, n, spacing, extent, exclusion } = m;
    seed = m.seed;
    detail = new Detail(seed, extent, exclusion);
    ground = (x, z) => bilinear(lola, n, spacing, extent, x, z) + detail.height(x, z, false);
    abundance = (x, z) => pebbleAbundance(detail, exclusion, x, z);
    return;
  }
  detail.enabled = m.enabled;
  const transfer: ArrayBuffer[] = [];
  const results = m.jobs.map((job): LevelResult => {
    const count = (job.quads + 1) ** 2;
    const buffers = job.buffers ?? { pos: new Float32Array(count * 3), nrm: new Float32Array(count * 3), alb: new Float32Array(count) };
    const { minY, maxY } = fillLevel(job, job.morph, ground, albedo, buffers);
    transfer.push(buffers.pos.buffer as ArrayBuffer, buffers.nrm.buffer as ArrayBuffer, buffers.alb.buffer as ArrayBuffer);
    return { level: job.level, x0: job.x0, z0: job.z0, spacing: job.spacing, quads: job.quads, buffers, minY, maxY };
  });
  const cuts = m.cuts.map((job): CutResult => {
    const indices = job.indices ?? indexBuffer(job.quads);
    transfer.push(indices.buffer as ArrayBuffer);
    return { level: job.level, indices, count: gridIndices(job.quads, indices, job.cut) };
  });
  let pebbles: WorkerReply["pebbles"];
  const fine = m.jobs.find((job) => job.level === 0);
  if (fine) {
    const size = fine.quads * fine.spacing;
    const matrices = m.pebbles ?? new Float32Array(pebbleCapacity(size) * 16);
    const count = m.enabled ? scatterPebbles(fine.x0, fine.z0, size, seed, ground, abundance, matrices) : 0;
    pebbles = { matrices, count };
    transfer.push(matrices.buffer as ArrayBuffer);
  }
  scope.postMessage({ t: "built", results, cuts, pebbles } satisfies WorkerReply, transfer);
};
