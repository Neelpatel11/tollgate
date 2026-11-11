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
import { messageText, newCompletionId, newToolCallId, nowSeconds } from '../util/misc.js';

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
}

const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'title',
]);

export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanSchema(v)]),
      );
    } else if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.filter((t) => t !== 'null');
      out.type = nonNull[0] ?? 'string';
      if (value.includes('null')) out.nullable = true;
    } else if (SCHEMA_KEYS.has(key)) {
      out[key] = cleanSchema(value);
    }
  }
  return out;
}

export function mapFinishReason(reason: string | undefined, hasToolCall: boolean): FinishReason {
  if (hasToolCall) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapUsage(u: GeminiUsage | undefined): Usage {
  const prompt = u?.promptTokenCount ?? 0;
  const completion = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

function convertParts(content: ChatMessage['content']): GeminiPart[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return content.map((part: ContentPart): GeminiPart => {
    if (part.type === 'text') return { text: part.text };
    const url = part.image_url.url;
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (match?.[1] && match[2]) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { mimeType: 'image/jpeg', fileUri: url } };
  });
}

function parseToolResult(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

export function toGeminiRequest(req: ChatRequest) {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const toolNames = new Map<string, string>();
  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };

  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = messageText(m.content);
      if (text) system.push(text);
    } else if (m.role === 'user') {
      push('user', convertParts(m.content));
    } else if (m.role === 'assistant') {
      const parts = convertParts(m.content);
      for (const call of m.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        let args: unknown = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      push('model', parts);
    } else if (m.role === 'tool') {
      const name = (m.tool_call_id && toolNames.get(m.tool_call_id)) || m.name || 'tool';
      push('user', [{ functionResponse: { name, response: parseToolResult(messageText(m.content)) } }]);
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;
  if (req.stop !== undefined) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.response_format && req.response_format.type !== 'text') {
    generationConfig.responseMimeType = 'application/json';
    const schema = (req.response_format.json_schema as { schema?: unknown } | undefined)?.schema;
    if (schema) generationConfig.responseSchema = cleanSchema(schema);
  }

  const body: Record<string, unknown> = { contents };
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? '',
          ...(t.function.parameters && Object.keys(t.function.parameters).length > 0
            ? { parameters: cleanSchema(t.function.parameters) }
            : {}),
        })),
      },
    ];
    const choice = req.tool_choice;
    if (choice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (choice === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (choice && typeof choice === 'object') {
      body.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] },
      };
    }
  }
  return body;
}

export interface GeminiAdapterOptions {
  name: string;
  apiKey: string;
  baseUrl?: string;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly type = 'gemini';
  readonly name: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: GeminiAdapterOptions) {
    this.name = opts.name;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey };
  }

  async chat(req: ChatRequest, model: string, ctx: CallContext): Promise<ChatResponse> {
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(toGeminiRequest(req)) },
      ctx,
    );
    const json = await readJson<GeminiResponse>(this.name, up, ctx);
    const candidate = json.candidates?.[0];
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        toolCalls.push({
          id: newToolCallId(),
          type: 'function',
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      } else if (part.text && !part.thought) {
        text += part.text;
      }
    }
    const blocked = !candidate && json.promptFeedback?.blockReason;
    return {
      id: newCompletionId(),
      object: 'chat.completion',
      created: nowSeconds(),
      model: json.modelVersion ?? model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text.length > 0 || toolCalls.length === 0 ? text : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: blocked ? 'content_filter' : mapFinishReason(candidate?.finishReason, toolCalls.length > 0),
        },
      ],
      usage: mapUsage(json.usageMetadata),
    };
  }

  async *stream(req: ChatRequest, model: string, ctx: CallContext): AsyncGenerator<ChatChunk> {
    const up = await upstreamFetch(
      this.name,
      `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(toGeminiRequest(req)) },
      ctx,
    );
    const id = newCompletionId();
    const created = nowSeconds();
    let outModel = model;
    let usage: GeminiUsage | undefined;
    let finishReason: string | undefined;
    let blocked = false;
    let toolIndex = 0;
    const mk = (delta: ChatChunk['choices'][number]['delta'], finish: FinishReason | null = null): ChatChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: outModel,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    yield mk({ role: 'assistant', content: '' });

    for await (const evt of sseEvents(this.name, up, ctx)) {
      let data: GeminiResponse;
      try {
        data = JSON.parse(evt.data) as GeminiResponse;
      } catch {
        throw new ProviderError(this.name, 502, `${this.name} sent a malformed stream event`, 'protocol');
      }
      if (data.modelVersion) outModel = data.modelVersion;
      if (data.usageMetadata) usage = data.usageMetadata;
      if (data.promptFeedback?.blockReason && !data.candidates?.length) blocked = true;
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          yield mk({
            tool_calls: [
              {
                index: toolIndex++,
                id: newToolCallId(),
                type: 'function',
                function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
              },
            ],
          });
        } else if (part.text && !part.thought) {
          yield mk({ content: part.text });
        }
      }
    }

    yield mk({}, blocked ? 'content_filter' : mapFinishReason(finishReason, toolIndex > 0));
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: outModel,
      choices: [],
      usage: mapUsage(usage),
    };
  }
}
