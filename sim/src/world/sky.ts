import * as THREE from "three";
import { mulberry32, type Rock } from "./detail";
import type { Terrain } from "./terrain";

const SUN_ELEVATION_DEG = 6; // the polar Sun skims the horizon; a little higher than reality for visibility
const SUN_AZIMUTH_DEG = 235;
const SHADOW_HALF = 70;

export class Environment {
  readonly sun: THREE.DirectionalLight;
  private sunDir: THREE.Vector3;

  constructor(private scene: THREE.Scene) {
    scene.background = new THREE.Color(0x000000);

    const el = THREE.MathUtils.degToRad(SUN_ELEVATION_DEG), az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
    this.sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.sun = new THREE.DirectionalLight(0xfff4e6, 4.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    Object.assign(this.sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1, far: 800 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);
    // faint fill: earthshine + scattered light from sunlit crater walls
    scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x5a554c, 0.6));

    this.addStars();
    this.addEarth();
  }

  private addStars(): void {
    const rnd = mulberry32(42);
    const count = 4000, pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 4500;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(th), r * Math.abs(u) * 0.98 + 30, r * s * Math.sin(th)], i * 3);
      const b = 0.4 + 0.6 * rnd() ** 3;
      col.set([b, b, b * (0.9 + 0.2 * rnd())], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false }));
    stars.frustumCulled = false;
    this.scene.add(stars);
  }

  private addEarth(): void {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const g = canvas.getContext("2d")!;
    const grad = g.createRadialGradient(100, 110, 20, 128, 128, 128);
    grad.addColorStop(0, "#cfe6ff");
    grad.addColorStop(0.45, "#3d7fd1");
    grad.addColorStop(0.95, "#0b2a5a");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(128, 128, 126, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.55)";
    for (const [x, y, w, h] of [[70, 80, 60, 14], [120, 150, 80, 12], [60, 170, 40, 10]]) g.fillRect(x, y, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const earth = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, fog: false, depthWrite: false }));
    const el = THREE.MathUtils.degToRad(4), az = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG - 140);
    earth.position.set(Math.sin(az) * Math.cos(el) * 4000, Math.sin(el) * 4000, -Math.cos(az) * Math.cos(el) * 4000);
    earth.scale.setScalar(150);
    this.scene.add(earth);
  }

  /** Keep the shadow frustum centred on the player. */
  follow(target: THREE.Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 300);
  }
}

export function buildRocks(scene: THREE.Scene, rocks: Rock[], terrain: Terrain): THREE.InstancedMesh {
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 1, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, rocks.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  rocks.forEach((rock, i) => {
    const ground = terrain.baseHeight(rock.x, rock.z) + terrain.detail.height(rock.x, rock.z, false);
    q.setFromEuler(new THREE.Euler(0.3 * Math.sin(rock.rot), rock.rot, 0.2 * Math.cos(rock.rot)));
    s.set(rock.r, rock.h * 1.1, rock.r * 0.85);
    p.set(rock.x, ground + rock.h * 0.25, rock.z);
    mesh.setMatrixAt(i, m.compose(p, q, s));
  });
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
