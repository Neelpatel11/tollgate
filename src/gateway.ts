import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { CachedKeyStore, MemoryKeyStore, type KeyStore } from './auth/keys.js';
import { ExactCache } from './cache/exact.js';
import { MemoryKV, RedisKV } from './cache/kv.js';
import {
  LocalHashEmbedder,
  MemoryVectorStore,
  ProviderEmbedder,
  RedisVectorStore,
  SemanticCache,
  type Embedder,
  type VectorStore,
} from './cache/semantic.js';
import type { Env, GatewayConfig } from './config.js';
import { createPool, PgKeyStore, PgUsageRepository } from './db/pg.js';
import { PriceBook } from './pricing.js';
import { RateLimiter } from './ratelimit/limiter.js';
import { MemoryLimitStore, RedisLimitStore, type LimitStore } from './ratelimit/store.js';
import { BreakerRegistry } from './router/circuit-breaker.js';
import { LatencyTracker } from './router/latency.js';
import { Router } from './router/router.js';
import { buildApp } from './server.js';
import { ChatService } from './service.js';
import { Metrics } from './telemetry/metrics.js';
import type { ProviderAdapter } from './types.js';
import {
  MemoryUsageStore,
  type UsageRepository,
  type UsageSink,
} from './usage/events.js';
import { KafkaUsageSink } from './usage/kafka.js';

export interface GatewayOverrides {
  adapters?: Map<string, ProviderAdapter>;
  prices?: PriceBook;
  keys?: KeyStore;
  limitStore?: LimitStore;
  usageSink?: UsageSink;
  usageRepo?: UsageRepository;
  now?: () => number;
}

export interface Gateway {
  app: FastifyInstance;
  breakers: BreakerRegistry;
  metrics: Metrics;
  keys: KeyStore;
  usageStore?: MemoryUsageStore;
  close(): Promise<void>;
}

function buildAdapters(config: GatewayConfig, log: FastifyBaseLogger): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  for (const [name, p] of Object.entries(config.providers)) {
    const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    if (p.type === 'openai') {
      if (p.apiKeyEnv && !apiKey) {
        log.warn({ provider: name, env: p.apiKeyEnv }, 'provider disabled: API key variable is not set');
        continue;
      }
      adapters.set(
        name,
        new OpenAIAdapter({
          name,
          baseUrl: p.baseUrl ?? 'https://api.openai.com/v1',
          apiKey,
          headers: p.headers,
        }),
      );
    } else {
      if (!apiKey) {
        log.warn({ provider: name, env: p.apiKeyEnv }, 'provider disabled: API key variable is not set');
        continue;
      }
      adapters.set(
        name,
        p.type === 'anthropic'
          ? new AnthropicAdapter({ name, apiKey, baseUrl: p.baseUrl })
          : new GeminiAdapter({ name, apiKey, baseUrl: p.baseUrl }),
      );
    }
  }
  return adapters;
}

