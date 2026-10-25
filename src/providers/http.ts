import { isTransientStatus, ProviderError } from "./types.js";

const TIMEOUT_MS = 120_000;

/**
 * POST JSON with Node's built-in fetch and map failures to ProviderError.
 * Used for OpenAI and Gemini: their current SDKs need Node 20+/22+, plain HTTP works on Node 18.
 */
export async function postJson(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout - always worth retrying.
    throw new ProviderError(`${providerName}: network error (${(err as Error).message})`, true);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(`${providerName} API error ${res.status}: ${extractErrorMessage(text)}`, isTransientStatus(res.status), res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${providerName}: response was not valid JSON`, true);
  }
}

function extractErrorMessage(text: string): string {
  try {
    const data = JSON.parse(text);
    return data?.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Parse the model's JSON text answer; malformed output is treated as transient (a retry usually fixes it). */
export function parseModelJson(providerName: string, text: string | undefined): unknown {
  if (!text) throw new ProviderError(`${providerName}: empty response`, true);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${providerName}: model returned malformed JSON`, true);
  }
}
