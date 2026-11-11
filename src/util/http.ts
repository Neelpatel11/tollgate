import type { IncomingHttpHeaders } from 'node:http';
import { Agent, request, type Dispatcher } from 'undici';
import { ClientAbortError, ProviderError } from '../errors.js';
import type { CallContext } from '../types.js';

const agent = new Agent({
  connections: 512,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 5_000 },
});

export interface UpstreamInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Dispatcher.ResponseData['body'];
}

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function translate(provider: string, err: unknown, ctx: CallContext): Error {
  if (err instanceof ProviderError || err instanceof ClientAbortError) return err;
  if (ctx.signal.aborted) return new ClientAbortError();
  const code = (err as { code?: string }).code;
  if (code && TIMEOUT_CODES.has(code)) {
    return new ProviderError(provider, 504, `${provider} timed out`, 'timeout');
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(provider, 502, `${provider} network error: ${message}`, 'network');
}

export async function upstreamFetch(
  provider: string,
  url: string,
  init: UpstreamInit,
  ctx: CallContext,
): Promise<UpstreamResponse> {
  if (ctx.signal.aborted) throw new ClientAbortError();
  let res: Dispatcher.ResponseData;
  try {
    res = await request(url, {
      method: init.method as Dispatcher.HttpMethod,
      headers: init.headers,
      body: init.body,
      signal: ctx.signal,
      headersTimeout: ctx.timeoutMs,
      bodyTimeout: ctx.streamIdleMs,
      dispatcher: agent,
    });
  } catch (err) {
    throw translate(provider, err, ctx);
  }

  if (res.statusCode >= 400) {
    const text = await res.body.text().catch(() => '');
    throw new ProviderError(
      provider,
      res.statusCode,
      `${provider} returned ${res.statusCode}: ${text.slice(0, 500)}`,
      'http',
      parseRetryAfter(res.headers['retry-after']),
    );
  }
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

export async function readJson<T>(provider: string, up: UpstreamResponse, ctx: CallContext): Promise<T> {
  let text: string;
  try {
    text = await up.body.text();
  } catch (err) {
    throw translate(provider, err, ctx);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, 502, `${provider} returned a non-JSON body`, 'protocol');
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* sseEvents(
  provider: string,
  up: UpstreamResponse,
  ctx: CallContext,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of up.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      if (buffer.includes('\r')) buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(raw);
        if (parsed) yield parsed;
      }
    }
  } catch (err) {
    throw translate(provider, err, ctx);
  } finally {
    if (!up.body.destroyed) up.body.destroy();
  }
  const tail = parseSseBlock(buffer.trim());
  if (tail) yield tail;
}

function parseSseBlock(block: string): SseEvent | null {
  if (!block) return null;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}
