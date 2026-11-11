import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter, toAnthropicRequest } from '../src/adapters/anthropic.js';
import { GeminiAdapter, cleanSchema, toGeminiRequest } from '../src/adapters/gemini.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { ProviderError } from '../src/errors.js';
import type { CallContext, ChatChunk, ChatRequest } from '../src/types.js';
import { ChunkAggregator } from '../src/util/aggregate.js';

const ctx = (): CallContext => ({
  requestId: 'req_test',
  signal: new AbortController().signal,
  timeoutMs: 2000,
  streamIdleMs: 2000,
});

const servers: FastifyInstance[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function stub(setup: (app: FastifyInstance) => void): Promise<string> {
  const app = Fastify({ forceCloseConnections: true });
  setup(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

function sse(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`)
    .join('');
}

async function collect(gen: AsyncGenerator<ChatChunk>) {
  const agg = new ChunkAggregator();
  const chunks: ChatChunk[] = [];
  for await (const c of gen) {
    chunks.push(c);
    agg.add(c);
  }
  return { agg, chunks, response: agg.build() };
}

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { city: { type: 'string' }, unit: { type: ['string', 'null'], enum: ['c', 'f'] } },
      required: ['city'],
    },
  },
};

describe('Anthropic request translation', () => {
  const req: ChatRequest = {
    model: 'smart',
    temperature: 1.7,
    stop: 'END',
    tool_choice: 'required',
    tools: [weatherTool],
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: 'Use metric.' },
      { role: 'user', content: 'Weather in Pune?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '31C sunny' },
      { role: 'tool', tool_call_id: 'call_2', content: 'second result' },
      { role: 'user', content: 'Thanks' },
    ],
  };
  const body = toAnthropicRequest(req, 'claude-x', false) as any;

  it('moves system and developer messages into the system field', () => {
    expect(body.system).toBe('Be brief.\n\nUse metric.');
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });

  it('maps tool calls and merges consecutive tool results into one user turn', () => {
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Pune' } }],
    });
    const results = body.messages[2];
    expect(results.role).toBe('user');
    expect(results.content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(results.content[0].tool_use_id).toBe('call_1');
  });

  it('clamps temperature, defaults max_tokens and maps stop and tool choice', () => {
    expect(body.temperature).toBe(1);
    expect(body.max_tokens).toBe(4096);
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(body.tools[0].input_schema.properties.city).toEqual({ type: 'string' });
  });

  it('converts data-URL images to base64 sources', () => {
    const out = toAnthropicRequest(
      {
        model: 'x',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      },
      'm',
      false,
    ) as any;
    expect(out.messages[0].content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });
});

describe('Anthropic adapter', () => {
  it('normalises a non-streaming tool_use response and usage', async () => {
    let seen: any;
    let headers: Record<string, unknown> = {};
    const url = await stub((app) =>
      app.post('/v1/messages', async (req) => {
        seen = req.body;
        headers = req.headers;
        return {
          id: 'msg_1',
          model: 'claude-x',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Pune' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 40 },
        };
      }),
    );
    const adapter = new AnthropicAdapter({ name: 'anthropic', apiKey: 'sk-test', baseUrl: url });
    const res = await adapter.chat({ model: 'smart', messages: [{ role: 'user', content: 'hi' }] }, 'claude-x', ctx());
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(seen.stream).toBe(false);
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
    expect(res.choices[0]?.message.content).toBe('Checking.');
    expect(res.choices[0]?.message.tool_calls?.[0]?.function).toEqual({
      name: 'get_weather',
      arguments: '{"city":"Pune"}',
    });
    expect(res.usage).toEqual({
      prompt_tokens: 50,
      completion_tokens: 7,
      total_tokens: 57,
      prompt_tokens_details: { cached_tokens: 40 },
    });
  });

  it('maps streaming events, including fragmented tool arguments, to OpenAI chunks', async () => {
    const url = await stub((app) =>
      app.post('/v1/messages', async (_req, reply) => {
        reply.header('content-type', 'text/event-stream');
        return sse([
          { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 12 } } } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { event: 'ping', data: { type: 'ping' } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: {} } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ci' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ty":"Pune"}' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
          { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }),
    );
    const adapter = new AnthropicAdapter({ name: 'anthropic', apiKey: 'k', baseUrl: url });
    const { response, chunks } = await collect(
      adapter.stream({ model: 'smart', messages: [{ role: 'user', content: 'hi' }] }, 'claude-x', ctx()),
    );
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    const msg = response.choices[0]!;
    expect(msg.message.content).toBe('Hello');
    expect(msg.message.tool_calls).toEqual([
      { id: 'toolu_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } },
    ]);
    expect(msg.finish_reason).toBe('tool_calls');
    expect(response.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 });
  });

  it('classifies provider errors for retry and failover decisions', async () => {
    const url = await stub((app) => {
      app.post('/v1/messages', async (_req, reply) => reply.code(529).header('retry-after', '3').send({ type: 'error' }));
    });
    const adapter = new AnthropicAdapter({ name: 'anthropic', apiKey: 'k', baseUrl: url });
    const err = await adapter
      .chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, 'c', ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).retryAfterMs).toBe(3000);
  });

  it('surfaces an in-stream overloaded error', async () => {
    const url = await stub((app) =>
      app.post('/v1/messages', async (_req, reply) => {
        reply.header('content-type', 'text/event-stream');
        return sse([
          { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c', usage: {} } } },
          { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
        ]);
      }),
    );
    const adapter = new AnthropicAdapter({ name: 'anthropic', apiKey: 'k', baseUrl: url });
    const err = await collect(
      adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, 'c', ctx()),
    ).catch((e: unknown) => e);
    expect((err as ProviderError).status).toBe(529);
  });
});

describe('Gemini request translation', () => {
  it('cleans JSON schema keys Gemini rejects and converts nullable types', () => {
    const cleaned = cleanSchema(weatherTool.function.parameters) as any;
    expect(cleaned.additionalProperties).toBeUndefined();
    expect(cleaned.properties.unit).toEqual({ type: 'string', nullable: true, enum: ['c', 'f'] });
    expect(cleaned.required).toEqual(['city']);
  });

  it('maps roles, tool calls and resolves the function name for tool results', () => {
    const body = toGeminiRequest({
      model: 'x',
      max_tokens: 50,
      response_format: { type: 'json_object' },
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      tools: [weatherTool],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Pune"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":31}' },
      ],
    }) as any;
    expect(body.systemInstruction.parts[0].text).toBe('Be brief.');
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[1].parts[0].functionCall).toEqual({ name: 'get_weather', args: { city: 'Pune' } });
    expect(body.contents[2].parts[0].functionResponse).toEqual({ name: 'get_weather', response: { temp: 31 } });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 50, responseMimeType: 'application/json' });
    expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['get_weather'] });
  });

  it('wraps non-object tool output', () => {
    const body = toGeminiRequest({
      model: 'x',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c', content: 'plain text' },
      ],
    }) as any;
    expect(body.contents[2].parts[0].functionResponse.response).toEqual({ result: 'plain text' });
  });
});

describe('Gemini adapter', () => {
  it('normalises a function call response with generated tool ids and thought tokens', async () => {
    let path = '';
    let key: unknown;
    const url = await stub((app) =>
      app.post('/models/:model', async (req) => {
        path = req.url;
        key = req.headers['x-goog-api-key'];
        return {
          candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Pune' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 6 },
          modelVersion: 'gemini-x-001',
        };
      }),
    );
    const adapter = new GeminiAdapter({ name: 'google', apiKey: 'g-key', baseUrl: url });
    const res = await adapter.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, 'gemini-x', ctx());
    expect(path).toContain('gemini-x:generateContent');
    expect(key).toBe('g-key');
    expect(res.choices[0]?.finish_reason).toBe('tool_calls');
    expect(res.choices[0]?.message.tool_calls?.[0]?.id).toMatch(/^call_/);
    expect(res.usage).toEqual({ prompt_tokens: 9, completion_tokens: 10, total_tokens: 19 });
  });

  it('streams text chunks and reports final usage and finish reason', async () => {
    const url = await stub((app) =>
      app.post('/models/:model', async (_req, reply) => {
        reply.header('content-type', 'text/event-stream');
        return sse([
          { data: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }], usageMetadata: { promptTokenCount: 5 } } },
          { data: { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } },
        ]);
      }),
    );
    const adapter = new GeminiAdapter({ name: 'google', apiKey: 'k', baseUrl: url });
    const { response } = await collect(
      adapter.stream({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, 'gemini-x', ctx()),
    );
    expect(response.choices[0]?.message.content).toBe('Hello');
    expect(response.choices[0]?.finish_reason).toBe('length');
    expect(response.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('reports a blocked prompt as content_filter', async () => {
    const url = await stub((app) =>
      app.post('/models/:model', async () => ({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 3 } })),
    );
    const adapter = new GeminiAdapter({ name: 'google', apiKey: 'k', baseUrl: url });
    const res = await adapter.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, 'g', ctx());
    expect(res.choices[0]?.finish_reason).toBe('content_filter');
  });
});

describe('OpenAI adapter', () => {
  it('forces include_usage on streams and stops at [DONE]', async () => {
    let body: any;
    const url = await stub((app) =>
      app.post('/v1/chat/completions', async (req, reply) => {
        body = req.body;
        reply.header('content-type', 'text/event-stream');
        const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' };
        return sse([
          { data: { ...base, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] } },
          { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
          { data: { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
          { data: '[DONE]' },
        ]);
      }),
    );
    const adapter = new OpenAIAdapter({ name: 'openai', baseUrl: `${url}/v1`, apiKey: 'k' });
    const { response } = await collect(
      adapter.stream({ model: 'alias', messages: [{ role: 'user', content: 'x' }] }, 'real-model', ctx()),
    );
    expect(body.model).toBe('real-model');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(response.usage?.total_tokens).toBe(2);
  });

  it('times out when the stream goes idle', async () => {
    const url = await stub((app) =>
      app.post('/v1/chat/completions', async (_req, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.write('data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n');
      }),
    );
    const adapter = new OpenAIAdapter({ name: 'openai', baseUrl: `${url}/v1` });
    const err = await collect(
      adapter.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, 'm', { ...ctx(), streamIdleMs: 100 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('timeout');
  });
});
