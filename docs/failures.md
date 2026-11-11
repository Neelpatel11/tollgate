# What broke and how it was fixed

A running log of real problems hit while building and testing Tollgate, plus the provider quirks the adapters have to absorb.

## Bugs found by tests

### Aadhaar pattern matched inside longer numbers

The PII redactor matched any 12-digit group with an optional space or dash separator. A 16-digit card number that failed the Luhn check, `4111 1111 1111 1112`, had its first twelve digits replaced with `[AADHAAR]`, leaving `1112` behind. The pattern's boundary check excluded only digits and dashes directly adjacent to the match, not a digit one separator away.

*Fix:* the lookbehind and lookahead now reject a digit even when a single space or dash precedes or follows it (`(?<!\d[\s-]?)` and `(?![\s-]?\d)`). A regression test covers the Luhn-invalid card.

### Test server hung on shutdown after a hung-provider test

The mock provider simulates a hung upstream by sleeping for two minutes. After the timeout test, the gateway had aborted its request, but the mock's sleep kept the connection and the test hook waited for it, failing the suite with a hook timeout even though all 31 tests had passed.

*Fix:* the mock now ends the hang when the client socket closes, and the test server uses `forceCloseConnections`.

### Circuit breaker never ejected a half-broken provider

Found by the failover benchmark, not by a test. With the primary provider failing 50% of requests, 1,471 of 1,500 requests still went to it. Failover still served every request (the backup answered whenever the primary failed), which is why no functional test caught it, but each request had a 50% chance of paying for a failed attempt first. There were two separate defects:

1. **Successes erased the evidence.** The first version cleared its failure count on any success, so with successes and failures interleaved the count never reached the threshold. It now keeps a rolling window of successes and failures and opens when there are at least `failureThreshold` failures and the failure *ratio* is at least `failureRatio` (default 0.5). The ratio also keeps a healthy high-traffic provider with a 1% error rate from tripping it.
2. **Stale in-flight results changed the state.** With 16 requests in flight, requests that started before the breaker opened kept finishing afterwards. A late success closed the open breaker (no half-open probe involved), and a late failure re-tripped it and extended the open period. Instrumenting a live run showed about 30 trips but only 57 denied calls. Now only the designated half-open probe can close the breaker or reopen it; results from other requests are ignored while it is open.

Regression tests cover an alternating pass/fail provider (ejected), a 1% error rate at high traffic (not ejected), and stale results while open (ignored). After the fix the same 50%-failing primary received 16 of 1,500 requests.

*Lesson:* a fault-tolerance feature can be invisible when it is broken, because the thing it protects keeps working. It needs a measurement of how much traffic reaches the unhealthy dependency, not just whether requests succeed. And in concurrent code, state machines need to distinguish results they asked for from results that merely arrive.

### RediSearch reply shape differs by server version

The Redis vector store parsed `FT.SEARCH` replies as the legacy array `[total, key, [field, value, ...]]`. The first run against `redis/redis-stack-server:7.4` returned a map-style reply (`attributes`, `format`, `results`, `total_results`, ...), so every lookup looked like a miss and the integration test failed while the in-memory store passed. Nothing errored; the cache would simply never have hit.

*Fix:* the parser accepts both shapes, with a unit test for each. `FT.INFO` showed the document was indexed with zero indexing failures, which ruled out the index definition before the parser was suspected.

*Lesson:* an in-memory implementation behind an interface proves the logic, not the wire format. The integration suite exists for exactly this.

## Performance

### `fetch` dominated gateway CPU

The first benchmark showed the gateway sustaining about a sixth of the throughput of a direct call to the mock, on the same machine. A CPU profile of the load window was flat: no hot function in gateway code, with time spread across WHATWG `fetch` internals (Request and Response construction, web streams) and Node's HTTP stack.

