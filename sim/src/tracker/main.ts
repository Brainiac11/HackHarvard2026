// Phone hand tracker (PLAN.md §9.6): rear camera -> hand landmarks -> hand.frame over wss to the hub.
// Engines: "phone" runs MediaPipe HandLandmarker in the browser; "wilor" and "hamer" stream frames to that model on
// the laptop GPU (handpose/), which copes better with the glove. They fall back to phone while the laptop isn't ready.
// Built for iPhone Safari (playsinline video, GPU->CPU delegate fallback, wake lock) but works on any browser.
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { HandednessFilter } from "../hand/gestures";
import { AnyHandClient, MODEL_NAMES, type Detection, type LaptopModel } from "./anyhand";
import { nextEngine, savedEngine } from "./engines";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("overlay");
const ctx = canvas.getContext("2d")!;
const params = new URLSearchParams(location.search);
const facing = params.get("cam") === "user" ? "user" : "environment";
const mirror = facing === "user"; // laptop-webcam fallback: flip so moving right moves the virtual hand right

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

let ws: WebSocket | null = null;
let landmarker: HandLandmarker | null = null;
let delegate: "GPU" | "CPU" = "GPU";
let rotation = Number(localStorage.getItem("lh.rotation") ?? 0); // 0 | 90 | 180 | 270
let fpsCap = Number(localStorage.getItem("lh.fpsCap") ?? 24);
let nextDue = 0, frames = 0, fpsWindowStart = performance.now(), fps = 0;
let lowFpsStrikes = 0;
let hits = 0, lastHandAt = performance.now(), lostHint = "", reconfiguring = false;
const handedness = new HandednessFilter();

// a saved laptop engine means "use the laptop": it starts on whichever model the laptop serves (anyhand.ts adopts it)
let engine = savedEngine(localStorage.getItem("lh.engine"));
const laptop = new AnyHandClient();
let firstLaptop: LaptopModel | null = null; // the laptop's model when the phone joined it (see nextEngine)

// MediaPipe's hand models are trained on bare hands. A glove (one flat colour, motors and wires on top) scores well
// under the 0.5 defaults, so start at "glove". Lower finds gloved hands more readily but can latch onto other hands.
const SENSITIVITY = { glove: 0.3, max: 0.15, bare: 0.5 } as const;
type Sensitivity = keyof typeof SENSITIVITY;
const savedSens = localStorage.getItem("lh.sens");
let sensitivity: Sensitivity = savedSens && savedSens in SENSITIVITY ? (savedSens as Sensitivity) : "glove";
const confidence = (s: Sensitivity) => ({
  minHandDetectionConfidence: SENSITIVITY[s], minHandPresenceConfidence: SENSITIVITY[s],
  minTrackingConfidence: SENSITIVITY[s],
});

function setMsg(text: string): void { $("msg").textContent = text; }
const usingLaptop = () => engine !== "phone" && laptop.ready;
const otherHand = (h: string) => (h === "Left" ? "Right" : "Left");

