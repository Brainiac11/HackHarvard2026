// Phone hand tracker (PLAN.md §9.6): rear camera -> MediaPipe HandLandmarker -> hand.frame over wss to the hub.
// Built for iPhone Safari (playsinline video, GPU->CPU delegate fallback, wake lock) but works on any browser.
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

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
let lastSent = 0, frames = 0, fpsWindowStart = performance.now(), fps = 0;
let lowFpsStrikes = 0;

function setMsg(text: string): void { $("msg").textContent = text; }

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

// ------------------------------------------------------------------ model
async function createLandmarker(d: "GPU" | "CPU"): Promise<HandLandmarker> {
  const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  return HandLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: "/mediapipe/hand_landmarker.task", delegate: d },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
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
  $("delegate").textContent = delegate;
}

async function fallbackToCpu(): Promise<void> {
  if (delegate === "CPU") return;
  setMsg("GPU delegate slow — switching to CPU");
  landmarker?.close();
  landmarker = await createLandmarker("CPU");
  delegate = "CPU";
  $("delegate").textContent = delegate;
}

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

function send(result: HandLandmarkerResult): void {
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64_000) return;
  if (!result.landmarks.length) return;
  const lm = result.landmarks[0].map((p) => {
    let [x, y] = rotate2d(p.x, p.y);
    if (mirror) x = 1 - x;
    return [+x.toFixed(4), +y.toFixed(4), +p.z.toFixed(4)];
  });
  const wlm = (result.worldLandmarks[0] ?? []).map((p) => {
    let [x, y] = rotateWorld(p.x, p.y);
    if (mirror) x = -x;
    return [+x.toFixed(4), +y.toFixed(4), +p.z.toFixed(4)];
  });
  const handed = result.handedness[0]?.[0];
  ws.send(JSON.stringify({ t: "hand.frame", ts: Date.now() / 1000, hand: handed?.categoryName ?? "Right",
    score: +(handed?.score ?? 0).toFixed(3), lm, wlm, fps: +fps.toFixed(1) }));
}

function draw(result: HandLandmarkerResult): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const pts = result.landmarks[0];
  $("hand").textContent = pts ? `${result.handedness[0]?.[0]?.categoryName ?? "?"}` : "none";
  if (!pts) return;
  const W = canvas.width, H = canvas.height;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#f0a83a";
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
function loop(): void {
  const now = performance.now();
  const schedule = () => ("requestVideoFrameCallback" in video
    ? (video as any).requestVideoFrameCallback(loop) : requestAnimationFrame(loop));
  if (!landmarker || video.readyState < 2 || now - lastSent < 1000 / fpsCap - 2) {
    schedule();
    return;
  }
  lastSent = now;
  const result = landmarker.detectForVideo(video, now);
  draw(result);
  send(result);
  frames++;
  if (now - fpsWindowStart > 1000) {
    fps = (frames * 1000) / (now - fpsWindowStart);
    frames = 0;
    fpsWindowStart = now;
    $("fps").textContent = fps.toFixed(0);
    // iOS: if the GPU delegate can't sustain 12 fps for 3 s, re-create on CPU
    lowFpsStrikes = fps < 12 ? lowFpsStrikes + 1 : 0;
    if (lowFpsStrikes >= 3 && delegate === "GPU") {
      lowFpsStrikes = 0;
      fallbackToCpu();
    }
  }
  schedule();
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
    setMsg("Loading hand model…");
    await initModel();
    await requestWakeLock();
    setMsg("");
    connect();
    loop();
  } catch (err) {
    setMsg(`Error: ${err}. Is this page on https and camera access allowed?`);
  }
};
