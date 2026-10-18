import * as THREE from "three";
import "./style.css";
import { DrillSystem } from "./equipment/drill";
import { feedCommand } from "./equipment/drillPress";
import { RoverModel } from "./equipment/rover";
import { RoverControls } from "./equipment/roverControls";
import { buildRoverMesh, COCKPIT_EYE, poseRover } from "./equipment/roverMesh";
import { PostFX, SHADOW_TEXELS } from "./gfx/post";
import { bakeLog } from "./gfx/procedural";
import { DEFAULT_CALIBRATION } from "./hand/gestures";
import { TrackedHand, type KeepOut } from "./hand/handModel";
import { Input } from "./input/keyboard";
import { HubClient } from "./net/hub";
import type { Equipment, HubState, Mode, SimStateMsg } from "./net/messages";
import { Walker } from "./player/walker";
import { Hud } from "./ui/hud";
import { GrokVoice } from "./voice/grokVoice";
import { Rocks } from "./world/rocks";
import { Environment } from "./world/sky";
import { Terrain } from "./world/terrain";

const PHYSICS_HZ = 120;
const TELEMETRY_HZ = 30;
const NEAR_DRILL_M = 2.5;
const NEAR_ROVER_M = 3.5;
const PENDING_TIMEOUT_S = 2.5;
// rover cameras. Chase: 7.5 m behind and 3 m up, aimed at the rover, so it sits in the middle of the view (about
// 37-72% down the screen) above the HUD's bottom-centre stack. Cockpit: tilted down so the console sits above the prompt
const CHASE_BACK_M = 7.5, CHASE_UP_M = 3, CHASE_AIM_Y = 0.6;
const COCKPIT_TILT = -0.26; // rad, plus half the mouse pitch
// the prompt's top sits a fixed 183 px above the window's bottom: in short windows tilt further down (up to 0.06 rad at
// 720 px) so the console's bottom row stays above it
const cockpitTilt = () => COCKPIT_TILT - 0.06 * THREE.MathUtils.clamp((860 - innerHeight) / 140, 0, 1);
// screen boxes the tracked glove keeps out of: the pendant, bit and samples from the press's operator station; the
// console from the rover's seat
const DRILL_KEEP_OUT: KeepOut = { u0: 0.28, u1: 0.69, v0: 0.2, v1: 0.8 };
const COCKPIT_KEEP_OUT: KeepOut = { u0: 0.51, u1: 0.76, v0: 0.5, v1: 0.82 };

// Startup timeline: ms since navigation start at each stage (the dev hook's stats() reports it)
const startup: Record<string, number> = {};
const mark = (stage: string) => { startup[stage] = Math.round(performance.now()); };

