<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img alt="Tollgate: one OpenAI-compatible endpoint for every LLM provider" src="assets/banner-light.svg" width="720">
  </picture>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%3E%3D22-339933.svg">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178c6.svg">
</p>

Tollgate is an LLM gateway. Applications talk to it using the OpenAI API, streaming included, and it decides which provider actually answers: Anthropic, Google Gemini, OpenAI, or a self-hosted model on Ollama or vLLM. Along the way it fails over when a provider is down, caches repeated work, enforces per-key rate limits and spend caps, and records the cost of every request.

Change one line in an existing app (`base_url`) and you get provider independence, outage protection and a spend ledger without touching application code.

## Results

Measured against mock providers on a single laptop (Intel i7-8650U, Windows, Node 22) with the gateway, providers and load generator all on the same machine. Full method and caveats are in [Benchmarks](#benchmarks); raw output is in [loadtest/results/bench-local.json](loadtest/results/bench-local.json).

| Scenario | Result |
|---|---|
| Added latency per request (sequential, 1,000 requests) | **+2.0 ms p50, +1.5 ms p99** over calling the provider directly |
| Added time to first streamed token | within about ±2 ms at p50 |
| Primary provider returning `500` (1,500 requests) | **100% served**; 16 requests reached the dead provider before its circuit opened |
| Primary provider failing 50% of requests | **100% served**; 16 of 1,500 requests reached it |
| Primary provider hanging (1 s timeout) | **100% served**; 33 requests waited out the timeout before the circuit opened, none after |
| Exact cache, synthetic Zipf workload (3,000 requests over 300 prompts) | 90.5% hit rate, **90.5% lower spend** |
| Golden-set eval through a primary failing 40% of requests | 20/20 passed |

These are measured on mocks and a synthetic workload. They show gateway behaviour, not what your providers will do.

## Contents

- [Why a gateway](#why-a-gateway)
- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Using it](#using-it)
- [Routing and failover](#routing-and-failover)
- [Caching](#caching)
- [Rate limits, budgets and cost tracking](#rate-limits-budgets-and-cost-tracking)
- [Observability](#observability)
- [Security](#security)
- [Testing and evaluation](#testing-and-evaluation)
- [Benchmarks](#benchmarks)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [Limitations](#limitations)
- [Further reading](#further-reading)

## Why a gateway

Once more than one service calls an LLM, the same problems appear in every codebase: each team re-implements retries and timeouts, API keys for every provider are scattered across services, nobody can say what a feature costs, and a single provider incident takes products down. A gateway moves those concerns to one place.

| Without a gateway | With Tollgate |
|---|---|
| Each service holds provider keys | Services hold a revocable Tollgate key; provider keys live in one place |
| A provider outage is an application outage | Requests fail over to the next provider in the chain |
| Switching model vendors is a code change | Switching is a config change to an alias |
| Spend is visible on a monthly invoice | Every request has a cost, attributed to a key, a model and a day |
| Identical prompts are paid for repeatedly | Deterministic requests are served from cache at zero cost |
| One runaway loop can burn the budget | Per-key rate limits and monthly caps return `429` |

## Features

**Compatibility**
- OpenAI Chat Completions API: messages, tools, `tool_choice`, `response_format`, images, and server-sent-event streaming with `stream_options.include_usage`.
- Verified against the official OpenAI SDK: if the SDK works unchanged, so does your app.
- Provider adapters for OpenAI, Anthropic (Claude), Google Gemini and any OpenAI-compatible server (Ollama, vLLM, LM Studio). Tool calls, tool results, images, finish reasons and token usage are translated in both directions, including streamed tool-call fragments.

**Reliability**
- Routing by alias with four policies: ordered fallback, lowest latency, cheapest, and weighted split.
- Per-provider circuit breaker with half-open probing, and retries with jittered backoff on retryable errors only (`429`, `5xx`, timeouts).
- Failover that is safe for streams: it happens until the first chunk reaches the client, and mid-stream failures are reported in-band.
- Client disconnects cancel the upstream request, so you do not pay for tokens nobody reads.

**Cost and control**
- Exact-match cache, safe by default (temperature 0 only), with replay as a stream.
- Semantic cache with per-alias opt-in, scoped so it cannot mix answers across system prompts, plus a tuning harness that reports the false-hit rate.
- Per-key requests/minute (atomic Lua token bucket), daily token quota and monthly spend cap, with `429` and `Retry-After`.
- Per-request cost from a dated price book; cache hits record the money they saved.
- Optional PII redaction (emails, phone numbers, Luhn-valid cards, PAN, Aadhaar, SSN) on the copy of the request that leaves the gateway.

**Operations**
- Usage events flow through Kafka into Postgres without ever blocking a request. Admin API for spend by key, model, provider or day.
- Prometheus metrics, OpenTelemetry traces using the GenAI semantic conventions, and a ready-made Grafana dashboard.
- Stateless: scale horizontally behind any load balancer. Helm chart with HPA and PodDisruptionBudget, Terraform for GKE Autopilot, Memorystore and Cloud SQL.
- Runs with no infrastructure at all for development: every backing service has an in-memory implementation.

## How it works

```mermaid
flowchart LR
    client[Client / OpenAI SDK] -->|"POST /v1/chat/completions"| auth

    subgraph gw[Tollgate]
      auth[Auth] --> limits[Rate limit and budget]
      limits --> exact[Exact cache]
      exact --> sem[Semantic cache]
      sem --> router[Router and circuit breaker]
      router --> adapters[Provider adapters]
    end

    adapters --> p1[(Anthropic)]
    adapters --> p2[(OpenAI)]
    adapters --> p3[(Gemini)]
    adapters --> p4[(Ollama / vLLM)]

    limits <--> redis[(Redis)]
    exact <--> redis
    adapters -->|usage event| kafka[(Kafka)] --> pg[(Postgres)]
    gw --> obs[Prometheus / Grafana / Jaeger]
```

The request path is short and ordered: authenticate, rate limit, check caches, pick a provider, call it, normalise the answer, then record usage after the response has been decided. Anything slow or optional (Kafka, Postgres, cache writes) happens off the critical path or fails open. The full lifecycle, failure semantics and cost accounting are in [docs/architecture.md](docs/architecture.md).

## Quick start

Requires Node 22 or later. No API keys and no Docker are needed for the demo: it uses two mock providers.

```bash
git clone <this repository> tollgate && cd tollgate
npm ci

# terminal 1 and 2: a primary and a backup mock provider
npm run mock
npm run mock -- --port 9101

# terminal 3: the gateway, using config/demo.env
npm run demo
```

Send a request:

```bash
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer tg_dev_local_key" -H "content-type: application/json" \
  -d '{"model":"demo","messages":[{"role":"user","content":"Hello"}]}' -i
```

The `x-tollgate-provider` response header shows which provider answered. Now break the primary and send the request again:

```bash
curl -s -XPOST localhost:9100/control -H "content-type: application/json" -d '{"errorRate":1}'
```

The same request now returns `200` with `x-tollgate-provider: backup` and `x-tollgate-attempts: 2`. After three failures the circuit opens and the primary is skipped entirely (`curl -s localhost:8080/admin/providers -H "Authorization: Bearer demo-admin-key-not-for-production"`).

### With real providers

```bash
cp .env.example .env     # add OPENAI_API_KEY, ANTHROPIC_API_KEY and/or GEMINI_API_KEY
npm run dev
```

Edit `config/tollgate.yaml` to define your aliases. Providers whose key is not set are skipped automatically.

### The full stack

Redis, Postgres, Kafka (Redpanda), an OpenTelemetry Collector, Jaeger, Prometheus and Grafana:

```bash
docker compose -f deploy/docker-compose.yml up --build
```

| Service | URL |
|---|---|
| Gateway | http://localhost:8080 |
| Grafana (dashboard: *Tollgate overview*) | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Jaeger | http://localhost:16686 |

Add `--profile mock` to include the mock provider on port 9100.

## Using it

Point any OpenAI client at the gateway. The model name is one of your aliases.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="tg_live_...")
stream = client.chat.completions.create(
    model="fast",
    messages=[{"role": "user", "content": "Explain circuit breakers in two sentences."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Create keys with their own limits through the admin API (needs `ADMIN_API_KEY`):

```bash
curl -X POST localhost:8080/admin/keys -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"support-bot","rpm":120,"monthly_budget_usd":25,"allowed_aliases":["fast"]}'

curl "localhost:8080/admin/usage?group_by=key" -H "Authorization: Bearer $ADMIN_API_KEY"
```

Full request, header, error and metric reference: [docs/api.md](docs/api.md).

## Routing and failover

Applications ask for an alias; the config says what it means:

```yaml
aliases:
  smart:
    policy: fallback
    chain: [anthropic/claude-sonnet-4-5, openai/gpt-4o, google/gemini-2.5-pro]
  fast:
    policy: lowest_latency
    chain: [google/gemini-2.5-flash, openai/gpt-4o-mini, anthropic/claude-haiku-4-5]
  cheap:
    policy: cheapest
    chain: [local/qwen2.5:7b, google/gemini-2.5-flash, openai/gpt-4o-mini]
```

| Policy | Order |
|---|---|
| `fallback` | As written. |
| `lowest_latency` | Fastest observed first (EWMA of time to first token); unmeasured targets are sampled first. |
| `cheapest` | Lowest blended price first; local models count as free. |
| `weighted` | Random, weighted, for splitting traffic or canarying a model. |

What happens when something fails:

| Failure | Behaviour |
|---|---|
| `429`, `5xx`, timeout, network error | Retry with backoff, then fail over to the next target. Counts toward the circuit breaker. |
| `401` / `403` from a provider (bad key) | Fail over, count toward the breaker. |
| `400` / `404` / `422` | Returned to the caller as-is. Another provider will not fix a malformed request. |
| Provider circuit is open | Skipped without a network call. If every provider is open, `503` immediately. |
| Failure before the first stream chunk | Fails over transparently. |
| Failure after the first stream chunk | The response is already on the wire, so an SSE `error` event is sent and the provider is marked unhealthy. |
| Client disconnects | Upstream request cancelled; the provider is not penalised. |

## Caching

**Exact cache.** The key is a hash of the normalised request (model alias, messages, tools, sampling parameters, response format). By default only `temperature: 0` requests are cached, because caching a sampled answer quietly makes a stochastic API deterministic. Override per alias (`exact: on`) or per request (`x-tollgate-cache: force`). A response generated by a streaming request is cached too, and a hit on a streaming request is replayed as a stream.

**Semantic cache.** Embeds the last user message and returns a stored answer when the cosine similarity clears a threshold. It is the riskiest feature here, because two similar questions can need different answers, so it is built defensively:

- Off by default; each alias opts in.
- A hit requires an identical scope: same alias, system prompt, earlier turns and sampling parameters. Only the final user message may differ.
- Never used for requests with `tools`.
- The threshold is meant to be tuned on labelled data, and the repo includes the tool to do it:

```bash
npm run eval:semantic                          # built-in dependency-free embedder
OPENAI_API_KEY=... npm run eval:semantic -- --embedder openai   # a real embedding model
```

`evals/semantic/pairs.json` holds 60 labelled pairs: 30 paraphrases that should hit, and 30 hard negatives that must not ("reset my password" vs "change my password", "15% of 200" vs "15% of 300", "enable 2FA" vs "disable 2FA"). The script sweeps thresholds and reports recall and false-hit rate at each.

Running it with the built-in embedder is instructive. That embedder hashes words and character trigrams, so it needs no network, but it measures surface overlap rather than meaning:

| | Mean similarity |
|---|---|
| Same-intent pairs | 0.581 |
| Different-intent pairs | 0.751 |

Hard negatives score *higher* than paraphrases, so no threshold works: at 0.50 the false-hit rate is 97%, and only at 0.89 does it reach 0%, by which point recall is 0%. At the default 0.92 it therefore behaves as a tolerant exact-match cache (casing, punctuation, whitespace). That is the right behaviour for a fallback with no model behind it, and exactly why the semantic cache is opt-in. Use a real embedding model (`cache.semantic.embedder.type: provider`), run the sweep with it, and choose your threshold from the false-hit rate you can tolerate.

## Rate limits, budgets and cost tracking

Each API key can carry its own limits; anything unset falls back to the global defaults.

| Limit | Mechanism | Exceeded |
|---|---|---|
| Requests per minute | Token bucket, atomic Lua script in Redis, time taken from Redis | `429` + `Retry-After` |
| Tokens per day | Counter per key per UTC day | `429`, `token_quota_exceeded` |
| Spend per month | Counter in micro-dollars per key per UTC month | `429`, `budget_exceeded` |

The per-minute limit is exact. The token and spend limits are checked before a request and charged after it, so requests already in flight can overshoot a cap by their own cost; [docs/decisions.md](docs/decisions.md) explains why that trade is deliberate.

**Cost** comes from the provider's reported token usage and a price book with effective dates (`config/prices.yaml`), so a price change never rewrites history. Cached prompt tokens are priced at the cached rate. When a provider reports no usage, tokens are estimated and the event is flagged `usage_estimated`. A model missing from the price book is served at zero cost and counted in `tollgate_unpriced_requests_total`, so a gap is visible. Prices in the repo are a starting point: check them against each provider's pricing page before using the numbers for billing.

Every request emits one event (key, alias, provider, model, tokens, cost, saved cost, latency, time to first token, cache outcome, status, attempts). Events go to Kafka, a consumer writes them to Postgres idempotently, and the admin API aggregates them. If Kafka is down, events queue in bounded memory and the oldest are dropped with a counter; a request is never delayed or failed by the usage pipeline.

## Observability

- **Metrics** at `/metrics`: request rate and errors by alias, provider and cache outcome; latency and time-to-first-token histograms; gateway overhead; tokens and cost; cache lookups and savings; fallbacks; circuit state; limiter rejections; absorbed backend errors and dropped usage events.
- **Dashboard** in [dashboards/tollgate.json](dashboards/tollgate.json), provisioned automatically by the Compose stack.
- **Traces** via OTLP, one `tollgate.chat` span per request with `gen_ai.*` attributes, token counts, cost and attempts.
- **Logs** are structured JSON; authorization headers are redacted and prompts are never logged.

## Security

- Gateway keys are 192 random bits, stored only as SHA-256 hashes, shown once, and revocable. Provider keys never leave the gateway.
- Keys can be restricted to specific aliases.
- The admin API is off unless `ADMIN_API_KEY` is set, and compares keys in constant time.
- Request bodies are size-limited and schema-validated.
- Optional PII redaction on the outbound copy of each request. It is pattern based and reduces accidental leakage; it is not a data-loss-prevention product.
- `/metrics` is unauthenticated, as Prometheus scrapers expect. Keep it on an internal network.
- Containers run as a non-root user with a read-only root filesystem in the Helm chart.

## Testing and evaluation

```bash
npm test             # 79 unit and end-to-end tests, no infrastructure needed, about 10 s
npm run lint && npm run typecheck
npm run eval:ci      # golden set through the gateway with a failing primary provider
```

- **End to end.** The suite starts real mock providers and a real gateway on ephemeral ports and drives them with the official OpenAI SDK and plain HTTP: streaming, failover before the first chunk, breaker opening and no further calls to the failed provider, `502` and `503` behaviour, caches (including stream replay and warming from a stream), the semantic cache's scoping, rate limits and `Retry-After`, budgets, key scoping and revocation, cost accuracy, and an aborted stream.
- **Adapters.** Anthropic and Gemini are tested against stub servers speaking each provider's real wire format: request translation, tool-call round trips, fragmented streamed tool arguments, usage mapping and error classification.
- **Integration.** `tests/integration/` runs the Redis Lua limiter, RediSearch vector lookups, Postgres migrations and idempotent inserts, and the Kafka sink against real services. They are skipped unless `IT_REDIS_URL`, `IT_DATABASE_URL` and `IT_KAFKA_BROKERS` are set, and CI provides all three.
- **Eval gate.** `evals/golden.json` holds 20 cases (arithmetic, extraction to JSON, classification, refusal when the answer is absent) with deterministic checks. CI runs them through a gateway whose primary provider fails 40% of requests and fails the build if the score drops more than 5 points below `evals/baseline.json`. In CI the providers are mocks, so the gate protects the gateway's plumbing: failover, normalisation and caching must not corrupt answers. To gate model quality, run `npm run eval -- --alias smart` against live providers and record the score as a baseline.

## Benchmarks

`npm run bench` starts a mock provider (instant responses unless told otherwise), several failure-injecting mocks and the gateway as separate processes, then runs every scenario below. `loadtest/k6/` has equivalent k6 scripts for a Compose or cluster deployment. All numbers here are from the Node benchmark, which writes `loadtest/results/bench-local.json`.

**Overhead.** One request at a time, 1,000 requests each, alternating direct-to-mock and through-the-gateway so both see the same machine state. Measuring with no concurrency removes queueing, so the difference is the gateway's own cost: auth, validation, rate-limit check, routing, normalisation, usage accounting.

| | p50 | p95 | p99 |
|---|---|---|---|
| Direct to provider | 13.6 ms | 17.1 ms | 18.8 ms |
| Through Tollgate | 15.6 ms | 19.0 ms | 20.3 ms |
| **Added** | **+2.0 ms** | **+1.9 ms** | **+1.5 ms** |

(The 13 ms floor is this Windows machine's loopback and timer behaviour; it is identical on both paths.) Across four runs the added p50 stayed between +2.0 and +2.3 ms.

**Streaming.** Time to first token over 300 streamed requests, 8 at a time, with the mock adding 20 ms of latency: added p50 was between -1.7 and +2.1 ms across runs, i.e. indistinguishable from direct.

**Failover.** 1,500 requests, 16 concurrent, to an alias whose primary is broken and whose backup is healthy:

| Primary | Served | Reached the primary | Notes |
|---|---|---|---|
| Returns `500` on every request | 100% | 16 | Circuit opens after the first few failures; p99 72 ms or less |
| Fails 50% of requests at random | 100% | 16 | Ejected on failure ratio even though successes are interleaved |
| Never answers (1 s timeout) | 100% | n/a | 33 requests waited about 1 s before the circuit opened; after that, p50 33 ms |

The 16 requests that reach the primary are the ones already in flight when the circuit opens (concurrency was 16). This scenario is what exposed two bugs in the first version of the breaker; see [docs/failures.md](docs/failures.md).

**Cache.** 3,000 requests at temperature 0 drawn from 300 distinct prompts with a Zipf popularity distribution: 90.5% hit rate, spend down by 90.5%, because every request costs the same here. A real workload's hit rate depends entirely on how repetitive it is, so treat this as a check that the savings accounting works, not a forecast.

**Throughput.** Pushing 128 connections at the gateway with a zero-latency provider sustained between 650 and 1,600 requests/s per process across runs, depending on what else the laptop was doing (the direct-to-mock rate in the same runs was 2,800 to 4,500). One Node process on a shared 15 W laptop CPU is not a capacity figure; scale horizontally and measure on your own hardware.

**Fixed-rate runs at 200, 500 and 1,000 requests/s** are recorded in the results file but are not summarised here. On this machine the open-loop load generator shares CPU and a coarse Windows timer with the system under test, so tail latencies swing by more than the effect being measured (some runs even show the gateway faster than direct at p95). Use the sequential figure for per-request overhead and the k6 scripts on separate hosts for rate-based numbers.

**Not measured:** cost reconciliation against provider dashboards (needs real provider accounts and a day of traffic), the semantic cache with a real embedding model (needs an API key; see [Caching](#caching)), and anything on Kubernetes or GKE.

## Deployment

| Target | Where | Notes |
|---|---|---|
| Local, no dependencies | `npm run demo` | Everything in memory. |
| Docker Compose | `deploy/docker-compose.yml` | Full stack with observability. |
| Kubernetes | `deploy/helm/tollgate` | Deployment, Service, HPA, PodDisruptionBudget, usage consumer, migration hook, optional ServiceMonitor. |
| GCP | `deploy/terraform` | GKE Autopilot, Memorystore, Cloud SQL, Artifact Registry. See its README for the install flow and Kafka and RediSearch notes. |

CI (`.github/workflows/ci.yml`) runs lint, type-check, config validation and the test suite against live Redis, Postgres and Redpanda, then the eval gate, `helm lint` and `helm template`, `terraform validate`, `docker compose config` and a container build.

The gateway holds no state of its own. Run several replicas behind a load balancer; limits and caches are shared through Redis, and a replica can be killed at any time (in-flight streams on that replica end, which clients should retry).

## Project layout

```
src/
  adapters/      OpenAI, Anthropic and Gemini translation
  router/        policies, circuit breaker, latency tracking
  cache/         exact cache, semantic cache, KV and vector stores
  ratelimit/     token bucket (memory and Redis Lua), budgets
  auth/          API key hashing and stores
  usage/         usage events, Kafka sink
  db/            Postgres stores and migrations runner
  telemetry/     Prometheus metrics, OpenTelemetry
  service.ts     the request pipeline
  server.ts      HTTP routes
consumer/        Kafka to Postgres usage writer
mock-provider/   configurable fake LLM server: latency, errors, hangs
evals/           golden set, CI gate, semantic cache tuning
loadtest/        Node benchmark and k6 scripts, saved results
deploy/          Docker Compose, Helm, Terraform
dashboards/      Grafana dashboard
docs/            architecture, configuration, API, decisions, failures
tests/           unit, end-to-end and integration tests
```

## Limitations

- Chat completions only. No embeddings, images, audio, Responses API or batch endpoints; `n` must be `1`.
- The semantic cache needs a real embedding model to be useful, and RediSearch (Redis Stack or Redis 8) to be shared across replicas. Memorystore does not provide RediSearch.
- Token and budget limits are soft (see above).
- Cost accuracy depends on the price book; there is no automatic reconciliation with provider invoices.
- The Kafka client uses plaintext connections; managed Kafka services that require SASL need that option added in `src/usage/kafka.ts`.
- Single-region design: Redis and Postgres are the shared state.

## Further reading

- [docs/architecture.md](docs/architecture.md): request lifecycle, adapter differences, failure semantics, cost accounting
- [docs/configuration.md](docs/configuration.md): every config key and environment variable
- [docs/api.md](docs/api.md): endpoints, headers, errors, usage events, metrics
- [docs/decisions.md](docs/decisions.md): why it is built this way, and the trade-offs
- [docs/failures.md](docs/failures.md): what broke while building it, and provider quirks
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
