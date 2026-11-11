import { describe, expect, it } from 'vitest';
import { exactCacheAllowed, exactCacheKey } from '../src/cache/exact.js';
import { MemoryKV } from '../src/cache/kv.js';
import { LocalHashEmbedder, MemoryVectorStore, cosine, semanticScope } from '../src/cache/semantic.js';
import { parseConfig } from '../src/config.js';
import { ProviderError } from '../src/errors.js';
import { PriceBook } from '../src/pricing.js';
import { RateLimiter } from '../src/ratelimit/limiter.js';
import { MemoryLimitStore } from '../src/ratelimit/store.js';
import { redactText } from '../src/redaction.js';
import { CircuitBreaker } from '../src/router/circuit-breaker.js';
import { LatencyTracker } from '../src/router/latency.js';
import { Router } from '../src/router/router.js';
import type { ChatRequest } from '../src/types.js';
import { ChunkAggregator, responseToChunks } from '../src/util/aggregate.js';
import { stableStringify } from '../src/util/misc.js';
import type { ApiKeyRecord } from '../src/auth/keys.js';

describe('CircuitBreaker', () => {
  const opts = { failureThreshold: 3, windowMs: 1000, openMs: 5000 };

  it('opens after the threshold within the window', () => {
    const now = 0;
    const b = new CircuitBreaker(opts, () => now);
    b.failure();
    b.failure();
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe('open');
    expect(b.allow()).toBe(false);
  });

  it('ejects a provider that fails half its requests even though successes are interleaved', () => {
    const now = 0;
    const b = new CircuitBreaker(opts, () => now);
    for (let i = 0; i < 20 && b.state === 'closed'; i++) {
      if (i % 2 === 0) b.failure();
      else b.success();
    }
    expect(b.state).toBe('open');
  });

  it('does not trip a healthy high-traffic provider on a low error rate', () => {
    const now = 0;
    const b = new CircuitBreaker({ ...opts, windowMs: 30_000 }, () => now);
    for (let i = 0; i < 2000; i++) {
      if (i % 100 === 0) b.failure();
      else b.success();
    }
    expect(b.state).toBe('closed');
  });

  it('forgets failures outside the window', () => {
    let now = 0;
    const b = new CircuitBreaker(opts, () => now);
    b.failure();
    b.failure();
    now = 2000;
    b.failure();
    expect(b.state).toBe('closed');
  });

  it('lets exactly one probe through when half-open, then closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker(opts, () => now);
    for (let i = 0; i < 3; i++) b.failure();
    now = 5000;
    expect(b.state).toBe('half_open');
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
    b.success();
    expect(b.state).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('ignores results from requests that were in flight when it opened', () => {
    let now = 0;
    const b = new CircuitBreaker(opts, () => now);
    for (let i = 0; i < 3; i++) b.failure();
    expect(b.state).toBe('open');
    now = 1000;
    b.success();
    expect(b.state).toBe('open');
    b.failure();
    expect(b.retryInMs()).toBe(4000);
    now = 5000;
    expect(b.state).toBe('half_open');
    b.success();
    expect(b.state).toBe('half_open');
    expect(b.allow()).toBe(true);
    b.success();
    expect(b.state).toBe('closed');
  });

  it('reopens when the probe fails', () => {
    let now = 0;
    const b = new CircuitBreaker(opts, () => now);
    for (let i = 0; i < 3; i++) b.failure();
    now = 5000;
    b.allow();
    b.failure();
    expect(b.state).toBe('open');
    expect(b.retryInMs()).toBe(5000);
  });
});

describe('RateLimiter', () => {
  const key = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
    id: 'k1',
    name: 'k',
    keyHash: 'h',
    prefix: 'tg_',
    rpm: null,
    tokensPerDay: null,
    monthlyBudgetUsd: null,
    allowedAliases: null,
    createdAt: '',
    revokedAt: null,
    ...over,
  });

  it('refills the token bucket over time', async () => {
    let now = 0;
    const store = new MemoryLimitStore(() => now);
    const limiter = new RateLimiter(store, { rpm: 60, tokensPerDay: null, monthlyBudgetUsd: null }, 'open');
    const k = key({ rpm: 2 });
    await limiter.check(k);
    await limiter.check(k);
    await expect(limiter.check(k)).rejects.toMatchObject({ status: 429 });
    now += 30_000;
    await expect(limiter.check(k)).resolves.toBeUndefined();
  });

  it('enforces the daily token quota', async () => {
    const limiter = new RateLimiter(new MemoryLimitStore(), { rpm: 100, tokensPerDay: 100, monthlyBudgetUsd: null }, 'open');
    const k = key();
    await limiter.check(k);
    await limiter.record(k, 100, 0);
    await expect(limiter.check(k)).rejects.toMatchObject({ code: 'token_quota_exceeded' });
  });

  it('fails open or closed when the store errors', async () => {
    const broken = {
      takeRequest: async () => {
        throw new Error('redis down');
      },
      counter: async () => 0,
      add: async () => 0,
    };
    const open = new RateLimiter(broken, { rpm: 1, tokensPerDay: null, monthlyBudgetUsd: null }, 'open');
    await expect(open.check(key())).resolves.toBeUndefined();
    const closed = new RateLimiter(broken, { rpm: 1, tokensPerDay: null, monthlyBudgetUsd: null }, 'closed');
    await expect(closed.check(key())).rejects.toMatchObject({ status: 503 });
  });
});

