import { ProviderError } from '../errors.js';
import type {
  CallContext,
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  FinishReason,
  ProviderAdapter,
  ToolCall,
  Usage,
} from '../types.js';
import { readJson, sseEvents, upstreamFetch } from '../util/http.js';
import { messageText, newCompletionId, nowSeconds } from '../util/misc.js';

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stop_reason: string | null;
  usage: AnthropicUsage;
}

interface AnthropicStreamEvent {
  type: string;
  index: number;
  message?: { model?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id: string; name: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

export const mapStopReason = (reason: string | null | undefined): FinishReason =>
  (reason && STOP_REASONS[reason]) || 'stop';

export function mapUsage(u: AnthropicUsage | undefined): Usage {
  const cached = u?.cache_read_input_tokens ?? 0;
  const prompt = (u?.input_tokens ?? 0) + cached + (u?.cache_creation_input_tokens ?? 0);
  const completion = u?.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function parseJsonObject(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function convertParts(content: ChatMessage['content']): AnthropicBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((part: ContentPart): AnthropicBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const url = part.image_url.url;
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (match?.[1] && match[2]) {
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }
    return { type: 'image', source: { type: 'url', url } };
  });
}

export function toAnthropicRequest(req: ChatRequest, model: string, stream: boolean) {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = messageText(m.content);
      if (text) system.push(text);
    } else if (m.role === 'user') {
      push('user', convertParts(m.content));
    } else if (m.role === 'assistant') {
      const blocks = convertParts(m.content);
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseJsonObject(call.function.arguments),
        });
      }
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      push('user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: messageText(m.content) },
      ]);
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? DEFAULT_MAX_TOKENS,
    stream,
  };
  if (system.length > 0) body.system = system.join('\n\n');
  if (req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature));
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop !== undefined) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    const choice = req.tool_choice;
    if (choice === 'required') body.tool_choice = { type: 'any' };
    else if (choice === 'none') body.tool_choice = { type: 'none' };
    else if (choice && typeof choice === 'object') {
      body.tool_choice = { type: 'tool', name: choice.function.name };
    } else if (choice === 'auto') body.tool_choice = { type: 'auto' };
  }
  return body;
}

export interface AnthropicAdapterOptions {
  name: string;
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic';
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: AnthropicAdapterOptions) {
    this.name = opts.name;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': API_VERSION,
    };
  }

  async chat(req: ChatRequest, model: string, ctx: CallContext): Promise<ChatResponse> {
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(toAnthropicRequest(req, model, false)) },
      ctx,
    );
    const json = await readJson<AnthropicResponse>(this.name, up, ctx);
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    return {
      id: newCompletionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: json.model ?? model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text.length > 0 || toolCalls.length === 0 ? text : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapStopReason(json.stop_reason),
        },
      ],
      usage: mapUsage(json.usage),
    };
  }

  async *stream(req: ChatRequest, model: string, ctx: CallContext): AsyncGenerator<ChatChunk> {
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(toAnthropicRequest(req, model, true)) },
      ctx,
    );

    const id = newCompletionId();
    const created = nowSeconds();
    let outModel = model;
    const usage: AnthropicUsage = {};
    let stopReason: string | null = null;
    let nextToolIndex = 0;
    const toolIndexByBlock = new Map<number, number>();
    const mk = (delta: ChatChunk['choices'][number]['delta'], finish: FinishReason | null = null): ChatChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: outModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    for await (const evt of sseEvents(this.name, up, ctx)) {
      let data: AnthropicStreamEvent;
      try {
        data = JSON.parse(evt.data) as AnthropicStreamEvent;
      } catch {
        throw new ProviderError(this.name, 502, `${this.name} sent a malformed stream event`, 'protocol');
      }
      switch (data.type) {
        case 'message_start': {
          outModel = data.message?.model ?? model;
          Object.assign(usage, data.message?.usage ?? {});
          yield mk({ role: 'assistant', content: '' });
          break;
        }
        case 'content_block_start': {
          const block = data.content_block;
          if (block?.type === 'tool_use') {
            const toolIndex = nextToolIndex++;
            toolIndexByBlock.set(data.index, toolIndex);
            yield mk({
              tool_calls: [
                { index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
              ],
            });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = data.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield mk({ content: delta.text });
          } else if (delta?.type === 'input_json_delta') {
            const toolIndex = toolIndexByBlock.get(data.index);
            if (toolIndex !== undefined) {
              yield mk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json ?? '' } }] });
            }
          }
          break;
        }
        case 'message_delta': {
          stopReason = data.delta?.stop_reason ?? stopReason;
          Object.assign(usage, data.usage ?? {});
          break;
        }
        case 'message_stop': {
          yield mk({}, mapStopReason(stopReason));
          yield {
            id,
            object: 'chat.completion.chunk',
            created,
            model: outModel,
            choices: [],
            usage: mapUsage(usage),
          };
          return;
        }
        case 'error': {
          const status = data.error?.type === 'overloaded_error' ? 529 : 502;
          throw new ProviderError(this.name, status, `${this.name} stream error: ${data.error?.message ?? 'unknown'}`);
        }
        default:
          break;
      }
    }
    throw new ProviderError(this.name, 502, `${this.name} stream ended before message_stop`, 'protocol');
  }
}
