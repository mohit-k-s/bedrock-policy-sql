import { Pool, type QueryResultRow } from "pg";

export interface QueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface QueryTimeoutOverrides {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export interface QueryTimeoutConfig {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

export interface PostgresExecutorOptions extends QueryTimeoutOverrides {
  connectionString: string;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

function normalizePositiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds`);
  }
  return value;
}

export function resolveQueryTimeouts(overrides: QueryTimeoutOverrides = {}): QueryTimeoutConfig {
  return {
    statementTimeoutMs: normalizePositiveInt(
      overrides.statementTimeoutMs,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      "statementTimeoutMs",
    ),
    lockTimeoutMs: normalizePositiveInt(overrides.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs"),
  };
}

export class PostgresExecutor implements QueryExecutor {
  private readonly pool: Pool;

  constructor(connectionString: string, timeouts?: QueryTimeoutOverrides);
  constructor(options: PostgresExecutorOptions);
  constructor(connectionOrOptions: string | PostgresExecutorOptions, timeouts: QueryTimeoutOverrides = {}) {
    const resolvedTimeouts =
      typeof connectionOrOptions === "string" ? resolveQueryTimeouts(timeouts) : resolveQueryTimeouts(connectionOrOptions);

    if (typeof connectionOrOptions === "string") {
      this.pool = new Pool({
        connectionString: connectionOrOptions,
        statement_timeout: resolvedTimeouts.statementTimeoutMs,
        lock_timeout: resolvedTimeouts.lockTimeoutMs,
      });
      return;
    }

    this.pool = new Pool({
      connectionString: connectionOrOptions.connectionString,
      statement_timeout: resolvedTimeouts.statementTimeoutMs,
      lock_timeout: resolvedTimeouts.lockTimeoutMs,
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.pool.query<T>(sql, params);
    return { rows: result.rows };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