describe('PriceBook', () => {
  const book = new PriceBook([
    { provider: 'p', model: 'm', input_per_mtok: 1, output_per_mtok: 2, effective_from: '2024-01-01' },
    { provider: 'p', model: 'm', input_per_mtok: 3, output_per_mtok: 6, effective_from: '2025-01-01' },
    { provider: 'p', model: 'c', input_per_mtok: 10, output_per_mtok: 10, cached_input_per_mtok: 1, effective_from: '2024-01-01' },
  ]);
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };

  it('selects the price effective on the request date', () => {
    expect(book.cost('p', 'm', usage, new Date('2024-06-01')).usd).toBe(3);
    expect(book.cost('p', 'm', usage, new Date('2025-06-01')).usd).toBe(9);
  });

  it('matches dated model names by longest known prefix', () => {
    expect(book.cost('p', 'm-2025-03-01', usage, new Date('2025-06-01')).priced).toBe(true);
  });

  it('prices cached prompt tokens at the cached rate', () => {
    const cost = book.cost('p', 'c', { ...usage, prompt_tokens_details: { cached_tokens: 500_000 } });
    expect(cost.usd).toBeCloseTo(0.5 * 10 + 0.5 * 1 + 10, 10);
  });

  it('reports unknown models as unpriced', () => {
    expect(book.cost('p', 'unknown', usage)).toEqual({ usd: 0, priced: false });
  });
});

