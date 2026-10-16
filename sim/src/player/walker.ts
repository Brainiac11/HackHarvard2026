import * as THREE from "three";
import type { Input } from "../input/keyboard";

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 2.2; // lunar lope
const RUN_SPEED = 4.5;
const MOUSE_SENS = 0.0022;

/** First-person astronaut on foot. Owns camera yaw/pitch; eye height follows the terrain. */
export class Walker {
  readonly position = new THREE.Vector3();
  yaw = 0; // rad, 0 = looking north (-z), positive = turn right (clockwise)
  pitch = -0.15;

  constructor(private camera: THREE.PerspectiveCamera, private ground: (x: number, z: number) => number,
              private inside: (x: number, z: number) => boolean) {}

  place(x: number, z: number, yaw: number): void {
    this.position.set(x, this.ground(x, z) + EYE_HEIGHT, z);
    this.yaw = yaw;
  }

  look(input: Input): void {
    this.yaw += input.mouseDX * MOUSE_SENS;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.mouseDY * MOUSE_SENS, -1.45, 1.45);
  }

  update(dt: number, input: Input): void {
    this.look(input);
    const fwd = input.axis("KeyS", "KeyW"), strafe = input.axis("KeyA", "KeyD");
    const speed = input.shift() ? RUN_SPEED : WALK_SPEED;
    const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
    let dx = (fx * fwd + rx * strafe) * speed * dt, dz = (fz * fwd + rz * strafe) * speed * dt;
    if (fwd && strafe) { dx *= Math.SQRT1_2; dz *= Math.SQRT1_2; }
    const nx = this.position.x + dx, nz = this.position.z + dz;
    if (this.inside(nx, nz)) { this.position.x = nx; this.position.z = nz; }
    const target = this.ground(this.position.x, this.position.z) + EYE_HEIGHT;
    this.position.y += (target - this.position.y) * Math.min(1, dt * 12);
    this.applyCamera();
  }

  applyCamera(): void {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(0, 0, 0, "YXZ");
    this.camera.rotation.y = -this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }
}
