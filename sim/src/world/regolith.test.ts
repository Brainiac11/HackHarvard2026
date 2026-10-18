import { describe, expect, it } from "vitest";
import { sumCells } from "./regolith";

describe("regolith cell features", () => {
  // like the craters: on half the points only, sized by id, up to 0.9 cells wide (wider than many a cell's border gap)
  const bump = (d: number, id: number) => {
    const w = 0.4 + id;
    return id < 0.5 && d < w ? (1 - d / w) ** 2 : 0;
  };

  it("are continuous across cell borders (no feature is clipped to its own cell)", () => {
    let worst = 0;
    for (let v = 0.05; v < 1; v += 0.1) {
      for (let u = 0; u < 0.999; u += 1e-4) worst = Math.max(worst, Math.abs(sumCells(u + 1e-4, v, 8, 3, bump) - sumCells(u, v, 8, 3, bump)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("tile", () => {
    for (const v of [0.13, 0.5, 0.91]) expect(sumCells(0, v, 8, 3, bump)).toBeCloseTo(sumCells(1 - 1e-12, v, 8, 3, bump), 6);
  });
});
