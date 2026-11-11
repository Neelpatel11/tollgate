import type { Redis } from 'ioredis';

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryKV implements KVStore {
  private readonly data = new Map<string, { value: string; expires: number }>();

  constructor(
    private readonly maxEntries = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<string | null> {
    const hit = this.data.get(key);
    if (!hit) return null;
    if (hit.expires <= this.now()) {
      this.data.delete(key);
      return null;
    }
    this.data.delete(key);
    this.data.set(key, hit);
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.data.delete(key);
    this.data.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
    while (this.data.size > this.maxEntries) {
      const oldest = this.data.keys().next().value;
      if (oldest === undefined) break;
      this.data.delete(oldest);
    }
  }

  get size(): number {
    return this.data.size;
  }
}

export class RedisKV implements KVStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
}
