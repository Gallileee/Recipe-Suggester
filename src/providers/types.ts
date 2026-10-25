/** A JSON Schema object (plain JSON). */
export type JsonSchema = Record<string, unknown>;

export interface GenerateRequest {
  system: string;
  prompt: string;
  /** JSON Schema the response must follow (used by OpenAI and Gemini). */
  jsonSchema: JsonSchema;
}

/** One AI vendor. `generate` returns the parsed JSON object produced by the model. */
export interface Provider {
  name: string;
  model: string;
  generate(req: GenerateRequest): Promise<unknown>;
}

/**
 * Normalized error thrown by every provider.
 * `transient` = worth retrying (rate limit, overload, 5xx, timeout, network error).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
