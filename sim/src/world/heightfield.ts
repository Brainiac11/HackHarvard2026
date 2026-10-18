// LOLA grid sampling, shared by the main thread (physics, telemetry) and the terrain worker (meshes).

/** Bilinear sample of a row-major n×n grid (row index along +z) centred on the origin; clamps at the edges. */
export function bilinear(arr: Float32Array, n: number, spacing: number, extent: number, x: number, z: number): number {
  const c = Math.min(Math.max((x + extent / 2) / spacing, 0), n - 1);
  const r = Math.min(Math.max((z + extent / 2) / spacing, 0), n - 1);
  const c0 = Math.floor(c), r0 = Math.floor(r);
  const c1 = Math.min(c0 + 1, n - 1), r1 = Math.min(r0 + 1, n - 1);
  const fc = c - c0, fr = r - r0;
  const top = arr[r0 * n + c0] * (1 - fc) + arr[r0 * n + c1] * fc;
  const bot = arr[r1 * n + c0] * (1 - fc) + arr[r1 * n + c1] * fc;
  return top * (1 - fr) + bot * fr;
}
