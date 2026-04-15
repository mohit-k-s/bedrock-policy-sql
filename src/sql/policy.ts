export type StatementType = "select";

export interface TablePolicy {
  columns: string[];
  tenantScoped?: boolean;
  tenantColumn?: string;
}

export interface SqlPolicy {
  allowedStatements: StatementType[];
  tables: Record<string, TablePolicy>;
  defaultLimit: number;
  maxLimit: number;
  blockStarSelect: boolean;
  blockedFunctions: string[];
  allowCte: boolean;
}

function normalizePositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function createSqlPolicy(overrides: Partial<SqlPolicy> = {}): SqlPolicy {
  const policy: SqlPolicy = {
    allowedStatements: ["select"],
    tables: {},
    defaultLimit: 100,
    maxLimit: 1000,
    blockStarSelect: true,
    blockedFunctions: ["pg_sleep"],
    allowCte: false,
    ...overrides,
  };

  const defaultLimit = normalizePositiveInt(policy.defaultLimit, "defaultLimit");
  const maxLimit = normalizePositiveInt(policy.maxLimit, "maxLimit");
  if (defaultLimit > maxLimit) {
    throw new Error("defaultLimit must be less than or equal to maxLimit");
  }

  return {
    ...policy,
    defaultLimit,
    maxLimit,
    blockedFunctions: policy.blockedFunctions.map((fn) => fn.toLowerCase()),
  };
}
