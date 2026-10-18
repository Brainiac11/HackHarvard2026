// Laptop hand-tracking engine: stream JPEG frames to the hand tracker in handpose/ (Vite proxies /anyhand to it),
// which runs WiLoR or HaMeR on the laptop GPU, and get the same 21 landmarks MediaPipe produces. Two frames in flight
// keep the GPU busy without building a queue; the server only ever works on the newest frame.

export interface Point { x: number; y: number; z: number }
/** One tracked hand from either engine. `hand` is the true handedness as seen by an unmirrored camera. */
export interface Detection { landmarks: Point[]; world: Point[]; hand: string; score: number }

interface RawHand { lm: number[][]; wlm: number[][]; hand: string; score: number }

export type LaptopModel = "wilor" | "hamer";
export const MODEL_NAMES: Record<LaptopModel, string> = { wilor: "WiLoR", hamer: "HaMeR" };

const MAX_IN_FLIGHT = 2;
const STALL_MS = 2000; // a frame unanswered this long is treated as lost
const JPEG_QUALITY = 0.75;

const points = (rows: number[][]): Point[] => rows.map(([x, y, z]) => ({ x, y, z }));

export class AnyHandClient {
  ready = false;
  detail = "not connected";
  // asked for (the server loads it, and may fall back to the other one), or null: whichever the server already serves,
  // adopted from its first status
  model: LaptopModel | null = null;
  serving: LaptopModel = "wilor"; // what produced the latest landmarks
  latencyMs = 0; // capture -> result on the phone
  inferMs = 0; // GPU time on the laptop
  error = ""; // why the laptop's last frame failed ("" once one succeeds)
  onResult: (d: Detection | null) => void = () => {};
  onStatus: (ready: boolean, detail: string) => void = () => {};
  onAdopt: (model: LaptopModel) => void = () => {};
  private ws: WebSocket | null = null;
  private wanted = false;
  private nextId = 1;
  private done = 0;
  private sentAt = new Map<number, number>();
  private encoding = false;
  private canvas = document.createElement("canvas");

  connect(): void {
    this.wanted = true;
    const query = this.model ? `?model=${this.model}` : "";
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/anyhand/ws${query}`);
    this.ws = ws;
    ws.onmessage = (ev) => typeof ev.data === "string" && this.handle(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.setStatus(false, ev.reason || "offline (start it with scripts/dev.sh --anyhand or --hamer)");
      if (this.wanted) setTimeout(() => this.wanted && this.ws === ws && this.connect(), 2000);
    };
  }

  /** Ask for `model` (the server reports "loading …", not ready, until it can serve it), or null: adopt its model. */
  setModel(model: LaptopModel | null): void {
    this.model = model;
    if (model && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "anyhand.model", model }));
  }

  close(): void {
    this.wanted = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus(false, "not connected");
  }

  canSend(now: number): boolean {
    if (!this.ready || this.encoding) return false;
    const oldest = this.sentAt.get(this.done + 1);
    if (oldest !== undefined && now - oldest > STALL_MS) this.markDone(this.nextId - 1);
    return this.nextId - 1 - this.done < MAX_IN_FLIGHT;
  }

  async sendFrame(video: HTMLVideoElement): Promise<void> {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    this.encoding = true;
    try {
      const t = performance.now();
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (!blob || this.ws?.readyState !== WebSocket.OPEN) return;
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const msg = new Uint8Array(4 + jpeg.length);
      const id = this.nextId++;
      new DataView(msg.buffer).setUint32(0, id, true);
      msg.set(jpeg, 4);
      this.sentAt.set(id, t);
      this.ws.send(msg);
    } finally {
      this.encoding = false;
    }
  }

  private handle(msg: any): void {
    if (msg.t === "anyhand.status") {
      if (!this.model && msg.model) {
        this.model = msg.model; // serving it, or loading it
        this.onAdopt(msg.model);
      }
      if (msg.ready) {
        this.markDone(this.nextId - 1); // fresh server state: nothing of ours is in flight
        this.serving = msg.model;
      }
      this.setStatus(!!msg.ready, msg.detail ?? "");
      return;
    }
    if (msg.t !== "anyhand.result" || msg.id <= this.done) return;
    const t = this.sentAt.get(msg.id);
    this.markDone(msg.id);
    if (msg.model) this.serving = msg.model;
    this.error = msg.error ?? "";
    if (t !== undefined) this.latencyMs = performance.now() - t;
    this.inferMs = msg.ms ?? 0;
    const h: RawHand | undefined = msg.hands?.[0];
    this.onResult(h ? { landmarks: points(h.lm), world: points(h.wlm), hand: h.hand, score: h.score } : null);
  }

  private markDone(id: number): void {
    for (const k of this.sentAt.keys()) if (k <= id) this.sentAt.delete(k);
    this.done = Math.max(this.done, id);
  }

  private setStatus(ready: boolean, detail: string): void {
    if (ready === this.ready && detail === this.detail) return;
    this.ready = ready;
    this.detail = detail;
    this.onStatus(ready, detail);
  }
}
