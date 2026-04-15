import { describe, expect, it } from "vitest";
import { createSqlPolicy } from "../src/sql/policy.js";
import { SqlValidator } from "../src/sql/validator.js";

const policy = createSqlPolicy({
  tables: {
    users: { columns: ["id", "name", "email", "org_id", "active", "created_at"] },
    orgs: { columns: ["id", "name", "plan", "created_at"] },
  },
  defaultLimit: 50,
  maxLimit: 200,
});

const validator = new SqlValidator(policy);

describe("SqlValidator", () => {
  it("allows valid select and injects default limit", () => {
    const result = validator.validate("select id, name from users where active = true");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("limit 50");
  });

  it("rejects multiple statements", () => {
    const result = validator.validate("select id from users; select id from orgs");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("single SQL statement");
  });

  it("rejects non-select statements", () => {
    const result = validator.validate("delete from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Statement type not allowed");
  });

  it("rejects disallowed tables", () => {
    const result = validator.validate("select id from payments");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Table not allowed");
  });

  it("rejects disallowed columns", () => {
    const result = validator.validate("select password_hash from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Column not allowed");
  });

  it("rejects select star", () => {
    const result = validator.validate("select * from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("SELECT * is not allowed");
  });

  it("caps limit to max limit", () => {
    const result = validator.validate("select id from users limit 9999");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("limit 200");
  });

  it("allows joins with scoped columns", () => {
    const result = validator.validate(
      "select u.id, o.name from users u join orgs o on u.org_id = o.id where u.active = true limit 25",
    );
    expect(result.ok).toBe(true);
  });

  it("allows an unqualified column when exactly one joined table exposes it", () => {
    const result = validator.validate("select email from users join orgs on users.org_id = orgs.id");
    expect(result.ok).toBe(true);
  });

  it("rejects an ambiguous unqualified column in a join", () => {
    const result = validator.validate("select id from users join orgs on users.org_id = orgs.id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Ambiguous unqualified column");
  });

  it("rejects blocked functions", () => {
    const result = validator.validate("select pg_sleep(1) from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Function not allowed");
  });

  it("rejects schema-qualified blocked functions", () => {
    const result = validator.validate("select pg_catalog.pg_sleep(1) from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Function not allowed");
  });

  it("rejects CTE by default", () => {
    const result = validator.validate("with u as (select id from users) select id from u");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("CTEs are not allowed");
  });

  it("rejects select without from", () => {
    const result = validator.validate("select 1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("SELECT without FROM is not allowed");
  });
});

describe("SqlValidator tenant guardrails", () => {
  const tenantPolicy = createSqlPolicy({
    tables: {
      users: { columns: ["id", "name", "tenant_id", "org_id"], tenantScoped: true },
      orgs: { columns: ["id", "name"] },
      invoices: { columns: ["id", "account_id"], tenantScoped: true, tenantColumn: "account_id" },
    },
    defaultLimit: 10,
    maxLimit: 100,
  });

  const tenantValidator = new SqlValidator(tenantPolicy);

  it("rejects tenant-scoped table access when tenantId missing", () => {
    const result = tenantValidator.validate("select id, name from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("tenantId is required");
  });

  it("injects tenant predicate for tenant-scoped table", () => {
    const result = tenantValidator.validate("select id, name from users", { tenantId: "t_123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("\"users\".tenant_id = $1");
    expect(result.params).toEqual(["t_123"]);
  });

  it("does not require tenantId for unscoped tables", () => {
    const result = tenantValidator.validate("select id, name from orgs");
    expect(result.ok).toBe(true);
  });

  it("injects tenant predicates for mixed join only on scoped tables", () => {
    const result = tenantValidator.validate(
      "select u.id, o.name from users u join orgs o on u.org_id = o.id",
      { tenantId: "tenantA" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("\"u\".tenant_id = $1");
    expect(sql).not.toContain("o.tenant_id");
    expect(result.params).toEqual(["tenantA"]);
  });

  it("injects tenant predicate into outer join condition instead of where", () => {
    const joinTenantPolicy = createSqlPolicy({
      tables: {
        users: { columns: ["id", "org_id"] },
        orgs: { columns: ["id", "name", "tenant_id"], tenantScoped: true },
      },
      defaultLimit: 10,
      maxLimit: 100,
    });
    const joinTenantValidator = new SqlValidator(joinTenantPolicy);

    const result = joinTenantValidator.validate(
      "select u.id, o.name from users u left join orgs o on o.id = u.org_id",
      { tenantId: "tenantA" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sql = result.sql.toLowerCase();
    expect(sql).toContain("left join");
    expect(sql).toContain("on \"o\".id = \"u\".org_id and \"o\".tenant_id = $1");
    expect(sql).not.toContain("where \"o\".tenant_id");
    expect(result.params).toEqual(["tenantA"]);
  });

  it("uses custom tenant column when configured", () => {
    const result = tenantValidator.validate("select id from invoices", { tenantId: "acct_7" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("\"invoices\".account_id = $1");
    expect(result.params).toEqual(["acct_7"]);
  });


  it("parameterizes tenantId instead of interpolating raw value", () => {
    const result = tenantValidator.validate("select id from users", { tenantId: "a' OR 1=1 --" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql).toContain("$1");
    expect(result.sql).not.toContain("OR 1=1");
    expect(result.params).toEqual(["a' OR 1=1 --"]);
  });
});

describe("SqlValidator complex queries", () => {
  it("allows aggregate/group by/having/order by query", () => {
    const result = validator.validate(
      [
        "select o.id, o.name, count(u.id) as user_count",
        "from orgs o",
        "join users u on u.org_id = o.id",
        "where u.active = true",
        "group by o.id, o.name",
        "having count(u.id) > 1",
        "order by o.name asc",
      ].join(" "),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("group by");
    expect(result.sql.toLowerCase()).toContain("having");
    expect(result.sql.toLowerCase()).toContain("limit 50");
  });

  it("allows deeply nested boolean predicates", () => {
    const result = validator.validate(
      [
        "select u.id, u.email, o.name",
        "from users u",
        "join orgs o on o.id = u.org_id",
        "where (u.active = true and (o.plan = 'pro' or o.plan = 'enterprise'))",
        "and (u.created_at > '2024-01-01' or u.name = 'alice')",
        "order by u.created_at desc",
        "limit 75",
      ].join(" "),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("limit 75");
  });

  it("applies tenant guardrail with existing complex where clause", () => {
    const tenantPolicy = createSqlPolicy({
      tables: {
        users: { columns: ["id", "name", "tenant_id", "org_id", "active"], tenantScoped: true },
        orgs: { columns: ["id", "name", "plan"] },
      },
      defaultLimit: 25,
      maxLimit: 200,
    });
    const tenantValidator = new SqlValidator(tenantPolicy);
    const result = tenantValidator.validate(
      [
        "select u.id, o.name",
        "from users u",
        "join orgs o on o.id = u.org_id",
        "where (u.active = true or o.plan = 'pro') and u.name <> 'test'",
      ].join(" "),
      { tenantId: "tenant_42" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("\"u\".tenant_id = $1");
    expect(sql).toContain("where");
    expect(sql).toContain("and");
    expect(result.params).toEqual(["tenant_42"]);
  });

  it("injects tenant filters for multiple tenant-scoped tables in joins", () => {
    const tenantPolicy = createSqlPolicy({
      tables: {
        users: { columns: ["id", "tenant_id"], tenantScoped: true },
        invoices: { columns: ["id", "tenant_id"], tenantScoped: true },
      },
      defaultLimit: 10,
      maxLimit: 100,
    });
    const tenantValidator = new SqlValidator(tenantPolicy);
    const result = tenantValidator.validate(
      "select u.id, i.id from users u join invoices i on i.id = u.id",
      { tenantId: "tX" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("\"u\".tenant_id = $1");
    expect(sql).toContain("\"i\".tenant_id = $2");
    expect(result.params).toEqual(["tX", "tX"]);
  });

  it("allows IN subquery and enforces default limit on both levels", () => {
    const result = validator.validate(
      "select id from users where id in (select id from users where active = true)",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("in (select id from \"users\" where active = true limit 50)");
    expect(sql).toContain("limit 50");
  });

  it("allows EXISTS subquery", () => {
    const result = validator.validate(
      "select id from users u where exists (select 1 from orgs o where o.id = u.org_id)",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sql.toLowerCase()).toContain("exists");
  });

  it("rejects subquery that references disallowed table", () => {
    const result = validator.validate(
      "select id from users where id in (select id from payments where id > 0)",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Table not allowed");
  });

  it("rejects subquery that references disallowed column", () => {
    const result = validator.validate(
      "select id from users where id in (select password_hash from users)",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Column not allowed");
  });

  it("applies limit cap in nested subquery", () => {
    const result = validator.validate(
      "select id from users where id in (select id from users limit 9999) limit 9999",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("in (select id from \"users\" limit 200)");
    expect(sql.endsWith("limit 200")).toBe(true);
  });

  it("enforces tenant guardrail inside nested subquery", () => {
    const tenantPolicy = createSqlPolicy({
      tables: {
        users: { columns: ["id", "tenant_id", "active"], tenantScoped: true },
      },
      defaultLimit: 20,
      maxLimit: 200,
    });
    const tenantValidator = new SqlValidator(tenantPolicy);
    const result = tenantValidator.validate(
      "select id from users where id in (select id from users where active = true)",
      { tenantId: "z9" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sql = result.sql.toLowerCase();
    expect(sql).toContain("\"users\".tenant_id = $1");
    expect(sql).toContain("\"users\".tenant_id = $2");
    expect(result.params).toEqual(["z9", "z9"]);
  });

  it("rejects tenant-scoped nested subquery when tenantId missing", () => {
    const tenantPolicy = createSqlPolicy({
      tables: {
        users: { columns: ["id", "tenant_id", "active"], tenantScoped: true },
      },
      defaultLimit: 20,
      maxLimit: 200,
    });
    const tenantValidator = new SqlValidator(tenantPolicy);
    const result = tenantValidator.validate(
      "select id from users where id in (select id from users where active = true)",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("tenantId is required");
  });

  it("rejects set operations like UNION", () => {
    const result = validator.validate("select id from users union select id from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Set operations are not allowed");
  });

  it("rejects set operations like UNION ALL", () => {
    const result = validator.validate("select id from users union all select id from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Set operations are not allowed");
  });

  it("rejects set operations like INTERSECT", () => {
    const result = validator.validate("select id from users intersect select id from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Set operations are not allowed");
  });

  it("rejects set operations like EXCEPT", () => {
    const result = validator.validate("select id from users except select id from users");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Set operations are not allowed");
  });

  it("rejects offset-only queries", () => {
    const result = validator.validate("select id from users offset 10");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("OFFSET without LIMIT is not allowed");
  });
});

describe("createSqlPolicy validation", () => {
  it("rejects non-positive defaultLimit", () => {
    expect(() =>
      createSqlPolicy({
        defaultLimit: 0,
      }),
    ).toThrow("defaultLimit must be a positive integer");
  });

  it("rejects non-positive maxLimit", () => {
    expect(() =>
      createSqlPolicy({
        maxLimit: -1,
      }),
    ).toThrow("maxLimit must be a positive integer");
  });

  it("rejects defaultLimit greater than maxLimit", () => {
    expect(() =>
      createSqlPolicy({
        defaultLimit: 101,
        maxLimit: 100,
      }),
    ).toThrow("defaultLimit must be less than or equal to maxLimit");
  });
});
