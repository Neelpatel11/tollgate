import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { buildRecord, generateKey, type ApiKeyRecord, type KeyStore, type NewKeyInput } from '../auth/keys.js';
import type { UsageEvent, UsageQuery, UsageRepository, UsageSummaryRow } from '../usage/events.js';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function migrate(pool: pg.Pool, dir = 'migrations'): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return ran;
}

interface KeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  rpm: number | null;
  tokens_per_day: string | null;
  monthly_budget_usd: string | null;
  allowed_aliases: string[] | null;
  created_at: Date;
  revoked_at: Date | null;
}

const toRecord = (row: KeyRow): ApiKeyRecord => ({
  id: row.id,
  name: row.name,
  keyHash: row.key_hash,
  prefix: row.prefix,
  rpm: row.rpm,
  tokensPerDay: row.tokens_per_day === null ? null : Number(row.tokens_per_day),
  monthlyBudgetUsd: row.monthly_budget_usd === null ? null : Number(row.monthly_budget_usd),
  allowedAliases: row.allowed_aliases,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
});

export class PgKeyStore implements KeyStore {
  constructor(private readonly pool: pg.Pool) {}

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.pool.query<KeyRow>('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(input: NewKeyInput, plaintext = generateKey()) {
    const record = buildRecord(input, plaintext);
    await this.pool.query(
      `INSERT INTO api_keys (id, name, key_hash, prefix, rpm, tokens_per_day, monthly_budget_usd, allowed_aliases)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.name,
        record.keyHash,
        record.prefix,
        record.rpm,
        record.tokensPerDay,
        record.monthlyBudgetUsd,
        record.allowedAliases,
      ],
    );
    return { record, plaintext };
  }

  async list(): Promise<ApiKeyRecord[]> {
    const { rows } = await this.pool.query<KeyRow>('SELECT * FROM api_keys ORDER BY created_at DESC');
    return rows.map(toRecord);
  }

  async revoke(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}

const GROUP_SQL: Record<UsageQuery['groupBy'], string> = {
  key: 'key_id',
  model: "provider || '/' || model",
  provider: 'provider',
  alias: 'alias',
  day: "to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
};

export class PgUsageRepository implements UsageRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertMany(events: UsageEvent[]): Promise<void> {
    if (events.length === 0) return;
    const cols = [
      'event_id',
      'ts',
      'request_id',
      'key_id',
      'alias',
      'provider',
      'model',
      'input_tokens',
      'output_tokens',
      'cached_tokens',
      'cost_usd',
      'saved_usd',
      'latency_ms',
      'ttft_ms',
      'cache',
      'status',
      'http_status',
      'error_code',
      'stream',
      'attempts',
      'usage_estimated',
    ] as const;
    const values: unknown[] = [];
    const tuples = events.map((e, row) => {
      const placeholders = cols.map((c, i) => {
        values.push(e[c]);
        return `$${row * cols.length + i + 1}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await this.pool.query(
      `INSERT INTO usage_events (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (event_id) DO NOTHING`,
      values,
    );
  }

  async summarize(query: UsageQuery): Promise<UsageSummaryRow[]> {
    const group = GROUP_SQL[query.groupBy];
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.from) where.push(`ts >= $${params.push(query.from)}`);
    if (query.to) where.push(`ts < $${params.push(query.to)}`);
    if (query.keyId) where.push(`key_id = $${params.push(query.keyId)}`);
    const { rows } = await this.pool.query(
      `SELECT ${group} AS "group",
              count(*)::int AS requests,
              coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
              coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
              coalesce(sum(cost_usd), 0) AS cost_usd,
              coalesce(sum(saved_usd), 0) AS saved_usd,
              count(*) FILTER (WHERE cache <> 'none')::int AS cache_hits,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              coalesce(avg(latency_ms), 0) AS avg_latency_ms
         FROM usage_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY 1
        ORDER BY cost_usd DESC, 1`,
      params,
    );
    return rows.map((r) => ({
      group: String(r.group),
      requests: Number(r.requests),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_usd: Number(r.cost_usd),
      saved_usd: Number(r.saved_usd),
      cache_hits: Number(r.cache_hits),
      errors: Number(r.errors),
      avg_latency_ms: Math.round(Number(r.avg_latency_ms)),
    }));
  }
}