// ------------------------------------------------------------------ hub connection
function connect(): void {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/tracker`);
  ws.onopen = () => $("ws").classList.add("on");
  ws.onclose = () => { $("ws").classList.remove("on"); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === "pong") $("rtt").textContent = `${Math.round(performance.now() - msg.ts)} ms`;
  };
}
setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping", ts: performance.now() })), 2000);

// ------------------------------------------------------------------ engines
async function createLandmarker(d: "GPU" | "CPU"): Promise<HandLandmarker> {
  const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  return HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: "/mediapipe/hand_landmarker.task", delegate: d },
    runningMode: "VIDEO",
    numHands: 1,
    ...confidence(sensitivity),
  });
}

async function initModel(): Promise<void> {
  try {
    landmarker = await createLandmarker("GPU");
    delegate = "GPU";
  } catch (err) {
    console.warn("GPU delegate failed, using CPU", err);
    landmarker = await createLandmarker("CPU");
    delegate = "CPU";
  }
  showEngine();
}

async function fallbackToCpu(): Promise<void> {
  if (delegate === "CPU") return;
  setMsg("GPU delegate slow — switching to CPU");
  const gpu = landmarker;
  landmarker = null; // the loop must not run the closed GPU model while the CPU one loads
  delegate = "CPU";
  gpu?.close();
  landmarker = await createLandmarker("CPU");
  showEngine();
}

function fromMediaPipe(r: HandLandmarkerResult): Detection | null {
  if (!r.landmarks.length) return null;
  const c = r.handedness[0]?.[0];
  // MediaPipe labels hands as if the frame were a mirrored selfie; the frames we give it are unmirrored
  return { landmarks: r.landmarks[0], world: r.worldLandmarks[0] ?? [], hand: otherHand(c?.categoryName ?? "Left"),
    score: c?.score ?? 0 };
}

function showEngine(): void {
  $("engine").textContent = `Engine: ${engine === "phone" ? "phone" : laptop.model ? MODEL_NAMES[engine] : "laptop"}`;
  $("delegate").textContent = usingLaptop()
    ? `${MODEL_NAMES[laptop.serving]} ${Math.round(laptop.inferMs)}/${Math.round(laptop.latencyMs)} ms`
    : landmarker ? `MediaPipe ${delegate}` : "no model";
}

const laptopDown = () =>
  `Laptop tracker: ${laptop.detail} — ${landmarker ? "using the phone model meanwhile" : "no phone model to fall back on"}.`;
laptop.onResult = (d) => onDetection(d, performance.now());
laptop.onAdopt = (model) => {
  engine = firstLaptop = model;
  localStorage.setItem("lh.engine", engine);
  showEngine();
};
laptop.onStatus = (ready, detail) => {
  showEngine();
  // ready on the other model means ours failed to load: say why
  if (engine !== "phone") setMsg(!ready ? laptopDown() : laptop.serving !== engine ? detail : "");
};

// ------------------------------------------------------------------ geometry helpers
function rotate2d(x: number, y: number): [number, number] {
  switch (rotation) {
    case 90: return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default: return [x, y];
  }
}
function rotateWorld(x: number, y: number): [number, number] {
  switch (rotation) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

function send(d: Detection | null, hand: string | null): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64_000) return;
  if (!d) return;
  const lm = d.landmarks.map((p) => {
    let [x, y] = rotate2d(p.x, p.y);
    if (mirror) x = 1 - x;
    return [+x.toFixed(4), +y.toFixed(4), +p.z.toFixed(4)];
  });
  const wlm = d.world.map((p) => {
    let [x, y] = rotateWorld(p.x, p.y);
    if (mirror) x = -x;
    return [+x.toFixed(4), +y.toFixed(4), +p.z.toFixed(4)];
  });
  ws.send(JSON.stringify({ t: "hand.frame", ts: Date.now() / 1000, hand: hand ?? "Right",
    score: +d.score.toFixed(3), lm, wlm, fps: +fps.toFixed(1), engine: usingLaptop() ? laptop.serving : "mediapipe" }));
}

function draw(d: Detection | null, hand: string | null): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("hand").textContent = d ? hand ?? "?" : "none";
  if (!d) return;
  const pts = d.landmarks;
  const W = canvas.width, H = canvas.height;
  ctx.lineWidth = 3;
  ctx.strokeStyle = usingLaptop() ? "#5fd08a" : "#f0a83a";
  for (const [a, b] of BONES) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x * W, pts[a].y * H);
    ctx.lineTo(pts[b].x * W, pts[b].y * H);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ loop
function onDetection(d: Detection | null, now: number): void {
  // the sim reads handedness against the landmarks it receives, which we mirror for the selfie camera
  const hand = d ? handedness.update(mirror ? otherHand(d.hand) : d.hand) : null;
  draw(d, hand);
  send(d, hand);
  frames++;
  if (d) {
    hits++;
    lastHandAt = now;
  }
  if (now - fpsWindowStart > 1000) {
    fps = (frames * 1000) / (now - fpsWindowStart);
    $("seen").textContent = `${Math.round((100 * hits) / frames)}%`; // share of frames with a hand found
    frames = hits = 0;
    fpsWindowStart = now;
    $("fps").textContent = fps.toFixed(0);
    showEngine();
    // no hand for a while: say how to get one found, or why the laptop model finds none (it fails every frame)
    const hint = now - lastHandAt <= 3000 ? ""
      : usingLaptop() && laptop.error ? `${MODEL_NAMES[laptop.serving]} is failing on the laptop: ${laptop.error}`
      : `No hand found: show the whole glove, fingers spread, in bright even light${
        usingLaptop() || sensitivity === "max" ? "" : " (or tap Sens)"}`;
    if (hint !== lostHint) {
      lostHint = hint;
      setMsg(hint);
    }
    // iOS: if the GPU delegate can't sustain 12 fps for 3 s, re-create on CPU
    lowFpsStrikes = !usingLaptop() && fps < 12 ? lowFpsStrikes + 1 : 0;
    if (lowFpsStrikes >= 3 && delegate === "GPU") {
      lowFpsStrikes = 0;
      fallbackToCpu();
    }
  }
}

function loop(): void {
  const now = performance.now();
  const schedule = () => ("requestVideoFrameCallback" in video
    ? (video as any).requestVideoFrameCallback(loop) : requestAnimationFrame(loop));
  if (video.readyState >= 2 && now >= nextDue) {
    if (usingLaptop()) {
      if (laptop.canSend(now)) {
        markSent(now);
        void laptop.sendFrame(video); // result arrives via laptop.onResult
      }
    } else if (landmarker && !reconfiguring) {
      markSent(now);
      onDetection(fromMediaPipe(landmarker.detectForVideo(video, now)), now);
    }
  }
  schedule();
}

// Average out to fpsCap. A "time since last send" gate quantises to camera frames: at 30 fps a 24 fps cap needs
// 41.7 ms, so every other frame (66 ms) passes and the real rate drops to 15 fps.
function markSent(now: number): void {
  const interval = 1000 / fpsCap;
  nextDue = Math.max(nextDue + interval, now - interval);
}

async function requestWakeLock(): Promise<void> {
  try {
    await (navigator as any).wakeLock?.request("screen");
  } catch {
    setMsg("Wake lock unavailable — set Auto-Lock to Never");
  }
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && requestWakeLock());

$("rotate").onclick = () => {
  rotation = (rotation + 90) % 360;
  localStorage.setItem("lh.rotation", String(rotation));
  $("rotate").textContent = `Rotate ${rotation}°`;
};
$("rotate").textContent = `Rotate ${rotation}°`;
$("cap").onclick = () => {
  fpsCap = fpsCap === 24 ? 30 : fpsCap === 30 ? 15 : 24;
  localStorage.setItem("lh.fpsCap", String(fpsCap));
  $("cap").textContent = `${fpsCap} fps`;
};
$("cap").textContent = `${fpsCap} fps`;
$("sens").onclick = async () => {
  const order = Object.keys(SENSITIVITY) as Sensitivity[];
  sensitivity = order[(order.indexOf(sensitivity) + 1) % order.length];
  localStorage.setItem("lh.sens", sensitivity);
  $("sens").textContent = `Sens: ${sensitivity}`;
  reconfiguring = true;
  try {
    await landmarker?.setOptions(confidence(sensitivity));
  } finally {
    reconfiguring = false;
  }
};
$("sens").textContent = `Sens: ${sensitivity}`;
let started = false;
$("engine").onclick = () => {
  const was = engine;
  engine = nextEngine(engine, firstLaptop);
  localStorage.setItem("lh.engine", engine);
  if (engine === "phone") {
    firstLaptop = null;
    laptop.close();
    setMsg("");
  } else if (was === "phone") {
    laptop.setModel(null); // join on the laptop's model: asking for WiLoR would unload a HaMeR that dev.sh loaded
    if (started) laptop.connect();
  } else {
    laptop.setModel(engine); // already connected: the server switches models (and says "loading …" meanwhile)
  }
  showEngine();
};
showEngine();

$("start").onclick = async () => {
  $("start").remove();
  setMsg("Starting camera…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    if (mirror) video.style.transform = canvas.style.transform = "scaleX(-1)";
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    started = true;
    if (engine !== "phone") laptop.connect();
    setMsg("Loading hand model…");
    try {
      await initModel(); // also the fallback whenever the laptop engine is unavailable
    } catch (err) {
      if (engine === "phone") throw err;
      console.warn("MediaPipe failed to load; laptop engine only", err); // the laptop engine doesn't need it
    }
    await requestWakeLock();
    if (!usingLaptop()) setMsg(engine === "phone" ? "" : laptopDown());
    connect();
    loop();
  } catch (err) {
    setMsg(`Error: ${err}. Is this page on https and camera access allowed?`);
  }
};
