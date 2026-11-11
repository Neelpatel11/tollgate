export type CacheOutcome = 'none' | 'exact' | 'semantic';

export interface UsageEvent {
  event_id: string;
  ts: string;
  request_id: string;
  key_id: string;
  alias: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  saved_usd: number;
  latency_ms: number;
  ttft_ms: number | null;
  cache: CacheOutcome;
  status: 'ok' | 'error' | 'aborted';
  http_status: number;
  error_code: string | null;
  stream: boolean;
  attempts: number;
  usage_estimated: boolean;
}

export type GroupBy = 'key' | 'model' | 'provider' | 'alias' | 'day';

export interface UsageQuery {
  from?: Date;
  to?: Date;
  groupBy: GroupBy;
  keyId?: string;
}

export interface UsageSummaryRow {
  group: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  saved_usd: number;
  cache_hits: number;
  errors: number;
  avg_latency_ms: number;
}

export interface UsageSink {
  emit(event: UsageEvent): void;
  close(): Promise<void>;
}

export interface UsageRepository {
  insertMany(events: UsageEvent[]): Promise<void>;
  summarize(query: UsageQuery): Promise<UsageSummaryRow[]>;
}

export class NoopUsageSink implements UsageSink {
  emit(): void {}
  async close(): Promise<void> {}
}

function groupKey(event: UsageEvent, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'key':
      return event.key_id;
    case 'model':
      return `${event.provider}/${event.model}`;
    case 'provider':
      return event.provider;
    case 'alias':
      return event.alias;
    case 'day':
      return event.ts.slice(0, 10);
  }
}

export class MemoryUsageStore implements UsageSink, UsageRepository {
  readonly events: UsageEvent[] = [];
  private readonly seen = new Set<string>();

  emit(event: UsageEvent): void {
    void this.insertMany([event]);
  }

  async close(): Promise<void> {}

  async insertMany(events: UsageEvent[]): Promise<void> {
    for (const event of events) {
      if (this.seen.has(event.event_id)) continue;
      this.seen.add(event.event_id);
      this.events.push(event);
    }
  }

  async summarize(query: UsageQuery): Promise<UsageSummaryRow[]> {
    const rows = new Map<string, UsageSummaryRow & { latencySum: number }>();
    for (const event of this.events) {
      const ts = Date.parse(event.ts);
      if (query.from && ts < query.from.getTime()) continue;
      if (query.to && ts >= query.to.getTime()) continue;
      if (query.keyId && event.key_id !== query.keyId) continue;
      const group = groupKey(event, query.groupBy);
      const row = rows.get(group) ?? {
        group,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        saved_usd: 0,
        cache_hits: 0,
        errors: 0,
        avg_latency_ms: 0,
        latencySum: 0,
      };
      row.requests++;
      row.input_tokens += event.input_tokens;
      row.output_tokens += event.output_tokens;
      row.cost_usd += event.cost_usd;
      row.saved_usd += event.saved_usd;
      if (event.cache !== 'none') row.cache_hits++;
      if (event.status === 'error') row.errors++;
      row.latencySum += event.latency_ms;
      rows.set(group, row);
    }
    return [...rows.values()]
      .map(({ latencySum, ...row }) => ({ ...row, avg_latency_ms: Math.round(latencySum / row.requests) }))
      .sort((a, b) => b.cost_usd - a.cost_usd || a.group.localeCompare(b.group));
  }
}
