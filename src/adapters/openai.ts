import { ProviderError } from '../errors.js';
import type { CallContext, ChatChunk, ChatRequest, ChatResponse, ProviderAdapter } from '../types.js';
import { readJson, sseEvents, upstreamFetch } from '../util/http.js';

export interface OpenAIAdapterOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface EmbeddingsResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly type = 'openai';
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAIAdapterOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.headers,
    };
  }

  async chat(req: ChatRequest, model: string, ctx: CallContext): Promise<ChatResponse> {
    const body = { ...req, model, stream: false };
    delete body.stream_options;
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      ctx,
    );
    const json = await readJson<ChatResponse>(this.name, up, ctx);
    if (!json.choices?.length) {
      throw new ProviderError(this.name, 502, `${this.name} returned no choices`, 'protocol');
    }
    return json;
  }

  async *stream(req: ChatRequest, model: string, ctx: CallContext): AsyncGenerator<ChatChunk> {
    const body = { ...req, model, stream: true, stream_options: { include_usage: true } };
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      ctx,
    );
    for await (const evt of sseEvents(this.name, up, ctx)) {
      if (evt.data === '[DONE]') return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(evt.data) as ChatChunk;
      } catch {
        throw new ProviderError(this.name, 502, `${this.name} sent a malformed stream chunk`, 'protocol');
      }
      if ((chunk as unknown as { error?: { message?: string } }).error) {
        const message = (chunk as unknown as { error: { message?: string } }).error.message ?? 'stream error';
        throw new ProviderError(this.name, 502, `${this.name} stream error: ${message}`, 'protocol');
      }
      yield chunk;
    }
  }

  async embed(input: string[], model: string, ctx: CallContext): Promise<number[][]> {
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/embeddings`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ model, input }) },
      ctx,
    );
    const json = await readJson<EmbeddingsResponse>(this.name, up, ctx);
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
