import { readFileSync } from 'node:fs';

export type Check =
  | { type: 'contains'; value: string }
  | { type: 'regex'; value: string }
  | { type: 'exact'; value: string }
  | { type: 'json'; fields: Record<string, string | number | boolean> };

export interface GoldenCase {
  id: string;
  prompt: string;
  system?: string;
  check: Check;
}

export interface CaseResult {
  id: string;
  passed: boolean;
  latency_ms: number;
  cost_usd: number;
  provider: string;
  cache: string;
  status: number;
  output: string;
  error?: string;
}

export interface EvalSummary {
  alias: string;
  base_url: string;
  total: number;
  passed: number;
  score: number;
  p50_ms: number;
  p95_ms: number;
  cost_usd: number;
  providers: Record<string, number>;
  cases: CaseResult[];
}

export const loadCases = (path: string): GoldenCase[] => JSON.parse(readFileSync(path, 'utf8')) as GoldenCase[];

export function evaluate(check: Check, output: string): boolean {
  switch (check.type) {
    case 'contains':
      return output.toLowerCase().includes(check.value.toLowerCase());
    case 'exact':
      return output.trim() === check.value;
    case 'regex':
      return new RegExp(check.value, 'i').test(output);
    case 'json': {
      const start = output.indexOf('{');
      const end = output.lastIndexOf('}');
      if (start === -1 || end <= start) return false;
      try {
        const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
        return Object.entries(check.fields).every(([k, v]) => parsed[k] === v);
      } catch {
        return false;
      }
    }
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export async function runCases(
  baseUrl: string,
  apiKey: string,
  alias: string,
  cases: GoldenCase[],
  concurrency = 4,
): Promise<EvalSummary> {
  const results: CaseResult[] = new Array<CaseResult>(cases.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      const c = cases[i]!;
      const started = performance.now();
      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: alias,
            temperature: 0,
            messages: [...(c.system ? [{ role: 'system', content: c.system }] : []), { role: 'user', content: c.prompt }],
          }),
        });
        const latency = performance.now() - started;
        if (!res.ok) {
          results[i] = {
            id: c.id,
            passed: false,
            latency_ms: latency,
            cost_usd: 0,
            provider: res.headers.get('x-tollgate-provider') ?? 'none',
            cache: res.headers.get('x-tollgate-cache') ?? 'none',
            status: res.status,
            output: '',
            error: (await res.text()).slice(0, 200),
          };
          continue;
        }
        const json = (await res.json()) as { choices: Array<{ message: { content: string | null } }> };
        const output = json.choices[0]?.message.content ?? '';
        results[i] = {
          id: c.id,
          passed: evaluate(c.check, output),
          latency_ms: latency,
          cost_usd: Number(res.headers.get('x-tollgate-cost-usd') ?? 0),
          provider: res.headers.get('x-tollgate-provider') ?? 'none',
          cache: res.headers.get('x-tollgate-cache') ?? 'none',
          status: res.status,
          output,
        };
      } catch (err) {
        results[i] = {
          id: c.id,
          passed: false,
          latency_ms: performance.now() - started,
          cost_usd: 0,
          provider: 'none',
          cache: 'none',
          status: 0,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const providers: Record<string, number> = {};
  for (const r of results) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
  const passed = results.filter((r) => r.passed).length;
  return {
    alias,
    base_url: baseUrl,
    total: results.length,
    passed,
    score: results.length ? passed / results.length : 0,
    p50_ms: Math.round(percentile(results.map((r) => r.latency_ms), 50)),
    p95_ms: Math.round(percentile(results.map((r) => r.latency_ms), 95)),
    cost_usd: results.reduce((s, r) => s + r.cost_usd, 0),
    providers,
    cases: results,
  };
}
