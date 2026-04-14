# bedrock-policy-sql

A deterministic TypeScript safety layer in front of Amazon Bedrock-generated SQL.

## What it does

1. Generate SQL from Bedrock (Claude prompt with strict output instructions).
2. Parse SQL into AST.
3. Deterministically validate against policy:
   - single statement only
   - `SELECT` only (default)
   - allowlisted tables and columns only
   - blocks `SELECT *`
   - blocks selected functions (e.g. `pg_sleep`)
   - enforces and caps `LIMIT`
4. Execute only validated SQL.

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Build

```bash
npm run build
```

## Quick start

```ts
import { SafeSqlLayer, createSqlPolicy } from "./src/index.js";
import { PostgresExecutor } from "./src/executor.js";

const policy = createSqlPolicy({
  tables: {
    users: { columns: ["id", "name", "email", "org_id", "active", "created_at", "tenant_id"], tenantScoped: true },
    orgs: { columns: ["id", "name", "plan", "created_at"] },
  },
  defaultLimit: 100,
  maxLimit: 1000,
});

const executor = new PostgresExecutor(process.env.DATABASE_URL!);

const layer = new SafeSqlLayer({
  policy,
  modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
  region: process.env.AWS_REGION || "us-east-1",
  schemaDescription: `
users(id, name, email, org_id, active, created_at)
orgs(id, name, plan, created_at)
  `.trim(),
  executor,
});

const result = await layer.ask("List active users with their org names", { tenantId: "tenant_123" });
console.log(result.executedSql);
console.log(result.rows);
```

### Query timeout defaults

- `statement_timeout`: `15000ms`
- `lock_timeout`: `2000ms`

You can override them:

```ts
const executor = new PostgresExecutor({
  connectionString: process.env.DATABASE_URL!,
  statementTimeoutMs: 10000,
  lockTimeoutMs: 1000,
});
```

## Notes

- Use a read-only DB role for this service.
- Tenant guardrails are policy-driven per table (`tenantScoped: true`) and require passing `tenantId` in `ask(...)`.
- Add DB-level RLS as a second safety boundary for stronger isolation.
- Keep policy/schema in source control so changes are auditable.
