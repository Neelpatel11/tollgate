import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { ApiKeyRecord } from './auth/keys.js';
import {
  exactCacheAllowed,
  exactCacheKey,
  responseStorable,
  type CacheDirective,
  type CachedEntry,
  type ExactCache,
} from './cache/exact.js';
import { semanticAllowed, type SemanticCache } from './cache/semantic.js';
import type { GatewayConfig } from './config.js';
import {
  ClientAbortError,
  GatewayError,
  ProviderError,
  forbidden,
  notFound,
  unavailable,
} from './errors.js';
import type { PriceBook } from './pricing.js';
import type { RateLimiter } from './ratelimit/limiter.js';
import { redactRequest } from './redaction.js';
import type { BreakerRegistry } from './router/circuit-breaker.js';
import type { LatencyTracker } from './router/latency.js';
import type { Route, RouteTarget, Router } from './router/router.js';
import type { Metrics } from './telemetry/metrics.js';
import { startSpan } from './telemetry/tracing.js';
import type {
  CallContext,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  Usage,
} from './types.js';
import type { CacheOutcome, UsageEvent, UsageSink } from './usage/events.js';
import { ChunkAggregator, responseToChunks } from './util/aggregate.js';
import { estimatePromptTokens, estimateTokens, newRequestId, sleep } from './util/misc.js';
import { randomUUID } from 'node:crypto';

export interface ServiceDeps {
  config: GatewayConfig;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  router: Router;
  breakers: BreakerRegistry;
  latency: LatencyTracker;
  prices: PriceBook;
  limiter: RateLimiter;
  usage: UsageSink;
  metrics: Metrics;
  logger: FastifyBaseLogger;
  exactCache?: ExactCache;
  semanticCache?: SemanticCache;
}

export interface RequestOptions {
  requestId?: string;
  signal: AbortSignal;
  cacheDirective: CacheDirective;
}

export interface CallMeta {
  requestId: string;
  alias: string;
  provider: string;
  model: string;
  cache: 'hit-exact' | 'hit-semantic' | 'miss' | 'bypass' | 'off';
  attempts: number;
  costUsd?: number;
}

export type ChatOutcome =
  | { kind: 'json'; body: ChatResponse; meta: CallMeta }
  | { kind: 'stream'; chunks: AsyncGenerator<ChatChunk>; meta: CallMeta };

interface Scope {
  requestId: string;
  startedAt: number;
  route: Route;
  key: ApiKeyRecord;
  req: ChatRequest;
  stream: boolean;
  includeUsage: boolean;
  exactKey: string | null;
  semanticEnabled: boolean;
  upstreamReq: ChatRequest;
  signal: AbortSignal;
  span: ReturnType<typeof startSpan>;
  cacheState: CallMeta['cache'];
}

interface Settled {
  status: 'ok' | 'error' | 'aborted';
  httpStatus: number;
  errorCode?: string;
  usage?: Usage;
  response?: ChatResponse;
  partialText?: string;
  ttftMs: number | null;
}

type Dispatched =
  | { kind: 'json'; target: RouteTarget; response: ChatResponse; attempts: number }
  | {
      kind: 'stream';
      target: RouteTarget;
      first: ChatChunk;
      rest: AsyncGenerator<ChatChunk>;
      attempts: number;
      firstAtMs: number;
    };

const MAX_RETRY_WAIT_MS = 2000;

export class ChatService {
  constructor(private readonly d: ServiceDeps) {}

