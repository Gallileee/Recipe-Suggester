import { z } from "zod";
import { createProvider, ProviderConfigError, ProviderError, type Provider } from "./providers/index.js";
import type { JsonSchema } from "./providers/types.js";

// ---------- Input ----------

export interface Constraints {
  dietary?: string; // e.g. "vegetarian", "gluten-free"
  cuisine?: string; // e.g. "italian"
  maxCookTimeMinutes?: number;
  servings?: number;
}

export interface RecipeRequest {
  ingredients: string[];
  constraints: Constraints;
}

// ---------- Output (validated for every provider) ----------

const IngredientSchema = z.object({
  name: z.string().describe("Ingredient name, e.g. 'eggs'"),
  quantity: z.string().describe("Amount for the requested servings, e.g. '2 pcs', '200 g'"),
  inFridge: z.boolean().describe("true if the user listed this ingredient, false if they must buy it"),
});

const RecipeSchema = z.object({
  title: z.string(),
  servings: z.number().int(),
  estimatedCookTimeMinutes: z.number().int().describe("Total time including prep"),
  ingredients: z.array(IngredientSchema),
  steps: z.array(z.string()).describe("Step-by-step instructions, one step per item"),
});

export const ResponseSchema = z.object({
  recipes: z.array(RecipeSchema).describe("Exactly three recipe suggestions"),
});

export type Recipe = z.infer<typeof RecipeSchema>;

/** Plain JSON Schema for OpenAI/Gemini; drops keys their strict modes don't need or accept. */
export function toPortableJsonSchema(schema: z.ZodType): JsonSchema {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !["$schema", "minimum", "maximum"].includes(key))
          .map(([key, value]) => [key, strip(value)]),
      );
    }
    return node;
  };
  return strip(z.toJSONSchema(schema)) as JsonSchema;
}

// ---------- Errors ----------

/** An error that is safe to show to the user as-is. */
export class RecipeError extends Error {}

// ---------- Validation ----------

export function validateRequest(req: RecipeRequest): void {
  const ingredients = req.ingredients.map((i) => i.trim()).filter(Boolean);
  if (ingredients.length === 0) {
    throw new RecipeError("Please provide at least one ingredient.");
  }
  const { maxCookTimeMinutes, servings } = req.constraints;
  if (maxCookTimeMinutes !== undefined && (!Number.isFinite(maxCookTimeMinutes) || maxCookTimeMinutes <= 0)) {
    throw new RecipeError("Max cook time must be a positive number of minutes.");
  }
  if (servings !== undefined && (!Number.isInteger(servings) || servings <= 0)) {
    throw new RecipeError("Servings must be a positive whole number.");
  }
}

// ---------- Prompt ----------

const SYSTEM_PROMPT = `You are a practical home-cooking assistant.
Given the ingredients a user has on hand and their constraints, suggest exactly three distinct recipes.
- Prefer recipes that use mostly what the user already has; keep missing items few and common.
- Mark each ingredient inFridge=true only if it matches something the user listed (treat obvious synonyms and singular/plural as matches). Basic pantry items the user did not list (salt, oil, water...) count as missing.
- Respect every constraint strictly: a dietary restriction must never be violated, and estimatedCookTimeMinutes must not exceed the time budget.
- Scale quantities to the requested number of servings.
- Write clear, numbered-style steps (without the numbers).`;

export function buildPrompt(req: RecipeRequest): string {
  const c = req.constraints;
  const lines = [`Ingredients I have: ${req.ingredients.join(", ")}`];
  if (c.dietary) lines.push(`Dietary restrictions: ${c.dietary}`);
  if (c.cuisine) lines.push(`Preferred cuisine: ${c.cuisine}`);
  if (c.maxCookTimeMinutes) lines.push(`Maximum total cook time: ${c.maxCookTimeMinutes} minutes`);
  lines.push(`Servings: ${c.servings ?? 2}`);
  return lines.join("\n");
}

// ---------- Retry ----------

export interface RetryOptions {
  retries: number; // retries after the first attempt
  baseDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/** Providers mark rate limits, overload, 5xx, timeouts, network errors and malformed output as transient. */
export function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.transient;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !isTransient(err)) throw err;
      // Exponential backoff with jitter: base, 2*base, 4*base ... (+0-25 %)
      const delayMs = Math.round(opts.baseDelayMs * 2 ** attempt * (1 + Math.random() * 0.25));
      opts.onRetry?.(attempt + 1, delayMs, err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------- Main entry point ----------

export interface SuggestOptions {
  provider?: Provider;
  retry?: Partial<RetryOptions>;
}

/** The provider that would be used with the current environment (for display). */
export function currentProvider(): Provider {
  try {
    return createProvider(ResponseSchema);
  } catch (err) {
    throw err instanceof ProviderConfigError ? new RecipeError(err.message) : err;
  }
}

export async function suggestRecipes(req: RecipeRequest, opts: SuggestOptions = {}): Promise<Recipe[]> {
  validateRequest(req);
  req = { ...req, ingredients: req.ingredients.map((i) => i.trim()).filter(Boolean) };

  const provider = opts.provider ?? currentProvider();
  const retry: RetryOptions = { retries: 3, baseDelayMs: 1000, ...opts.retry };
  const generateRequest = { system: SYSTEM_PROMPT, prompt: buildPrompt(req), jsonSchema: toPortableJsonSchema(ResponseSchema) };

  try {
    return await withRetry(async () => {
      const raw = await provider.generate(generateRequest);
      const parsed = ResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.recipes.length === 0) {
        // Output that doesn't match the schema is usually a one-off; retry it.
        throw new ProviderError(`${provider.name}: response did not match the recipe format`, true);
      }
      return parsed.data.recipes.slice(0, 3);
    }, retry);
  } catch (err) {
    throw toRecipeError(err, provider);
  }
}

function toRecipeError(err: unknown, provider: Provider): Error {
  if (!(err instanceof ProviderError)) return err instanceof Error ? err : new Error(String(err));
  const keyVar = `${provider.name.toUpperCase()}_API_KEY`;
  if (err.status === 401) return new RecipeError(`Invalid API key. Check ${keyVar} in your .env file.`);
  if (err.status === 403) return new RecipeError(`This API key is not allowed to use the model "${provider.model}".`);
  if (err.status === 404) {
    return new RecipeError(`Model "${provider.model}" was not found. Set ${provider.name.toUpperCase()}_MODEL in .env to a model your account can use.`);
  }
  if (err.transient) {
    return new RecipeError(`The ${provider.name} API is temporarily unavailable (gave up after retrying): ${err.message}`);
  }
  return new RecipeError(err.message);
}

// ---------- Formatting ----------

export function formatRecipe(recipe: Recipe, index: number): string {
  const out: string[] = [];
  out.push(`${index + 1}. ${recipe.title}`);
  out.push(`   Cook time: ~${recipe.estimatedCookTimeMinutes} min | Servings: ${recipe.servings}`);
  out.push("");
  out.push("   Ingredients:");
  for (const ing of recipe.ingredients) {
    const mark = ing.inFridge ? "[x]" : "[ ]";
    const note = ing.inFridge ? "" : "   <- MISSING";
    out.push(`     ${mark} ${ing.name} (${ing.quantity})${note}`);
  }
  out.push("");
  out.push("   Steps:");
  recipe.steps.forEach((step, i) => out.push(`     ${i + 1}) ${step}`));
  return out.join("\n");
}
