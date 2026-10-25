import type { ZodType } from "zod";
import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenAIProvider } from "./openai.js";
import type { Provider } from "./types.js";

export { ProviderError, type Provider } from "./types.js";

export type ProviderName = "anthropic" | "openai" | "gemini";

/** Env var holding each provider's key, in auto-detection priority order. */
export const KEY_VARS: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const ALIASES: Record<string, ProviderName> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gpt: "openai",
  gemini: "gemini",
  google: "gemini",
};

/** Thrown when no usable provider is configured; the message is meant for the user. */
export class ProviderConfigError extends Error {}

/**
 * Pick the provider: PROVIDER env var if set, otherwise the first one whose API key is present
 * (order: Anthropic, OpenAI, Gemini).
 */
export function resolveProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const override = env.PROVIDER?.trim().toLowerCase();
  if (override) {
    const name = ALIASES[override];
    if (!name) {
      throw new ProviderConfigError(`Unknown PROVIDER "${env.PROVIDER}". Use one of: anthropic, openai, gemini.`);
    }
    if (!env[KEY_VARS[name]]) {
      throw new ProviderConfigError(`PROVIDER is set to "${name}" but ${KEY_VARS[name]} is missing in your .env.`);
    }
    return name;
  }

  const found = (Object.keys(KEY_VARS) as ProviderName[]).find((name) => env[KEY_VARS[name]]);
  if (!found) {
    throw new ProviderConfigError(
      `No API key found. Copy .env.example to .env and set one of: ${Object.values(KEY_VARS).join(", ")}.`,
    );
  }
  return found;
}

export function createProvider(schema: ZodType, env: NodeJS.ProcessEnv = process.env): Provider {
  const name = resolveProviderName(env);
  const key = env[KEY_VARS[name]]!;
  switch (name) {
    case "anthropic":
      return createAnthropicProvider(schema); // the SDK reads ANTHROPIC_API_KEY itself
    case "openai":
      return createOpenAIProvider(key);
    case "gemini":
      return createGeminiProvider(key);
  }
}
