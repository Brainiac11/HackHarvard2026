import { describe, expect, it } from "vitest";
import { peakOf } from "./audio";

describe("mic level", () => {
  it("is the loudest sample of a PCM16 chunk, 0..1", () => {
    expect(peakOf(new Int16Array(480))).toBe(0); // a muted or wrong input device: exact zeros
    expect(peakOf(new Int16Array([100, -16384, 3]))).toBe(0.5);
    expect(peakOf(new Int16Array([-32768, 32767]))).toBe(1);
  });
});
