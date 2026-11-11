# Configuration

Tollgate is configured with a YAML file (`TOLLGATE_CONFIG`, default `config/tollgate.yaml`) plus environment variables for secrets and backing services. Validate a file without starting the server:

```bash
npm run validate:config -- config/tollgate.yaml
```

Validation checks the schema, that every alias target refers to a declared provider, and that the semantic cache embedder is complete.

## Providers

```yaml
providers:
  openai:
    type: openai            # openai | anthropic | gemini
    apiKeyEnv: OPENAI_API_KEY
  local:
    type: openai            # Ollama, vLLM and LM Studio speak the OpenAI protocol
    baseUrl: http://localhost:11434/v1
    timeoutMs: 60000        # optional per-provider override
```

A provider whose `apiKeyEnv` variable is unset is disabled at startup with a warning, and is dropped from every alias chain. This lets one config file run in environments that have only some keys.

## Aliases

```yaml
aliases:
  smart:
    policy: fallback
    chain:
      - anthropic/claude-sonnet-4-5
      - openai/gpt-4o
    maxRetries: 1
    timeoutMs: 45000
    cache:
      exact: auto           # auto | on | off
      semantic: false
      ttlSeconds: 3600
```

Clients send the alias as `model`. A client may also send `provider/model` (for example `openai/gpt-4o`) to bypass aliases for a one-off call, subject to the key's allow-list.

### Policies

| Policy | Order of attempts |
|---|---|
| `fallback` | Chain order. |
| `lowest_latency` | Ascending exponentially weighted latency (time to first token for streams). Targets with no measurements yet are tried first so every target gets sampled. |
| `cheapest` | Ascending blended price (75% input rate, 25% output rate). Unpriced and local targets count as free. |
| `weighted` | Random order, weighted by each target's `weight`. Use `- target: openai/gpt-4o` with `weight: 3` to split traffic. |

Whatever the order, failover continues down the rest of the chain.

### Cache modes

| `exact` | Behaviour |
|---|---|
| `auto` | Cache only when `temperature` is `0`. |
| `on` | Cache regardless of temperature (use for deterministic prompts). |
| `off` | Never cache. |

Per-request override with the `x-tollgate-cache` header: `bypass` skips both caches, `force` caches even when the alias is `auto` and the temperature is non-zero.

The semantic cache is disabled globally by default and must also be enabled per alias. It is skipped for requests with `tools`, and entries are scoped to the exact system prompt, earlier turns and sampling parameters, so only the final user message can differ.

## Global settings

| Key | Default | Meaning |
|---|---|---|
| `server.requestTimeoutMs` | `30000` | Time to wait for a provider's response headers. |
| `server.streamIdleMs` | `30000` | Maximum silence between streamed chunks. |
| `server.maxRetries` | `1` | Retries on the same provider before failing over. |
| `server.retryBaseDelayMs` | `150` | Base for exponential backoff. |
| `server.bodyLimitBytes` | `4194304` | Maximum request body. |
| `cache.exact.enabled` | `true` | Master switch. |
| `cache.exact.ttlSeconds` | `3600` | Default entry lifetime. |
| `cache.semantic.enabled` | `false` | Master switch. |
| `cache.semantic.threshold` | `0.92` | Minimum cosine similarity for a hit. |
| `cache.semantic.embedder.type` | `local` | `local` (feature hashing, no network) or `provider` (`provider` and `model` required). |
| `rateLimit.defaultRpm` | `60` | Applied to keys without their own limit. |
| `rateLimit.defaultTokensPerDay` | none | Daily token quota. |
| `rateLimit.defaultMonthlyBudgetUsd` | none | Monthly spend cap. |
| `rateLimit.failureMode` | `open` | Behaviour when Redis is unreachable. |
| `circuitBreaker.failureThreshold` | `5` | Minimum failures in the window before the breaker can open. |
| `circuitBreaker.failureRatio` | `0.5` | Minimum share of requests in the window that failed. |
| `circuitBreaker.windowMs` | `30000` | Rolling window for counting results. |
| `circuitBreaker.openMs` | `20000` | Time open before a probe is allowed. |
| `redaction.enabled` | `false` | Mask PII in the upstream copy of requests. |
| `redaction.emails` / `phones` / `cards` / `govIds` | `true` | Categories when enabled. |
| `pricing.file` | none | Price book path. |

### The local embedder

`cache.semantic.embedder.type: local` hashes words, word pairs and character trigrams into a 384-dimension vector. It needs no network and is deterministic, which makes it useful for development and tests. It measures *lexical* overlap, not meaning, so it matches casing and punctuation variants but not paraphrases, and it can rate two questions that differ by one important word as near-identical. Use `type: provider` with a real embedding model in production, and tune the threshold first (see the README section on semantic caching).

## PII redaction

When enabled, these are replaced with placeholders before the request leaves the gateway:

| Category | Placeholder | Notes |
|---|---|---|
| Emails | `[EMAIL]` | |
| Phone numbers | `[PHONE]` | Indian mobile numbers and `+`-prefixed international numbers. |
| Card numbers | `[CARD]` | 13 to 19 digits, only when the Luhn check passes. |
| Government ids | `[PAN]`, `[AADHAAR]`, `[SSN]` | PAN pattern, 12-digit Aadhaar, US SSN. |

Redaction is pattern based. It reduces accidental leakage; it is not a data-loss-prevention system. Only message text is scanned (not tool arguments), and responses are returned unmodified.

## Price book

```yaml
prices:
  - { provider: openai, model: gpt-4o-mini, input_per_mtok: 0.15, output_per_mtok: 0.60, cached_input_per_mtok: 0.075, effective_from: "2024-07-18" }
```

USD per million tokens. When a price changes, add a new row with a later `effective_from`; usage on earlier dates keeps its old price. A request for `gpt-4o-mini-2024-07-18` matches the longest known prefix, `gpt-4o-mini`. The bundled prices are a starting point: confirm them against each provider's pricing page.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address. |
| `LOG_LEVEL` | `info` | `silent` to `trace`. |
| `TOLLGATE_CONFIG` | `config/tollgate.yaml` | Config path. |
| `ADMIN_API_KEY` | unset | Enables `/admin/*` (min 16 characters). |
| `TOLLGATE_DEV_KEY` | unset | Creates a single in-store key at startup. For local use only. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | unset | Named by `apiKeyEnv`. |
| `REDIS_URL` | unset | Enables Redis for cache and limits. Without it, everything is per-process memory. |
| `REDIS_VECTOR_URL` | `REDIS_URL` | Redis with RediSearch for the semantic cache. |
| `DATABASE_URL` | unset | Enables Postgres for keys and usage. |
| `KAFKA_BROKERS`, `KAFKA_TOPIC` | unset, `llm.usage` | Enables the Kafka usage pipeline (requires `DATABASE_URL`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Enables trace export. |

With none of the backing services configured, Tollgate runs entirely in memory, which is how the test suite exercises it.
