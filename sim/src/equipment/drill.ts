// Drill + sample blocks (PLAN.md §9.3). Physics-lite penetration model:
//   feed = trigger * (0.6 + 0.4 * push);  rate = feed * V0 * (1 - h)^2;  depth += rate * dt
// Hard basalt barely advances, so sustained drilling raises a stall (drives the haptic stall warning).
import * as THREE from "three";

const V0 = 0.02; // m/s
export const DRILL_REACH_M = 2.4; // from the eye: arm + drill, with slack so you needn't stand on the stand
const SIGHT_M = 12; // a block aimed at from this far is named in the prompt ("step closer")
// aim assist: a block whose edge is within ASSIST of the aim ray is the target; once aimed, it holds out to HOLD,
// and while drilling out to LOCK, so hand-tracking jitter can't drop the target or end the contact
const ASSIST_RAD = THREE.MathUtils.degToRad(6);
const HOLD_RAD = THREE.MathUtils.degToRad(9);
const LOCK_RAD = THREE.MathUtils.degToRad(15);
const STALL_RATE = 0.002;
const STALL_AFTER_S = 2.0; // grind for a while before declaring a stall
const BLOCK_DEPTH = 0.45;

export interface Block {
  name: string;
  label: string;
  hardness: number;
  kind: "soft" | "hard";
  mesh: THREE.Mesh;
  depth: number;
  hole: THREE.Mesh;
  color: number;
}

function labelSprite(text: string, sub: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 160;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(10,12,16,0.75)";
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = "#f2efe8";
  g.font = "bold 54px system-ui, sans-serif";
  g.fillText(text, 24, 70);
  g.fillStyle = "#c9b98f";
  g.font = "30px system-ui, sans-serif";
  g.fillText(sub, 24, 124);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  s.scale.set(1.1, 0.34, 1);
  return s;
}

export interface AimHit { index: number; point: THREE.Vector3; normal: THREE.Vector3; distance: number }

const _box = new THREE.Box3(), _center = new THREE.Vector3(), _near = new THREE.Vector3(), _toward = new THREE.Vector3();
const _ray = new THREE.Raycaster();

/**
 * What the drill is aimed at. A direct hit wins; otherwise the block whose nearest point is within `cone` of the ray
 * (`hold` for the block aimed at last frame), and the contact point is that nearest spot on its surface.
 */
export function acquireTarget(origin: THREE.Vector3, dir: THREE.Vector3, meshes: THREE.Mesh[], far: number,
                              cone: number, held = -1, hold = cone): AimHit | null {
  const hitOf = (index: number, h: THREE.Intersection): AimHit => ({
    index, point: h.point.clone(), distance: h.distance,
    normal: h.face!.normal.clone().transformDirection(meshes[index].matrixWorld),
  });
  _ray.set(origin, dir);
  _ray.far = far;
  const direct = _ray.intersectObjects(meshes, false)[0];
  if (direct) return hitOf(meshes.indexOf(direct.object as THREE.Mesh), direct);

  let best = -1, bestMiss = Infinity;
  meshes.forEach((mesh, i) => {
    _box.setFromObject(mesh).getCenter(_center);
    const along = _toward.subVectors(_center, origin).dot(dir);
    if (along <= 0 || along > far) return; // behind the eye, or out of sight
    _box.clampPoint(_near.copy(origin).addScaledVector(dir, along), _near);
    const miss = _toward.subVectors(_near, origin).angleTo(dir);
    if (miss < (i === held ? hold : cone) && miss < bestMiss) { best = i; bestMiss = miss; }
  });
  if (best < 0) return null;
  // aim at that nearest point (nudged inward so the ray can't graze past the edge)
  _box.setFromObject(meshes[best]).getCenter(_center);
  _box.clampPoint(_near.copy(origin).addScaledVector(dir, _toward.subVectors(_center, origin).dot(dir)), _near);
  _near.lerp(_center, 0.05);
  _ray.set(origin, _toward.subVectors(_near, origin).normalize());
  const h = _ray.intersectObject(meshes[best], false)[0];
  return h ? hitOf(best, h) : null;
}

export interface DrillTelemetry {
  held: boolean; trigger: number; target: "soft" | "hard" | null; contact: boolean;
  hardness: number; depth_m: number; rate_mps: number; stalled: boolean;
}

