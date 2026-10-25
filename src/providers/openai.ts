import { parseModelJson, postJson } from "./http.js";
import { ProviderError, type GenerateRequest, type Provider } from "./types.js";

export const OPENAI_DEFAULT_MODEL = "gpt-6-luna";

/** OpenAI Responses API with a strict JSON Schema output format. */
export function createOpenAIProvider(apiKey: string): Provider {
  const model = process.env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL;

  return {
    name: "openai",
    model,
    async generate(req: GenerateRequest) {
      const data = await postJson(
        "openai",
        "https://api.openai.com/v1/responses",
        { Authorization: `Bearer ${apiKey}` },
        {
          model,
          instructions: req.system,
          input: req.prompt,
          text: { format: { type: "json_schema", name: "recipes", strict: true, schema: req.jsonSchema } },
        },
      );

      if (data.status === "incomplete") {
        const reason = data.incomplete_details?.reason;
        if (reason === "content_filter") {
          throw new ProviderError("The model declined this request. Try different ingredients or constraints.", false);
        }
        throw new ProviderError(`openai: response incomplete (${reason ?? "unknown reason"})`, true);
      }

      // Collect the text parts of the assistant message; a refusal comes back as its own content part.
      let text = "";
      for (const item of data.output ?? []) {
        for (const part of item.content ?? []) {
          if (part.type === "refusal") {
            throw new ProviderError("The model declined this request. Try different ingredients or constraints.", false);
          }
          if (part.type === "output_text") text += part.text;
        }
      }
      return parseModelJson("openai", text);
    },
  };
}
