import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadCases, runCases } from './lib.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const baseUrl = arg('base-url', process.env.EVAL_BASE_URL ?? 'http://localhost:8080')!;
const apiKey = arg('api-key', process.env.EVAL_API_KEY)!;
const alias = arg('alias', process.env.EVAL_ALIAS ?? 'smart')!;
const cases = loadCases(arg('cases', 'evals/golden.json')!);
const out = arg('out', `evals/results/${alias}.json`)!;

if (!apiKey) {
  console.error('Set EVAL_API_KEY or pass --api-key');
  process.exit(1);
}

const summary = await runCases(baseUrl, apiKey, alias, cases);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);

console.log(`alias=${alias} score=${summary.passed}/${summary.total} (${(summary.score * 100).toFixed(1)}%)`);
console.log(`latency p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms cost=$${summary.cost_usd.toFixed(6)}`);
console.log(`providers: ${JSON.stringify(summary.providers)}`);
for (const c of summary.cases.filter((r) => !r.passed)) {
  console.log(`  FAIL ${c.id}: ${c.error ?? JSON.stringify(c.output.slice(0, 80))}`);
}
console.log(`written to ${out}`);
