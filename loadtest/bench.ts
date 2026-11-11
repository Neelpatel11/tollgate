import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import autocannon from 'autocannon';

const GATEWAY = 'http://127.0.0.1:8099';
const MOCK = 'http://127.0.0.1:9100';
const KEY = 'tg_bench_key_0001';
const DURATION = Number(process.env.BENCH_DURATION ?? 10);

const children: ChildProcess[] = [];

function start(name: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0 && code !== null) console.error(`${name} exited with ${code}`);
  });
  return child;
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function control(port: number, state: Record<string, unknown>): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/control/reset`, { method: 'POST' });
  await fetch(`http://127.0.0.1:${port}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  });
}

const body = (model: string, content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model, messages: [{ role: 'user', content }], ...extra });

interface Stats {
  requests_per_sec: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  errors: number;
  non2xx: number;
  total: number;
}

async function run(url: string, headers: Record<string, string>, payload: string, opts: Partial<autocannon.Options>): Promise<Stats> {
  const result = await autocannon({
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
    duration: DURATION,
    ...opts,
  });
  return {
    requests_per_sec: Math.round(result.requests.average),
    p50_ms: result.latency.p50,
    p95_ms: result.latency.p97_5 ?? result.latency.p99,
    p99_ms: result.latency.p99,
    errors: result.errors + result.timeouts,
    non2xx: result.non2xx,
    total: result.requests.total,
  };
}

