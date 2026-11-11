import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { splitTarget } from './util/misc.js';

const targetSpec = z.union([
  z.string().refine((s) => /^[^/]+\/.+$/.test(s), 'must look like "provider/model"'),
  z.object({
    target: z.string().refine((s) => /^[^/]+\/.+$/.test(s), 'must look like "provider/model"'),
    weight: z.number().positive().default(1),
  }),
]);

const providerSchema = z.object({
  type: z.enum(['openai', 'anthropic', 'gemini']),
  apiKeyEnv: z.string().optional(),
  baseUrl: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const aliasSchema = z.object({
  policy: z.enum(['fallback', 'lowest_latency', 'cheapest', 'weighted']).default('fallback'),
  chain: z.array(targetSpec).min(1),
  maxRetries: z.number().int().min(0).max(5).optional(),
  timeoutMs: z.number().int().positive().optional(),
  cache: z
    .object({
      exact: z.enum(['auto', 'on', 'off']).default('auto'),
      semantic: z.boolean().default(false),
      ttlSeconds: z.number().int().positive().optional(),
    })
    .prefault({}),
});

export const configSchema = z.object({
  server: z
    .object({
      requestTimeoutMs: z.number().int().positive().default(30_000),
      streamIdleMs: z.number().int().positive().default(30_000),
      maxRetries: z.number().int().min(0).max(5).default(1),
      retryBaseDelayMs: z.number().int().min(0).default(150),
      bodyLimitBytes: z.number().int().positive().default(4 * 1024 * 1024),
    })
    .prefault({}),
  providers: z.record(z.string(), providerSchema),
  aliases: z.record(z.string(), aliasSchema),
  cache: z
    .object({
      exact: z
        .object({
          enabled: z.boolean().default(true),
          ttlSeconds: z.number().int().positive().default(3600),
          maxEntries: z.number().int().positive().default(5000),
        })
        .prefault({}),
      semantic: z
        .object({
          enabled: z.boolean().default(false),
          threshold: z.number().min(0).max(1).default(0.92),
          ttlSeconds: z.number().int().positive().default(3600),
          maxEntries: z.number().int().positive().default(5000),
          embedder: z
            .object({
              type: z.enum(['local', 'provider']).default('local'),
              provider: z.string().optional(),
              model: z.string().optional(),
            })
            .prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
  rateLimit: z
    .object({
      defaultRpm: z.number().int().positive().default(60),
      defaultTokensPerDay: z.number().int().positive().nullable().default(null),
      defaultMonthlyBudgetUsd: z.number().positive().nullable().default(null),
      failureMode: z.enum(['open', 'closed']).default('open'),
    })
    .prefault({}),
  circuitBreaker: z
    .object({
      failureThreshold: z.number().int().positive().default(5),
      failureRatio: z.number().min(0).max(1).default(0.5),
      windowMs: z.number().int().positive().default(30_000),
      openMs: z.number().int().positive().default(20_000),
    })
    .prefault({}),
  redaction: z
    .object({
      enabled: z.boolean().default(false),
      emails: z.boolean().default(true),
      phones: z.boolean().default(true),
      cards: z.boolean().default(true),
      govIds: z.boolean().default(true),
    })
    .prefault({}),
  pricing: z.object({ file: z.string().optional() }).prefault({}),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type AliasConfig = z.infer<typeof aliasSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

export function parseConfig(raw: unknown): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const config = result.data;
  for (const [alias, def] of Object.entries(config.aliases)) {
    for (const entry of def.chain) {
      const { provider } = splitTarget(typeof entry === 'string' ? entry : entry.target);
      if (!config.providers[provider]) {
        throw new Error(`Invalid configuration:\n  - aliases.${alias}: unknown provider "${provider}"`);
      }
    }
  }
  const emb = config.cache.semantic.embedder;
  if (emb.type === 'provider') {
    if (!emb.provider || !emb.model) {
      throw new Error('Invalid configuration:\n  - cache.semantic.embedder: provider and model are required');
    }
    if (!config.providers[emb.provider]) {
      throw new Error(`Invalid configuration:\n  - cache.semantic.embedder: unknown provider "${emb.provider}"`);
    }
  }
  return config;
}

export function loadConfigFile(path: string): GatewayConfig {
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TOLLGATE_CONFIG: z.string().default('config/tollgate.yaml'),
  ADMIN_API_KEY: z.string().min(16).optional(),
  TOLLGATE_DEV_KEY: z.string().min(8).optional(),
  REDIS_URL: z.string().optional(),
  REDIS_VECTOR_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  KAFKA_BROKERS: z.string().optional(),
  KAFKA_TOPIC: z.string().default('llm.usage'),
  KAFKA_CLIENT_ID: z.string().default('tollgate'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('tollgate'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}
