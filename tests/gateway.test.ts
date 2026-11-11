import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_KEY,
  API_KEY,
  baseConfig,
  chat,
  readSse,
  startGateway,
  startMock,
  userMsg,
  type MockHandle,
  type TestGateway,
} from './helpers.js';

describe('gateway end to end', () => {
  let a: MockHandle;
  let b: MockHandle;
  let gw: TestGateway;

  beforeAll(async () => {
    a = await startMock();
    b = await startMock();
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  beforeEach(async () => {
    await a.app.inject({ method: 'POST', url: '/control/reset' });
    await b.app.inject({ method: 'POST', url: '/control/reset' });
    gw = await startGateway(baseConfig(a.url, b.url));
  });

  afterEach(async () => {
    await gw.close();
  });

  describe('OpenAI SDK compatibility', () => {
    it('serves a non-streaming completion unchanged through the official SDK', async () => {
      const client = new OpenAI({ apiKey: API_KEY, baseURL: `${gw.base}/v1` });
      const res = await client.chat.completions.create({
        model: 'smart',
        messages: [{ role: 'user', content: 'hello gateway' }],
      });
      expect(res.object).toBe('chat.completion');
      expect(res.choices[0]?.message.content).toContain('hello gateway');
      expect(res.usage?.total_tokens).toBeGreaterThan(0);
    });

    it('streams chunks and the final usage chunk through the official SDK', async () => {
      const client = new OpenAI({ apiKey: API_KEY, baseURL: `${gw.base}/v1` });
      const stream = await client.chat.completions.create({
        model: 'smart',
        messages: [{ role: 'user', content: 'stream this please' }],
        stream: true,
        stream_options: { include_usage: true },
      });
      let text = '';
      let usage: unknown;
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta?.content ?? '';
        if (chunk.usage) usage = chunk.usage;
      }
      expect(text).toContain('stream this please');
      expect(usage).toBeTruthy();
    });

    it('omits the usage chunk unless the client asks for it', async () => {
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('hi'), stream: true });
      const { chunks, done } = await readSse(res);
      expect(done).toBe(true);
      expect(chunks.some((c) => c.usage)).toBe(false);
    });

    it('lists the configured aliases', async () => {
      const client = new OpenAI({ apiKey: API_KEY, baseURL: `${gw.base}/v1` });
      const page = await client.models.list();
      expect(page.data.map((m) => m.id)).toEqual(expect.arrayContaining(['smart', 'only_a']));
    });
  });

  describe('auth and validation', () => {
    it('rejects a missing or unknown key with an OpenAI-shaped error', async () => {
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('x') }, {}, 'tg_nope');
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('invalid_api_key');
      expect(body.error.type).toBe('authentication_error');
    });

    it('returns 404 for an unknown model', async () => {
      const res = await chat(gw.base, { model: 'nope', messages: userMsg('x') });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('model_not_found');
    });

    it('returns 400 for a malformed body', async () => {
      const res = await chat(gw.base, { model: 'smart', messages: [] });
      expect(res.status).toBe(400);
    });

    it('rejects n > 1', async () => {
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('x'), n: 2 });
      expect(res.status).toBe(400);
    });
  });

  describe('failover and circuit breaker', () => {
    it('falls back to the next provider on a 5xx', async () => {
      await a.control({ errorRate: 1 });
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('fallback please') });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-tollgate-provider')).toBe('b');
      expect(res.headers.get('x-tollgate-attempts')).toBe('2');
    });

    it('opens the breaker after repeated failures and stops calling the provider', async () => {
      await a.control({ errorRate: 1 });
      for (let i = 0; i < 3; i++) {
        await chat(gw.base, { model: 'smart', messages: userMsg(`warm ${i}`) });
      }
      const before = await a.failed();
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('after open') });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-tollgate-provider')).toBe('b');
      expect(res.headers.get('x-tollgate-attempts')).toBe('1');
      expect(await a.failed()).toBe(before);
    });

    it('fails over before the first streamed chunk', async () => {
      await a.control({ errorRate: 1 });
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('stream failover'), stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-tollgate-provider')).toBe('b');
      const { chunks, done } = await readSse(res);
      expect(done).toBe(true);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('returns 502 when every provider fails', async () => {
      await a.control({ errorRate: 1 });
      await b.control({ errorRate: 1 });
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('all down') });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_error');
    });

    it('returns 503 immediately once every breaker is open', async () => {
      await a.control({ errorRate: 1 });
      await b.control({ errorRate: 1 });
      for (let i = 0; i < 3; i++) await chat(gw.base, { model: 'smart', messages: userMsg(`trip ${i}`) });
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('fast fail') });
      expect(res.status).toBe(503);
    });

    it('does not fail over on a client error from the provider', async () => {
      await a.control({ errorRate: 1, errorStatus: 400 });
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('bad') });
      expect(res.status).toBe(400);
      expect(await b.served()).toBe(0);
    });

    it('times out a hung provider and falls back', async () => {
      await a.control({ hangRate: 1 });
      const fast = await startGateway(
        baseConfig(a.url, b.url, {
          server: { requestTimeoutMs: 150, streamIdleMs: 150, maxRetries: 0, retryBaseDelayMs: 1 },
        }),
      );
      try {
        const res = await chat(fast.base, { model: 'smart', messages: userMsg('hang') });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-tollgate-provider')).toBe('b');
      } finally {
        await fast.close();
      }
    });
  });

  describe('exact cache', () => {
    it('serves the second identical temperature-0 request from cache', async () => {
      const body = { model: 'smart', messages: userMsg('cache me'), temperature: 0 };
      const first = await chat(gw.base, body);
      expect(first.headers.get('x-tollgate-cache')).toBe('miss');
      await first.json();
      await new Promise((r) => setTimeout(r, 20));
      const second = await chat(gw.base, body);
      expect(second.headers.get('x-tollgate-cache')).toBe('hit-exact');
      expect(await a.served()).toBe(1);
    });

    it('does not cache by default when temperature is not zero', async () => {
      const body = { model: 'smart', messages: userMsg('no cache'), temperature: 0.7 };
      await (await chat(gw.base, body)).json();
      await (await chat(gw.base, body)).json();
      expect(await a.served()).toBe(2);
    });

    it('honours the bypass directive', async () => {
      const body = { model: 'smart', messages: userMsg('bypass me'), temperature: 0 };
      await (await chat(gw.base, body)).json();
      await new Promise((r) => setTimeout(r, 20));
      const res = await chat(gw.base, body, { 'x-tollgate-cache': 'bypass' });
      expect(res.headers.get('x-tollgate-cache')).toBe('bypass');
      await res.json();
      expect(await a.served()).toBe(2);
    });

    it('replays a cached answer as a stream', async () => {
      const body = { model: 'det', messages: userMsg('replay this') };
      await (await chat(gw.base, body)).json();
      await new Promise((r) => setTimeout(r, 20));
      const res = await chat(gw.base, { ...body, stream: true });
      expect(res.headers.get('x-tollgate-cache')).toBe('hit-exact');
      const { chunks, done } = await readSse(res);
      expect(done).toBe(true);
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toContain('replay this');
      expect(await a.served()).toBe(1);
    });

    it('caches the answer produced by a streaming request', async () => {
      const body = { model: 'det', messages: userMsg('warm from stream'), stream: true };
      await readSse(await chat(gw.base, body));
      await new Promise((r) => setTimeout(r, 20));
      const res = await chat(gw.base, { ...body, stream: false });
      expect(res.headers.get('x-tollgate-cache')).toBe('hit-exact');
      await res.json();
      expect(await a.served()).toBe(1);
    });

    it('keeps different prompts apart', async () => {
      await (await chat(gw.base, { model: 'det', messages: userMsg('one') })).json();
      await new Promise((r) => setTimeout(r, 20));
      await (await chat(gw.base, { model: 'det', messages: userMsg('two') })).json();
      expect(await a.served()).toBe(2);
    });
  });

  describe('semantic cache', () => {
    it('answers a paraphrase from cache and sends an unrelated question upstream', async () => {
      const ask = (q: string) => chat(gw.base, { model: 'faq', messages: userMsg(q) });
      await (await ask('How do I reset my account password?')).json();
      await new Promise((r) => setTimeout(r, 30));

      const near = await ask('how do i reset my account password');
      expect(near.headers.get('x-tollgate-cache')).toBe('hit-semantic');
      await near.json();

      const far = await ask('What is the refund policy for annual plans?');
      expect(far.headers.get('x-tollgate-cache')).toBe('miss');
      await far.json();
      expect(await a.served()).toBe(2);
    });

    it('never mixes answers across different system prompts', async () => {
      const ask = (system: string) =>
        chat(gw.base, {
          model: 'faq',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: 'How do I reset my account password?' },
          ],
        });
      await (await ask('You are a support bot.')).json();
      await new Promise((r) => setTimeout(r, 30));
      const other = await ask('You are a pirate.');
      expect(other.headers.get('x-tollgate-cache')).toBe('miss');
      await other.json();
    });
  });

  describe('rate limits and budgets', () => {
    it('returns 429 with Retry-After beyond the per-minute limit', async () => {
      const limited = await startGateway(baseConfig(a.url, b.url, { rateLimit: { defaultRpm: 2 } }));
      try {
        const statuses: number[] = [];
        let retryAfter: string | null = null;
        for (let i = 0; i < 4; i++) {
          const res = await chat(limited.base, { model: 'smart', messages: userMsg(`r${i}`) });
          statuses.push(res.status);
          if (res.status === 429) retryAfter = res.headers.get('retry-after');
          await res.json();
        }
        expect(statuses).toEqual([200, 200, 429, 429]);
        expect(Number(retryAfter)).toBeGreaterThan(0);
      } finally {
        await limited.close();
      }
    });

    it('blocks a key after its monthly budget is spent', async () => {
      const res = await fetch(`${gw.base}/admin/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: 'tiny-budget', monthly_budget_usd: 0.000001 }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { key: string };

      const first = await chat(gw.base, { model: 'smart', messages: userMsg('spend something') }, {}, created.key);
      expect(first.status).toBe(200);
      await first.json();
      await new Promise((r) => setTimeout(r, 30));

      const second = await chat(gw.base, { model: 'smart', messages: userMsg('more') }, {}, created.key);
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe('budget_exceeded');
    });

    it('restricts a key to its allowed aliases', async () => {
      const res = await fetch(`${gw.base}/admin/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: 'scoped', allowed_aliases: ['only_a'] }),
      });
      const { key } = (await res.json()) as { key: string };
      const denied = await chat(gw.base, { model: 'smart', messages: userMsg('x') }, {}, key);
      expect(denied.status).toBe(403);
      const ok = await chat(gw.base, { model: 'only_a', messages: userMsg('x') }, {}, key);
      expect(ok.status).toBe(200);
      await ok.json();
    });
  });

  describe('usage tracking and admin API', () => {
    it('records cost per request and exposes it through the admin API', async () => {
      const res = await chat(gw.base, { model: 'smart', messages: userMsg('track my cost please') });
      const body = (await res.json()) as { usage: { prompt_tokens: number; completion_tokens: number } };
      const expected =
        (body.usage.prompt_tokens * 1 + body.usage.completion_tokens * 2) / 1_000_000;
      expect(Number(res.headers.get('x-tollgate-cost-usd'))).toBeCloseTo(expected, 10);

      const usage = await fetch(`${gw.base}/admin/usage?group_by=model`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      const json = (await usage.json()) as { data: Array<{ group: string; requests: number; cost_usd: number }> };
      expect(json.data[0]?.group).toBe('a/m');
      expect(json.data[0]?.requests).toBe(1);
      expect(json.data[0]?.cost_usd).toBeCloseTo(expected, 10);
    });

    it('records cache savings and zero cost for hits', async () => {
      const body = { model: 'det', messages: userMsg('saving money') };
      await (await chat(gw.base, body)).json();
      await new Promise((r) => setTimeout(r, 20));
      await (await chat(gw.base, body)).json();
      const events = gw.gateway.usageStore!.events;
      expect(events).toHaveLength(2);
      const hit = events.find((e) => e.cache === 'exact')!;
      expect(hit.cost_usd).toBe(0);
      expect(hit.saved_usd).toBeGreaterThan(0);
    });

    it('requires the admin key and supports revoking a key', async () => {
      const denied = await fetch(`${gw.base}/admin/keys`);
      expect(denied.status).toBe(401);

      const created = await fetch(`${gw.base}/admin/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_KEY}` },
        body: JSON.stringify({ name: 'temp' }),
      });
      const { id, key } = (await created.json()) as { id: string; key: string };
      expect((await chat(gw.base, { model: 'smart', messages: userMsg('x') }, {}, key)).status).toBe(200);

      const revoke = await fetch(`${gw.base}/admin/keys/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(revoke.status).toBe(204);
      expect((await chat(gw.base, { model: 'smart', messages: userMsg('x') }, {}, key)).status).toBe(401);
    });

    it('exports prometheus metrics', async () => {
      await (await chat(gw.base, { model: 'smart', messages: userMsg('metrics') })).json();
      const text = await (await fetch(`${gw.base}/metrics`)).text();
      expect(text).toContain('tollgate_requests_total');
      expect(text).toContain('tollgate_tokens_total');
      expect(text).toContain('tollgate_circuit_state');
    });
  });

  describe('client disconnects', () => {
    it('records an aborted stream and does not count it against the provider', async () => {
      await a.control({ streamDelayMs: 40, replyWords: 200 });
      const controller = new AbortController();
      const res = await fetch(`${gw.base}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: 'only_a', messages: userMsg('long answer'), stream: true }),
      });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await new Promise((r) => setTimeout(r, 300));
      const events = gw.gateway.usageStore!.events;
      expect(events.at(-1)?.status).toBe('aborted');
      const providers = await fetch(`${gw.base}/admin/providers`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      const json = (await providers.json()) as { breakers: Record<string, { state: string }> };
      expect(json.breakers.a?.state ?? 'closed').toBe('closed');
    });
  });
});