  async handle(req: ChatRequest, key: ApiKeyRecord, opts: RequestOptions): Promise<ChatOutcome> {
    const startedAt = performance.now();
    const requestId = opts.requestId ?? newRequestId();
    const route = this.d.router.resolve(req.model);
    if (!route) throw notFound(`The model "${req.model}" does not exist or is not enabled`, 'model_not_found');
    if (key.allowedAliases && !key.allowedAliases.includes(route.alias)) {
      throw forbidden(`This API key may not use "${req.model}"`, 'model_not_allowed');
    }

    const span = startSpan('tollgate.chat', {
      'tollgate.alias': route.alias,
      'tollgate.key_id': key.id,
      'gen_ai.operation.name': 'chat',
    });

    try {
      try {
        await this.d.limiter.check(key);
      } catch (err) {
        if (err instanceof GatewayError) this.d.metrics.limited.inc({ reason: err.code });
        throw err;
      }

      const stream = req.stream === true;
      const bypass = opts.cacheDirective === 'bypass' || opts.cacheDirective === 'no-store';
      const redaction = this.d.config.redaction;
      const upstreamReq = redaction.enabled ? redactRequest(req, redaction).request : req;

      const exactKey =
        this.d.exactCache && exactCacheAllowed(req, route.cache.exact, opts.cacheDirective)
          ? exactCacheKey(route.alias, req)
          : null;
      const semanticEnabled =
        !!this.d.semanticCache && route.cache.semantic && !bypass && semanticAllowed(upstreamReq);

      const scope: Scope = {
        requestId,
        startedAt,
        route,
        key,
        req,
        stream,
        includeUsage: req.stream_options?.include_usage === true,
        exactKey,
        semanticEnabled,
        upstreamReq,
        signal: opts.signal,
        span,
        cacheState: bypass ? 'bypass' : exactKey || semanticEnabled ? 'miss' : 'off',
      };

      const cached = await this.lookupCaches(scope);
      if (cached) return cached;

      this.d.metrics.overhead.observe({ phase: 'pre_upstream' }, (performance.now() - startedAt) / 1000);
      const dispatched = await this.dispatch(scope);
      return dispatched.kind === 'json' ? this.finishJson(scope, dispatched) : this.finishStream(scope, dispatched);
    } catch (err) {
      span.recordException(err as Error);
      span.end();
      throw err;
    }
  }

  private async lookupCaches(s: Scope): Promise<ChatOutcome | null> {
    const { exactCache, semanticCache, metrics } = this.d;
    if (s.exactKey && exactCache) {
      try {
        const entry = await exactCache.get(s.exactKey);
        metrics.cache.inc({ kind: 'exact', result: entry ? 'hit' : 'miss' });
        if (entry) return this.serveCached(s, entry, 'exact');
      } catch (err) {
        this.absorb('exact_cache', err);
      }
    }
    if (s.semanticEnabled && semanticCache) {
      try {
        const hit = await semanticCache.lookup(s.route.alias, s.upstreamReq, this.cacheCtx(s));
        metrics.cache.inc({ kind: 'semantic', result: hit ? 'hit' : 'miss' });
        if (hit) return this.serveCached(s, hit.entry, 'semantic');
      } catch (err) {
        this.absorb('semantic_cache', err);
      }
    }
    return null;
  }

  private serveCached(s: Scope, entry: CachedEntry, kind: 'exact' | 'semantic'): ChatOutcome {
    const latencyMs = performance.now() - s.startedAt;
    const meta: CallMeta = {
      requestId: s.requestId,
      alias: s.route.alias,
      provider: entry.provider,
      model: entry.model,
      cache: kind === 'exact' ? 'hit-exact' : 'hit-semantic',
      attempts: 0,
      costUsd: 0,
    };
    this.record(s, {
      provider: entry.provider,
      model: entry.model,
      cache: kind,
      status: 'ok',
      httpStatus: 200,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      savedUsd: entry.costUsd,
      latencyMs,
      ttftMs: s.stream ? latencyMs : null,
      attempts: 0,
      estimated: false,
      errorCode: null,
    });
    this.d.metrics.saved.inc({ kind }, entry.costUsd);
    s.span.setAttributes({ 'tollgate.cache': kind });
    s.span.end();

    if (!s.stream) return { kind: 'json', body: entry.response, meta };
    const chunks = responseToChunks(entry.response);
    if (s.includeUsage && entry.response.usage) {
      chunks.push({
        id: entry.response.id,
        object: 'chat.completion.chunk',
        created: entry.response.created,
        model: entry.response.model,
        choices: [],
        usage: entry.response.usage,
      });
    }
    return {
      kind: 'stream',
      meta,
      chunks: (async function* () {
        for (const c of chunks) yield c;
      })(),
    };
  }

