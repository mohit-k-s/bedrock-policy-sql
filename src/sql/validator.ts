import { Parser } from "node-sql-parser";
import type { SqlPolicy } from "./policy.js";

const parser = new Parser();

type ValidationResult =
  | { ok: true; sql: string; params: unknown[] }
  | { ok: false; reason: string };

type AnyNode = Record<string, unknown>;

type FromEntry = {
  table?: string;
  as?: string;
  join?: string;
  on?: AnyNode;
};

type ParameterState = {
  placeholders: Array<{ name: string; value: unknown }>;
};

export class SqlValidator {
  constructor(private readonly policy: SqlPolicy) {}

  validate(inputSql: string, context: { tenantId?: string } = {}): ValidationResult {
    const sql = inputSql.trim();
    let ast: unknown;

    try {
      ast = parser.astify(sql, { database: "Postgresql" });
    } catch (error) {
      return {
        ok: false,
        reason: `SQL parse failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (Array.isArray(ast)) {
      return { ok: false, reason: "Only a single SQL statement is allowed" };
    }

    const stmt = structuredClone(ast as AnyNode);
    const parameterState: ParameterState = { placeholders: [] };
    const validated = this.validateSelectTree(stmt, context, parameterState);
    if (!validated.ok) return validated;
    const normalized = parser.sqlify(validated.stmt as never, { database: "Postgresql" });
    const finalized = this.finalizeSqlParameters(normalized, parameterState.placeholders);
    return {
      ok: true,
      sql: finalized.sql,
      params: finalized.params,
    };
  }

  private validateSelectTree(
    stmt: AnyNode,
    context: { tenantId?: string },
    parameterState: ParameterState,
    outerAliasToTable: Record<string, string> = {},
  ): { ok: true; stmt: AnyNode } | { ok: false; reason: string } {
    const statementType = String(stmt.type ?? "").toLowerCase();
    if (!this.policy.allowedStatements.includes(statementType as never)) {
      return { ok: false, reason: `Statement type not allowed: ${statementType}` };
    }

    if (stmt.with && !this.policy.allowCte) {
      return { ok: false, reason: "CTEs are not allowed" };
    }

    if (stmt.set_op || stmt._next) {
      return { ok: false, reason: "Set operations are not allowed" };
    }

    const fromList = Array.isArray(stmt.from) ? (stmt.from as FromEntry[]) : [];
    if (fromList.length === 0) {
      return { ok: false, reason: "SELECT without FROM is not allowed" };
    }

    for (const from of fromList) {
      const tableName = (from.table ?? "").toLowerCase();
      if (!tableName || !this.policy.tables[tableName]) {
        return { ok: false, reason: `Table not allowed: ${tableName || "<unknown>"}` };
      }
    }

    const aliasToTable = { ...outerAliasToTable, ...this.buildAliasMap(fromList) };
    const violations = this.scanExpressionTree(stmt, aliasToTable, fromList.map((f) => String(f.table ?? "").toLowerCase()));
    if (violations.length > 0) {
      return { ok: false, reason: violations[0] };
    }

    const withTenantGuardrails = this.enforceTenantGuardrails(stmt, fromList, aliasToTable, context.tenantId, parameterState);
    if (!withTenantGuardrails.ok) return withTenantGuardrails;

    if (this.isOffsetOnly(withTenantGuardrails.stmt)) {
      return { ok: false, reason: "OFFSET without LIMIT is not allowed" };
    }

    const withLimit = this.enforceLimit(withTenantGuardrails.stmt);
    const nested = this.validateNestedSelects(withLimit, context, parameterState, withLimit, aliasToTable);
    if (!nested.ok) return nested;
    return { ok: true, stmt: withLimit };
  }

  private buildAliasMap(fromList: FromEntry[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const from of fromList) {
      const table = String(from.table ?? "").toLowerCase();
      if (!table) continue;
      map[table] = table;
      if (from.as) map[String(from.as).toLowerCase()] = table;
    }
    return map;
  }

  private scanExpressionTree(root: AnyNode, aliasToTable: Record<string, string>, defaultTables: string[]): string[] {
    const stack: unknown[] = [root];
    const violations: string[] = [];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;

      const obj = node as AnyNode;
      const type = String(obj.type ?? "");
      if (type === "select" && obj !== root) continue;

      if (type === "column_ref") {
        const tableRaw = obj.table ? String(obj.table).toLowerCase() : "";
        if (obj.column === "*") {
          if (this.policy.blockStarSelect) violations.push("SELECT * is not allowed");
          continue;
        }
        const rawCol = (obj.column as AnyNode | undefined)?.expr as AnyNode | undefined;
        const column = String(rawCol?.value ?? "").toLowerCase();

        const resolvedTables = tableRaw
          ? [aliasToTable[tableRaw]].filter(Boolean)
          : defaultTables.filter((table) => {
              const allowed = this.policy.tables[table]?.columns ?? [];
              return allowed.includes(column);
            });

        if (!column) {
          violations.push("Could not resolve referenced column");
        } else if (resolvedTables.length === 0) {
          violations.push(`Column not allowed: ${tableRaw ? `${tableRaw}.` : ""}${column}`);
        } else if (!tableRaw && resolvedTables.length > 1) {
          violations.push(`Ambiguous unqualified column: ${column}`);
        } else {
          for (const table of resolvedTables) {
            const allowed = this.policy.tables[table]?.columns ?? [];
            if (!allowed.includes(column)) {
              violations.push(`Column not allowed: ${table}.${column}`);
              break;
            }
          }
        }
      }

      if (type === "star" && this.policy.blockStarSelect) {
        violations.push("SELECT * is not allowed");
      }

      if (type === "function" || type === "aggr_func") {
        const fn = this.extractFunctionName(obj.name);
        if (this.isBlockedFunction(fn)) {
          violations.push(`Function not allowed: ${fn}`);
        }
      }

      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          for (const item of value) stack.push(item);
        } else {
          stack.push(value);
        }
      }
    }

    return violations;
  }

  private extractFunctionName(nameNode: unknown): string {
    if (typeof nameNode === "string") return nameNode.toLowerCase();
    if (!nameNode || typeof nameNode !== "object") return "";

    const nameObj = nameNode as AnyNode;
    if (typeof nameObj.value === "string") return String(nameObj.value).toLowerCase();
    const schema = (nameObj.schema as AnyNode | undefined)?.value;
    if (Array.isArray(nameObj.name) && nameObj.name.length > 0) {
      const first = nameObj.name[0] as AnyNode;
      if (typeof first?.value === "string") {
        const baseName = String(first.value).toLowerCase();
        if (typeof schema === "string" && schema.length > 0) {
          return `${String(schema).toLowerCase()}.${baseName}`;
        }
        return baseName;
      }
    }

    return "";
  }

  private isBlockedFunction(functionName: string): boolean {
    if (!functionName) return false;
    if (this.policy.blockedFunctions.includes(functionName)) return true;
    const unqualified = functionName.split(".").at(-1);
    return !!unqualified && this.policy.blockedFunctions.includes(unqualified);
  }

  private enforceLimit(stmt: AnyNode): AnyNode {
    const next = structuredClone(stmt);
    const limitNode = (next.limit as AnyNode | undefined) ?? {};
    const values = (limitNode.value as AnyNode[] | undefined) ?? [];
    const rawLimit = values[0];

    if (!rawLimit) {
      next.limit = {
        seperator: "",
        value: [{ type: "number", value: this.policy.defaultLimit }],
      };
      return next;
    }

    const value = Number((rawLimit as AnyNode).value);
    if (!Number.isFinite(value) || value <= 0) {
      next.limit = {
        seperator: "",
        value: [{ type: "number", value: this.policy.defaultLimit }],
      };
      return next;
    }

    if (value > this.policy.maxLimit) {
      ((next.limit as AnyNode).value as AnyNode[])[0] = { type: "number", value: this.policy.maxLimit };
    }

    return next;
  }

  private isOffsetOnly(stmt: AnyNode): boolean {
    const limitNode = (stmt.limit as AnyNode | undefined) ?? {};
    const separator = String(limitNode.seperator ?? "").toLowerCase();
    const values = (limitNode.value as AnyNode[] | undefined) ?? [];
    return separator === "offset" && values.length === 1;
  }

  private enforceTenantGuardrails(
    stmt: AnyNode,
    fromList: FromEntry[],
    aliasToTable: Record<string, string>,
    tenantId?: string,
    parameterState?: ParameterState,
  ): { ok: true; stmt: AnyNode } | { ok: false; reason: string } {
    const tenantTables = fromList
      .map((f) => String(f.table ?? "").toLowerCase())
      .filter((table) => this.policy.tables[table]?.tenantScoped);

    if (tenantTables.length === 0) {
      return { ok: true, stmt: structuredClone(stmt) };
    }

    if (!tenantId) {
      return { ok: false, reason: "tenantId is required for tenant-scoped tables" };
    }

    const next = structuredClone(stmt);
    const nextFromList = Array.isArray(next.from) ? (next.from as FromEntry[]) : [];
    let where = (next.where as AnyNode | null | undefined) ?? null;

    for (const from of nextFromList) {
      const predicate = this.buildTenantPredicateForFrom(from, aliasToTable, tenantId, parameterState);
      if (!predicate) continue;

      if (this.isOuterJoin(from.join)) {
        from.on = from.on
          ? { type: "binary_expr", operator: "AND", left: from.on, right: predicate }
          : predicate;
        continue;
      }

      where = where ? { type: "binary_expr", operator: "AND", left: where, right: predicate } : predicate;
    }

    next.where = where;
    return { ok: true, stmt: next };
  }

  private buildTenantPredicateForFrom(
    from: FromEntry,
    aliasToTable: Record<string, string>,
    tenantId: string,
    parameterState?: ParameterState,
  ): AnyNode | null {
    const placeholder = `__safe_sql_param_${parameterState?.placeholders.length ?? 0}__`;
    if (parameterState) {
      parameterState.placeholders.push({ name: placeholder, value: tenantId });
    }

    const table = String(from.table ?? "").toLowerCase();
    const tablePolicy = this.policy.tables[table];
    if (!tablePolicy?.tenantScoped) return null;

    const alias = from.as ? String(from.as).toLowerCase() : table;
    const tenantColumn = (tablePolicy.tenantColumn ?? "tenant_id").toLowerCase();
    const resolvedAlias = aliasToTable[alias] ? alias : table;

    return {
      type: "binary_expr",
      operator: "=",
      left: {
        type: "column_ref",
        table: resolvedAlias,
        column: { expr: { type: "default", value: tenantColumn } },
        collate: null,
      },
      right: { type: "single_quote_string", value: placeholder },
    };
  }

  private isOuterJoin(joinType: string | undefined): boolean {
    const normalized = String(joinType ?? "").toUpperCase();
    return normalized.includes("LEFT") || normalized.includes("RIGHT") || normalized.includes("FULL");
  }

  private validateNestedSelects(
    node: unknown,
    context: { tenantId?: string },
    parameterState: ParameterState,
    root: AnyNode,
    outerAliasToTable: Record<string, string>,
  ): { ok: true } | { ok: false; reason: string } {
    if (!node || typeof node !== "object") return { ok: true };
    const obj = node as AnyNode;

    if (obj !== root && String(obj.type ?? "").toLowerCase() === "select") {
      const nestedResult = this.validateSelectTree(obj, context, parameterState, outerAliasToTable);
      if (!nestedResult.ok) return nestedResult;
      Object.keys(obj).forEach((key) => delete obj[key]);
      Object.assign(obj, nestedResult.stmt);
    }

    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const result = this.validateNestedSelects(item, context, parameterState, root, outerAliasToTable);
          if (!result.ok) return result;
        }
      } else {
        const result = this.validateNestedSelects(value, context, parameterState, root, outerAliasToTable);
        if (!result.ok) return result;
      }
    }

    return { ok: true };
  }

  private finalizeSqlParameters(
    sql: string,
    placeholders: Array<{ name: string; value: unknown }>,
  ): { sql: string; params: unknown[] } {
    const placeholderValueMap = new Map(placeholders.map((entry) => [entry.name, entry.value]));
    const indexByPlaceholder = new Map<string, number>();
    const params: unknown[] = [];

    const nextSql = sql.replace(/'(__safe_sql_param_\d+__)'/g, (_full, placeholderName: string) => {
      if (!indexByPlaceholder.has(placeholderName)) {
        const value = placeholderValueMap.get(placeholderName);
        params.push(value);
        indexByPlaceholder.set(placeholderName, params.length);
      }

      return `$${indexByPlaceholder.get(placeholderName)}`;
    });

    return { sql: nextSql, params };
  }
}
