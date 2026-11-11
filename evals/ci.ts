import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pino } from 'pino';
import { buildMock, loadFixtures } from '../mock-provider/server.js';
import { loadEnv, parseConfig } from '../src/config.js';
import { createGateway } from '../src/gateway.js';
import { PriceBook } from '../src/pricing.js';
import { loadCases, runCases } from './lib.js';

const fixtures = loadFixtures('evals/fixtures.json');
const primary = await buildMock({ fixtures, state: { errorRate: 0.4, latencyMs: 5 } });
const secondary = await buildMock({ fixtures, state: { latencyMs: 8 } });
await primary.listen({ port: 0, host: '127.0.0.1' });
await secondary.listen({ port: 0, host: '127.0.0.1' });
const url = (app: typeof primary) => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1`;

const config = parseConfig({
  server: { requestTimeoutMs: 3000, maxRetries: 0 },
  providers: {
    primary: { type: 'openai', baseUrl: url(primary) },
    secondary: { type: 'openai', baseUrl: url(secondary) },
  },
  aliases: {
    golden: { policy: 'fallback', chain: ['primary/mock', 'secondary/mock'] },
  },
  rateLimit: { defaultRpm: 100_000 },
  circuitBreaker: { failureThreshold: 5, windowMs: 30_000, openMs: 10_000 },
});

const env = { ...loadEnv({}), TOLLGATE_DEV_KEY: 'tg_eval_ci_key' };
const gateway = await createGateway(config, env, pino({ level: 'silent' }), {
  prices: new PriceBook([
    { provider: 'primary', model: 'mock', input_per_mtok: 1, output_per_mtok: 2, effective_from: '2020-01-01' },
    { provider: 'secondary', model: 'mock', input_per_mtok: 1, output_per_mtok: 2, effective_from: '2020-01-01' },
  ]),
});
await gateway.app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;

const summary = await runCases(base, 'tg_eval_ci_key', 'golden', loadCases('evals/golden.json'), 4);
mkdirSync('evals/results', { recursive: true });
writeFileSync('evals/results/golden.json', `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  `golden: ${summary.passed}/${summary.total} passed, p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms, providers=${JSON.stringify(summary.providers)}`,
);

await gateway.close();
await primary.close();
await secondary.close();
