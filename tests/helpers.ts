import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { loadEnv, parseConfig, type GatewayConfig } from '../src/config.js';
import { createGateway, type Gateway, type GatewayOverrides } from '../src/gateway.js';
import { PriceBook } from '../src/pricing.js';
import { buildMock, type Fixture, type MockState } from '../mock-provider/server.js';

export const API_KEY = 'tg_test_key_0001';
export const ADMIN_KEY = 'admin-key-for-tests-0001';

export interface MockHandle {
  app: FastifyInstance;
  url: string;
  control(state: Partial<MockState>): Promise<void>;
  served(): Promise<number>;
  failed(): Promise<number>;
  close(): Promise<void>;
}

export async function startMock(state: Partial<MockState> = {}, fixtures: Fixture[] = []): Promise<MockHandle> {
  const app = await buildMock({ state, fixtures });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const get = async () => (await (await fetch(`${url}/control`)).json()) as { served: number; failed: number };
  return {
    app,
    url,
    control: async (s) => {
      await fetch(`${url}/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(s),
      });
    },
    served: async () => (await get()).served,
    failed: async () => (await get()).failed,
    close: () => app.close(),
  };
}

export const TEST_PRICES = new PriceBook([
  { provider: 'a', model: 'm', input_per_mtok: 1, output_per_mtok: 2, effective_from: '2020-01-01' },
  { provider: 'b', model: 'm', input_per_mtok: 1, output_per_mtok: 2, effective_from: '2020-01-01' },
  { provider: 'a', model: 'pricey', input_per_mtok: 100, output_per_mtok: 200, effective_from: '2020-01-01' },
]);

export interface TestGateway {
  gateway: Gateway;
  app: FastifyInstance;
  base: string;
  close(): Promise<void>;
}

export function baseConfig(a: string, b: string, extra: Record<string, unknown> = {}): GatewayConfig {
  return parseConfig({
    server: { requestTimeoutMs: 2000, streamIdleMs: 2000, maxRetries: 0, retryBaseDelayMs: 1 },
    providers: {
      a: { type: 'openai', baseUrl: `${a}/v1` },
      b: { type: 'openai', baseUrl: `${b}/v1` },
    },
    aliases: {
      smart: { policy: 'fallback', chain: ['a/m', 'b/m'] },
      only_a: { policy: 'fallback', chain: ['a/m'] },
      det: { policy: 'fallback', chain: ['a/m'], cache: { exact: 'on' } },
      faq: { policy: 'fallback', chain: ['a/m'], cache: { exact: 'off', semantic: true } },
    },
    cache: { semantic: { enabled: true, threshold: 0.8, embedder: { type: 'local' } } },
    rateLimit: { defaultRpm: 1000 },
    circuitBreaker: { failureThreshold: 3, windowMs: 10_000, openMs: 60_000 },
    ...extra,
  });
}

export async function startGateway(
  config: GatewayConfig,
  overrides: GatewayOverrides = {},
  envOverrides: Record<string, string> = {},
): Promise<TestGateway> {
  const env = {
    ...loadEnv({}),
    TOLLGATE_DEV_KEY: API_KEY,
    ADMIN_API_KEY: ADMIN_KEY,
    ...envOverrides,
  };
  const gateway = await createGateway(config, env, pino({ level: 'silent' }), {
    prices: TEST_PRICES,
    ...overrides,
  });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  return { gateway, app: gateway.app, base, close: () => gateway.close() };
}

export async function chat(
  base: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  key = API_KEY,
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
}

export const userMsg = (content: string) => [{ role: 'user', content }];

export async function readSse(res: Response): Promise<{ chunks: Array<Record<string, any>>; done: boolean }> {
  const text = await res.text();
  const chunks: Array<Record<string, any>> = [];
  let done = false;
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') done = true;
    else chunks.push(JSON.parse(data) as Record<string, any>);
  }
  return { chunks, done };
}