  private callContext(s: Scope, target: RouteTarget): CallContext {
    const providerTimeout = this.d.config.providers[target.provider]?.timeoutMs;
    return {
      requestId: s.requestId,
      signal: s.signal,
      timeoutMs: s.route.timeoutMs ?? providerTimeout ?? this.d.config.server.requestTimeoutMs,
      streamIdleMs: this.d.config.server.streamIdleMs,
    };
  }

  private cacheCtx(s: Scope): CallContext {
    return { requestId: s.requestId, signal: s.signal, timeoutMs: 5000, streamIdleMs: 5000 };
  }

  private async dispatch(s: Scope): Promise<Dispatched> {
    const { breakers, latency, metrics, adapters } = this.d;
    const targets = this.d.router.order(s.route);
    const retryBase = this.d.config.server.retryBaseDelayMs;
    let attempts = 0;
    let lastError: ProviderError | undefined;

    for (const [position, target] of targets.entries()) {
      const adapter = adapters.get(target.provider);
      if (!adapter) continue;
      const breaker = breakers.get(target.provider);
      if (!breaker.allow()) continue;

      let retriesLeft = s.route.maxRetries;
      for (;;) {
        attempts++;
        const ctx = this.callContext(s, target);
        const t0 = performance.now();
        try {
          if (!s.stream) {
            const response = await adapter.chat(s.upstreamReq, target.model, ctx);
            breaker.success();
            latency.record(target.provider, target.model, performance.now() - t0);
            return { kind: 'json', target, response, attempts };
          }
          const gen = adapter.stream(s.upstreamReq, target.model, ctx);
          const first = await gen.next();
          if (first.done) {
            throw new ProviderError(target.provider, 502, `${target.provider} returned an empty stream`, 'protocol');
          }
          const firstAtMs = performance.now();
          breaker.success();
          latency.record(target.provider, target.model, firstAtMs - t0);
          return { kind: 'stream', target, first: first.value, rest: gen, attempts, firstAtMs };
        } catch (err) {
          if (err instanceof ClientAbortError || s.signal.aborted) {
            breaker.release();
            throw err instanceof ClientAbortError ? err : new ClientAbortError();
          }
          const perr =
            err instanceof ProviderError
              ? err
              : new ProviderError(target.provider, 502, `${target.provider} adapter failure: ${String(err)}`, 'protocol');
          lastError = perr;
          metrics.providerErrors.inc({
            provider: target.provider,
            kind: perr.kind === 'http' ? String(perr.status) : perr.kind,
          });
          this.d.logger.warn(
            { provider: target.provider, model: target.model, status: perr.status, kind: perr.kind, requestId: s.requestId },
            'upstream attempt failed',
          );

          if (perr.countsAgainstHealth) breaker.failure();
          else breaker.release();

          const waitMs = Math.max(retryBase * 2 ** (s.route.maxRetries - retriesLeft), perr.retryAfterMs ?? 0);
          const canRetry =
            perr.retryable && retriesLeft > 0 && breaker.state === 'closed' && waitMs <= MAX_RETRY_WAIT_MS;
          if (canRetry) {
            retriesLeft--;
            await sleep(waitMs + Math.random() * retryBase, s.signal);
            if (s.signal.aborted) throw new ClientAbortError();
            continue;
          }
          if (!perr.failoverEligible) {
            throw new GatewayError(perr.status, 'invalid_request_error', 'upstream_rejected', perr.message);
          }
          if (position < targets.length - 1) metrics.fallbacks.inc({ alias: s.route.alias, from: target.provider });
          break;
        }
      }
    }

    if (!lastError) {
      throw unavailable(`All providers for "${s.route.alias}" are currently unavailable`);
    }
    const status = lastError.status === 429 ? 429 : lastError.kind === 'timeout' ? 504 : 502;
    throw new GatewayError(status, 'server_error', 'upstream_error', `All providers failed. Last error: ${lastError.message}`);
  }

