import type { Redis } from 'ioredis';

export interface LimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface LimitStore {
  takeRequest(id: string, perMinute: number): Promise<LimitDecision>;
  counter(name: string): Promise<number>;
  add(name: string, amount: number, ttlSeconds: number): Promise<number>;
}

export class MemoryLimitStore implements LimitStore {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();
  private readonly counters = new Map<string, { value: number; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async takeRequest(id: string, perMinute: number): Promise<LimitDecision> {
    const now = this.now();
    const ratePerMs = perMinute / 60_000;
    const bucket = this.buckets.get(id) ?? { tokens: perMinute, ts: now };
    const tokens = Math.min(perMinute, bucket.tokens + (now - bucket.ts) * ratePerMs);
    if (tokens >= 1) {
      this.buckets.set(id, { tokens: tokens - 1, ts: now });
      return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterMs: 0 };
    }
    this.buckets.set(id, { tokens, ts: now });
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil((1 - tokens) / ratePerMs) };
  }

  async counter(name: string): Promise<number> {
    const entry = this.counters.get(name);
    if (!entry || entry.expires <= this.now()) return 0;
    return entry.value;
  }

  async add(name: string, amount: number, ttlSeconds: number): Promise<number> {
    const now = this.now();
    const existing = this.counters.get(name);
    const base = existing && existing.expires > now ? existing : { value: 0, expires: now + ttlSeconds * 1000 };
    base.value += amount;
    this.counters.set(name, base);
    return base.value;
  }
}

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + (now - ts) * rate)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate) * 2)
return {allowed, math.floor(tokens), retry}
`;

export class RedisLimitStore implements LimitStore {
  constructor(private readonly redis: Redis) {
    this.redis.defineCommand('tgTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  }

  async takeRequest(id: string, perMinute: number): Promise<LimitDecision> {
    const fn = (this.redis as unknown as Record<string, (...a: unknown[]) => Promise<number[]>>).tgTokenBucket;
    const [allowed, remaining, retry] = await fn!.call(this.redis, `tg:rl:${id}`, perMinute, perMinute / 60_000);
    return { allowed: allowed === 1, remaining: remaining ?? 0, retryAfterMs: retry ?? 0 };
  }

  async counter(name: string): Promise<number> {
    const value = await this.redis.get(name);
    return value ? Number(value) : 0;
  }

  async add(name: string, amount: number, ttlSeconds: number): Promise<number> {
    const results = await this.redis.multi().incrby(name, amount).expire(name, ttlSeconds, 'NX').exec();
    const value = results?.[0]?.[1];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }
}
