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

export function createSqlPolicy(overrides: Partial<SqlPolicy> = {}): SqlPolicy {
  return {
    allowedStatements: ["select"],
    tables: {},
    defaultLimit: 100,
    maxLimit: 1000,
    blockStarSelect: true,
    blockedFunctions: ["pg_sleep"],
    allowCte: false,
    ...overrides,
  };
}
