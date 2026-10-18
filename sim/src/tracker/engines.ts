// The phone tracker's engines: MediaPipe on the phone, or one of the laptop GPU models (anyhand.ts). Kept free of the
// DOM so the Engine button's order and the saved-choice migration are unit-tested.
import type { LaptopModel } from "./anyhand";

export type Engine = "phone" | LaptopModel;
export const ENGINES: readonly Engine[] = ["phone", "wilor", "hamer"];

/** The engine a saved choice names; "laptop" is from before HaMeR, when WiLoR was the only laptop model. */
export const savedEngine = (saved: string | null): Engine =>
  saved === "laptop" ? "wilor" : ENGINES.find((e) => e === saved) ?? "phone";

export const otherModel = (m: LaptopModel): LaptopModel => (m === "wilor" ? "hamer" : "wilor");

/**
 * The Engine button: from the phone to the laptop, on whichever model it already serves (`first`, once known: asking
 * for the other would unload the one scripts/dev.sh just loaded), then the other model, then back to the phone. Leaving
 * the phone, it names WiLoR until the laptop says what it serves.
 */
export function nextEngine(e: Engine, first: LaptopModel | null): Engine {
  if (e === "phone") return first ?? "wilor";
  return first === null || e === first ? otherModel(e) : "phone";
}
