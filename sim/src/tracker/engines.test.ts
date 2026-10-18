import { describe, expect, it } from "vitest";
import { nextEngine, savedEngine } from "./engines";

describe("tracker engines", () => {
  it("goes phone -> the laptop's model -> its other model -> phone", () => {
    expect(nextEngine("hamer", "hamer")).toBe("wilor"); // the laptop came up on HaMeR (dev.sh --hamer)
    expect(nextEngine("wilor", "hamer")).toBe("phone");
    expect(nextEngine("wilor", "wilor")).toBe("hamer");
    expect(nextEngine("hamer", "wilor")).toBe("phone");
  });

  it("leaves the phone before the laptop says what it serves", () => {
    expect(nextEngine("phone", null)).toBe("wilor");
    expect(nextEngine("wilor", null)).toBe("hamer"); // tapped again before it answered: the other model
  });

  it("restores a saved choice and migrates the pre-HaMeR 'laptop' to WiLoR", () => {
    expect(savedEngine("laptop")).toBe("wilor");
    expect(savedEngine("hamer")).toBe("hamer");
    expect(savedEngine("phone")).toBe("phone");
    expect(savedEngine(null)).toBe("phone");
    expect(savedEngine("anyhand")).toBe("phone"); // never stored by any version: start safe
  });
});