describe('Router', () => {
  const config = parseConfig({
    providers: { a: { type: 'openai' }, b: { type: 'openai' }, c: { type: 'openai' } },
    aliases: {
      fb: { chain: ['a/x', 'b/x'] },
      fast: { policy: 'lowest_latency', chain: ['a/x', 'b/x', 'c/x'] },
      cheap: { policy: 'cheapest', chain: ['a/exp', 'b/mid', 'c/free'] },
      split: { policy: 'weighted', chain: [{ target: 'a/x', weight: 9 }, { target: 'b/x', weight: 1 }] },
      partial: { chain: ['a/x', 'zzz/x'.replace('zzz', 'c')] },
    },
  });
  const prices = new PriceBook([
    { provider: 'a', model: 'exp', input_per_mtok: 10, output_per_mtok: 10, effective_from: '2020-01-01' },
    { provider: 'b', model: 'mid', input_per_mtok: 1, output_per_mtok: 1, effective_from: '2020-01-01' },
  ]);

  it('keeps chain order for fallback', () => {
    const r = new Router(config, new Set(['a', 'b', 'c']), prices, new LatencyTracker());
    expect(r.order(r.resolve('fb')!).map((t) => t.provider)).toEqual(['a', 'b']);
  });

  it('orders by observed latency, trying unmeasured targets first', () => {
    const lat = new LatencyTracker();
    lat.record('a', 'x', 500);
    lat.record('b', 'x', 100);
    const r = new Router(config, new Set(['a', 'b', 'c']), prices, lat);
    expect(r.order(r.resolve('fast')!).map((t) => t.provider)).toEqual(['c', 'b', 'a']);
  });

  it('orders by price with unpriced targets treated as free', () => {
    const r = new Router(config, new Set(['a', 'b', 'c']), prices, new LatencyTracker());
    expect(r.order(r.resolve('cheap')!).map((t) => t.provider)).toEqual(['c', 'b', 'a']);
  });

  it('shuffles by weight', () => {
    const r = new Router(config, new Set(['a', 'b']), prices, new LatencyTracker(), () => 0.95);
    expect(r.order(r.resolve('split')!)[0]?.provider).toBe('b');
    const r2 = new Router(config, new Set(['a', 'b']), prices, new LatencyTracker(), () => 0.1);
    expect(r2.order(r2.resolve('split')!)[0]?.provider).toBe('a');
  });

  it('drops targets whose provider is not enabled and resolves direct provider/model names', () => {
    const r = new Router(config, new Set(['a']), prices, new LatencyTracker());
    expect(r.resolve('fb')!.chain.map((t) => t.provider)).toEqual(['a']);
    expect(r.resolve('a/some-model')).toMatchObject({ direct: true, chain: [{ provider: 'a', model: 'some-model' }] });
    expect(r.resolve('b/some-model')).toBeUndefined();
  });
});

describe('Exact cache keys', () => {
  const base: ChatRequest = { model: 'x', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };

  it('ignores stream flags and key ordering but not content or parameters', () => {
    const k = exactCacheKey('a', base);
    expect(exactCacheKey('a', { ...base, stream: true, stream_options: { include_usage: true }, user: 'u' })).toBe(k);
    expect(exactCacheKey('a', { temperature: 0, messages: [{ content: 'hi', role: 'user' }], model: 'x' })).toBe(k);
    expect(exactCacheKey('a', { ...base, messages: [{ role: 'user', content: 'hi!' }] })).not.toBe(k);
    expect(exactCacheKey('a', { ...base, temperature: 0.2 })).not.toBe(k);
    expect(exactCacheKey('b', base)).not.toBe(k);
  });

  it('only caches automatically at temperature zero', () => {
    expect(exactCacheAllowed(base, 'auto', 'default')).toBe(true);
    expect(exactCacheAllowed({ ...base, temperature: 0.5 }, 'auto', 'default')).toBe(false);
    expect(exactCacheAllowed({ ...base, temperature: 0.5 }, 'on', 'default')).toBe(true);
    expect(exactCacheAllowed({ ...base, temperature: 0.5 }, 'auto', 'force')).toBe(true);
    expect(exactCacheAllowed(base, 'on', 'bypass')).toBe(false);
    expect(exactCacheAllowed(base, 'off', 'force')).toBe(false);
  });
});

describe('MemoryKV', () => {
  it('expires entries and evicts the least recently used', async () => {
    let now = 0;
    const kv = new MemoryKV(2, () => now);
    await kv.set('a', '1', 10);
    await kv.set('b', '2', 10);
    await kv.get('a');
    await kv.set('c', '3', 10);
    expect(await kv.get('b')).toBeNull();
    expect(await kv.get('a')).toBe('1');
    now = 11_000;
    expect(await kv.get('a')).toBeNull();
  });
});

