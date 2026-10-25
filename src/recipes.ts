import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const MODEL = process.env.RECIPE_MODEL ?? "claude-opus-5-5";

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

// ---------- Output (validated by structured outputs) ----------

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

const ResponseSchema = z.object({
  recipes: z.array(RecipeSchema).describe("Exactly three recipe suggestions"),
});

export type Recipe = z.infer<typeof RecipeSchema>;

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

/** Rate limits, overload, server errors, timeouts and network failures are worth retrying. */
export function isTransient(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.RateLimitError) return true; // 429
  if (err instanceof Anthropic.InternalServerError) return true; // 5xx, including 529 overloaded
  if (err instanceof Anthropic.APIError) return err.status === 408 || err.status === 409;
  return false;
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
  client?: Anthropic;
  retry?: Partial<RetryOptions>;
}

export async function suggestRecipes(req: RecipeRequest, opts: SuggestOptions = {}): Promise<Recipe[]> {
  validateRequest(req);
  req = { ...req, ingredients: req.ingredients.map((i) => i.trim()).filter(Boolean) };

  if (!opts.client && !process.env.ANTHROPIC_API_KEY) {
    throw new RecipeError("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
  // SDK-level retries are disabled so that our own retry loop (below) is the single, visible policy.
  const client = opts.client ?? new Anthropic({ maxRetries: 0, timeout: 120_000 });

  const retry: RetryOptions = { retries: 3, baseDelayMs: 1000, ...opts.retry };

  let response;
  try {
    response = await withRetry(
      () =>
        client.beta.messages.parse({
          model: MODEL,
          max_tokens: 16000,
          // Claude Opus 5.5 always thinks; "low" effort is plenty for recipe ideas and keeps it fast.
          output_config: { effort: "low", format: zodOutputFormat(ResponseSchema) },
          // If a safety classifier declines, let the API retry on a suitable fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildPrompt(req) }],
        }),
      retry,
    );
  } catch (err) {
    throw toRecipeError(err);
  }

  if (response.stop_reason === "refusal") {
    throw new RecipeError("The model declined this request. Try different ingredients or constraints.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new RecipeError("The response was cut off. Please try again.");
  }
  const parsed = response.parsed_output;
  if (!parsed || parsed.recipes.length === 0) {
    throw new RecipeError("The model returned an unexpected response. Please try again.");
  }
  return parsed.recipes.slice(0, 3);
}

function toRecipeError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new RecipeError("Invalid API key. Check ANTHROPIC_API_KEY in your .env file.");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new RecipeError("This API key is not allowed to use the model.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new RecipeError(`Bad request: ${err.message}`);
  }
  if (isTransient(err)) {
    return new RecipeError("The Claude API is temporarily unavailable (gave up after retrying). Please try again later.");
  }
  return err instanceof Error ? err : new Error(String(err));
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
