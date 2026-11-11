import type { Redis } from 'ioredis';
import type { CallContext, ChatRequest, ProviderAdapter } from '../types.js';
import { messageText, sha256, stableStringify } from '../util/misc.js';
import { normalisedRequest, type CachedEntry } from './exact.js';

export interface Embedder {
  readonly dimensions: number;
  embed(text: string, ctx: CallContext): Promise<number[]>;
}

export class LocalHashEmbedder implements Embedder {
  constructor(readonly dimensions = 384) {}

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    const normalised = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = normalised.split(' ').filter(Boolean);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      const idx = h % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + ((h >>> 31) & 1 ? -weight : weight);
    };
    for (const w of words) add(`w:${w}`, 1);
    for (let i = 0; i < words.length - 1; i++) add(`b:${words[i]} ${words[i + 1]}`, 0.7);
    const padded = ` ${normalised} `;
    for (let i = 0; i < padded.length - 2; i++) add(`c:${padded.slice(i, i + 3)}`, 0.3);
    return normalise(vec);
  }
}

export class ProviderEmbedder implements Embedder {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(text: string, ctx: CallContext): Promise<number[]> {
    if (!this.adapter.embed) throw new Error(`Provider ${this.adapter.name} does not support embeddings`);
    const [vec] = await this.adapter.embed([text], this.model, ctx);
    if (!vec) throw new Error('Embedding response was empty');
    return normalise(vec);
  }
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalise(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export interface VectorHit {
  score: number;
  entry: CachedEntry;
}

export interface VectorStore {
  search(scope: string, vector: number[]): Promise<VectorHit | null>;
  add(scope: string, vector: number[], entry: CachedEntry, ttlSeconds: number): Promise<void>;
}

export class MemoryVectorStore implements VectorStore {
  private readonly scopes = new Map<string, Array<{ vector: number[]; entry: CachedEntry; expires: number }>>();
  private total = 0;

  constructor(
    private readonly maxEntries = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  async search(scope: string, vector: number[]): Promise<VectorHit | null> {
    const items = this.scopes.get(scope);
    if (!items) return null;
    const now = this.now();
    let best: VectorHit | null = null;
    for (const item of items) {
      if (item.expires <= now) continue;
      const score = cosine(vector, item.vector);
      if (!best || score > best.score) best = { score, entry: item.entry };
    }
    return best;
  }

  async add(scope: string, vector: number[], entry: CachedEntry, ttlSeconds: number): Promise<void> {
    const list = this.scopes.get(scope) ?? [];
    list.push({ vector, entry, expires: this.now() + ttlSeconds * 1000 });
    this.scopes.set(scope, list);
    this.total++;
    while (this.total > this.maxEntries) {
      const firstScope = this.scopes.keys().next().value;
      if (firstScope === undefined) break;
      const bucket = this.scopes.get(firstScope)!;
      bucket.shift();
      this.total--;
      if (bucket.length === 0) this.scopes.delete(firstScope);
    }
  }
}

export class RedisVectorStore implements VectorStore {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly dimensions: number,
    private readonly index = 'tg:idx:semantic',
    private readonly prefix = 'tg:sem:',
  ) {}

  private ensureIndex(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.redis.call(
          'FT.CREATE',
          this.index,
          'ON',
          'HASH',
          'PREFIX',
          '1',
          this.prefix,
          'SCHEMA',
          'scope',
          'TAG',
          'vec',
          'VECTOR',
          'FLAT',
          '6',
          'TYPE',
          'FLOAT32',
          'DIM',
          String(this.dimensions),
          'DISTANCE_METRIC',
          'COSINE',
        );
      } catch (err) {
        if (!(err instanceof Error) || !/already exists/i.test(err.message)) {
          this.ready = undefined;
          throw err;
        }
      }
    })();
    return this.ready;
  }

  async search(scope: string, vector: number[]): Promise<VectorHit | null> {
    await this.ensureIndex();
    const reply = (await this.redis.call(
      'FT.SEARCH',
      this.index,
      `@scope:{${scope}}=>[KNN 1 @vec $B AS dist]`,
      'PARAMS',
      '2',
      'B',
      toBuffer(vector),
      'SORTBY',
      'dist',
      'RETURN',
      '2',
      'dist',
      'entry',
      'DIALECT',
      '2',
    )) as unknown[];
    const map = firstSearchResult(reply);
    if (!map) return null;
    const dist = Number(map.get('dist'));
    const raw = map.get('entry');
    if (!raw || Number.isNaN(dist)) return null;
    return { score: 1 - dist, entry: JSON.parse(raw) as CachedEntry };
  }

  async add(scope: string, vector: number[], entry: CachedEntry, ttlSeconds: number): Promise<void> {
    await this.ensureIndex();
    const key = `${this.prefix}${sha256(`${scope}:${entry.storedAt}:${Math.random()}`)}`;
    await this.redis
      .multi()
      .hset(key, { scope, vec: toBuffer(vector), entry: JSON.stringify(entry) })
      .expire(key, ttlSeconds)
      .exec();
  }
}

function pairsToMap(fields: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(fields)) return map;
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(String(fields[i]), String(fields[i + 1]));
  return map;
}

export function firstSearchResult(reply: unknown): Map<string, string> | null {
  if (!Array.isArray(reply) || reply.length === 0) return null;
  if (typeof reply[0] === 'string') {
    const top = new Map<string, unknown>();
    for (let i = 0; i + 1 < reply.length; i += 2) top.set(String(reply[i]), reply[i + 1]);
    const results = top.get('results');
    if (!Array.isArray(results) || results.length === 0) return null;
    const first = results[0];
    if (!Array.isArray(first)) return null;
    const entry = new Map<string, unknown>();
    for (let i = 0; i + 1 < first.length; i += 2) entry.set(String(first[i]), first[i + 1]);
    return pairsToMap(entry.get('extra_attributes'));
  }
  if (Number(reply[0]) < 1) return null;
  return pairsToMap(reply[2]);
}

function toBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function lastUserText(req: ChatRequest): string | null {
  const last = req.messages[req.messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const text = messageText(last.content).trim();
  return text.length > 0 ? text : null;
}

export function semanticScope(alias: string, req: ChatRequest): string {
  const base = normalisedRequest(req);
  const messages = (base.messages as unknown[]).slice(0, -1);
  return sha256(stableStringify({ alias, ...base, messages })).slice(0, 32);
}

export function semanticAllowed(req: ChatRequest): boolean {
  if (req.tools && req.tools.length > 0) return false;
  return lastUserText(req) !== null;
}

export interface SemanticLookup {
  entry: CachedEntry;
  score: number;
}

export class SemanticCache {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: VectorStore,
    readonly threshold: number,
    private readonly ttlSeconds: number,
  ) {}

  async lookup(alias: string, req: ChatRequest, ctx: CallContext): Promise<SemanticLookup | null> {
    const text = lastUserText(req);
    if (!text) return null;
    const vector = await this.embedder.embed(text, ctx);
    const hit = await this.store.search(semanticScope(alias, req), vector);
    if (!hit || hit.score < this.threshold) return null;
    return { entry: hit.entry, score: hit.score };
  }

  async put(alias: string, req: ChatRequest, entry: CachedEntry, ctx: CallContext, ttl?: number): Promise<void> {
    const text = lastUserText(req);
    if (!text) return;
    const vector = await this.embedder.embed(text, ctx);
    await this.store.add(semanticScope(alias, req), vector, entry, ttl ?? this.ttlSeconds);
  }
}
