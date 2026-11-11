CREATE TABLE IF NOT EXISTS api_keys (
  id                  UUID PRIMARY KEY,
  name                TEXT        NOT NULL,
  key_hash            TEXT        NOT NULL UNIQUE,
  prefix              TEXT        NOT NULL,
  rpm                 INTEGER,
  tokens_per_day      BIGINT,
  monthly_budget_usd  NUMERIC(12, 4),
  allowed_aliases     TEXT[],
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id         TEXT PRIMARY KEY,
  ts               TIMESTAMPTZ      NOT NULL,
  request_id       TEXT             NOT NULL,
  key_id           TEXT             NOT NULL,
  alias            TEXT             NOT NULL,
  provider         TEXT             NOT NULL,
  model            TEXT             NOT NULL,
  input_tokens     INTEGER          NOT NULL,
  output_tokens    INTEGER          NOT NULL,
  cached_tokens    INTEGER          NOT NULL DEFAULT 0,
  cost_usd         DOUBLE PRECISION NOT NULL,
  saved_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms       INTEGER          NOT NULL,
  ttft_ms          INTEGER,
  cache            TEXT             NOT NULL,
  status           TEXT             NOT NULL,
  http_status      INTEGER          NOT NULL,
  error_code       TEXT,
  stream           BOOLEAN          NOT NULL,
  attempts         INTEGER          NOT NULL,
  usage_estimated  BOOLEAN          NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts);
CREATE INDEX IF NOT EXISTS usage_events_key_ts_idx ON usage_events (key_id, ts);

CREATE TABLE IF NOT EXISTS model_prices (
  provider               TEXT           NOT NULL,
  model                  TEXT           NOT NULL,
  input_per_mtok         NUMERIC(12, 6) NOT NULL,
  output_per_mtok        NUMERIC(12, 6) NOT NULL,
  cached_input_per_mtok  NUMERIC(12, 6),
  effective_from         DATE           NOT NULL,
  PRIMARY KEY (provider, model, effective_from)
);