  private finishJson(s: Scope, d: Extract<Dispatched, { kind: 'json' }>): ChatOutcome {
    const latencyMs = performance.now() - s.startedAt;
    const response = d.response;
    let usage = response.usage;
    let estimated = false;
    if (!usage || (usage.prompt_tokens === 0 && usage.completion_tokens === 0)) {
      estimated = true;
      const prompt = estimatePromptTokens(s.upstreamReq.messages);
      const completion = estimateTokens(response.choices[0]?.message.content ?? '');
      usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      response.usage = usage;
    }
    const costUsd = this.settle(s, d.target, d.attempts, {
      status: 'ok',
      httpStatus: 200,
      usage,
      response,
      ttftMs: null,
    }, estimated, latencyMs);
    return {
      kind: 'json',
      body: response,
      meta: {
        requestId: s.requestId,
        alias: s.route.alias,
        provider: d.target.provider,
        model: d.target.model,
        cache: s.cacheState,
        attempts: d.attempts,
        costUsd,
      },
    };
  }

  private finishStream(s: Scope, d: Extract<Dispatched, { kind: 'stream' }>): ChatOutcome {
    const meta: CallMeta = {
      requestId: s.requestId,
      alias: s.route.alias,
      provider: d.target.provider,
      model: d.target.model,
      cache: s.cacheState,
      attempts: d.attempts,
    };
    return { kind: 'stream', chunks: this.streamBody(s, d), meta };
  }

  private async *streamBody(
    s: Scope,
    d: Extract<Dispatched, { kind: 'stream' }>,
  ): AsyncGenerator<ChatChunk> {
    const ttftMs = d.firstAtMs - s.startedAt;
    const breaker = this.d.breakers.get(d.target.provider);
    const agg = new ChunkAggregator();
    let status: Settled['status'] = 'aborted';
    let httpStatus = 499;
    let errorCode: string | undefined;
    const forward = (chunk: ChatChunk): boolean => {
      agg.add(chunk);
      return !(chunk.choices.length === 0 && chunk.usage && !s.includeUsage);
    };
    try {
      if (forward(d.first)) yield d.first;
      for await (const chunk of d.rest) {
        if (forward(chunk)) yield chunk;
      }
      status = 'ok';
      httpStatus = 200;
    } catch (err) {
      if (err instanceof ClientAbortError || s.signal.aborted) {
        status = 'aborted';
      } else {
        status = 'error';
        httpStatus = err instanceof ProviderError ? err.status : 502;
        errorCode = 'upstream_stream_error';
        if (err instanceof ProviderError && err.countsAgainstHealth) breaker.failure();
        throw err;
      }
    } finally {
      let usage = agg.reportedUsage;
      let estimated = false;
      if (!usage && (status === 'ok' || agg.hasContent)) {
        estimated = true;
        const prompt = estimatePromptTokens(s.upstreamReq.messages);
        const completion = estimateTokens(agg.completionText);
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
      }
      const response = status === 'ok' ? agg.build() : undefined;
      if (response && usage) response.usage = usage;
      this.settle(
        s,
        d.target,
        d.attempts,
        { status, httpStatus, errorCode, usage, response, ttftMs },
        estimated,
        performance.now() - s.startedAt,
      );
    }
  }

  private settle(
    s: Scope,
    target: RouteTarget,
    attempts: number,
    r: Settled,
    estimated: boolean,
    latencyMs: number,
  ): number {
    const { prices, metrics } = this.d;
    const cost = prices.cost(target.provider, target.model, r.usage);
    if (r.usage && !cost.priced) metrics.unpriced.inc({ provider: target.provider, model: target.model });
    const usage = r.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;

    this.record(s, {
      provider: target.provider,
      model: target.model,
      cache: 'none',
      status: r.status,
      httpStatus: r.httpStatus,
      inputTokens,
      outputTokens,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: cost.usd,
      savedUsd: 0,
      latencyMs,
      ttftMs: r.ttftMs,
      attempts,
      estimated,
      errorCode: r.errorCode ?? null,
    });

    metrics.tokens.inc({ alias: s.route.alias, provider: target.provider, model: target.model, type: 'input' }, inputTokens);
    metrics.tokens.inc({ alias: s.route.alias, provider: target.provider, model: target.model, type: 'output' }, outputTokens);
    metrics.cost.inc({ alias: s.route.alias, provider: target.provider, model: target.model }, cost.usd);
    if (r.ttftMs !== null) metrics.ttft.observe({ alias: s.route.alias, provider: target.provider }, r.ttftMs / 1000);

    s.span.setAttributes({
      'gen_ai.system': target.provider,
      'gen_ai.request.model': target.model,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'tollgate.cost_usd': cost.usd,
      'tollgate.attempts': attempts,
      'tollgate.status': r.status,
    });
    s.span.end();

    if (usage) void this.d.limiter.record(s.key, usage.total_tokens, cost.usd);
    if (r.status === 'ok' && r.response) this.storeInCaches(s, target, r.response, cost.usd);
    return cost.usd;
  }