export async function createGateway(
  config: GatewayConfig,
  env: Env,
  logger: FastifyBaseLogger,
  overrides: GatewayOverrides = {},
): Promise<Gateway> {
  const closers: Array<() => Promise<void>> = [];

  const adapters = overrides.adapters ?? buildAdapters(config, logger);
  const prices =
    overrides.prices ?? (config.pricing.file ? PriceBook.fromFile(config.pricing.file) : PriceBook.empty());

  const breakers = new BreakerRegistry(config.circuitBreaker, overrides.now);
  const latency = new LatencyTracker();
  const metrics = new Metrics(breakers, !overrides.adapters);
  const router = new Router(config, new Set(adapters.keys()), prices, latency);

  let redis: Redis | undefined;
  if (env.REDIS_URL) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
    closers.push(async () => void redis!.disconnect());
  }

  let pool: pg.Pool | undefined;
  if (env.DATABASE_URL) {
    pool = createPool(env.DATABASE_URL);
    closers.push(() => pool!.end());
  }

  const limitStore = overrides.limitStore ?? (redis ? new RedisLimitStore(redis) : new MemoryLimitStore());
  const limiter = new RateLimiter(
    limitStore,
    {
      rpm: config.rateLimit.defaultRpm,
      tokensPerDay: config.rateLimit.defaultTokensPerDay,
      monthlyBudgetUsd: config.rateLimit.defaultMonthlyBudgetUsd,
    },
    config.rateLimit.failureMode,
    () => metrics.storeErrors.inc({ component: 'ratelimit' }),
  );

  const keys: KeyStore =
    overrides.keys ?? (pool ? new CachedKeyStore(new PgKeyStore(pool)) : new MemoryKeyStore());
  if (env.TOLLGATE_DEV_KEY && !overrides.keys) {
    await keys.create({ name: 'dev' }, env.TOLLGATE_DEV_KEY);
    logger.warn('TOLLGATE_DEV_KEY is set: a development API key is active');
  }

  let usageSink: UsageSink;
  let usageRepo: UsageRepository;
  let usageStore: MemoryUsageStore | undefined;
  if (overrides.usageSink && overrides.usageRepo) {
    usageSink = overrides.usageSink;
    usageRepo = overrides.usageRepo;
  } else if (env.KAFKA_BROKERS && pool) {
    usageSink = new KafkaUsageSink({
      brokers: env.KAFKA_BROKERS.split(',').map((b) => b.trim()),
      topic: env.KAFKA_TOPIC,
      clientId: env.KAFKA_CLIENT_ID,
      onDrop: (n) => metrics.usageDropped.inc(n),
      onError: (err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'kafka publish failed'),
    });
    usageRepo = new PgUsageRepository(pool);
  } else if (pool) {
    const repo = new PgUsageRepository(pool);
    usageRepo = repo;
    usageSink = {
      emit: (e) => void repo.insertMany([e]).catch(() => metrics.usageDropped.inc()),
      close: async () => undefined,
    };
  } else {
    usageStore = new MemoryUsageStore();
    usageSink = usageStore;
    usageRepo = usageStore;
  }
  closers.push(() => usageSink.close());

  let exactCache: ExactCache | undefined;
  if (config.cache.exact.enabled) {
    const kv = redis ? new RedisKV(redis) : new MemoryKV(config.cache.exact.maxEntries);
    exactCache = new ExactCache(kv, config.cache.exact.ttlSeconds);
  }

  let semanticCache: SemanticCache | undefined;
  const sem = config.cache.semantic;
  if (sem.enabled) {
    let embedder: Embedder;
    if (sem.embedder.type === 'provider') {
      const adapter = adapters.get(sem.embedder.provider!);
      if (!adapter?.embed) throw new Error(`Semantic cache embedder provider "${sem.embedder.provider}" is unavailable`);
      embedder = new ProviderEmbedder(adapter, sem.embedder.model!, 1536);
    } else {
      embedder = new LocalHashEmbedder();
    }
    let vectorRedis = redis;
    if (env.REDIS_VECTOR_URL) {
      vectorRedis = new Redis(env.REDIS_VECTOR_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
      vectorRedis.on('error', (err) => logger.warn({ err: err.message }, 'redis vector store error'));
      const client = vectorRedis;
      closers.push(async () => void client.disconnect());
    }
    const store: VectorStore = vectorRedis
      ? new RedisVectorStore(vectorRedis, embedder.dimensions)
      : new MemoryVectorStore(sem.maxEntries);
    semanticCache = new SemanticCache(embedder, store, sem.threshold, sem.ttlSeconds);
  }

  const service = new ChatService({
    config,
    adapters,
    router,
    breakers,
    latency,
    prices,
    limiter,
    usage: usageSink,
    metrics,
    logger,
    exactCache,
    semanticCache,
  });

  const app = await buildApp({
    service,
    keys,
    usage: usageRepo,
    metrics,
    router,
    breakers,
    latency,
    adminKey: env.ADMIN_API_KEY,
    bodyLimit: config.server.bodyLimitBytes,
    logger,
    readiness: async () => {
      const checks: Record<string, boolean> = { providers: adapters.size > 0 };
      if (redis) checks.redis = (await redis.ping().catch(() => 'ERR')) === 'PONG';
      if (pool) checks.postgres = await pool.query('SELECT 1').then(() => true, () => false);
      return checks;
    },
  });

  return {
    app,
    breakers,
    metrics,
    keys,
    usageStore,
    close: async () => {
      await app.close();
      for (const close of closers.reverse()) await close().catch(() => undefined);
    },
  };
}
