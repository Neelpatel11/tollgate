import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('tollgate');

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function startSpan(name: string, attributes: Attributes): Span {
  return tracer.startSpan(name, { attributes });
}

export function genAiAttributes(provider: string, model: string): Attributes {
  return { 'gen_ai.system': provider, 'gen_ai.request.model': model, 'gen_ai.operation.name': 'chat' };
}
