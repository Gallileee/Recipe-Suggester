import { parseModelJson, postJson } from "./http.js";
import { ProviderError, type GenerateRequest, type Provider } from "./types.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

/** Google Gemini API (generateContent) with JSON output constrained by a JSON Schema. */
export function createGeminiProvider(apiKey: string): Provider {
  const model = process.env.GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;

  return {
    name: "gemini",
    model,
    async generate(req: GenerateRequest) {
      let data;
      try {
        data = await postJson(
          "gemini",
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          { "x-goog-api-key": apiKey },
          {
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: "user", parts: [{ text: req.prompt }] }],
            generationConfig: { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema },
          },
        );
      } catch (err) {
        // Gemini reports a bad key as 400 "API key not valid"; treat it like a 401 elsewhere.
        if (err instanceof ProviderError && err.status === 400 && /API key not valid/i.test(err.message)) {
          throw new ProviderError(err.message, false, 401);
        }
        throw err;
      }

      if (data.promptFeedback?.blockReason) {
        throw new ProviderError("The model declined this request. Try different ingredients or constraints.", false);
      }
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") {
        throw new ProviderError("The model declined this request. Try different ingredients or constraints.", false);
      }
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new ProviderError("gemini: response was cut off", true);
      }
      const text = (candidate?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      return parseModelJson("gemini", text);
    },
  };
}
