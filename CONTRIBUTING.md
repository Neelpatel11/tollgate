# Contributing

## Setup

```bash
npm ci
npm test            # unit and end-to-end tests, no infrastructure required
npm run lint
npm run typecheck
```

Node 22 or later is required.

## Running the integration suite

The Redis, Postgres and Kafka tests are skipped unless their URLs are set:

```bash
docker compose -f deploy/docker-compose.yml up -d redis postgres redpanda
IT_REDIS_URL=redis://localhost:6379 \
IT_DATABASE_URL=postgres://tollgate:tollgate@localhost:5432/tollgate \
IT_KAFKA_BROKERS=localhost:9092 \
npm test
```

## Adding a provider

1. Implement `ProviderAdapter` in `src/adapters/` (`chat`, `stream`, optionally `embed`). Convert requests and responses to and from the OpenAI format, and report usage including cached tokens.
2. Register the provider `type` in `src/config.ts` and `buildAdapters` in `src/gateway.ts`.
3. Add a stub server test in `tests/adapters.test.ts` using the provider's real wire format, covering a plain response, a streamed response, tool calls and an error.
4. Add prices to `config/prices.yaml`.

## Changing routing or prompts

Run the eval gate before opening a pull request:

```bash
npm run eval:ci
```

A drop in the golden-set score beyond 5 percentage points fails CI. To record a baseline for a live alias, run `npm run eval -- --alias smart` against a running gateway and add the resulting score to `evals/baseline.json`.

## Style

- TypeScript strict mode, no `any` outside tests.
- Comments explain why, not what. Prefer a clear name to a comment.
- Behavioural changes need a test; bug fixes need a regression test.