async function ttft(url: string, headers: Record<string, string>, payload: string, n: number, concurrency: number): Promise<number[]> {
  const samples: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next++ < n) {
      const t0 = performance.now();
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
      const reader = res.body!.getReader();
      let seen = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!seen && value && new TextDecoder().decode(value).includes('"content":"')) {
          samples.push(performance.now() - t0);
          seen = true;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return samples;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

async function main() {
  mkdirSync('loadtest/results', { recursive: true });
  start('mock', ['mock-provider/main.ts'], { MOCK_PORT: '9100' });
  for (const port of [9101, 9102, 9103, 9104]) start(`mock-${port}`, ['mock-provider/main.ts'], { MOCK_PORT: String(port) });
  start('gateway', ['src/index.ts'], {
    PORT: '8099',
    LOG_LEVEL: 'error',
    TOLLGATE_CONFIG: 'loadtest/bench.yaml',
    TOLLGATE_DEV_KEY: KEY,
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  });
  await Promise.all([
    waitFor(`${MOCK}/control`),
    ...[9101, 9102, 9103, 9104].map((p) => waitFor(`http://127.0.0.1:${p}/control`)),
    waitFor(`${GATEWAY}/healthz`),
  ]);

  const auth = { authorization: `Bearer ${KEY}` };
  const results: Record<string, unknown> = {
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: process.platform },
    duration_s: DURATION,
    note: 'Gateway, mock providers and the load generator share one machine. Treat results as relative overhead, not capacity planning.',
  };

  await control(9100, { latencyMs: 0 });
  const payload = body('bench', 'overhead probe');
  const directPayload = body('mock', 'overhead probe');

  console.log('warmup');
  await run(`${GATEWAY}/v1/chat/completions`, auth, payload, { connections: 16, duration: 3 });
  await run(`${MOCK}/v1/chat/completions`, {}, directPayload, { connections: 16, duration: 3 });

  console.log('sequential overhead (one request at a time, mock latency 0 ms)');
  const seqDirect: number[] = [];
  const seqGateway: number[] = [];
  const seqCall = async (url: string, headers: Record<string, string>, payloadBody: string) => {
    const t0 = performance.now();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payloadBody });
    await res.text();
    return performance.now() - t0;
  };
  for (let i = 0; i < 1000; i++) {
    seqDirect.push(await seqCall(`${MOCK}/v1/chat/completions`, {}, directPayload));
    seqGateway.push(await seqCall(`${GATEWAY}/v1/chat/completions`, auth, payload));
  }
  results.sequential_overhead = {
    requests_each: 1000,
    direct: { p50: +pct(seqDirect, 50).toFixed(2), p95: +pct(seqDirect, 95).toFixed(2), p99: +pct(seqDirect, 99).toFixed(2) },
    gateway: { p50: +pct(seqGateway, 50).toFixed(2), p95: +pct(seqGateway, 95).toFixed(2), p99: +pct(seqGateway, 99).toFixed(2) },
    added_p50: +(pct(seqGateway, 50) - pct(seqDirect, 50)).toFixed(2),
    added_p95: +(pct(seqGateway, 95) - pct(seqDirect, 95)).toFixed(2),
    added_p99: +(pct(seqGateway, 99) - pct(seqDirect, 99)).toFixed(2),
  };

  console.log('overhead at fixed rates (mock latency 0 ms)');
  const overhead: Record<string, unknown>[] = [];
  for (const rate of [200, 500, 1000]) {
    const direct = await run(`${MOCK}/v1/chat/completions`, {}, directPayload, { connections: 32, overallRate: rate });
    const viaGateway = await run(`${GATEWAY}/v1/chat/completions`, auth, payload, { connections: 32, overallRate: rate });
    overhead.push({
      target_rate: rate,
      direct,
      gateway: viaGateway,
      added_p50_ms: +(viaGateway.p50_ms - direct.p50_ms).toFixed(2),
      added_p95_ms: +(viaGateway.p95_ms - direct.p95_ms).toFixed(2),
      added_p99_ms: +(viaGateway.p99_ms - direct.p99_ms).toFixed(2),
    });
  }
  results.overhead = overhead;

  console.log('max sustained throughput');
  const maxDirect = await run(`${MOCK}/v1/chat/completions`, {}, directPayload, { connections: 128 });
  const maxGateway = await run(`${GATEWAY}/v1/chat/completions`, auth, payload, { connections: 128 });
  results.throughput = { direct: maxDirect, gateway: maxGateway };

  console.log('streaming time to first token');
  await control(9100, { latencyMs: 20, streamDelayMs: 2 });
  const streamBody = (model: string) => body(model, 'stream probe', { stream: true });
  const direct = await ttft(`${MOCK}/v1/chat/completions`, {}, streamBody('mock'), 300, 8);
  const gw = await ttft(`${GATEWAY}/v1/chat/completions`, auth, streamBody('bench'), 300, 8);
  results.streaming_ttft_ms = {
    direct: { p50: +pct(direct, 50).toFixed(2), p95: +pct(direct, 95).toFixed(2) },
    gateway: { p50: +pct(gw, 50).toFixed(2), p95: +pct(gw, 95).toFixed(2) },
    added_p50: +(pct(gw, 50) - pct(direct, 50)).toFixed(2),
    added_p95: +(pct(gw, 95) - pct(direct, 95)).toFixed(2),
  };

  const failoverScenario = async (label: string, alias: string, primaryPort: number, primaryState: Record<string, unknown>) => {
    console.log(`failover: ${label}`);
    await control(primaryPort, primaryState);
    await control(9102, { latencyMs: 5 });
    const lat: number[] = [];
    let ok = 0;
    const total = 1500;
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (next++ < total) {
          const t0 = performance.now();
          const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth },
            body: body(alias, `${label} probe ${next}`),
          });
          await res.text();
          lat.push(performance.now() - t0);
          if (res.ok) ok++;
        }
      }),
    );
    const primary = (await (await fetch(`http://127.0.0.1:${primaryPort}/control`)).json()) as { served: number; failed: number };
    return {
      requests: total,
      served_pct: +((ok / total) * 100).toFixed(2),
      requests_that_reached_primary: primary.served + primary.failed,
      slower_than_500ms: lat.filter((l) => l > 500).length,
      p50_ms: +pct(lat, 50).toFixed(1),
      p95_ms: +pct(lat, 95).toFixed(1),
      p99_ms: +pct(lat, 99).toFixed(1),
      max_ms: +Math.max(...lat).toFixed(1),
      wall_s: +((performance.now() - started) / 1000).toFixed(1),
    };
  };

  results.failover_half_errors = await failoverScenario('primary at 50% errors', 'fo_half', 9101, { errorRate: 0.5, latencyMs: 5 });
  results.failover_primary_down = await failoverScenario('primary returning 500', 'fo_down', 9103, { errorRate: 1, latencyMs: 5 });
  results.failover_primary_hanging = await failoverScenario('primary hanging, 1 s timeout', 'fo_hang', 9104, { hangRate: 1 });

  console.log('cache: synthetic zipf workload');
  await control(9100, { latencyMs: 0, replyWords: 120 });
  const distinct = 300;
  const weights = Array.from({ length: distinct }, (_, i) => 1 / (i + 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = Math.random() * sum;
    for (let i = 0; i < distinct; i++) {
      r -= weights[i]!;
      if (r <= 0) return i;
    }
    return distinct - 1;
  };
  const N = 3000;
  let hits = 0;
  let spent = 0;
  let saved = 0;
  for (let i = 0; i < N; i++) {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: body('cached', `question number ${pick()} about the product`, { temperature: 0 }),
    });
    await res.text();
    if (res.headers.get('x-tollgate-cache') === 'hit-exact') hits++;
    spent += Number(res.headers.get('x-tollgate-cost-usd') ?? 0);
  }
  const metrics = await (await fetch(`${GATEWAY}/metrics`)).text();
  const m = /tollgate_saved_usd_total\{kind="exact"\} ([0-9.e+-]+)/.exec(metrics);
  saved = m ? Number(m[1]) : 0;
  results.cache_zipf = {
    requests: N,
    distinct_prompts: distinct,
    hit_rate_pct: +((hits / N) * 100).toFixed(1),
    cost_usd: +spent.toFixed(6),
    saved_usd: +saved.toFixed(6),
    cost_reduction_pct: +((saved / (spent + saved)) * 100).toFixed(1),
  };

  writeFileSync('loadtest/results/bench-local.json', `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) c.kill();
  });