async function main(): Promise<void> {
  mark("main");
  const loading = document.getElementById("loading")!;
  const renderer = new THREE.WebGLRenderer({ powerPreference: "high-performance" }); // PostFX multisamples the scene
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied once, by PostFX's output pass
  renderer.toneMappingExposure = 1.35;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.03, 6000);
  scene.add(camera);
  const post = new PostFX(renderer, scene, camera);
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight);
  });
  // dev stats(): count every pass of a frame (shadows, scene, AO, bloom, output) together, reset once per frame
  if (import.meta.env.DEV) renderer.info.autoReset = false;

  // ------------------------------------------------------------------ world
  loading.textContent = "Loading NASA LOLA terrain…";
  const terrain = await Terrain.load("site04");
  mark("terrainFetched");
  const site = terrain.findFlatSite();
  await terrain.build(scene, 7, site);
  mark("terrainBuilt");
  const env = new Environment(scene);
  env.setShadowMapSize(SHADOW_TEXELS[post.quality]); // ?gfx= may have picked a lower level
  mark("sky");
  const rocks = new Rocks(terrain.detail.rocks, (x, z) => terrain.groundAt(x, z));
  scene.add(rocks);
  mark("rocks");
  const ground = (x: number, z: number) => terrain.heightAt(x, z);
  const siteV = new THREE.Vector3(site.x, ground(site.x, site.z), site.z);

  const drill = new DrillSystem(scene, siteV, ground);
  mark("drillPress");
  const rover = new RoverModel(ground);
  const roverStart = { x: site.x + 12, z: site.z + 3, heading: 0 };
  rover.reset(roverStart.x, roverStart.z, roverStart.heading);
  const { group: roverMesh, wheels: roverWheels } = buildRoverMesh();
  const roverControls = new RoverControls();
  scene.add(roverMesh);
  poseRover(roverMesh, roverWheels, rover, ground, 0);
  mark("rover");

  const walker = new Walker(camera, ground, (x, z) => terrain.inside(x, z, 5));
  walker.place(site.x + 1, site.z + 3, 0);
  walker.applyCamera();
  /** Turn the astronaut's view toward a world point. */
  const lookAt = (x: number, y: number, z: number) => {
    const p = walker.position;
    walker.yaw = Math.atan2(x - p.x, -(z - p.z));
    walker.pitch = Math.atan2(y - p.y, Math.hypot(x - p.x, z - p.z));
    walker.applyCamera();
  };

  const hand = new TrackedHand(camera);
  mark("glove");

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
  // the operator tried to move the table or reset the samples with the bit down: when, and what to do once it's up
  let refusedAt = -1e9, refusedThen = "";
  let handFeedArmed = false; // the fist that took the press controls doesn't also start the feed

  const enter = (equipment: Equipment) => {
    if (equipment === "drill") {
      // step up to the operator station, eyes on the bit
      walker.place(drill.station.x, drill.station.z, 0);
      lookAt(drill.focus.x, drill.focus.y, drill.focus.z);
      drill.operating = true;
      handFeedArmed = false;
      mode = "drill";
    } else {
      mode = "rover";
      drill.operating = false;
      walker.pitch = 0; // the cockpit view starts at COCKPIT_TILT; the mouse tilts it from there
    }
    pending = null;
  };
  const exitToWalk = () => {
    if (mode === "rover") {
      const [rx, rz] = rover.right();
      walker.place(rover.x - rx * 2.2, rover.z - rz * 2.2, rover.heading);
    }
    if (mode === "drill") {
      drill.operating = false;
      walker.place(drill.station.x, drill.station.z + 0.6, walker.yaw); // off the tread plate
    }
    mode = "walk";
  };

  let calibrationKey = "null";
  hub.on("hub.state", (s) => {
    hubState = s;
    hud.updateState(s);
    // a glove limits how far fingers curl, so grip only works with the wearer's saved calibration (K)
    const cal = s.profile?.hand_calibration;
    if (JSON.stringify(cal ?? null) !== calibrationKey) {
      calibrationKey = JSON.stringify(cal ?? null);
      hand.calibration = cal?.open?.length === 5 && cal.closed?.length === 5 ? structuredClone(cal)
        : structuredClone(DEFAULT_CALIBRATION);
    }
    if (pending && s.equipment.active === pending.equipment) enter(pending.equipment);
    if (mode !== "walk" && s.equipment.active !== mode) exitToWalk(); // signed out / switched by voice
  });
  hub.on("hub.motors", (m) => {
    hud.updateMotors(m.levels, m.dominant, m.alert);
    hand.showMotors(m.levels);
  });
  hub.on("hand.frame", (f) => hand.onFrame(f));
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
    if (Math.hypot(p.x - drill.position.x, p.z - drill.position.z) < NEAR_DRILL_M) return "drill";
    if (Math.hypot(p.x - rover.x, p.z - rover.z) < NEAR_ROVER_M) return "rover";
    return null;
  };

  let calibrating = false;
  const calibrateHand = async () => {
    if (calibrating || !hand.active) {
      hud.toast({ level: "warn", text: "Start the hand tracker first (tracker.html on the phone)" });
      return;
    }
    calibrating = true;
    const sample = async (label: string): Promise<number[]> => {
      hud.toast({ level: "info", text: label });
      await new Promise((r) => setTimeout(r, 900));
      const acc: number[][] = [];
      for (let i = 0; i < 30; i++) {
        acc.push([...hand.raw]);
        await new Promise((r) => setTimeout(r, 50));
      }
      return [0, 1, 2, 3, 4].map((f) => acc.map((a) => a[f]).sort((a, b) => a - b)[Math.floor(acc.length / 2)]);
    };
    const open = await sample("Calibration: hold your hand OPEN and flat");
    const closed = await sample("Calibration: now make a FIST");
    hand.calibration = { open, closed: closed.map((c, i) => Math.max(c, open[i] + 0.4)) };
    hub.action("calibrate_hand", { calibration: hand.calibration });
    calibrating = false;
  };

  // ------------------------------------------------------------------ Grok Voice (CAPCOM)
  const voice = new GrokVoice(hub);
  let speakAlerts = false;
  voice.onStatus = (s, detail) => hud.setVoiceStatus(s, detail);
  voice.onLevel = (peak) => hud.setVoiceLevel(peak);
  voice.onTranscript = (role, text) => {
    hud.addTranscript(role, text);
    if (role !== "tool") hub.send({ t: "voice.transcript", role, text });
  };
  hub.on("voice.local_reply", (r) => {
    hud.addTranscript("assistant", `[offline] ${r.text}`);
    if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(r.text));
  });
  hub.on("hub.assistant", (a) => {
    if (speakAlerts && a.status === "ready" && a.advice && a.trigger.startsWith("auto:alert")) {
      voice.speak(`${a.advice.explanation} ${a.advice.action}`);
    }
  });
  // push-to-talk follows the key events, not the frame loop: a frame longer than the press (a hitch, a slow GPU) lost
  // the release and left the mic streaming in "listening"; the keydown is also the gesture that lets audio start
  addEventListener("keydown", (e) => { if (e.code === "KeyV" && !e.repeat && !input.typing) void voice.pttDown(); });
  addEventListener("keyup", (e) => { if (e.code === "KeyV") void voice.pttUp(); });
  addEventListener("blur", () => void voice.pttUp());
  const textBox = hud.voiceInput;
  textBox.addEventListener("focus", () => (input.typing = true));
  textBox.addEventListener("blur", () => { input.typing = false; textBox.classList.add("hidden"); });
  textBox.addEventListener("keydown", async (e) => {
    e.stopPropagation();
    if (e.key === "Escape") textBox.blur();
    if (e.key !== "Enter" || !textBox.value.trim()) return;
    const text = textBox.value.trim();
    textBox.value = "";
    textBox.blur();
    const ok = await voice.sendText(text);
    if (!ok) {
      hud.addTranscript("user", text);
      hub.action("local_command", { text }); // Grok unreachable: deterministic offline intents
    }
  });

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
    if (input.pressed("KeyN")) {
      const profile_id = input.shift() ? "okafor" : "rivera";
      // a real tag the hub doesn't know yet: bind it to that astronaut (persisted in data/profiles.json)
      hub.action(hubState?.nfc.unknown_uid ? "enroll" : "nfc_simulate", { profile_id });
    }
    if (input.pressed("KeyH")) hub.action("ask_assistant", { question: "" });
    if (input.pressed("KeyJ")) hub.action("assistant_auto", { enabled: !(hubState?.assistant.auto ?? true) });
    if (input.pressed("KeyF")) {
      terrain.setDetail(!terrain.detail.enabled);
      rocks.visible = terrain.detail.enabled;
      drill.reground(ground);
      hud.toast({ level: "info", text: `Synthetic fine detail ${terrain.detail.enabled ? "ON" : "OFF (NASA LOLA only)"}` });
    }
    if (input.pressed("KeyC")) roverCam = roverCam === "chase" ? "cockpit" : "chase";
    if (input.pressed("KeyR") && mode === "rover") rover.reset(rover.x, rover.z, rover.heading);
    if (input.pressed("KeyQ") && !drill.resetSamples()) {
      if (mode === "drill") [refusedAt, refusedThen] = [clock, "Q to reset the samples"];
      else hud.toast({ level: "warn", text: "Wait for the drill press to raise its bit, then Q" });
    }
    if (mode === "drill") {
      const slide = input.pressed("KeyA") || input.pressed("ArrowLeft") ? -1
        : input.pressed("KeyD") || input.pressed("ArrowRight") ? 1 : 0;
      if (slide && !drill.slideTable(slide)) [refusedAt, refusedThen] = [clock, "A/D to move the table"];
    }
    if (input.pressed("Slash")) hud.toggleHelp();
    if (input.pressed("KeyP")) {
      hud.toast({ level: "info", text: `Graphics ${post.cycle()}` });
      env.setShadowMapSize(SHADOW_TEXELS[post.quality]);
    }
    if (input.pressed("KeyK")) calibrateHand();
    if (input.pressed("KeyT")) {
      document.exitPointerLock();
      textBox.classList.remove("hidden");
      setTimeout(() => textBox.focus(), 0);
    }
    if (input.pressed("KeyG")) {
      speakAlerts = !speakAlerts;
      hud.toast({ level: "info", text: `CAPCOM ${speakAlerts ? "will read" : "won't read"} assistant alerts aloud` });
    }
    // hand: a grip near authorized equipment takes the drill press / rover controls
    if (hand.active && hand.grip && !prevGrip && mode === "walk" && nearNow) request(nearNow);
    prevGrip = hand.grip;
    if (input.pressed("Escape")) document.exitPointerLock();
  };

  const drillPrompt = (): string => {
    const tracked = hand.active, s = drill.sample;
    const raise = tracked ? "open your hand" : "W";
    if (clock - refusedAt < 2.5) return `Raise the bit clear of the sample first (${raise}), then ${refusedThen}`;
    if (!s) return "Table moving to the next sample…";
    if (s.through) return `${s.label} — broken through! Raise the bit (${raise}) to load a fresh sample`;
    if (drill.press.stalled) return `${s.label} — bit stalled: ${raise} to back it out`;
    // the fist that took the controls doesn't feed: it has to open first
    if (tracked && !handFeedArmed) return `${s.label} — open your hand, then close your fist to lower the bit`;
    const table = drill.press.tableLocked ? "" : " · A/D: other sample"; // it only moves with the bit up clear
    return `${s.label} — ${tracked ? "close your fist to lower the bit · open hand to raise"
      : "hold Space or S to lower the bit · W to raise"}${table} · E: step away`;
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
      walker, rover, drill, hand, terrain, site, debug,
      get mode() { return mode; },
      get hubState() { return hubState; },
      enter, // take over equipment without the hub's NFC authorization (screenshots, scripted tests)
      exit: exitToWalk,
      aimAt: lookAt,
      post,
      /** GPU-independent costs: the last frame's renderer.info over all passes, CPU timings, startup breakdown. */
      stats() {
        const { memory, programs } = renderer.info;
        const bakes: Record<string, number> = {};
        for (const b of bakeLog) bakes[b.key || "(uncached)"] = Math.round(((bakes[b.key || "(uncached)"] ?? 0) + b.ms) * 10) / 10;
        const stages = Object.entries(startup);
        return {
          ...frameStats,
          geometries: memory.geometries, textures: memory.textures, programs: programs?.length ?? 0,
          gfx: post.quality,
          startup: Object.fromEntries(stages.map(([k, t], i) => [k, i ? t - stages[i - 1][1] : t])), // ms per stage
          firstFrameAt: startup.firstFrame ?? null, // ms since navigation start
          bakeMs: Math.round(bakeLog.reduce((sum, b) => sum + b.ms, 0)),
          bakes,
        };
      },
    };
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let physicsAcc = 0, telemetryAcc = 0, provAcc = 0;
  const camTmp = new THREE.Vector3();
  let prevGrip = false;
  const roverFocus = new THREE.Vector3();
  // last frame: draw calls and primitives over every pass; CPU ms (smoothed) for the whole frame() and its parts
  const frameStats = { calls: 0, triangles: 0, points: 0, lines: 0, frameCpuMs: 0, worldCpuMs: 0, renderCpuMs: 0 };
  const smooth = (avg: number, ms: number) => (avg ? avg + (ms - avg) * 0.1 : ms);
  loading.textContent = "Compiling shaders…";
  await post.precompile();
  mark("precompiled");
  loading.remove();
  updateProvenance();
  mark("ready");

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    if (pending && clock - pending.at > PENDING_TIMEOUT_S) pending = null;
    handleKeys();

    // the glove is first-person: in the chase view the hand still drives (the speedo shows its command), undrawn
    hand.hidden = mode === "rover" && roverCam === "chase";
    hand.keepOut = mode === "drill" ? DRILL_KEEP_OUT : mode === "rover" ? COCKPIT_KEEP_OUT : null;
    hand.update();
    if (mode === "drill") {
      // closed fist / Space, S, down, right mouse: lower the bit · open hand / W, up: raise it · neither: hold
      if (hand.pose !== "fist") handFeedArmed = true;
      const lower = input.held("Space") || input.held("KeyS") || input.held("ArrowDown") || input.mouseRight;
      drill.feed = feedCommand(lower, input.held("KeyW") || input.held("ArrowUp"),
        hand.active && handFeedArmed ? hand.pose : null);
    }
    drill.update(dt);

    if (mode === "rover") {
      walker.look(input);
      // open hand accelerates, fist brakes, A/D steer; W/S override the hand
      const roverInput = roverControls.update(dt, input, hand, rover.v);
      physicsAcc += dt;
      while (physicsAcc >= 1 / PHYSICS_HZ) {
        rover.step(1 / PHYSICS_HZ, roverInput);
        physicsAcc -= 1 / PHYSICS_HZ;
      }
      if (!terrain.inside(rover.x, rover.z, 4)) rover.reset(roverStart.x, roverStart.z, roverStart.heading);
    } else if (mode === "drill") {
      walker.look(input); // at the controls: look around, but no walking
      walker.applyCamera();
    } else {
      walker.update(dt, input);
    }
    poseRover(roverMesh, roverWheels, rover, ground, mode === "rover" ? dt : 0);

    // camera
    if (mode === "rover") {
      const [fx, fz] = rover.forward();
      if (roverCam === "chase") {
        const desired = camTmp.set(rover.x - fx * CHASE_BACK_M, rover.y + CHASE_UP_M, rover.z - fz * CHASE_BACK_M);
        desired.y = Math.max(desired.y, ground(desired.x, desired.z) + 1.5);
        camera.position.lerp(desired, Math.min(1, dt * 4));
        camera.lookAt(camTmp.set(rover.x, rover.y + CHASE_AIM_Y, rover.z));
      } else {
        roverMesh.updateMatrixWorld(); // this frame's pose, or the seat lags a frame behind the rover
        camera.position.copy(COCKPIT_EYE).applyMatrix4(roverMesh.matrixWorld);
        camera.quaternion.copy(roverMesh.quaternion);
        camera.rotateX(cockpitTilt() + walker.pitch * 0.5);
      }
    }
    if (drill.shake > 0 && mode === "drill") {
      camera.position.x += (Math.random() - 0.5) * drill.shake;
      camera.position.y += (Math.random() - 0.5) * drill.shake;
    }
    camera.updateMatrixWorld();

    // prompts
    const n = near();
    const authorized = hubState?.equipment.authorized ?? [];
    if (mode === "walk" && n) {
      hud.setPrompt(hubState?.nfc.unknown_uid ? `Unknown glove — N to enroll it (Shift+N: crewmate) · ${n.toUpperCase()}`
        : !hubState?.profile ? `Tap glove to identify (N) · ${n.toUpperCase()}`
        : !authorized.includes(n) ? `Tap glove to authorize ${n.toUpperCase()} (N)`
          : `E${hand.active ? " or close your fist" : ""} — ${n === "drill" ? "operate the drill press" : "board rover"}`);
    } else if (mode === "drill") {
      hud.setPrompt(drillPrompt());
    } else if (mode === "rover") {
      hud.setPrompt(hand.active ? "Open hand: accelerate · Fist: brake · A/D: steer · E: exit"
        : "W: throttle · S: brake / reverse · A/D: steer · E: exit");
    } else hud.setPrompt(null);
    hud.setCrosshair(mode === "walk");
    if (mode === "drill") hud.setDrillReadout(drill.readout());
    else hud.setSpeedo(mode === "rover", Math.abs(rover.v) * 3.6, rover.rough,
      THREE.MathUtils.radToDeg(rover.pitch), THREE.MathUtils.radToDeg(rover.roll), roverControls.command);

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

    const tWorld = performance.now();
    const focus = mode === "rover" ? roverFocus.set(rover.x, rover.y, rover.z) : walker.position;
    terrain.update(focus, camera.position);
    rocks.update(focus, camera.position);
    env.follow(focus, camera);
    const tRender = performance.now();
    post.render();
    if (import.meta.env.DEV) {
      const tEnd = performance.now(), info = renderer.info.render;
      Object.assign(frameStats, { calls: info.calls, triangles: info.triangles, points: info.points, lines: info.lines,
        frameCpuMs: smooth(frameStats.frameCpuMs, tEnd - now), worldCpuMs: smooth(frameStats.worldCpuMs, tRender - tWorld),
        renderCpuMs: smooth(frameStats.renderCpuMs, tEnd - tRender) });
      renderer.info.reset(); // autoReset is off: the next frame's passes count from zero
    }
    if (startup.firstFrame === undefined) mark("firstFrame");
  };
  // one bad frame (a NaN pose, a malformed hub message) mustn't freeze the sim: log each distinct error once, go on
  const frameErrors = new Set<string>();
  const loop = () => {
    try {
      frame();
    } catch (err) {
      if (!frameErrors.has(String(err))) {
        frameErrors.add(String(err));
        console.error("frame failed, continuing:", err);
      }
    } finally {
      input.endFrame();
      requestAnimationFrame(loop);
    }
  };
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  if (loading) loading.textContent = `Failed to start: ${err}`;
});
