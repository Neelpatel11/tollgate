export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody(): OpenAIErrorBody {
    return { error: { message: this.message, type: this.type, param: null, code: this.code } };
  }
}

export const badRequest = (message: string, code = 'invalid_request') =>
  new GatewayError(400, 'invalid_request_error', code, message);

export const unauthorized = (message = 'Invalid or missing API key') =>
  new GatewayError(401, 'authentication_error', 'invalid_api_key', message);

export const forbidden = (message: string, code = 'forbidden') =>
  new GatewayError(403, 'permission_error', code, message);

export const notFound = (message: string, code = 'not_found') =>
  new GatewayError(404, 'invalid_request_error', code, message);

export const rateLimited = (message: string, retryAfterSeconds: number, code = 'rate_limit_exceeded') =>
  new GatewayError(429, 'rate_limit_error', code, message, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

export const unavailable = (message: string, code = 'providers_unavailable') =>
  new GatewayError(503, 'server_error', code, message);

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    message: string,
    public readonly kind: 'http' | 'timeout' | 'network' | 'protocol' = 'http',
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    if (this.kind !== 'http') return true;
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }

  get failoverEligible(): boolean {
    if (this.retryable) return true;
    return this.status === 401 || this.status === 403;
  }

  get countsAgainstHealth(): boolean {
    return this.failoverEligible;
  }
}

export class ClientAbortError extends Error {
  constructor() {
    super('Client closed the connection');
    this.name = 'ClientAbortError';
  }
}
