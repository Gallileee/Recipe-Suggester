# Recipe Suggester

Give it the ingredients you have in the fridge plus optional constraints (dietary restriction, cuisine,
max cook time, servings) and it returns **three recipe suggestions**. Each recipe has a title, the full
ingredient list with the items you are **missing** clearly marked, step-by-step instructions and an
estimated cook time.

It uses the [Claude API](https://docs.claude.com) (model `claude-opus-5-5`) with structured outputs, so the
response is always validated JSON. There is a CLI and a minimal web UI.

## Features

- **Input:** ingredient list + any subset of `--diet`, `--cuisine`, `--max-time`, `--servings`.
- **Output per recipe:** title, ingredients (`[x]` have it / `[ ]` missing), numbered steps, estimated cook time.
- **Error handling:** input validation, friendly messages for a missing/invalid API key, refusals and cut-off responses.
- **Retries:** transient API failures (429 rate limit, 5xx / 529 overloaded, timeouts, network errors) are retried
  up to 3 times with exponential backoff + jitter (see `withRetry` in [src/recipes.ts](src/recipes.ts)).
  Non-transient errors (e.g. 400, 401) fail immediately.
- **Secrets:** the API key is read from the `ANTHROPIC_API_KEY` environment variable (or a git-ignored `.env` file); it is never committed.
- **Web UI (bonus):** `npm run web` → http://localhost:3000

## Setup

Requirements: Node.js 18.12+ and an Anthropic API key (https://console.anthropic.com → API Keys).

```bash
git clone https://github.com/<your-username>/recipe-suggester.git
cd recipe-suggester
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
# open .env and paste your key after ANTHROPIC_API_KEY=
npm run build
```

## Environment variables

| Variable            | Required | Default           | Description                                  |
| ------------------- | -------- | ----------------- | -------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | –                 | Your Anthropic API key.                      |
| `RECIPE_MODEL`      | no       | `claude-opus-5-5` | Claude model to use.                         |
| `PORT`              | no       | `3000`            | Port for the web UI (`npm run web`).         |

Variables can be set in the shell or in a `.env` file in the project root (loaded with `dotenv`).
`.env` is listed in `.gitignore`.

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

Unit tests cover input validation, prompt building and the retry logic (using a fake client, so no API key or network is needed).

## Example run

<!-- SAMPLE_RUN -->
_To be filled in with a real run._

## Project structure

```
src/recipes.ts   core logic: validation, prompt, Claude API call, retry, formatting
src/cli.ts       command-line interface
src/server.ts    minimal HTTP server for the web UI
public/index.html  web UI
src/test/        unit tests (node:test)
```
