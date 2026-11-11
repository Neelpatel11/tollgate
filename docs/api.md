# API reference

## Chat completions

`POST /v1/chat/completions` follows the OpenAI Chat Completions format, including streaming. Point any OpenAI SDK at Tollgate by changing `base_url` and using a Tollgate key.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="tg_dev_local_key")
reply = client.chat.completions.create(
    model="smart",
    messages=[{"role": "user", "content": "Summarise this in one line."}],
)
```

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:8080/v1', apiKey: 'tg_dev_local_key' });
const stream = await client.chat.completions.create({
  model: 'fast',
  messages: [{ role: 'user', content: 'Stream a haiku.' }],
  stream: true,
  stream_options: { include_usage: true },
});
```

Supported request fields: `model`, `messages` (text and image parts), `stream`, `stream_options.include_usage`, `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `tools`, `tool_choice`, `response_format`, `seed`, `presence_penalty`, `frequency_penalty`, `user`. `n` must be `1`. Fields a provider has no equivalent for are dropped by that provider's adapter.

### Request headers

| Header | Values | Effect |
|---|---|---|
| `Authorization` | `Bearer <key>` | Required. |
| `x-request-id` | any string | Used as the request id; generated if absent. |
| `x-tollgate-cache` | `bypass`, `force` | `bypass` skips both caches. `force` caches the response even at non-zero temperature. |

### Response headers

| Header | Meaning |
|---|---|
| `x-request-id` | Correlates with logs, traces and usage events. |
| `x-tollgate-alias` | The alias or direct target that was requested. |
| `x-tollgate-provider`, `x-tollgate-model` | What actually served the request. After a failover this differs from the first choice. |
| `x-tollgate-cache` | `hit-exact`, `hit-semantic`, `miss`, `bypass` or `off`. |
| `x-tollgate-attempts` | Upstream attempts made (`0` on a cache hit). |
| `x-tollgate-cost-usd` | Cost of this request. Non-streaming responses only. |

### Errors

Errors use the OpenAI shape: `{"error": {"message", "type", "param", "code"}}`.

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_request`, `unsupported_parameter`, `upstream_rejected` | Bad body, `n > 1`, or the provider rejected the request itself. |
| `401` | `invalid_api_key` | Missing, unknown or revoked key. |
| `403` | `model_not_allowed` | The key's alias allow-list excludes the model. |
| `404` | `model_not_found` | Unknown alias or provider. |
| `429` | `rate_limit_exceeded`, `token_quota_exceeded`, `budget_exceeded` | Includes `Retry-After`. |
| `502` / `504` | `upstream_error` | Every provider in the chain failed. |
| `503` | `providers_unavailable`, `ratelimit_unavailable` | All circuits open, or Redis is down with `failureMode: closed`. |

A stream that fails after it has started ends with a data event containing an `error` object, then `[DONE]`.

## Models

`GET /v1/models` lists the aliases the calling key may use.

## Operations

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness. |
| `GET /readyz` | none | Readiness: providers loaded, Redis and Postgres reachable when configured. |
| `GET /metrics` | none | Prometheus metrics. Expose only on an internal network. |

## Admin API

Requires `Authorization: Bearer $ADMIN_API_KEY`. Disabled (`404`) when `ADMIN_API_KEY` is unset.

### Keys

```bash
curl -X POST localhost:8080/admin/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"rag-service","rpm":300,"tokens_per_day":2000000,"monthly_budget_usd":50,"allowed_aliases":["fast","smart"]}'
```

The response includes the plaintext `key` exactly once. Only a SHA-256 hash is stored.

| Route | Purpose |
|---|---|
| `POST /admin/keys` | Create a key. All limits are optional and fall back to the global defaults. |
| `GET /admin/keys` | List keys (prefix and limits, never the secret). |
| `DELETE /admin/keys/:id` | Revoke. Takes effect on each replica within 15 s (the key cache TTL). |

### Usage

```bash
curl "localhost:8080/admin/usage?group_by=model&from=2026-11-01T00:00:00Z" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

`group_by` is one of `key`, `model`, `provider`, `alias`, `day`. Optional `from`, `to` (ISO 8601) and `key_id`. Each row has `requests`, `input_tokens`, `output_tokens`, `cost_usd`, `saved_usd`, `cache_hits`, `errors` and `avg_latency_ms`.

### Providers

`GET /admin/providers` returns each provider's circuit state and the observed latency per target.

## Usage events

Every request produces one event on the `llm.usage` topic:

```json
{
  "event_id": "…", "ts": "2026-11-11T10:15:02.114Z", "request_id": "req_…",
  "key_id": "…", "alias": "smart", "provider": "anthropic", "model": "claude-sonnet-4-5",
  "input_tokens": 412, "output_tokens": 96, "cached_tokens": 0,
  "cost_usd": 0.002676, "saved_usd": 0, "latency_ms": 1840, "ttft_ms": null,
  "cache": "none", "status": "ok", "http_status": 200, "error_code": null,
  "stream": false, "attempts": 2, "usage_estimated": false
}
```

## Metrics

| Metric | Type | Labels |
|---|---|---|
| `tollgate_requests_total` | counter | `alias`, `provider`, `status`, `cache` |
| `tollgate_request_duration_seconds` | histogram | `alias`, `provider`, `stream` |
| `tollgate_time_to_first_token_seconds` | histogram | `alias`, `provider` |
| `tollgate_gateway_overhead_seconds` | histogram | `phase` |
| `tollgate_tokens_total` | counter | `alias`, `provider`, `model`, `type` |
| `tollgate_cost_usd_total` | counter | `alias`, `provider`, `model` |
| `tollgate_saved_usd_total` | counter | `kind` |
| `tollgate_cache_lookups_total` | counter | `kind`, `result` |
| `tollgate_provider_errors_total` | counter | `provider`, `kind` |
| `tollgate_fallbacks_total` | counter | `alias`, `from` |
| `tollgate_rate_limited_total` | counter | `reason` |
| `tollgate_circuit_state` | gauge | `provider` (0 closed, 1 half-open, 2 open) |
| `tollgate_store_errors_total` | counter | `component` |
| `tollgate_usage_events_dropped_total` | counter | none |
| `tollgate_unpriced_requests_total` | counter | `provider`, `model` |

Traces carry one `tollgate.chat` span per request with `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `tollgate.cost_usd` and `tollgate.attempts`.
