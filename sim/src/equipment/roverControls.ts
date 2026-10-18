// Rover driving controls: keys + tracked hand -> RoverInput. Pure (no DOM), so it is unit-tested.
// The hand is a two-way throttle: open hand accelerates, fist brakes, anything in between coasts. Steering is
// keyboard-only for now (hand roll is too noisy through a suit glove). W/S override the hand while held.
import type { HandPose } from "../hand/gestures";
import type { RoverInput } from "./rover";

/** The slice of the keyboard the controls read (Input satisfies it). */
export interface KeyState { held(code: string): boolean }
/** The slice of the tracked hand the controls read (TrackedHand satisfies it). */
export interface HandState { active: boolean; pose: HandPose }
/** What the tracked hand is asking the rover to do. */
export type HandCommand = "accelerate" | "brake" | "coast";

const THROTTLE_RAMP_S = 0.4; // an open hand reaches full throttle over this long: a smooth start, no lurch
const STEER_RATE = 6; // 1/s: keys are all-or-nothing, the front wheels swing over in a few hundred ms
const REVERSE_BELOW = 0.05; // m/s: S brakes while rolling forward, reverses once stopped
const REVERSE_THROTTLE = -0.5;

export class RoverControls {
  /** Reused every update: the caller reads it, never keeps it. */
  readonly input: RoverInput = { throttle: 0, brake: 0, steer: 0, boost: false };
  /** The hand's command, or null without fresh tracker frames. */
  command: HandCommand | null = null;
  private handThrottle = 0;

  update(dt: number, keys: KeyState, hand: HandState, speed: number): RoverInput {
    // lost tracking coasts: a stale pose must neither drive nor brake
    this.command = !hand.active ? null : hand.pose === "open" ? "accelerate" : hand.pose === "fist" ? "brake" : "coast";
    // closing the hand cuts the throttle at once; opening it again ramps up from zero
    this.handThrottle = this.command === "accelerate" ? Math.min(1, this.handThrottle + dt / THROTTLE_RAMP_S) : 0;

    const i = this.input;
    const right = keys.held("KeyD") || keys.held("ArrowRight"), left = keys.held("KeyA") || keys.held("ArrowLeft");
    i.steer += ((right ? 1 : 0) - (left ? 1 : 0) - i.steer) * Math.min(1, dt * STEER_RATE);
    i.boost = keys.held("ShiftLeft") || keys.held("ShiftRight");
    if (keys.held("KeyW") || keys.held("ArrowUp")) {
      i.throttle = 1;
      i.brake = 0;
    } else if (keys.held("KeyS") || keys.held("ArrowDown")) {
      const rolling = speed > REVERSE_BELOW;
      i.throttle = rolling ? 0 : REVERSE_THROTTLE;
      i.brake = rolling ? 1 : 0;
    } else {
      // the hand never asks for negative throttle, so a fist stops the rover and holds it
      i.throttle = this.handThrottle;
      i.brake = this.command === "brake" ? 1 : 0;
    }
    return i;
  }
}
