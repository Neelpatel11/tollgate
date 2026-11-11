import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cosine, LocalHashEmbedder, ProviderEmbedder, type Embedder } from '../../src/cache/semantic.js';
import { OpenAIAdapter } from '../../src/adapters/openai.js';
import type { CallContext } from '../../src/types.js';

interface Pair {
  a: string;
  b: string;
  same: boolean;
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const ctx: CallContext = {
  requestId: 'tune',
  signal: new AbortController().signal,
  timeoutMs: 30_000,
  streamIdleMs: 30_000,
};

const embedderName = arg('embedder', 'local')!;
let embedder: Embedder;
if (embedderName === 'local') {
  embedder = new LocalHashEmbedder();
} else {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is required for --embedder openai');
    process.exit(1);
  }
  const model = arg('model', 'text-embedding-3-small')!;
  embedder = new ProviderEmbedder(
    new OpenAIAdapter({ name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey }),
    model,
    1536,
  );
}

const pairs = JSON.parse(readFileSync(arg('pairs', 'evals/semantic/pairs.json')!, 'utf8')) as Pair[];
const positives = pairs.filter((p) => p.same);
const negatives = pairs.filter((p) => !p.same);

const scored = await Promise.all(
  pairs.map(async (p) => ({
    ...p,
    score: cosine(await embedder.embed(p.a, ctx), await embedder.embed(p.b, ctx)),
  })),
);

const rows: Array<{ threshold: number; recall: number; false_hit_rate: number; precision: number }> = [];
for (let t = 0.5; t <= 0.995; t += 0.01) {
  const threshold = Math.round(t * 100) / 100;
  const tp = scored.filter((s) => s.same && s.score >= threshold).length;
  const fp = scored.filter((s) => !s.same && s.score >= threshold).length;
  rows.push({
    threshold,
    recall: tp / positives.length,
    false_hit_rate: fp / negatives.length,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
  });
}

const target = Number(arg('max-false-hit-rate', '0'));
const eligible = rows.filter((r) => r.false_hit_rate <= target);
const recommended = eligible.length ? eligible.reduce((best, r) => (r.recall > best.recall ? r : best)) : null;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const posMean = mean(scored.filter((s) => s.same).map((s) => s.score));
const negMean = mean(scored.filter((s) => !s.same).map((s) => s.score));

console.log(`embedder=${embedderName} pairs=${pairs.length} (${positives.length} same-intent, ${negatives.length} hard negatives)`);
console.log(`mean similarity: same-intent=${posMean.toFixed(3)} different-intent=${negMean.toFixed(3)}`);
console.log('\nthreshold  recall  false-hit-rate  precision');
for (const r of rows.filter((x) => Math.round(x.threshold * 100) % 5 === 0)) {
  console.log(
    `${r.threshold.toFixed(2)}       ${(r.recall * 100).toFixed(0).padStart(3)}%    ${(r.false_hit_rate * 100).toFixed(0).padStart(3)}%            ${(r.precision * 100).toFixed(0).padStart(3)}%`,
  );
}
if (recommended) {
  console.log(
    `\nhighest recall with false-hit rate <= ${(target * 100).toFixed(1)}%: threshold ${recommended.threshold.toFixed(2)} (recall ${(recommended.recall * 100).toFixed(0)}%)`,
  );
} else {
  console.log(`\nno threshold reaches a false-hit rate <= ${(target * 100).toFixed(1)}%`);
}

const worst = scored
  .filter((s) => !s.same)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);
console.log('\nhighest-scoring hard negatives (would be served the wrong cached answer):');
for (const w of worst) console.log(`  ${w.score.toFixed(3)}  "${w.a}"  vs  "${w.b}"`);

mkdirSync('evals/results', { recursive: true });
writeFileSync(
  `evals/results/semantic-cache-${embedderName}.json`,
  `${JSON.stringify({ embedder: embedderName, pairs: pairs.length, mean_same: posMean, mean_different: negMean, recommended, sweep: rows, pair_scores: scored }, null, 2)}\n`,
);