export class DrillSystem {
  readonly rack = new THREE.Group();
  readonly tool = new THREE.Group();
  readonly blocks: Block[] = [];
  private bit: THREE.Mesh;
  private marker: THREE.Mesh;
  private bore: { block: Block; point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  private dust: THREE.Points;
  private dustVel: Float32Array;
  private dustLife: Float32Array;
  private dustNext = 0;
  private contactTime = 0;
  held = false;
  trigger = 0;
  target: Block | null = null; // aimed at and within reach
  tooFar: Block | null = null; // aimed at but out of reach
  aimDistance = 0; // m from the eye to the aimed-at block
  readonly aimPoint = new THREE.Vector3(); // where the bit points (the reticle goes here)
  contact = false;
  rate = 0;
  stalled = false;
  shake = 0;
  onBreakthrough: () => void = () => {};

  constructor(scene: THREE.Scene, site: THREE.Vector3, ground: (x: number, z: number) => number) {
    // rack
    const metal = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.5, metalness: 0.6 });
    const rackBase = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.4), metal);
    rackBase.position.y = 0.45;
    this.rack.add(rackBase);
    this.rack.position.set(site.x - 2.5, ground(site.x - 2.5, site.z - 1), site.z - 1);
    scene.add(this.rack);

    // the tool itself (pistol-grip core drill)
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.38), new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.5 }));
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.08), new THREE.MeshStandardMaterial({ color: 0x2a2a2a }));
    grip.position.set(0, -0.13, 0.1);
    grip.rotation.x = 0.25;
    this.bit = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.012, 0.32, 10), metal);
    this.bit.rotation.x = Math.PI / 2;
    this.bit.position.z = -0.34;
    const chuck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 12), metal);
    chuck.rotation.x = Math.PI / 2;
    chuck.position.z = -0.2;
    this.tool.add(body, grip, chuck, this.bit);
    this.tool.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.parkTool();
    scene.add(this.tool);

    // aim ring on the block face the bit is pointing at
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.062, 32),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false }));
    this.marker.visible = false;
    scene.add(this.marker);

    // sample blocks on stands (properties are simulated, not NASA measurements)
    const specs = [
      { name: "regolith", label: "Regolith brick", sub: "soft · simulated hardness 0.25", hardness: 0.25, kind: "soft" as const, color: 0xb59a74, dx: 0.2 },
      { name: "basalt", label: "Basalt core", sub: "hard · simulated hardness 0.9", hardness: 0.9, kind: "hard" as const, color: 0x3b3a3d, dx: 2.2 },
    ];
    for (const sp of specs) {
      const x = site.x + sp.dx, z = site.z - 1.6;
      const y = ground(x, z);
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.85, 10), metal);
      stand.position.set(x, y + 0.42, z);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: sp.color, roughness: 0.95 }));
      mesh.position.set(x, y + 1.1, z);
      mesh.castShadow = mesh.receiveShadow = true;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.03, 16), new THREE.MeshBasicMaterial({ color: 0x050505 }));
      hole.visible = false;
      scene.add(hole);
      const label = labelSprite(sp.label, sp.sub);
      label.position.set(x, y + 1.75, z);
      scene.add(stand, mesh, label);
      this.blocks.push({ name: sp.name, label: sp.label, hardness: sp.hardness, kind: sp.kind, mesh, depth: 0, hole, color: sp.color });
    }

    // dust / spark particles
    const N = 300;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3).fill(-9999), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.012, vertexColors: true }));
    this.dust.frustumCulled = false;
    this.dustVel = new Float32Array(N * 3);
    this.dustLife = new Float32Array(N);
    scene.add(this.dust);
  }

  get rackPosition(): THREE.Vector3 { return this.rack.position; }

  parkTool(): void {
    this.held = false;
    this.tool.position.copy(this.rack.position).add(new THREE.Vector3(0, 1.0, 0));
    this.tool.rotation.set(0, Math.PI / 2, 0);
  }

  resetBlocks(): void {
    for (const b of this.blocks) { b.depth = 0; b.hole.visible = false; }
  }

  /**
   * hand: where the drill is held (world position; its orientation gives "up"). aim: unit ray from the eye.
   * push 0..1: hand moving forward / W key.
   */
  update(dt: number, hand: THREE.Object3D, aimOrigin: THREE.Vector3, aimDir: THREE.Vector3, push: number): void {
    this.updateDust(dt);
    const prev = this.target ?? this.tooFar;
    this.target = this.tooFar = null;
    this.contact = false;
    this.rate = 0;
    if (!this.held) {
      this.stalled = false;
      this.contactTime = 0;
      this.shake = 0;
      this.bore = null;
      this.marker.visible = false;
      this.highlight(null, false);
      return;
    }

    const drilling = this.bore !== null && this.trigger > 0.02;
    const held = drilling ? this.bore!.block : prev;
    const aim = acquireTarget(aimOrigin, aimDir, this.blocks.map((b) => b.mesh), SIGHT_M, ASSIST_RAD,
      held ? this.blocks.indexOf(held) : -1, drilling ? LOCK_RAD : HOLD_RAD);
    const block = aim ? this.blocks[aim.index] : null;
    const inReach = !!aim && aim.distance <= DRILL_REACH_M;
    this.aimDistance = aim ? aim.distance : 0;
    if (aim) this.aimPoint.copy(aim.point);
    else this.aimPoint.copy(aimOrigin).addScaledVector(aimDir, DRILL_REACH_M);

    // the tool stays in the hand and turns its bit toward whatever it's aimed at
    this.tool.position.copy(hand.position);
    const look = new THREE.Matrix4().lookAt(hand.position, this.aimPoint, new THREE.Vector3(0, 1, 0).applyQuaternion(hand.quaternion));
    this.tool.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(look), 1 - Math.exp(-25 * dt));
    this.bit.rotation.y += this.trigger * 60 * dt;

    if (block && inReach) {
      this.target = block;
      if (this.trigger > 0.02) {
        this.contact = true;
        // keep boring the same spot for as long as the trigger stays down, however much the hand wobbles
        if (this.bore?.block !== block) this.bore = { block, point: aim!.point.clone(), normal: aim!.normal.clone() };
        const { point: p, normal: n } = this.bore;
        const feed = this.trigger * (0.6 + 0.4 * push);
        this.rate = feed * V0 * (1 - block.hardness) ** 2;
        block.depth = Math.min(BLOCK_DEPTH, block.depth + this.rate * dt);
        if (block.depth >= BLOCK_DEPTH && this.rate > 0) {
          this.onBreakthrough();
          block.depth = 0;
        }
        // hole marker on the struck face, growing with depth
        block.hole.visible = true;
        block.hole.position.copy(p).addScaledVector(n, 0.002);
        block.hole.lookAt(p.clone().add(n));
        block.hole.scale.setScalar(0.6 + 8 * block.depth);
        this.emitDust(p, n, block, dt);
      } else this.bore = null;
    } else {
      this.bore = null;
      this.tooFar = block;
    }
    this.marker.visible = !!aim && !this.contact;
    if (aim) {
      (this.marker.material as THREE.MeshBasicMaterial).color.setHex(inReach ? 0x8dff9e : 0xffb347);
      this.marker.position.copy(aim.point).addScaledVector(aim.normal, 0.004);
      this.marker.lookAt(aim.point.clone().add(aim.normal));
    }
    this.highlight(block, inReach);
    this.contactTime = this.contact ? this.contactTime + dt : 0;
    this.stalled = this.contact && this.trigger > 0.5 && this.rate < STALL_RATE && this.contactTime > STALL_AFTER_S;
    this.shake = this.contact ? this.trigger * (this.target!.hardness > 0.5 ? 0.006 : 0.0015) : this.trigger * 0.0005;
  }

  /** Tint the aimed-at block: green when it's in reach, amber when you need to step closer. */
  private highlight(block: Block | null, inReach: boolean): void {
    for (const b of this.blocks) {
      (b.mesh.material as THREE.MeshStandardMaterial).emissive.setHex(b !== block ? 0 : inReach ? 0x1f4a26 : 0x4a3208);
    }
  }

  private emitDust(p: THREE.Vector3, n: THREE.Vector3, block: Block, dt: number): void {
    const pos = this.dust.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.dust.geometry.getAttribute("color") as THREE.BufferAttribute;
    const hard = block.kind === "hard";
    const count = Math.ceil((hard ? 90 : 160) * dt * this.trigger);
    const base = new THREE.Color(block.color).offsetHSL(0, 0, 0.15);
    for (let k = 0; k < count; k++) {
      const i = this.dustNext;
      this.dustNext = (this.dustNext + 1) % this.dustLife.length;
      pos.setXYZ(i, p.x, p.y, p.z);
      const spread = hard ? 2.2 : 0.7;
      this.dustVel[i * 3] = n.x * 0.6 + (Math.random() - 0.5) * spread;
      this.dustVel[i * 3 + 1] = n.y * 0.6 + Math.random() * spread * 0.8;
      this.dustVel[i * 3 + 2] = n.z * 0.6 + (Math.random() - 0.5) * spread;
      this.dustLife[i] = hard ? 0.35 : 0.9;
      const spark = hard && Math.random() < 0.35;
      col.setXYZ(i, spark ? 1 : base.r, spark ? 0.75 : base.g, spark ? 0.3 : base.b);
    }
    col.needsUpdate = true;
  }

  private updateDust(dt: number): void {
    const pos = this.dust.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.dustLife.length; i++) {
      if (this.dustLife[i] <= 0) continue;
      this.dustLife[i] -= dt;
      this.dustVel[i * 3 + 1] -= 1.62 * dt;
      pos.setXYZ(i, pos.getX(i) + this.dustVel[i * 3] * dt, pos.getY(i) + this.dustVel[i * 3 + 1] * dt, pos.getZ(i) + this.dustVel[i * 3 + 2] * dt);
      if (this.dustLife[i] <= 0) pos.setXYZ(i, 0, -9999, 0);
    }
    pos.needsUpdate = true;
  }

  telemetry(): DrillTelemetry {
    const t = this.target;
    return {
      held: this.held, trigger: this.trigger, target: t ? t.kind : null, contact: this.contact,
      hardness: t ? t.hardness : 0, depth_m: t ? t.depth : 0, rate_mps: this.rate, stalled: this.stalled,
    };
  }
}
