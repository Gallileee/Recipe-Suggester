import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, RecipeError, suggestRecipes, validateRequest, withRetry } from "../recipes.js";

const noDelay = { retries: 3, baseDelayMs: 1 };

function overloaded() {
  return Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error" } }, "Overloaded", new Headers());
}

test("validateRequest rejects empty ingredients and bad numbers", () => {
  assert.throws(() => validateRequest({ ingredients: [" ", ""], constraints: {} }), RecipeError);
  assert.throws(() => validateRequest({ ingredients: ["eggs"], constraints: { servings: 0 } }), RecipeError);
  assert.throws(() => validateRequest({ ingredients: ["eggs"], constraints: { maxCookTimeMinutes: -5 } }), RecipeError);
  validateRequest({ ingredients: ["eggs"], constraints: { servings: 4, maxCookTimeMinutes: 30 } });
});

test("buildPrompt includes only the constraints that were given", () => {
  const prompt = buildPrompt({ ingredients: ["eggs", "rice"], constraints: { cuisine: "thai" } });
  assert.match(prompt, /eggs, rice/);
  assert.match(prompt, /thai/);
  assert.doesNotMatch(prompt, /Dietary/);
  assert.match(prompt, /Servings: 2/);
});

test("withRetry retries transient errors and then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw overloaded();
    return "ok";
  }, noDelay);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry does not retry non-transient errors", async () => {
  let calls = 0;
  const badRequest = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error" } }, "Bad", new Headers());
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw badRequest;
    }, noDelay),
  );
  assert.equal(calls, 1);
});

test("suggestRecipes turns exhausted retries into a friendly RecipeError", async () => {
  let calls = 0;
  const fakeClient = {
    beta: { messages: { parse: async () => { calls++; throw overloaded(); } } },
  } as unknown as Anthropic;
  await assert.rejects(
    suggestRecipes({ ingredients: ["eggs"], constraints: {} }, { client: fakeClient, retry: { baseDelayMs: 1, retries: 2 } }),
    (err: unknown) => err instanceof RecipeError && /temporarily unavailable/.test(err.message),
  );
  assert.equal(calls, 3); // 1 attempt + 2 retries
});
