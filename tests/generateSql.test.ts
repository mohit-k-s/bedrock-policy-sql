import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSqlFromBedrock } from "../src/bedrock/generateSql.js";
import { createSqlPolicy } from "../src/sql/policy.js";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class BedrockRuntimeClient {
    constructor(_config: unknown) {}

    send = sendMock;
  }

  class InvokeModelCommand {
    constructor(public readonly input: unknown) {}
  }

  return { BedrockRuntimeClient, InvokeModelCommand };
});

const policy = createSqlPolicy({
  tables: {
    users: { columns: ["id"] },
  },
});

const baseInput = {
  prompt: "List users",
  schemaDescription: "users(id)",
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  region: "us-east-1",
  policy,
};

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("generateSqlFromBedrock", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("extracts SQL from content text chunks", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ content: [{ type: "text", text: "select id from users limit 10" }] }),
    });

    await expect(generateSqlFromBedrock(baseInput)).resolves.toBe("select id from users limit 10");
  });

  it("strips markdown sql fences", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ content: [{ type: "text", text: "```sql\nselect id from users\n```" }] }),
    });

    await expect(generateSqlFromBedrock(baseInput)).resolves.toBe("select id from users");
  });

  it("falls back to outputText", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ outputText: "select id from users" }),
    });

    await expect(generateSqlFromBedrock(baseInput)).resolves.toBe("select id from users");
  });

  it("falls back to completion", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ completion: "select id from users" }),
    });

    await expect(generateSqlFromBedrock(baseInput)).resolves.toBe("select id from users");
  });

  it("falls back to generated_text", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ generated_text: "select id from users" }),
    });

    await expect(generateSqlFromBedrock(baseInput)).resolves.toBe("select id from users");
  });

  it("throws for invalid JSON responses", async () => {
    sendMock.mockResolvedValue({
      body: new TextEncoder().encode("not-json"),
    });

    await expect(generateSqlFromBedrock(baseInput)).rejects.toThrow("Bedrock response was not valid JSON");
  });

  it("throws when response contains no text", async () => {
    sendMock.mockResolvedValue({
      body: encodeJson({ content: [{ type: "tool_use", name: "x" }] }),
    });

    await expect(generateSqlFromBedrock(baseInput)).rejects.toThrow("Bedrock returned no text content");
  });
});