A controlled experiment, a minimal Fastify proxy to the same mock using `fetch` versus `undici.request`, measured 587 and 704 requests/s for `fetch` against 1,365 and 1,739 requests/s for `undici.request` across two runs each (p50 82 to 103 ms against 34 to 43 ms). The upstream layer was rewritten on `undici.request` with a shared connection pool, and undici's native `headersTimeout` and `bodyTimeout` replaced the manual abort timers. The behavioural test suite passed unchanged.

*Lesson:* measure before tuning. The instinct was to look for slow gateway code; the real cost was the HTTP client.

## Semantic cache

### The dependency-free embedder cannot recognise paraphrases

The local embedder (feature hashing of words, word pairs and character trigrams) exists so development and tests need no API key. The tuning harness (`npm run eval:semantic`, 60 labelled pairs) showed it is not a semantic model:

| | Mean cosine similarity |
|---|---|
| Same-intent pairs ("How do I reset my password?" / "How can I reset my account password?") | 0.581 |
| Different-intent pairs, one word apart ("...with Okta?" / "...with Google?") | 0.751 |

Different-intent pairs scored *higher* than paraphrases, because the embedder measures shared surface text. No threshold separates the classes: at 0.50 it returns the wrong cached answer for 97% of the hard negatives, and by the time the threshold is high enough to reject them (0.89) recall is 0%.

*Outcome:* the default threshold of 0.92 turns the local embedder into a tolerant exact-match cache (casing, punctuation, whitespace). The configuration docs say so explicitly, the semantic cache is off unless an alias opts in, and production use is meant to pair it with a real embedding model after running the same sweep with `--embedder openai`.

## Framework churn

- Fastify 5.12 deprecated the top-level `disableRequestLogging` option. Moved to `logController`.
- An install-time peer-dependency conflict in the lint toolchain was resolved by pinning ESLint 9.

## Provider quirks the adapters absorb

These are not bugs in Tollgate, but each would produce wrong output if ignored. Each has a unit test against a stub server using the provider's real wire format.

**Anthropic**
- `max_tokens` is required; the adapter defaults it to 4096.
- Temperature is limited to 0 to 1; OpenAI allows up to 2, so it is clamped.
- Roles must alternate and tool results live inside a user turn. Consecutive OpenAI `tool` messages are merged into one user message with several `tool_result` blocks.
- Tool arguments stream as `input_json_delta` string fragments that only form valid JSON once concatenated. They are forwarded as OpenAI argument fragments with a stable tool index.
- `input_tokens` excludes cached tokens. Prompt tokens are `input + cache_read + cache_creation`, otherwise cost and quotas are understated.
- An overloaded provider can fail *inside* an open stream with an `error` event and a `200` status.

**Gemini**
- Function calls have no ids; the adapter generates them, and keeps a map from id to function name so a later `tool` message can be turned into a `functionResponse`, which is keyed by name.
- Function declarations accept only a subset of JSON Schema. `additionalProperties`, `$schema` and similar keys cause a `400`, and `["string", "null"]` must become `type: string, nullable: true`. Schemas are pruned recursively.
- Thinking tokens are billed as output. Completion tokens are `candidatesTokenCount + thoughtsTokenCount`.
- A blocked prompt returns no candidate at all, only `promptFeedback`; this is mapped to `finish_reason: content_filter` rather than an empty success.
- Function calls arrive complete in one chunk; a call forces `finish_reason: tool_calls` even though Gemini reports `STOP`.

**OpenAI-compatible servers**
- Streaming usage is only sent when `stream_options.include_usage` is set, so the adapter always sets it and the gateway strips the extra chunk unless the client asked for it.
- Some local servers return no usage at all. Tokens are then estimated and the event is flagged `usage_estimated`.

## Known gaps

- The semantic cache and Redis/Kafka paths are exercised by the integration suite in CI, not by the default `npm test` run on a machine without those services.
- Cost accuracy is only as good as the price book. There is no automated reconciliation against provider invoices; `tollgate_unpriced_requests_total` flags models missing from the book.
- Streaming responses cached from a stream replay in fixed-size text slices, not the original chunk boundaries.
