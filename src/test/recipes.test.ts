import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderConfigError, resolveProviderName } from "../providers/index.js";
import { ProviderError, type Provider } from "../providers/types.js";
import {
  buildPrompt,
  RecipeError,
  ResponseSchema,
  suggestRecipes,
  toPortableJsonSchema,
  validateRequest,
  withRetry,
} from "../recipes.js";

const noDelay = { retries: 3, baseDelayMs: 1 };
const overloaded = () => new ProviderError("overloaded", true, 529);

const sampleRecipe = {
  title: "Egg fried rice",
  servings: 2,
  estimatedCookTimeMinutes: 15,
  ingredients: [
    { name: "eggs", quantity: "2", inFridge: true },
    { name: "soy sauce", quantity: "1 tbsp", inFridge: false },
  ],
  steps: ["Fry the eggs.", "Add rice and soy sauce."],
};

function fakeProvider(generate: Provider["generate"]): Provider {
  return { name: "fake", model: "fake-1", generate };
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
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new ProviderError("bad request", false, 400);
    }, noDelay),
  );
  assert.equal(calls, 1);
});

test("suggestRecipes returns validated recipes from the provider", async () => {
  const provider = fakeProvider(async () => ({ recipes: [sampleRecipe, sampleRecipe, sampleRecipe] }));
  const recipes = await suggestRecipes({ ingredients: ["eggs"], constraints: {} }, { provider });
  assert.equal(recipes.length, 3);
  assert.equal(recipes[0].ingredients[1].inFridge, false);
});

test("suggestRecipes retries a response that does not match the schema", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => (++calls === 1 ? { recipes: [{ title: "broken" }] } : { recipes: [sampleRecipe] }));
  const recipes = await suggestRecipes({ ingredients: ["eggs"], constraints: {} }, { provider, retry: noDelay });
  assert.equal(calls, 2);
  assert.equal(recipes[0].title, "Egg fried rice");
});

test("suggestRecipes turns exhausted retries into a friendly RecipeError", async () => {
  let calls = 0;
  const provider = fakeProvider(async () => {
    calls++;
    throw overloaded();
  });
  await assert.rejects(
    suggestRecipes({ ingredients: ["eggs"], constraints: {} }, { provider, retry: { baseDelayMs: 1, retries: 2 } }),
    (err: unknown) => err instanceof RecipeError && /temporarily unavailable/.test(err.message),
  );
  assert.equal(calls, 3); // 1 attempt + 2 retries
});

test("suggestRecipes explains an invalid API key", async () => {
  const provider = fakeProvider(async () => {
    throw new ProviderError("unauthorized", false, 401);
  });
  await assert.rejects(
    suggestRecipes({ ingredients: ["eggs"], constraints: {} }, { provider, retry: noDelay }),
    (err: unknown) => err instanceof RecipeError && /FAKE_API_KEY/.test(err.message),
  );
});

test("resolveProviderName picks the first key present, or the PROVIDER override", () => {
  assert.equal(resolveProviderName({ GEMINI_API_KEY: "g" }), "gemini");
  assert.equal(resolveProviderName({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }), "openai");
  assert.equal(resolveProviderName({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }), "anthropic");
  assert.equal(resolveProviderName({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", PROVIDER: "Gemini" }), "gemini");
  assert.equal(resolveProviderName({ OPENAI_API_KEY: "o", PROVIDER: "gpt" }), "openai");
});

test("resolveProviderName reports missing or unknown configuration", () => {
  assert.throws(() => resolveProviderName({}), ProviderConfigError);
  assert.throws(() => resolveProviderName({ ANTHROPIC_API_KEY: "a", PROVIDER: "openai" }), /OPENAI_API_KEY is missing/);
  assert.throws(() => resolveProviderName({ ANTHROPIC_API_KEY: "a", PROVIDER: "mistral" }), /Unknown PROVIDER/);
});

test("portable JSON schema is strict and has no $schema/min/max keys", () => {
  const schema = toPortableJsonSchema(ResponseSchema);
  const text = JSON.stringify(schema);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(text, /"\$schema"|"minimum"|"maximum"/);
});
