import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChatMessage, ContentPart } from '../types.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const newRequestId = (): string => `req_${randomUUID().replace(/-/g, '')}`;

export const newCompletionId = (): string => `chatcmpl-${randomBytes(12).toString('hex')}`;

export const newToolCallId = (): string => `call_${randomBytes(9).toString('hex')}`;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function messageText(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4 + estimateTokens(messageText(m.content));
    for (const call of m.tool_calls ?? []) {
      total += estimateTokens(call.function.name + call.function.arguments);
    }
  }
  return total + 2;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export function splitTarget(spec: string): { provider: string; model: string } {
  const idx = spec.indexOf('/');
  if (idx <= 0 || idx === spec.length - 1) {
    throw new Error(`Invalid target "${spec}", expected "provider/model"`);
  }
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}
