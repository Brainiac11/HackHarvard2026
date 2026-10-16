import * as THREE from "three";
import "./style.css";
import { DrillSystem } from "./equipment/drill";
import { buildRoverMesh, poseRover, RoverModel } from "./equipment/rover";
import { Input } from "./input/keyboard";
import { HubClient } from "./net/hub";
import type { Equipment, HubState, Mode, SimStateMsg } from "./net/messages";
import { Walker } from "./player/walker";
import { Hud } from "./ui/hud";
import { buildRocks, Environment } from "./world/sky";
import { Terrain } from "./world/terrain";

const PHYSICS_HZ = 120;
const TELEMETRY_HZ = 30;
const NEAR_DRILL_M = 2.5;
const NEAR_ROVER_M = 3.5;
const PENDING_TIMEOUT_S = 2.5;

async function main(): Promise<void> {
  const loading = document.getElementById("loading")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.03, 6000);
  scene.add(camera);
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ------------------------------------------------------------------ world
  loading.textContent = "Loading NASA LOLA terrain…";
  const terrain = await Terrain.load("site04");
  const site = terrain.findFlatSite();
  terrain.build(scene, 7, site);
  const env = new Environment(scene);
  const rocks = buildRocks(scene, terrain.detail.rocks, terrain);
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const siteV = new THREE.Vector3(site.x, ground(site.x, site.z), site.z);

  const drill = new DrillSystem(scene, siteV, ground);
  const rover = new RoverModel(ground);
  const roverStart = { x: site.x + 12, z: site.z + 3, heading: 0 };
  rover.reset(roverStart.x, roverStart.z, roverStart.heading);
  const { group: roverMesh, wheels: roverWheels } = buildRoverMesh();
  scene.add(roverMesh);
  poseRover(roverMesh, roverWheels, rover, ground, 0);

  const walker = new Walker(camera, ground, (x, z) => terrain.inside(x, z, 5));
  walker.place(site.x + 1, site.z + 3, 0);
  walker.applyCamera();

  // where the drill sits when held without hand tracking: lower-right of view
  const handAnchor = new THREE.Object3D();
  handAnchor.position.set(0.3, -0.3, -0.62);
  camera.add(handAnchor);

  // ------------------------------------------------------------------ hub + HUD
  const hud = new Hud(`/terrain/site04/overview.png`);
  const hub = new HubClient();
  hub.onStatus = (ok) => hud.setHubConnected(ok);
  const input = new Input(renderer.domElement);
  let hubState: HubState | null = null;
  let pending: { equipment: Equipment; at: number } | null = null;
  let mode: Mode = "walk";
  let roverCam: "chase" | "cockpit" = "chase";
  let clock = 0;

  const enter = (equipment: Equipment) => {
    if (equipment === "drill") {
      drill.held = true;
      mode = "drill";
    } else {
      mode = "rover";
      drill.parkTool();
    }
    pending = null;
  };
  const exitToWalk = () => {
    if (mode === "rover") {
      const [rx, rz] = rover.right();
      walker.place(rover.x - rx * 2.2, rover.z - rz * 2.2, rover.heading);
    }
    if (mode === "drill") drill.parkTool();
    mode = "walk";
  };

  hub.on("hub.state", (s) => {
    hubState = s;
    hud.updateState(s);
    if (pending && s.equipment.active === pending.equipment) enter(pending.equipment);
    if (mode !== "walk" && s.equipment.active !== mode) exitToWalk(); // signed out / switched by voice
  });
  hub.on("hub.motors", (m) => {
    hud.updateMotors(m.levels, m.dominant, m.alert);
  });
  hub.on("hub.toast", (t) => hud.toast(t));
  hub.on("hub.welcome", (w) => hud.welcome(w));
  hub.on("hub.assistant", (a) => hud.assistantUpdate(a));
  rover.onImpact = (side, mag) => hub.send({ t: "sim.event", name: "impact", mag, side });
  drill.onBreakthrough = () => hub.send({ t: "sim.event", name: "breakthrough", mag: 1 });

  const request = (equipment: Equipment | null) => {
    if (equipment && hubState?.equipment.active === equipment) {
      enter(equipment);
      return;
    }
    hub.action("select_equipment", { equipment });
    pending = equipment ? { equipment, at: clock } : null;
  };

  const near = (): Equipment | null => {
    if (mode === "rover") return "rover";
    if (mode === "drill") return "drill";
    const p = walker.position;
    if (Math.hypot(p.x - drill.rackPosition.x, p.z - drill.rackPosition.z) < NEAR_DRILL_M) return "drill";
    if (Math.hypot(p.x - rover.x, p.z - rover.z) < NEAR_ROVER_M) return "rover";
    return null;
  };

  // ------------------------------------------------------------------ input handling
  const handleKeys = () => {
    const nearNow = near();
    if (input.pressed("KeyE")) {
      if (mode === "drill" || mode === "rover") {
        exitToWalk();
        request(null);
      } else if (nearNow) {
        request(nearNow);
      }
    }
    if (input.pressed("KeyN")) hub.action("nfc_simulate", { profile_id: input.shift() ? "okafor" : "rivera" });
    if (input.pressed("KeyH")) hub.action("ask_assistant", { question: "" });
    if (input.pressed("KeyJ")) hub.action("assistant_auto", { enabled: !(hubState?.assistant.auto ?? true) });
    if (input.pressed("KeyF")) {
      terrain.detail.enabled = !terrain.detail.enabled;
      terrain.applyHeights();
      rocks.visible = terrain.detail.enabled;
      hud.toast({ level: "info", text: `Synthetic fine detail ${terrain.detail.enabled ? "ON" : "OFF (NASA LOLA only)"}` });
    }
    if (input.pressed("KeyC")) roverCam = roverCam === "chase" ? "cockpit" : "chase";
    if (input.pressed("KeyR") && mode === "rover") rover.reset(rover.x, rover.z, rover.heading);
    if (input.pressed("KeyQ")) drill.resetBlocks();
    if (input.pressed("Slash")) hud.toggleHelp();
    if (input.pressed("Escape")) document.exitPointerLock();
  };

  // ------------------------------------------------------------------ telemetry
  const telemetry = (): SimStateMsg => {
    const px = mode === "rover" ? rover.x : walker.position.x;
    const pz = mode === "rover" ? rover.z : walker.position.z;
    const lola = terrain.lola(px, pz);
    const ll = terrain.latlon(px, pz);
    return {
      t: "sim.state", ts: performance.now() / 1000, mode, near: near(),
      drill: drill.telemetry(),
      rover: {
        speed: rover.v, accel: rover.accel, throttle: rover.throttle, steer: rover.steer,
        wheels: rover.wheels.map((w) => ({ comp: +w.comp.toFixed(4), vel: +w.vel.toFixed(4), contact: w.contact })),
        rough: rover.rough, pitch_deg: THREE.MathUtils.radToDeg(rover.pitch), roll_deg: THREE.MathUtils.radToDeg(rover.roll),
        heading_deg: mode === "rover" ? rover.headingDeg() : ((THREE.MathUtils.radToDeg(walker.yaw) % 360) + 360) % 360,
      },
      terrain: {
        x: px, z: pz, elev_m: terrain.baseHeight(px, pz) + terrain.meta.elev_offset_m, lat: ll.lat, lon: ll.lon,
        lola_slope_deg: mode === "rover" ? lola.slope : null, lola_slope_err_deg: lola.err, coverage: lola.cover,
        synthetic_detail: terrain.detail.enabled,
      },
    };
  };

  const updateProvenance = () => {
    const px = mode === "rover" ? rover.x : walker.position.x;
    const pz = mode === "rover" ? rover.z : walker.position.z;
    const lola = terrain.lola(px, pz);
    const ll = terrain.latlon(px, pz);
    const box = terrain.meta.src.overview_box_uv;
    const u = (px + terrain.extent / 2) / terrain.extent, v = (pz + terrain.extent / 2) / terrain.extent;
    hud.updateProvenance({
      site: terrain.meta.site_name, lat: ll.lat, lon: ll.lon, elev: terrain.baseHeight(px, pz) + terrain.meta.elev_offset_m,
      slope: lola.slope, err: lola.err, cover: lola.cover, detail: terrain.detail.enabled, overviewUv: box,
      posUv: [u, v], limit: hubState?.profile?.settings.rover.slope_warn_deg ?? null,
    });
  };

  // dev-only hook for scripted end-to-end tests (stripped from production builds)
  const debug = { lastMotors: null as unknown, lastAssistant: null as unknown };
  hub.on("hub.motors", (m) => { debug.lastMotors = m; });
  hub.on("hub.assistant", (a) => { debug.lastAssistant = a; });
  if (import.meta.env.DEV) {
    (window as any).__lh = {
      walker, rover, drill, terrain, site, debug,
      get mode() { return mode; },
      get hubState() { return hubState; },
      aimAt(x: number, y: number, z: number) {
        const p = walker.position;
        walker.yaw = Math.atan2(x - p.x, -(z - p.z));
        walker.pitch = Math.atan2(y - p.y, Math.hypot(x - p.x, z - p.z));
        walker.applyCamera();
      },
    };
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let physicsAcc = 0, telemetryAcc = 0, provAcc = 0;
  let steerSmooth = 0;
  loading.remove();
  updateProvenance();

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    if (pending && clock - pending.at > PENDING_TIMEOUT_S) pending = null;
    handleKeys();

    const triggerHeld = input.held("Space") || input.mouseRight;
    drill.trigger = THREE.MathUtils.clamp(drill.trigger + (triggerHeld ? 8 : -10) * dt, 0, 1);

    if (mode === "rover") {
      walker.look(input);
      steerSmooth += (input.axis("KeyA", "KeyD") - steerSmooth) * Math.min(1, dt * 6);
      const w = input.held("KeyW"), s = input.held("KeyS");
      const roverInput = {
        throttle: w ? 1 : s && rover.v <= 0.05 ? -0.5 : 0,
        brake: s && rover.v > 0.05 ? 1 : 0,
        steer: steerSmooth,
        boost: input.shift(),
      };
      physicsAcc += dt;
      while (physicsAcc >= 1 / PHYSICS_HZ) {
        rover.step(1 / PHYSICS_HZ, roverInput);
        physicsAcc -= 1 / PHYSICS_HZ;
      }
      if (!terrain.inside(rover.x, rover.z, 4)) rover.reset(roverStart.x, roverStart.z, roverStart.heading);
    } else {
      walker.update(dt, input);
    }
    poseRover(roverMesh, roverWheels, rover, ground, mode === "rover" ? dt : 0);

    // camera
    if (mode === "rover") {
      const [fx, fz] = rover.forward();
      if (roverCam === "chase") {
        const target = new THREE.Vector3(rover.x + fx * 3, rover.y + 0.8, rover.z + fz * 3);
        const desired = new THREE.Vector3(rover.x - fx * 7, rover.y + 3.2, rover.z - fz * 7);
        desired.y = Math.max(desired.y, ground(desired.x, desired.z) + 1.5);
        camera.position.lerp(desired, Math.min(1, dt * 4));
        camera.lookAt(target);
      } else {
        const seat = new THREE.Vector3(-0.4, 0.95, 0.1).applyMatrix4(roverMesh.matrixWorld);
        camera.position.copy(seat);
        camera.quaternion.copy(roverMesh.quaternion);
        camera.rotateX(walker.pitch * 0.5);
      }
    }
    if (drill.shake > 0 && mode === "drill") {
      camera.position.x += (Math.random() - 0.5) * drill.shake;
      camera.position.y += (Math.random() - 0.5) * drill.shake;
    }
    camera.updateMatrixWorld();

    // drill (aim along view direction)
    const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const anchorWorld = new THREE.Object3D();
    handAnchor.getWorldPosition(anchorWorld.position);
    handAnchor.getWorldQuaternion(anchorWorld.quaternion);
    drill.update(dt, anchorWorld, camera.position, aimDir, input.held("KeyW") ? 1 : 0);

    // prompts
    const n = near();
    const authorized = hubState?.equipment.authorized ?? [];
    if (mode === "walk" && n) {
      hud.setPrompt(!hubState?.profile ? `Tap glove to identify (N) · ${n.toUpperCase()}`
        : !authorized.includes(n) ? `Tap glove to authorize ${n.toUpperCase()}`
          : n === "drill" ? "E — pick up drill" : "E — board rover");
    } else if (mode === "drill") {
      hud.setPrompt(drill.target ? `${drill.target.label} — hold Space to drill` : "Aim at a sample · E to put the drill back");
    } else hud.setPrompt(null);
    hud.setCrosshair(mode !== "rover");
    hud.setSpeedo(mode === "rover", Math.abs(rover.v) * 3.6, rover.rough,
      THREE.MathUtils.radToDeg(rover.pitch), THREE.MathUtils.radToDeg(rover.roll));

    // telemetry + provenance
    telemetryAcc += dt;
    if (telemetryAcc >= 1 / TELEMETRY_HZ) {
      telemetryAcc = 0;
      hub.send(telemetry());
    }
    provAcc += dt;
    if (provAcc > 0.2) {
      provAcc = 0;
      updateProvenance();
    }

    env.follow(mode === "rover" ? new THREE.Vector3(rover.x, rover.y, rover.z) : walker.position);
    renderer.render(scene, camera);
    input.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  if (loading) loading.textContent = `Failed to start: ${err}`;
});
