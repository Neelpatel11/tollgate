export class LatencyTracker {
  private readonly ewma = new Map<string, number>();

  constructor(private readonly alpha = 0.3) {}

  record(provider: string, model: string, ms: number): void {
    const key = `${provider}/${model}`;
    const prev = this.ewma.get(key);
    this.ewma.set(key, prev === undefined ? ms : this.alpha * ms + (1 - this.alpha) * prev);
  }

  get(provider: string, model: string): number | undefined {
    return this.ewma.get(`${provider}/${model}`);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.ewma.entries()].map(([k, v]) => [k, Math.round(v)]));
  }
}
