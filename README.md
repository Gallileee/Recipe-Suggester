# Recipe Suggester

Give it the ingredients you have in the fridge plus optional constraints (dietary restriction, cuisine,
max cook time, servings) and it returns **three recipe suggestions**. Each recipe has a title, the full
ingredient list with the items you are **missing** clearly marked, step-by-step instructions and an
estimated cook time.

It works with three AI providers: **Anthropic Claude**, **OpenAI** and **Google Gemini**. The app uses
whichever API key you put in `.env`. Every provider is asked for JSON that follows the same schema, and
the response is validated before it is shown. There is a CLI and a minimal web UI.

## Features

- **Input:** ingredient list + any subset of `--diet`, `--cuisine`, `--max-time`, `--servings`.
- **Output per recipe:** title, ingredients (`[x]` have it / `[ ]` missing), numbered steps, estimated cook time.
- **Error handling:** input validation, friendly messages for a missing/invalid API key, refusals and cut-off responses.
- **Multiple providers:** Claude, OpenAI or Gemini, picked automatically from the key you set. See [Choosing the AI provider](#choosing-the-ai-provider).
- **Retries:** transient API failures (429 rate limit, 5xx / 529 overloaded, timeouts, network errors and
  responses that don't match the schema) are retried up to 3 times with exponential backoff + jitter
  (see `withRetry` in [src/recipes.ts](src/recipes.ts)). Non-transient errors (e.g. 400, 401) fail immediately.
- **Secrets:** API keys are read from environment variables (or a git-ignored `.env` file) and are never committed.
- **Web UI (bonus):** `npm run web` → http://localhost:3000

## Setup

Requirements: Node.js 18.12+ (22 LTS recommended) and an API key from **one** of:

| Provider  | Where to get a key                                    | Note                       |
| --------- | ----------------------------------------------------- | -------------------------- |
| Anthropic | https://console.anthropic.com → API Keys              | paid                       |
| OpenAI    | https://platform.openai.com/api-keys                  | paid                       |
| Gemini    | https://aistudio.google.com/apikey                    | has a free tier            |

```bash
git clone https://github.com/<your-username>/recipe-suggester.git
cd recipe-suggester
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
# open .env and paste your key after ANTHROPIC_API_KEY=, OPENAI_API_KEY= or GEMINI_API_KEY=
npm run build
```

## Environment variables

| Variable            | Required        | Default            | Description                                              |
| ------------------- | --------------- | ------------------ | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | one of the keys | –                  | Anthropic (Claude) API key.                              |
| `OPENAI_API_KEY`    | one of the keys | –                  | OpenAI API key.                                          |
| `GEMINI_API_KEY`    | one of the keys | –                  | Google Gemini API key.                                   |
| `PROVIDER`          | no              | auto               | Force a provider: `anthropic`, `openai` or `gemini`.     |
| `ANTHROPIC_MODEL`   | no              | `claude-opus-5-5`  | Claude model.                                            |
| `OPENAI_MODEL`      | no              | `gpt-6-luna`       | OpenAI model.                                            |
| `GEMINI_MODEL`      | no              | `gemini-3.6-flash` | Gemini model (newer `gemini-3.8-flash` also works, but was often overloaded). |
| `PORT`              | no              | `3000`             | Port for the web UI (`npm run web`).                     |

Variables can be set in the shell or in a `.env` file in the project root (loaded with `dotenv`).
`.env` is listed in `.gitignore`.

## Choosing the AI provider

1. If `PROVIDER` is set, that provider is used. Its key must also be set, otherwise the app stops with a clear error.
2. Otherwise the app uses the first key it finds, in this order: `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY`.
3. If no key is set, the app tells you to create `.env`.

The CLI prints which provider and model it is using, e.g. `Asking gemini (gemini-3.6-flash) for recipe ideas...`.

| Provider  | How it is called                                                                   |
| --------- | ---------------------------------------------------------------------------------- |
| Anthropic | official `@anthropic-ai/sdk`, structured outputs (`messages.parse` + zod schema)   |
| OpenAI    | Responses API over HTTP, `text.format` = strict JSON Schema                        |
| Gemini    | `generateContent` over HTTP, `responseMimeType: application/json` + JSON Schema    |

OpenAI and Gemini are called with Node's built-in `fetch`, because their current SDKs need Node 20/22+.
On Node 18 this prints a one-time `ExperimentalWarning: The Fetch API is an experimental feature`, which is harmless.

## Usage

### CLI

```bash
npm start -- [options] <ingredients...>
```

| Option                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `-d, --diet <text>`    | Dietary restriction, e.g. `vegetarian`, `gluten-free` |
| `-c, --cuisine <text>` | Preferred cuisine, e.g. `italian`                   |
| `-t, --max-time <min>` | Maximum total cook time in minutes                  |
| `-s, --servings <n>`   | Number of servings (default 2)                      |
| `--json`               | Print raw JSON instead of formatted text            |
| `-h, --help`           | Show help                                           |

Ingredients can be separate arguments or one comma-separated string.

### Web UI

```bash
npm run web
```

Open http://localhost:3000, type your ingredients, optionally fill in constraints and click **Suggest recipes**.
The page calls `POST /api/recipes` with JSON like
`{"ingredients": "eggs, rice", "dietary": "vegetarian", "maxCookTimeMinutes": 30, "servings": 2}`.

### Tests

```bash
npm test
```

Unit tests cover input validation, prompt building, the retry logic, schema validation and provider selection
(using a fake provider, so no API key or network is needed).

## Example run

Real run with a Gemini key in `.env` (default model `gemini-3.6-flash`). The first two attempts hit a
503 "high demand" error, so you can see the
retry logic at work:

```bash
npm start -- "eggs, rice, spinach, garlic, parmesan" --diet vegetarian --max-time 30 --servings 2
```

```text
Asking gemini (gemini-3.6-flash) for recipe ideas...
Transient error (gemini API error 503: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.); retry 1 in 1.1 s...
Transient error (gemini API error 503: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.); retry 2 in 2.2 s...

1. Garlic Spinach Fried Rice with Fried Eggs
   Cook time: ~20 min | Servings: 2

   Ingredients:
     [x] cooked rice (3 cups)
     [x] spinach (150 g)
     [x] garlic (3 cloves)
     [x] eggs (2 pcs)
     [x] grated parmesan (30 g)
     [ ] vegetable oil (1 tbsp)   <- MISSING
     [ ] salt (1/2 tsp)   <- MISSING
     [ ] black pepper (1/4 tsp)   <- MISSING

   Steps:
     1) Finely mince the garlic cloves and roughly chop the spinach.
     2) Heat vegetable oil in a large skillet over medium heat.
     3) Add minced garlic and saute for 1 minute until fragrant.
     4) Toss in chopped spinach and stir-fry until wilted, about 2 minutes.
     5) Add cooked rice to the skillet, breaking up any clumps, and stir-fry for 3 to 4 minutes until heated through.
     6) Season with salt, black pepper, and fold in grated parmesan cheese.
     7) In a separate small non-stick pan, fry the eggs to your desired doneness.
     8) Divide the spinach fried rice between two plates and top each with a fried egg.

------------------------------------------------------------

2. Cheesy Spinach Garlic Omelet with Rice
   Cook time: ~15 min | Servings: 2

   Ingredients:
     [x] eggs (4 pcs)
     [x] spinach (100 g)
     [x] garlic (2 cloves)
     [x] parmesan (40 g)
     [x] cooked rice (2 cups)
     [ ] butter (1 tbsp)   <- MISSING
     [ ] salt (1/2 tsp)   <- MISSING

   Steps:
     1) Warm cooked rice and divide onto two serving plates.
     2) Whisk eggs with a pinch of salt in a medium bowl until smooth.
     3) Melt half the butter in a pan over medium heat, add minced garlic and spinach, sautéing until wilted, then set aside.
     4) Melt remaining butter in the skillet over medium-low heat and pour in whisked eggs.
     5) Gently lift edges to let raw egg flow underneath until mostly set.
     6) Sprinkle sautéed garlic spinach and grated parmesan over half of the omelet.
     7) Fold omelet over, slice in half, and serve each portion alongside warm rice.

------------------------------------------------------------

3. Spinach Parmesan Egg Drop Rice Soup
   Cook time: ~25 min | Servings: 2

   Ingredients:
     [x] cooked rice (2 cups)
     [x] eggs (2 pcs)
     [x] spinach (100 g)
     [x] garlic (2 cloves)
     [x] parmesan (30 g)
     [ ] vegetable broth (4 cups)   <- MISSING
     [ ] olive oil (1 tbsp)   <- MISSING
     [ ] salt and pepper (to taste)   <- MISSING

   Steps:
     1) Heat olive oil in a soup pot over medium heat, add minced garlic, and sauté for 1 minute.
     2) Pour in vegetable broth and bring to a gentle simmer.
     3) Whisk eggs and grated parmesan together in a small bowl until combined.
     4) Stir cooked rice and spinach into the simmering broth until spinach wilts.
     5) Slowly drizzle egg and parmesan mixture into the simmering soup while stirring gently to form egg ribbons.
     6) Season with salt and pepper to taste, then ladle into two bowls and serve hot.

[x] = you have it   [ ] = missing, need to buy
```

## Project structure

```
src/recipes.ts           core logic: validation, prompt, schema, retry, formatting
src/providers/index.ts   provider selection from env (PROVIDER / which key is set)
src/providers/anthropic.ts  Claude via the Anthropic SDK
src/providers/openai.ts  OpenAI Responses API
src/providers/gemini.ts  Google Gemini API
src/providers/http.ts    shared fetch helper with error mapping
src/cli.ts       command-line interface
src/server.ts    minimal HTTP server for the web UI
public/index.html  web UI
src/test/        unit tests (node:test)
```
