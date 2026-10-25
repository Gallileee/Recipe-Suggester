import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { isTransientStatus, ProviderError, type GenerateRequest, type Provider } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Claude via the official Anthropic SDK, with structured outputs validated against a zod schema. */
export function createAnthropicProvider(schema: ZodType, client?: Anthropic): Provider {
  const model = process.env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL;
  // SDK-level retries are disabled so that our own retry loop is the single, visible policy.
  const api = client ?? new Anthropic({ maxRetries: 0, timeout: 120_000 });

  return {
    name: "anthropic",
    model,
    async generate(req: GenerateRequest) {
      let response;
      try {
        response = await api.beta.messages.parse({
          model,
          max_tokens: 16000,
          // Claude Opus 5.5 always thinks; "low" effort is plenty for recipe ideas and keeps it fast.
          output_config: { effort: "low", format: zodOutputFormat(schema) },
          // If a safety classifier declines, let the API retry on a suitable fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        });
      } catch (err) {
        throw toProviderError(err);
      }

      if (response.stop_reason === "refusal") {
        throw new ProviderError("The model declined this request. Try different ingredients or constraints.", false);
      }
      if (response.stop_reason === "max_tokens") {
        throw new ProviderError("anthropic: response was cut off", true);
      }
      if (!response.parsed_output) {
        throw new ProviderError("anthropic: model returned an unexpected response", true);
      }
      return response.parsed_output;
    },
  };
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`anthropic: network error (${err.message})`, true); // includes timeouts
  }
  if (err instanceof Anthropic.APIError && err.status !== undefined) {
    return new ProviderError(`anthropic API error ${err.status}: ${err.message}`, isTransientStatus(err.status), err.status);
  }
  return new ProviderError(`anthropic: ${(err as Error).message ?? String(err)}`, false);
}
