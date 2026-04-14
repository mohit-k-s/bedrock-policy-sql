import { describe, expect, it } from "vitest";
import { resolveQueryTimeouts } from "../src/executor.js";

describe("resolveQueryTimeouts", () => {
  it("uses defaults when values are omitted", () => {
    const value = resolveQueryTimeouts();
    expect(value.statementTimeoutMs).toBe(15000);
    expect(value.lockTimeoutMs).toBe(2000);
  });

  it("uses provided values", () => {
    const value = resolveQueryTimeouts({ statementTimeoutMs: 8000, lockTimeoutMs: 500 });
    expect(value.statementTimeoutMs).toBe(8000);
    expect(value.lockTimeoutMs).toBe(500);
  });

  it("rejects non-positive statement timeout", () => {
    expect(() => resolveQueryTimeouts({ statementTimeoutMs: 0 })).toThrow(
      "statementTimeoutMs must be a positive integer in milliseconds",
    );
  });

  it("rejects non-positive lock timeout", () => {
    expect(() => resolveQueryTimeouts({ lockTimeoutMs: -1 })).toThrow(
      "lockTimeoutMs must be a positive integer in milliseconds",
    );
  });

  it("rejects non-integer timeout values", () => {
    expect(() => resolveQueryTimeouts({ statementTimeoutMs: 1.2 })).toThrow(
      "statementTimeoutMs must be a positive integer in milliseconds",
    );
  });
});