describe('Semantic cache primitives', () => {
  const emb = new LocalHashEmbedder();

  it('scores paraphrases above unrelated questions', async () => {
    const q = await emb.embed('How do I reset my account password?');
    const paraphrase = await emb.embed('how do i reset the password for my account');
    const unrelated = await emb.embed('What is the refund policy for annual plans?');
    expect(cosine(q, paraphrase)).toBeGreaterThan(cosine(q, unrelated) + 0.2);
    expect(cosine(q, q)).toBeCloseTo(1, 5);
  });

  it('isolates entries by scope', async () => {
    const store = new MemoryVectorStore();
    const v = await emb.embed('hello there');
    const entry = { response: {} as never, costUsd: 0, provider: 'p', model: 'm', storedAt: 0 };
    await store.add('scope-1', v, entry, 60);
    expect(await store.search('scope-2', v)).toBeNull();
    expect((await store.search('scope-1', v))?.score).toBeCloseTo(1, 5);
  });

  it('changes scope when earlier context changes but not when only the last question does', () => {
    const mk = (system: string, last: string): ChatRequest => ({
      model: 'x',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: last },
      ],
    });
    expect(semanticScope('a', mk('s', 'q1'))).toBe(semanticScope('a', mk('s', 'q2')));
    expect(semanticScope('a', mk('s', 'q1'))).not.toBe(semanticScope('a', mk('other', 'q1')));
  });
});

describe('Redaction', () => {
  const all = { emails: true, phones: true, cards: true, govIds: true };

  it('masks emails, Indian mobiles, PAN and Aadhaar', () => {
    const r = redactText(
      'Mail ravi.k@example.co.in or call +91 98765 43210. PAN ABCDE1234F, Aadhaar 2345 6789 0123.',
      all,
    );
    expect(r.text).toBe('Mail [EMAIL] or call [PHONE]. PAN [PAN], Aadhaar [AADHAAR].');
    expect(r.count).toBe(4);
  });

  it('only masks card numbers that pass the Luhn check', () => {
    expect(redactText('card 4111 1111 1111 1111 ok', all).text).toBe('card [CARD] ok');
    expect(redactText('order 4111 1111 1111 1112 ok', all).text).toContain('4111 1111 1111 1112');
  });

  it('respects disabled categories', () => {
    expect(redactText('a@b.com', { ...all, emails: false }).text).toBe('a@b.com');
  });
});

describe('Chunk aggregation', () => {
  it('round-trips a response through chunks', () => {
    const response = {
      id: 'c1',
      object: 'chat.completion' as const,
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant' as const,
            content: 'A reasonably long answer that spans several chunks.',
            tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'f', arguments: '{"a":1}' } }],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    };
    const agg = new ChunkAggregator();
    for (const chunk of responseToChunks(response, 7)) agg.add(chunk);
    expect(agg.build().choices[0]).toEqual(response.choices[0]);
  });
});

describe('Misc', () => {
  it('stringifies objects deterministically', () => {
    expect(stableStringify({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });

  it('rejects an invalid config with a readable message', () => {
    expect(() => parseConfig({ providers: { a: { type: 'openai' } }, aliases: { x: { chain: ['nope/m'] } } })).toThrow(
      /unknown provider "nope"/,
    );
    expect(() => parseConfig({ providers: {}, aliases: { x: { chain: ['bad'] } } })).toThrow(/provider\/model/);
  });

  it('classifies provider errors', () => {
    expect(new ProviderError('p', 429, 'x').retryable).toBe(true);
    expect(new ProviderError('p', 503, 'x').retryable).toBe(true);
    expect(new ProviderError('p', 400, 'x').failoverEligible).toBe(false);
    expect(new ProviderError('p', 401, 'x').failoverEligible).toBe(true);
    expect(new ProviderError('p', 401, 'x').retryable).toBe(false);
    expect(new ProviderError('p', 0, 'x', 'timeout').retryable).toBe(true);
  });
});
