import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';

export interface MockState {
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  errorStatus: number;
  hangRate: number;
  streamDelayMs: number;
  replyWords: number;
}

export interface Fixture {
  match: string;
  answer: string;
}

export interface MockOptions {
  state?: Partial<MockState>;
  fixtures?: Fixture[];
  logger?: boolean;
}

const DEFAULTS: MockState = {
  latencyMs: 0,
  jitterMs: 0,
  errorRate: 0,
  errorStatus: 500,
  hangRate: 0,
  streamDelayMs: 0,
  replyWords: 24,
};

interface Msg {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
}

const textOf = (c: Msg['content']): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join(' ') : '';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function loadFixtures(path: string | undefined): Fixture[] {
  if (!path) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture[];
}

export async function buildMock(opts: MockOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, forceCloseConnections: true });
  const state: MockState = { ...DEFAULTS, ...opts.state };
  const fixtures = (opts.fixtures ?? []).map((f) => ({ re: new RegExp(f.match, 'i'), answer: f.answer }));
  let served = 0;
  let failed = 0;

  const reply = (messages: Msg[]): string => {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = textOf(last?.content ?? '');
    const fixture = fixtures.find((f) => f.re.test(prompt));
    if (fixture) return fixture.answer;
    const words = ['mock', 'reply', 'to:', ...prompt.split(/\s+/).filter(Boolean)];
    while (words.length < state.replyWords) words.push('lorem');
    return words.slice(0, state.replyWords).join(' ');
  };

  app.get('/control', async () => ({ state, served, failed }));
  app.post('/control', async (req) => {
    Object.assign(state, req.body as Partial<MockState>);
    return { state };
  });
  app.post('/control/reset', async () => {
    Object.assign(state, DEFAULTS);
    served = 0;
    failed = 0;
    return { state };
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body as {
      model: string;
      messages: Msg[];
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
      tools?: Array<{ function: { name: string } }>;
    };

    if (state.hangRate > 0 && Math.random() < state.hangRate) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120_000);
        req.raw.socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return res.code(504).send({ error: { message: 'mock provider hang ended' } });
    }
    const delay = state.latencyMs + (state.jitterMs ? Math.random() * state.jitterMs : 0);
    if (delay > 0) await sleep(delay);

    if (state.errorRate > 0 && Math.random() < state.errorRate) {
      failed++;
      return res
        .code(state.errorStatus)
        .send({ error: { message: 'mock provider failure', type: 'server_error', code: 'mock_error' } });
    }

    served++;
    const text = reply(body.messages);
    const promptTokens = Math.max(1, Math.ceil(body.messages.map((m) => textOf(m.content)).join(' ').length / 4));
    const completionTokens = Math.max(1, Math.ceil(text.length / 4));
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    const id = `chatcmpl-mock-${served}`;
    const created = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      return {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      };
    }

    res.hijack();
    res.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (obj: unknown) => res.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id, object: 'chat.completion.chunk', created, model: body.model };
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    const parts = text.split(/(?<=\s)/);
    for (const part of parts) {
      if (state.streamDelayMs > 0) await sleep(state.streamDelayMs);
      if (res.raw.destroyed) return res;
      send({ ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (body.stream_options?.include_usage) send({ ...base, choices: [], usage });
    res.raw.write('data: [DONE]\n\n');
    res.raw.end();
    return res;
  });

  app.post('/v1/embeddings', async (req) => {
    const body = req.body as { model: string; input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      object: 'list',
      model: body.model,
      data: inputs.map((text, index) => {
        const vec = new Array<number>(64).fill(0);
        for (let i = 0; i < text.length; i++) vec[text.charCodeAt(i) % 64] = (vec[text.charCodeAt(i) % 64] ?? 0) + 1;
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
        return { object: 'embedding', index, embedding: vec.map((v) => v / norm) };
      }),
      usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
    };
  });

  return app;
}
