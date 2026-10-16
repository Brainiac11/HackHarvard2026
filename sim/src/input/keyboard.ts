/** Keyboard + mouse state. `pressed()` is edge-triggered and cleared each frame by `endFrame()`. */
export class Input {
  private down = new Set<string>();
  private edges = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  mouseRight = false;
  typing = false; // true while a text field has focus: game keys are ignored

  constructor(element: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (this.typing) return;
      if (!this.down.has(e.code)) this.edges.add(e.code);
      this.down.add(e.code);
      if (["Space", "Tab", "Backquote"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.down.delete(e.code));
    addEventListener("blur", () => this.down.clear());
    element.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.mouseRight = true;
      if (document.pointerLockElement !== element) element.requestPointerLock();
    });
    addEventListener("mouseup", (e) => { if (e.button === 2) this.mouseRight = false; });
    element.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === element) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
  }

  held(code: string): boolean { return this.down.has(code); }
  pressed(code: string): boolean { return this.edges.has(code); }
  axis(neg: string, pos: string): number { return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0); }
  shift(): boolean { return this.held("ShiftLeft") || this.held("ShiftRight"); }

  endFrame(): void {
    this.edges.clear();
    this.mouseDX = this.mouseDY = 0;
  }
}
