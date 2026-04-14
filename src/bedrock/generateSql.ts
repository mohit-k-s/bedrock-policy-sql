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
  const parsed = JSON.parse(text) as { content?: Array<{ type?: string; text?: string }> };
  const sql = parsed.content?.find((chunk) => chunk.type === "text")?.text?.trim();

  if (!sql) {
    throw new Error("Bedrock returned empty SQL response");
  }

  return sql.replace(/^```sql\s*/i, "").replace(/```$/i, "").trim();
}
