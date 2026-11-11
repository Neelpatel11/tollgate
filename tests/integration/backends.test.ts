import { Kafka, logLevel } from 'kafkajs';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisKV } from '../../src/cache/kv.js';
import { LocalHashEmbedder, RedisVectorStore } from '../../src/cache/semantic.js';
import { createPool, migrate, PgKeyStore, PgUsageRepository } from '../../src/db/pg.js';
import { RedisLimitStore } from '../../src/ratelimit/store.js';
import { KafkaUsageSink } from '../../src/usage/kafka.js';
import type { UsageEvent } from '../../src/usage/events.js';

const REDIS_URL = process.env.IT_REDIS_URL;
const DATABASE_URL = process.env.IT_DATABASE_URL;
const KAFKA_BROKERS = process.env.IT_KAFKA_BROKERS;

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  event_id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  request_id: 'req_it',
  key_id: 'key-it',
  alias: 'smart',
  provider: 'openai',
  model: 'gpt-4o-mini',
  input_tokens: 10,
  output_tokens: 20,
  cached_tokens: 0,
  cost_usd: 0.001,
  saved_usd: 0,
  latency_ms: 120,
  ttft_ms: null,
  cache: 'none',
  status: 'ok',
  http_status: 200,
  error_code: null,
  stream: false,
  attempts: 1,
  usage_estimated: false,
  ...over,
});

describe.skipIf(!REDIS_URL)('redis', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('enforces the token bucket atomically in Lua', async () => {
    const store = new RedisLimitStore(redis);
    const id = `it-${crypto.randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => store.takeRequest(id, 5)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.find((r) => !r.allowed)?.retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps counters with expiry', async () => {
    const store = new RedisLimitStore(redis);
    const name = `tg:it:${crypto.randomUUID()}`;
    await store.add(name, 5, 60);
    expect(await store.add(name, 7, 60)).toBe(12);
    expect(await store.counter(name)).toBe(12);
    expect(await redis.ttl(name)).toBeGreaterThan(0);
  });

  it('round-trips cache values with a TTL', async () => {
    const kv = new RedisKV(redis);
    const key = `tg:it:kv:${crypto.randomUUID()}`;
    await kv.set(key, 'value', 30);
    expect(await kv.get(key)).toBe('value');
  });

  it('finds a semantically similar vector within its scope using RediSearch', async () => {
    const embedder = new LocalHashEmbedder();
    const store = new RedisVectorStore(redis, embedder.dimensions, `tg:it:idx:${Date.now()}`, `tg:it:sem:${Date.now()}:`);
    const scope = crypto.randomUUID().replace(/-/g, '');
    const entry = { response: {} as never, costUsd: 0.01, provider: 'p', model: 'm', storedAt: Date.now() };
    await store.add(scope, await embedder.embed('how do i reset my password'), entry, 60);
    const hit = await store.search(scope, await embedder.embed('how do i reset my password'));
    if (!hit) {
      const idx = `tg:it:idx:dbg`;
      const info = await redis.call('FT.INFO', (store as unknown as { index: string }).index);
      const all = await redis.call('FT.SEARCH', (store as unknown as { index: string }).index, '*', 'LIMIT', '0', '3', 'RETURN', '1', 'scope');
      const raw = await redis.call('FT.SEARCH', (store as unknown as { index: string }).index, `@scope:{${scope}}`, 'RETURN', '1', 'scope');
      console.log('DBG', idx, JSON.stringify(info), JSON.stringify(all), JSON.stringify(raw), scope);
    }
    expect(hit?.score).toBeGreaterThan(0.99);
    expect(await store.search('f'.repeat(32), await embedder.embed('how do i reset my password'))).toBeNull();
  });
});

describe.skipIf(!DATABASE_URL)('postgres', () => {
  const pool = DATABASE_URL ? createPool(DATABASE_URL) : undefined;
  afterAll(async () => {
    await pool?.end();
  });

  it('applies migrations idempotently', async () => {
    await migrate(pool!);
    expect(await migrate(pool!)).toEqual([]);
  });

  it('stores keys by hash and supports revocation', async () => {
    const store = new PgKeyStore(pool!);
    const { record, plaintext } = await store.create({ name: 'it-key', rpm: 5, allowedAliases: ['smart'] });
    const found = await store.findByHash(record.keyHash);
    expect(found?.rpm).toBe(5);
    expect(found?.allowedAliases).toEqual(['smart']);
    expect(plaintext.startsWith('tg_')).toBe(true);
    expect(await store.revoke(record.id)).toBe(true);
    expect((await store.findByHash(record.keyHash))?.revokedAt).not.toBeNull();
  });

  it('inserts usage events idempotently and aggregates them', async () => {
    const repo = new PgUsageRepository(pool!);
    const keyId = `it-${crypto.randomUUID()}`;
    const a = event({ key_id: keyId, cost_usd: 0.5 });
    const b = event({ key_id: keyId, cost_usd: 0.25, cache: 'exact', saved_usd: 0.25 });
    await repo.insertMany([a, b]);
    await repo.insertMany([a]);
    const rows = await repo.summarize({ groupBy: 'key', keyId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 2, cache_hits: 1 });
    expect(rows[0]?.cost_usd).toBeCloseTo(0.75, 6);
  });
});

describe.skipIf(!KAFKA_BROKERS)('kafka', () => {
  it('delivers usage events published by the sink', async () => {
    const topic = `llm.usage.it.${Date.now()}`;
    const brokers = KAFKA_BROKERS!.split(',');
    const kafka = new Kafka({ clientId: 'it', brokers, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
    await admin.disconnect();

    const sink = new KafkaUsageSink({ brokers, topic, clientId: 'it-sink', flushIntervalMs: 50 });
    const sent = event({ key_id: 'kafka-it' });
    sink.emit(sent);

    const consumer = kafka.consumer({ groupId: `it-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const received = await new Promise<UsageEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for event')), 20_000);
      void consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timer);
          resolve(JSON.parse(message.value!.toString()) as UsageEvent);
        },
      });
    });
    expect(received.event_id).toBe(sent.event_id);
    await consumer.disconnect();
    await sink.close();
  }, 40_000);

  it('buffers events without throwing while the broker is unreachable and reports drops', async () => {
    let dropped = 0;
    const sink = new KafkaUsageSink({
      brokers: ['127.0.0.1:1'],
      topic: 'unreachable',
      clientId: 'it-down',
      maxQueue: 5,
      flushIntervalMs: 20,
      onDrop: (n) => (dropped += n),
    });
    for (let i = 0; i < 20; i++) sink.emit(event());
    expect(sink.pending).toBeLessThanOrEqual(5);
    expect(dropped).toBeGreaterThanOrEqual(15);
    await sink.close();
  }, 30_000);
});
