// One Euro filter (Casiez et al. 2012): low jitter at rest, low lag when moving fast.

class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null { return this.y; }
}

const alphaFor = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;

  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1.0) {}

  filter(value: number, t: number): number {
    const dt = this.lastT === null ? 1 / 30 : Math.max(1e-3, t - this.lastT);
    this.lastT = t;
    const prev = this.x.last();
    const deriv = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(deriv, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

/** Filters an array of 3-vectors (e.g. 21 landmarks). */
export class OneEuroPoints {
  private filters: OneEuro[][] = [];
  constructor(private minCutoff = 1.2, private beta = 0.02) {}
  filter(points: number[][], t: number): number[][] {
    return points.map((p, i) => {
      if (!this.filters[i]) this.filters[i] = [0, 1, 2].map(() => new OneEuro(this.minCutoff, this.beta));
      return p.map((v, k) => this.filters[i][k].filter(v, t));
    });
  }
  reset(): void { this.filters = []; }
}
