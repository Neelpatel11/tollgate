import { performance } from 'node:perf_hooks';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { bearerToken, safeEqual, type ApiKeyRecord, type KeyStore } from './auth/keys.js';
import { parseCacheDirective } from './cache/exact.js';
import {
  ClientAbortError,
  GatewayError,
  ProviderError,
  badRequest,
  notFound,
  unauthorized,
} from './errors.js';
import { parseChatRequest } from './schema.js';
import type { ChatService } from './service.js';
import type { Metrics } from './telemetry/metrics.js';
import type { UsageRepository } from './usage/events.js';
import { newRequestId, sha256 } from './util/misc.js';
import type { BreakerRegistry } from './router/circuit-breaker.js';
import type { LatencyTracker } from './router/latency.js';
import type { Router } from './router/router.js';

export interface AppDeps {
  service: ChatService;
  keys: KeyStore;
  usage: UsageRepository;
  metrics: Metrics;
  router: Router;
  breakers: BreakerRegistry;
  latency: LatencyTracker;
  adminKey?: string;
  bodyLimit: number;
  logger: FastifyBaseLogger;
  readiness?: () => Promise<Record<string, boolean>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyRecord;
    requestId: string;
  }
}

function sendError(reply: FastifyReply, err: GatewayError): FastifyReply {
  return reply.code(err.status).headers(err.headers).send(err.toBody());
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: deps.bodyLimit,
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? newRequestId(),
  });

  app.decorateRequest('requestId', '');
  app.addHook('onRequest', async (req, reply) => {
    req.requestId = String(req.id);
    reply.header('x-request-id', req.requestId);
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (err instanceof GatewayError) return sendError(reply, err);
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      return sendError(reply, new GatewayError(status, 'invalid_request_error', 'invalid_request', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, new GatewayError(500, 'server_error', 'internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, notFound('Route not found', 'route_not_found')));

  const authenticate = async (req: FastifyRequest): Promise<ApiKeyRecord> => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    const record = await deps.keys.findByHash(sha256(token));
    if (!record || record.revokedAt) throw unauthorized();
    req.apiKey = record;
    return record;
  };

  const adminOnly = async (req: FastifyRequest): Promise<void> => {
    if (!deps.adminKey) throw notFound('Route not found', 'route_not_found');
    const token = bearerToken(req.headers.authorization);
    if (!token || !safeEqual(token, deps.adminKey)) throw unauthorized('Invalid admin key');
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const checks = deps.readiness ? await deps.readiness() : {};
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });

  app.get('/v1/models', async (req) => {
    const key = await authenticate(req);
    const created = Math.floor(Date.now() / 1000);
    const aliases = deps.router.aliases().filter((a) => !key.allowedAliases || key.allowedAliases.includes(a));
    return {
      object: 'list',
      data: aliases.map((id) => ({ id, object: 'model', created, owned_by: 'tollgate' })),
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const startedAt = performance.now();
    const key = await authenticate(req);
    const body = parseChatRequest(req.body);

    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    let outcome;
    try {
      outcome = await deps.service.handle(body, key, {
        requestId: req.requestId,
        signal: abort.signal,
        cacheDirective: parseCacheDirective(req.headers['x-tollgate-cache']),
      });
    } catch (err) {
      if (err instanceof ClientAbortError) return reply.code(499).send();
      if (err instanceof GatewayError && err.status >= 500) {
        deps.service.recordFailure({
          requestId: req.requestId,
          key,
          alias: body.model,
          stream: body.stream === true,
          httpStatus: err.status,
          code: err.code,
          latencyMs: performance.now() - startedAt,
        });
      }
      throw err;
    }

    const headers: Record<string, string> = {
      'x-tollgate-alias': outcome.meta.alias,
      'x-tollgate-provider': outcome.meta.provider,
      'x-tollgate-model': outcome.meta.model,
      'x-tollgate-cache': outcome.meta.cache,
      'x-tollgate-attempts': String(outcome.meta.attempts),
    };

    if (outcome.kind === 'json') {
      if (outcome.meta.costUsd !== undefined) headers['x-tollgate-cost-usd'] = outcome.meta.costUsd.toFixed(8);
      return reply.headers(headers).send(outcome.body);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...headers,
      'x-request-id': req.requestId,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try {
      for await (const chunk of outcome.chunks) {
        if (raw.destroyed) break;
        raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      if (!raw.destroyed) raw.write('data: [DONE]\n\n');
    } catch (err) {
      if (!(err instanceof ClientAbortError) && !raw.destroyed) {
        const message = err instanceof ProviderError ? err.message : 'Upstream stream failed';
        const payload = new GatewayError(502, 'server_error', 'upstream_stream_error', message).toBody();
        raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        raw.write('data: [DONE]\n\n');
      }
    } finally {
      raw.end();
    }
    return reply;
  });

  const keyBody = z.object({
    name: z.string().min(1).max(120),
    rpm: z.number().int().positive().nullish(),
    tokens_per_day: z.number().int().positive().nullish(),
    monthly_budget_usd: z.number().positive().nullish(),
    allowed_aliases: z.array(z.string()).nullish(),
  });

  const publicKey = (k: ApiKeyRecord) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    rpm: k.rpm,
    tokens_per_day: k.tokensPerDay,
    monthly_budget_usd: k.monthlyBudgetUsd,
    allowed_aliases: k.allowedAliases,
    created_at: k.createdAt,
    revoked_at: k.revokedAt,
  });

  app.post('/admin/keys', async (req, reply) => {
    await adminOnly(req);
    const parsed = keyBody.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const b = parsed.data;
    const { record, plaintext } = await deps.keys.create({
      name: b.name,
      rpm: b.rpm,
      tokensPerDay: b.tokens_per_day,
      monthlyBudgetUsd: b.monthly_budget_usd,
      allowedAliases: b.allowed_aliases,
    });
    return reply.code(201).send({ ...publicKey(record), key: plaintext });
  });

  app.get('/admin/keys', async (req) => {
    await adminOnly(req);
    return { data: (await deps.keys.list()).map(publicKey) };
  });

  app.delete<{ Params: { id: string } }>('/admin/keys/:id', async (req, reply) => {
    await adminOnly(req);
    const ok = await deps.keys.revoke(req.params.id);
    if (!ok) throw notFound('Key not found or already revoked', 'key_not_found');
    return reply.code(204).send();
  });

  const usageQuery = z.object({
    group_by: z.enum(['key', 'model', 'provider', 'alias', 'day']).default('model'),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    key_id: z.string().optional(),
  });

  app.get('/admin/usage', async (req) => {
    await adminOnly(req);
    const parsed = usageQuery.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query');
    const q = parsed.data;
    const rows = await deps.usage.summarize({
      groupBy: q.group_by,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      keyId: q.key_id,
    });
    return { group_by: q.group_by, data: rows };
  });

  app.get('/admin/providers', async (req) => {
    await adminOnly(req);
    return { breakers: deps.breakers.snapshot(), latency_ms: deps.latency.snapshot() };
  });

  return app;
}
