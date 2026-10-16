import type { HubMessage } from "./messages";

type Handler<T> = (msg: T) => void;

/** Reconnecting WebSocket to the hub (same origin; Vite proxies /ws to the hub). */
export class HubClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler<any>>>();
  private backoff = 500;
  connected = false;
  onStatus: (connected: boolean) => void = () => {};

  constructor(private path = "/ws/sim") {
    this.connect();
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this.onStatus(true);
    };
    ws.onmessage = (ev) => {
      let msg: HubMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handlers.get(msg.t)?.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus(false);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  on<K extends HubMessage["t"]>(type: K, handler: Handler<Extract<HubMessage, { t: K }>>): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  action(action: string, args: Record<string, unknown> = {}): void {
    this.send({ t: "ui.action", action, args });
  }
}
