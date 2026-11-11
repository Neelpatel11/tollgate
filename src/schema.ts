import { z } from 'zod';
import { badRequest } from './errors.js';
import type { ChatRequest } from './types.js';

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }),
});

const toolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.union([textPart, imagePart])), z.null()]).optional().default(null),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
});

const tool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

export const chatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    n: z.number().int().nullish(),
    stop: z.union([z.string(), z.array(z.string())]).nullish(),
    tools: z.array(tool).nullish(),
    tool_choice: z
      .union([
        z.enum(['none', 'auto', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
      ])
      .nullish(),
    response_format: z
      .object({ type: z.enum(['text', 'json_object', 'json_schema']), json_schema: z.unknown().optional() })
      .nullish(),
    seed: z.number().int().nullish(),
    presence_penalty: z.number().nullish(),
    frequency_penalty: z.number().nullish(),
    user: z.string().nullish(),
  })
  .passthrough();

export function parseChatRequest(body: unknown): ChatRequest {
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'body';
    throw badRequest(`Invalid request: ${path}: ${issue?.message ?? 'malformed'}`);
  }
  const data = parsed.data;
  if (data.n !== undefined && data.n !== null && data.n !== 1) {
    throw badRequest('Only n=1 is supported', 'unsupported_parameter');
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && k !== 'n') clean[k] = v;
  }
  return clean as ChatRequest;
}
