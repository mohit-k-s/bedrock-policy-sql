import { z } from "zod";
import type { QueryResultRow } from "pg";
import { generateSqlFromBedrock } from "./bedrock/generateSql.js";
import type { QueryExecutor } from "./executor.js";
import { createSqlPolicy, type SqlPolicy } from "./sql/policy.js";
import { SqlValidator } from "./sql/validator.js";

const AskInputSchema = z.object({
  question: z.string().min(1),
  tenantId: z.string().min(1).optional(),
});

export interface SafeSqlLayerConfig {
  policy: SqlPolicy;
  modelId: string;
  region: string;
  schemaDescription: string;
  executor: QueryExecutor;
}

export interface AskResult<T = Record<string, unknown>> {
  generatedSql: string;
  executedSql: string;
  rows: T[];
}

export class SafeSqlLayer {
  private readonly validator: SqlValidator;

  constructor(private readonly config: SafeSqlLayerConfig) {
    this.validator = new SqlValidator(config.policy);
  }

  async ask<T extends QueryResultRow = QueryResultRow>(
    question: string,
    options: { tenantId?: string } = {},
  ): Promise<AskResult<T>> {
    const parsed = AskInputSchema.parse({ question, tenantId: options.tenantId });

    const generatedSql = await generateSqlFromBedrock({
      prompt: parsed.question,
      schemaDescription: this.config.schemaDescription,
      modelId: this.config.modelId,
      region: this.config.region,
      policy: this.config.policy,
    });

    const validation = this.validator.validate(generatedSql, { tenantId: parsed.tenantId });
    if (!validation.ok) {
      throw new Error(`SQL rejected by deterministic validator: ${validation.reason}`);
    }

    const result = await this.config.executor.query<T>(validation.sql);

    return {
      generatedSql,
      executedSql: validation.sql,
      rows: result.rows,
    };
  }
}

const DEFAULT_POLICY = createSqlPolicy({
  tables: {
    users: { columns: ["id", "name", "email", "org_id", "active", "created_at"] },
    orgs: { columns: ["id", "name", "plan", "created_at"] },
  },
});

export function createDefaultSafeSqlLayer(config: Omit<SafeSqlLayerConfig, "policy">): SafeSqlLayer {
  return new SafeSqlLayer({ ...config, policy: DEFAULT_POLICY });
}

export { createSqlPolicy };
