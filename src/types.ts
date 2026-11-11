export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  response_format?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: unknown };
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  [extra: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      refusal?: string | null;
    };
    finish_reason: FinishReason | null;
    logprobs?: null;
  }>;
  usage?: Usage;
  system_fingerprint?: string | null;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: ToolCallDelta[];
      refusal?: string | null;
    };
    finish_reason: FinishReason | null;
    logprobs?: null;
  }>;
  usage?: Usage | null;
  system_fingerprint?: string | null;
}

export interface Target {
  provider: string;
  model: string;
}

export interface CallContext {
  requestId: string;
  signal: AbortSignal;
  timeoutMs: number;
  streamIdleMs: number;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly type: string;
  chat(req: ChatRequest, model: string, ctx: CallContext): Promise<ChatResponse>;
  stream(req: ChatRequest, model: string, ctx: CallContext): AsyncGenerator<ChatChunk>;
  embed?(input: string[], model: string, ctx: CallContext): Promise<number[][]>;
}