  private storeInCaches(s: Scope, target: RouteTarget, response: ChatResponse, costUsd: number): void {
    if (!responseStorable(response)) return;
    const entry: CachedEntry = {
      response,
      costUsd,
      provider: target.provider,
      model: target.model,
      storedAt: Date.now(),
    };
    const { exactCache, semanticCache } = this.d;
    if (s.exactKey && exactCache) {
      exactCache.set(s.exactKey, entry, s.route.cache.ttlSeconds).catch((e: unknown) => this.absorb('exact_cache', e));
    }
    if (s.semanticEnabled && semanticCache) {
      semanticCache
        .put(s.route.alias, s.upstreamReq, entry, this.cacheCtx(s), s.route.cache.ttlSeconds)
        .catch((e: unknown) => this.absorb('semantic_cache', e));
    }
  }

  private record(
    s: Scope,
    r: {
      provider: string;
      model: string;
      cache: CacheOutcome;
      status: UsageEvent['status'];
      httpStatus: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      savedUsd: number;
      latencyMs: number;
      ttftMs: number | null;
      attempts: number;
      estimated: boolean;
      errorCode: string | null;
    },
  ): void {
    const { metrics } = this.d;
    metrics.requests.inc({ alias: s.route.alias, provider: r.provider, status: r.status, cache: r.cache });
    metrics.duration.observe(
      { alias: s.route.alias, provider: r.provider, stream: String(s.stream) },
      r.latencyMs / 1000,
    );
    try {
      this.d.usage.emit({
        event_id: randomUUID(),
        ts: new Date().toISOString(),
        request_id: s.requestId,
        key_id: s.key.id,
        alias: s.route.alias,
        provider: r.provider,
        model: r.model,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cached_tokens: r.cachedTokens,
        cost_usd: r.costUsd,
        saved_usd: r.savedUsd,
        latency_ms: Math.round(r.latencyMs),
        ttft_ms: r.ttftMs === null ? null : Math.round(r.ttftMs),
        cache: r.cache,
        status: r.status,
        http_status: r.httpStatus,
        error_code: r.errorCode,
        stream: s.stream,
        attempts: r.attempts,
        usage_estimated: r.estimated,
      });
    } catch (err) {
      this.absorb('usage_sink', err);
    }
  }

  private absorb(component: string, err: unknown): void {
    this.d.metrics.storeErrors.inc({ component });
    this.d.logger.warn({ component, err: err instanceof Error ? err.message : String(err) }, 'backing store error absorbed');
  }

  recordFailure(s: { requestId: string; key: ApiKeyRecord; alias: string; stream: boolean; httpStatus: number; code: string; latencyMs: number }): void {
    this.d.metrics.requests.inc({ alias: s.alias, provider: 'none', status: 'error', cache: 'none' });
    try {
      this.d.usage.emit({
        event_id: randomUUID(),
        ts: new Date().toISOString(),
        request_id: s.requestId,
        key_id: s.key.id,
        alias: s.alias,
        provider: 'none',
        model: 'none',
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
        saved_usd: 0,
        latency_ms: Math.round(s.latencyMs),
        ttft_ms: null,
        cache: 'none',
        status: 'error',
        http_status: s.httpStatus,
        error_code: s.code,
        stream: s.stream,
        attempts: 0,
        usage_estimated: false,
      });
    } catch (err) {
      this.absorb('usage_sink', err);
    }
  }
}
