import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { SqlPolicy } from "../sql/policy.js";

export interface GenerateSqlInput {
  prompt: string;
  schemaDescription: string;
  modelId: string;
  region: string;
  policy: SqlPolicy;
}

export async function generateSqlFromBedrock(input: GenerateSqlInput): Promise<string> {
  const client = new BedrockRuntimeClient({ region: input.region });

  const systemPrompt = [
    "You are an assistant that writes PostgreSQL queries.",
    "Return ONLY raw SQL.",
    `Allowed statement types: ${input.policy.allowedStatements.join(", ")}`,
    "Use only allowed tables and columns from the schema provided.",
    `Never output LIMIT above ${input.policy.maxLimit}.`,
  ].join("\n");

  const userPrompt = [
    "Schema:",
    input.schemaDescription,
    "",
    "Task:",
    input.prompt,
  ].join("\n");

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 512,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  };

  const response = await client.send(
    new InvokeModelCommand({
      modelId: input.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }),
  );

  const text = new TextDecoder().decode(response.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Bedrock response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sql = extractTextFromBedrockResponse(parsed);

  if (!sql) {
    throw new Error("Bedrock returned no text content");
  }

  return sql.replace(/^```sql\s*/i, "").replace(/```$/i, "").trim();
}

function extractTextFromBedrockResponse(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  const content = obj.content;
  if (Array.isArray(content)) {
    for (const chunk of content) {
      if (!chunk || typeof chunk !== "object") continue;
      const chunkObj = chunk as Record<string, unknown>;
      if (chunkObj.type === "text" && typeof chunkObj.text === "string") {
        return chunkObj.text.trim();
      }
    }
  }

  if (typeof obj.outputText === "string") return obj.outputText.trim();
  if (typeof obj.completion === "string") return obj.completion.trim();
  if (typeof obj.generated_text === "string") return obj.generated_text.trim();
  return undefined;
}
