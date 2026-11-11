export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold: number;
  windowMs: number;
  openMs: number;
  failureRatio?: number;
}

interface Bucket {
  second: number;
  ok: number;
  failed: number;
}

export class CircuitBreaker {
  private buckets: Bucket[] = [];
  private openedAt = 0;
  private current: BreakerState = 'closed';
  private probeInFlight = false;
  private readonly ratio: number;

  constructor(
    private readonly opts: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.ratio = opts.failureRatio ?? 0.5;
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.opts.openMs) {
      return 'half_open';
    }
    return this.current;
  }

  retryInMs(): number {
    if (this.current !== 'open') return 0;
    return Math.max(0, this.opts.openMs - (this.now() - this.openedAt));
  }

  allow(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    this.current = 'half_open';
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  success(): void {
    if (this.current === 'half_open') {
      this.probeInFlight = false;
      this.buckets = [];
      this.current = 'closed';
      return;
    }
    if (this.current === 'closed') this.bucket().ok++;
  }

  failure(): void {
    const now = this.now();
    if (this.current === 'half_open') {
      this.probeInFlight = false;
      this.trip(now);
      return;
    }
    if (this.current === 'open') return;
    this.bucket().failed++;
    let failed = 0;
    let total = 0;
    for (const b of this.buckets) {
      failed += b.failed;
      total += b.ok + b.failed;
    }
    if (failed >= this.opts.failureThreshold && failed / total >= this.ratio) this.trip(now);
  }

  release(): void {
    this.probeInFlight = false;
  }

  private bucket(): Bucket {
    const now = this.now();
    const cutoff = now - this.opts.windowMs;
    while (this.buckets.length > 0 && this.buckets[0]!.second * 1000 <= cutoff) this.buckets.shift();
    const second = Math.floor(now / 1000);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.second === second) return last;
    const created: Bucket = { second, ok: 0, failed: 0 };
    this.buckets.push(created);
    return created;
  }

  private trip(now: number): void {
    this.current = 'open';
    this.openedAt = now;
    this.buckets = [];
  }
}

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly opts: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get(provider: string): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(this.opts, this.now);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  snapshot(): Record<string, { state: BreakerState; retryInMs: number }> {
    return Object.fromEntries(
      [...this.breakers.entries()].map(([name, b]) => [name, { state: b.state, retryInMs: b.retryInMs() }]),
    );
  }
}
