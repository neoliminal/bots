// Typed errors for OpenRouter API failures.

export class OpenRouterError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** 401/403 — the API key is missing, invalid, or unfunded. */
export class AuthError extends OpenRouterError {
  constructor(message = "OpenRouter authentication failed", status = 401) {
    super(message, status);
    this.name = "AuthError";
  }
}

/** 429 — rate limited by OpenRouter or the upstream provider. */
export class RateLimitError extends OpenRouterError {
  constructor(message = "OpenRouter rate limit exceeded", status = 429) {
    super(message, status);
    this.name = "RateLimitError";
  }
}

/** Any other non-2xx provider failure (outage, bad request, deprecated model...). */
export class ProviderError extends OpenRouterError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "ProviderError";
  }
}

/** Map an HTTP status (plus optional response detail) to a typed error. */
export function errorForStatus(status: number, detail?: string): OpenRouterError {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new AuthError(`OpenRouter authentication failed (${status})${suffix}`, status);
  }
  if (status === 429) {
    return new RateLimitError(`OpenRouter rate limit exceeded (429)${suffix}`, status);
  }
  return new ProviderError(`OpenRouter request failed (${status})${suffix}`, status);
}
