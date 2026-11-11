import type { ChatChunk, ChatResponse, FinishReason, ToolCall, Usage } from '../types.js';

export class ChunkAggregator {
  private id = '';
  private model = '';
  private created = 0;
  private content = '';
  private finishReason: FinishReason | null = null;
  private usage: Usage | undefined;
  private readonly toolCalls = new Map<number, ToolCall>();

  add(chunk: ChatChunk): void {
    if (!this.id) {
      this.id = chunk.id;
      this.model = chunk.model;
      this.created = chunk.created;
    }
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) return;
    if (choice.delta.content) this.content += choice.delta.content;
    for (const delta of choice.delta.tool_calls ?? []) {
      let call = this.toolCalls.get(delta.index);
      if (!call) {
        call = { id: delta.id ?? '', type: 'function', function: { name: '', arguments: '' } };
        this.toolCalls.set(delta.index, call);
      }
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.function.name += delta.function.name;
      if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  get hasContent(): boolean {
    return this.content.length > 0 || this.toolCalls.size > 0;
  }

  get completionText(): string {
    return this.content;
  }

  get reportedUsage(): Usage | undefined {
    return this.usage;
  }

  get finished(): boolean {
    return this.finishReason !== null;
  }

  build(): ChatResponse {
    const calls = [...this.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.content.length > 0 || calls.length === 0 ? this.content : null,
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          },
          finish_reason: this.finishReason ?? 'stop',
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

export function responseToChunks(res: ChatResponse, chunkSize = 24): ChatChunk[] {
  const base = { id: res.id, object: 'chat.completion.chunk' as const, created: res.created, model: res.model };
  const choice = res.choices[0];
  if (!choice) return [];
  const chunks: ChatChunk[] = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  ];
  const text = choice.message.content ?? '';
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }],
    });
  }
  (choice.message.tool_calls ?? []).forEach((call, index) => {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: call.function.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
  return chunks;
}
