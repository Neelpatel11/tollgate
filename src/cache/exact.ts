import type { ChatRequest, ChatResponse } from '../types.js';
import { sha256, stableStringify } from '../util/misc.js';
import type { KVStore } from './kv.js';

export interface CachedEntry {
  response: ChatResponse;
  costUsd: number;
  provider: string;
  model: string;
  storedAt: number;
}

export type CacheDirective = 'default' | 'bypass' | 'no-store' | 'force';

export function parseCacheDirective(header: string | string[] | undefined): CacheDirective {
  const value = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (value === 'bypass' || value === 'no-store' || value === 'force') return value;
  return 'default';
}

export function normalisedRequest(req: ChatRequest): Record<string, unknown> {
  return {
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    })),
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_completion_tokens ?? req.max_tokens,
    stop: req.stop,
    tools: req.tools,
    tool_choice: req.tool_choice,
    response_format: req.response_format,
    seed: req.seed,
    presence_penalty: req.presence_penalty,
    frequency_penalty: req.frequency_penalty,
  };
}

export function exactCacheKey(alias: string, req: ChatRequest): string {
  return `tg:exact:v1:${sha256(stableStringify({ alias, ...normalisedRequest(req) }))}`;
}

export function exactCacheAllowed(
  req: ChatRequest,
  mode: 'auto' | 'on' | 'off',
  directive: CacheDirective,
): boolean {
  if (directive === 'bypass' || directive === 'no-store') return false;
  if (mode === 'off') return false;
  if (directive === 'force' || mode === 'on') return true;
  return req.temperature === 0;
}

export function responseStorable(res: ChatResponse): boolean {
  const reason = res.choices[0]?.finish_reason;
  return reason === 'stop' || reason === 'tool_calls';
}

export class ExactCache {
  constructor(
    private readonly kv: KVStore,
    private readonly ttlSeconds: number,
  ) {}

  async get(key: string): Promise<CachedEntry | null> {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CachedEntry, ttlSeconds?: number): Promise<void> {
    await this.kv.set(key, JSON.stringify(entry), ttlSeconds ?? this.ttlSeconds);
  }
}
