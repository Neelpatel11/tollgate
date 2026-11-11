import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { BreakerRegistry } from '../router/circuit-breaker.js';

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const OVERHEAD_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

export class Metrics {
  readonly registry = new Registry();
  readonly requests: Counter<'alias' | 'provider' | 'status' | 'cache'>;
  readonly duration: Histogram<'alias' | 'provider' | 'stream'>;
  readonly ttft: Histogram<'alias' | 'provider'>;
  readonly overhead: Histogram<'phase'>;
  readonly tokens: Counter<'alias' | 'provider' | 'model' | 'type'>;
  readonly cost: Counter<'alias' | 'provider' | 'model'>;
  readonly saved: Counter<'kind'>;
  readonly cache: Counter<'kind' | 'result'>;
  readonly providerErrors: Counter<'provider' | 'kind'>;
  readonly fallbacks: Counter<'alias' | 'from'>;
  readonly limited: Counter<'reason'>;
  readonly usageDropped: Counter<string>;
  readonly storeErrors: Counter<'component'>;
  readonly unpriced: Counter<'provider' | 'model'>;
  readonly circuit: Gauge<'provider'>;

  constructor(breakers?: BreakerRegistry, collectDefaults = true) {
    const registers = [this.registry];
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
    this.requests = new Counter({
      name: 'tollgate_requests_total',
      help: 'Completed chat requests',
      labelNames: ['alias', 'provider', 'status', 'cache'],
      registers,
    });
    this.duration = new Histogram({
      name: 'tollgate_request_duration_seconds',
      help: 'End-to-end request duration',
      labelNames: ['alias', 'provider', 'stream'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.ttft = new Histogram({
      name: 'tollgate_time_to_first_token_seconds',
      help: 'Time to first streamed chunk',
      labelNames: ['alias', 'provider'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.overhead = new Histogram({
      name: 'tollgate_gateway_overhead_seconds',
      help: 'Time spent in the gateway before the upstream call',
      labelNames: ['phase'],
      buckets: OVERHEAD_BUCKETS,
      registers,
    });
    this.tokens = new Counter({
      name: 'tollgate_tokens_total',
      help: 'Tokens processed',
      labelNames: ['alias', 'provider', 'model', 'type'],
      registers,
    });
    this.cost = new Counter({
      name: 'tollgate_cost_usd_total',
      help: 'Spend in USD',
      labelNames: ['alias', 'provider', 'model'],
      registers,
    });
    this.saved = new Counter({
      name: 'tollgate_saved_usd_total',
      help: 'Spend avoided through caching in USD',
      labelNames: ['kind'],
      registers,
    });
    this.cache = new Counter({
      name: 'tollgate_cache_lookups_total',
      help: 'Cache lookups',
      labelNames: ['kind', 'result'],
      registers,
    });
    this.providerErrors = new Counter({
      name: 'tollgate_provider_errors_total',
      help: 'Upstream failures',
      labelNames: ['provider', 'kind'],
      registers,
    });
    this.fallbacks = new Counter({
      name: 'tollgate_fallbacks_total',
      help: 'Requests that moved past a failing provider',
      labelNames: ['alias', 'from'],
      registers,
    });
    this.limited = new Counter({
      name: 'tollgate_rate_limited_total',
      help: 'Requests rejected by limits',
      labelNames: ['reason'],
      registers,
    });
    this.usageDropped = new Counter({
      name: 'tollgate_usage_events_dropped_total',
      help: 'Usage events dropped because the sink was unavailable',
      registers,
    });
    this.storeErrors = new Counter({
      name: 'tollgate_store_errors_total',
      help: 'Backing store failures that were absorbed',
      labelNames: ['component'],
      registers,
    });
    this.unpriced = new Counter({
      name: 'tollgate_unpriced_requests_total',
      help: 'Requests for models missing from the price book',
      labelNames: ['provider', 'model'],
      registers,
    });
    this.circuit = new Gauge({
      name: 'tollgate_circuit_state',
      help: 'Circuit breaker state per provider (0 closed, 1 half-open, 2 open)',
      labelNames: ['provider'],
      registers,
      collect: () => {
        if (!breakers) return;
        for (const [provider, info] of Object.entries(breakers.snapshot())) {
          this.circuit.set({ provider }, info.state === 'closed' ? 0 : info.state === 'half_open' ? 1 : 2);
        }
      },
    });
  }
}
