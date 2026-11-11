# Design decisions

Each entry records the choice, what it costs, and when to revisit it.

## Build, not buy

Mature gateways exist (LiteLLM, Portkey and others), and for most teams adopting one is the right call. Tollgate was built to understand the problem end to end: streaming normalisation, failure handling, cost accounting. The cases where building your own is defensible are a data-residency or compliance boundary that excludes third-party proxies, routing logic tied to your own systems, and a need to own the failure semantics. If none of those apply, evaluate an existing gateway first.

## TypeScript on Fastify

- **Fastify over NestJS.** The gateway is a thin pipeline of about fifteen small modules wired in one place. Dependency-injection decorators would add indirection without removing code. Fastify's per-request overhead is low and it handles raw streaming responses cleanly.
- **Async generators for streaming.** Adapters expose `AsyncGenerator<ChatChunk>`. Backpressure, early termination (client disconnect calls `return()`), and the settle-on-finish accounting all fall out of `try/finally` in one place.
- **`undici.request` over `fetch`.** Profiling showed no hotspot in gateway code; the cost was the WHATWG `fetch` machinery. In a minimal proxy on the same hardware, `undici.request` sustained roughly 2.4x the throughput. It also provides `headersTimeout` and `bodyTimeout` natively, which replaced a hand-written timer.
- **zod for validation.** One schema validates requests and the config file, and produces readable error paths.

## Everything behind an interface, with an in-memory implementation

Cache, rate-limit store, key store, usage sink and vector store are interfaces with in-memory and Redis/Postgres/Kafka implementations. This is why the unit and end-to-end tests run in seconds with no infrastructure, and why a developer can run the gateway with `npm run dev` and nothing else. Redis, Postgres and Kafka behavior is covered by a separate integration suite that CI runs against real services.

## State

- **Redis for shared, disposable state.** Cache entries and rate-limit counters. Losing it degrades behaviour (cold cache, reset counters) but loses no records.
- **Postgres for records.** Keys and usage events.
- **Kafka between the gateway and Postgres.** Usage logging must never sit on the request path or fail a request. A queue absorbs database slowness and lets a consumer batch inserts. Delivery is at-least-once; the consumer inserts with `ON CONFLICT (event_id) DO NOTHING`, which makes redelivery harmless.
- **Revisit when** event volume outgrows Postgres. Swap the consumer's sink for ClickHouse or BigQuery without touching the gateway.

## Rate limiting

- **Token bucket in a Lua script**, so check-and-decrement is atomic across replicas. The script reads `TIME` from Redis rather than trusting each pod's clock.
- **Soft token and budget limits.** They are checked before a request and charged after it. The alternative, reserving an estimated cost up front and reconciling afterwards, makes caps strict but rejects requests that would have fit. For budgets whose purpose is to stop runaway spend, soft is the better trade.
- **Fail open by default.** If Redis is down, serve traffic and count `tollgate_store_errors_total`. Set `failureMode: closed` where overspend is worse than downtime.

## API keys

Keys are 192 random bits, so a fast hash is sufficient: SHA-256, not bcrypt or argon2, whose cost exists to slow brute force of low-entropy passwords and would add milliseconds to every request. Plaintext is shown once. Lookups are cached for 15 seconds per pod, which bounds revocation latency.

## Routing

- **Failover happens before the first streamed chunk, not after.** Once bytes reach the client the response cannot be retried transparently. Failing over earlier is safe; mid-stream failures are surfaced as an `error` event. The alternative, buffering the stream to retry invisibly, would destroy time-to-first-token, which is the reason to stream.
- **Provider-level breaker, not per model.** Outages are overwhelmingly provider- or key-wide. Per-model breakers would take longer to notice and add state.
- **Client errors are not retried or failed over.** A `400` will fail the same way on the next provider, and masking it hides a bug in the caller.
- **`lowest_latency` tries unmeasured targets first.** Otherwise a target that was slow once is never sampled again.

## Caching

- **Exact cache only at temperature 0 unless told otherwise.** Caching a sampled response silently turns a stochastic API into a deterministic one.
- **The exact-cache key is built from the original request**, even when redaction is on. Hashing the redacted text would make two prompts that differ only in an email address share an answer.
- **Semantic cache is off by default and scoped.** Similar questions can need different answers ("cancel my subscription" versus "cancel my order"). Entries are scoped to an exact hash of the system prompt, earlier turns and sampling parameters, so only the final user message may vary, and requests with tools are never served from it. It must be enabled per alias and tuned on labelled pairs (`npm run eval:semantic`).

## Observability

- **`prom-client` for metrics, OpenTelemetry for traces.** Prometheus scraping is the lowest-friction path for dashboards, and the OTel metrics SDK would add a collector hop without adding information. Traces use the `gen_ai.*` attribute names from the OpenTelemetry GenAI semantic conventions so they are portable.
- **Usage events duplicate some metrics on purpose.** Metrics answer "what is happening now" cheaply; events answer "who spent what", which needs per-key granularity that would explode metric cardinality.

## Out of scope

`n > 1`, embeddings, image generation, audio, the Responses API, batch endpoints, and per-organisation hierarchies. Adding an endpoint means a schema, an adapter method and cost rules; none of that conflicts with the current structure.
