#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import { formatRecipe, RecipeError, suggestRecipes, type RecipeRequest } from "./recipes.js";

const HELP = `Usage: npm start -- [options] <ingredient> [ingredient ...]

Ingredients can be given as separate words or as one comma-separated string:
  npm start -- "eggs, rice, spinach, garlic"

Options (all optional):
  -d, --diet <text>        Dietary restriction, e.g. vegetarian, vegan, gluten-free
  -c, --cuisine <text>     Preferred cuisine, e.g. italian, mexican
  -t, --max-time <min>     Maximum total cook time in minutes
  -s, --servings <n>       Number of servings (default 2)
      --json               Print raw JSON instead of formatted text
  -h, --help               Show this help`;

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n)) throw new RecipeError(`${name} must be a number, got "${value}".`);
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      diet: { type: "string", short: "d" },
      cuisine: { type: "string", short: "c" },
      "max-time": { type: "string", short: "t" },
      servings: { type: "string", short: "s" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const request: RecipeRequest = {
    ingredients: positionals.flatMap((p) => p.split(",")),
    constraints: {
      dietary: values.diet,
      cuisine: values.cuisine,
      maxCookTimeMinutes: parseNumber(values["max-time"], "--max-time"),
      servings: parseNumber(values.servings, "--servings"),
    },
  };

  console.error("Asking Claude for recipe ideas...");
  const recipes = await suggestRecipes(request, {
    retry: {
      onRetry: (attempt, delayMs, err) =>
        console.error(`Transient error (${(err as Error).message}); retry ${attempt} in ${(delayMs / 1000).toFixed(1)} s...`),
    },
  });

  if (values.json) {
    console.log(JSON.stringify(recipes, null, 2));
  } else {
    console.log("\n" + recipes.map(formatRecipe).join("\n\n" + "-".repeat(60) + "\n\n"));
    console.log("\n[x] = you have it   [ ] = missing, need to buy");
  }
}

main().catch((err) => {
  if (err instanceof RecipeError || (err as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    console.error(`Error: ${(err as Error).message}`);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exitCode = 1;
});
