import "dotenv/config";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { RecipeError, suggestRecipes, type RecipeRequest } from "./recipes.js";

const PORT = Number(process.env.PORT ?? 3000);
const INDEX_HTML = new URL("../public/index.html", import.meta.url);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new RecipeError("Request body is too large.");
  }
  return data;
}

function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null || value === "" ? undefined : Number(value);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(INDEX_HTML));
      return;
    }

    if (req.method === "POST" && req.url === "/api/recipes") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        throw err instanceof RecipeError ? err : new RecipeError("Request body must be valid JSON.");
      }
      const request: RecipeRequest = {
        ingredients: String(body.ingredients ?? "").split(","),
        constraints: {
          dietary: (body.dietary as string) || undefined,
          cuisine: (body.cuisine as string) || undefined,
          maxCookTimeMinutes: optionalNumber(body.maxCookTimeMinutes),
          servings: optionalNumber(body.servings),
        },
      };
      const recipes = await suggestRecipes(request, {
        retry: { onRetry: (attempt, delayMs) => console.warn(`Transient API error, retry ${attempt} in ${delayMs} ms`) },
      });
      sendJson(res, 200, { recipes });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof RecipeError) {
      sendJson(res, 400, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: "Something went wrong on the server." });
    }
  }
});

server.listen(PORT, () => console.log(`Recipe suggester running at http://localhost:${PORT}`));
