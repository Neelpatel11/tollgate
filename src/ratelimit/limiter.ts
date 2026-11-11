import type { ApiKeyRecord } from '../auth/keys.js';
import { GatewayError, rateLimited, unavailable } from '../errors.js';
import type { LimitStore } from './store.js';

export interface LimitDefaults {
  rpm: number;
  tokensPerDay: number | null;
  monthlyBudgetUsd: number | null;
}

export type LimitFailureMode = 'open' | 'closed';

const MICRO = 1_000_000;

const dayStamp = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const monthStamp = (d: Date) => d.toISOString().slice(0, 7).replace('-', '');

function secondsUntilNextUtcDay(d: Date): number {
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.ceil((next - d.getTime()) / 1000);
}

function secondsUntilNextUtcMonth(d: Date): number {
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.ceil((next - d.getTime()) / 1000);
}

export class RateLimiter {
  constructor(
    private readonly store: LimitStore,
    private readonly defaults: LimitDefaults,
    private readonly failureMode: LimitFailureMode,
    private readonly onStoreError: (err: unknown) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(key: ApiKeyRecord): Promise<void> {
    try {
      const rpm = key.rpm ?? this.defaults.rpm;
      const decision = await this.store.takeRequest(key.id, rpm);
      if (!decision.allowed) {
        throw rateLimited(`Rate limit of ${rpm} requests/minute exceeded`, decision.retryAfterMs / 1000);
      }

      const date = this.now();
      const tokenLimit = key.tokensPerDay ?? this.defaults.tokensPerDay;
      if (tokenLimit !== null) {
        const used = await this.store.counter(`tg:tok:${key.id}:${dayStamp(date)}`);
        if (used >= tokenLimit) {
          throw rateLimited(
            `Daily token limit of ${tokenLimit} reached`,
            secondsUntilNextUtcDay(date),
            'token_quota_exceeded',
          );
        }
      }

      const budget = key.monthlyBudgetUsd ?? this.defaults.monthlyBudgetUsd;
      if (budget !== null) {
        const spent = await this.store.counter(`tg:spend:${key.id}:${monthStamp(date)}`);
        if (spent / MICRO >= budget) {
          throw rateLimited(
            `Monthly budget of $${budget.toFixed(2)} exhausted`,
            secondsUntilNextUtcMonth(date),
            'budget_exceeded',
          );
        }
      }
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      this.onStoreError(err);
      if (this.failureMode === 'closed') {
        throw unavailable('Rate limit backend unavailable', 'ratelimit_unavailable');
      }
    }
  }

  async record(key: ApiKeyRecord, tokens: number, costUsd: number): Promise<void> {
    const date = this.now();
    try {
      if (tokens > 0) {
        await this.store.add(`tg:tok:${key.id}:${dayStamp(date)}`, tokens, secondsUntilNextUtcDay(date) + 3600);
      }
      if (costUsd > 0) {
        await this.store.add(
          `tg:spend:${key.id}:${monthStamp(date)}`,
          Math.round(costUsd * MICRO),
          secondsUntilNextUtcMonth(date) + 86_400,
        );
      }
    } catch (err) {
      this.onStoreError(err);
    }
  }

  async spendThisMonth(keyId: string): Promise<number> {
    return (await this.store.counter(`tg:spend:${keyId}:${monthStamp(this.now())}`)) / MICRO;
  }
}
