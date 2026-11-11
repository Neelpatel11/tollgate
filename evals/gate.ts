import { readFileSync } from 'node:fs';
import type { EvalSummary } from './lib.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const resultPath = arg('results')!;
const baselinePath = arg('baseline', 'evals/baseline.json')!;
const maxDrop = Number(arg('max-drop', '0.05'));

if (!resultPath) {
  console.error('Usage: gate --results <file> [--baseline <file>] [--max-drop 0.05]');
  process.exit(2);
}

const result = JSON.parse(readFileSync(resultPath, 'utf8')) as EvalSummary;
const baselines = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, { score: number }>;
const baseline = baselines[result.alias];

if (!baseline) {
  console.error(`No baseline for alias "${result.alias}" in ${baselinePath}`);
  process.exit(2);
}

const drop = baseline.score - result.score;
console.log(
  `alias=${result.alias} baseline=${(baseline.score * 100).toFixed(1)}% current=${(result.score * 100).toFixed(1)}% drop=${(drop * 100).toFixed(1)}pp allowed=${(maxDrop * 100).toFixed(1)}pp`,
);

if (drop > maxDrop + 1e-9) {
  console.error('Eval gate failed: quality dropped beyond the allowed threshold');
  process.exit(1);
}
console.log('Eval gate passed');
