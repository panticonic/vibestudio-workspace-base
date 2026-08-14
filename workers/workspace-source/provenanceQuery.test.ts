// Builtin semantic-authority tests for the layered query budget contract.
import { describe, expect, it } from "vitest";
import type { SqlStorage } from "@vibestudio/durable";
import {
  PROVENANCE_QUERY_BUDGET,
  executeProvenanceQuery,
  validateProvenanceQuery,
} from "./provenanceQuery.js";

/** A scriptable engine: the gate and the abort are testable without a workspace. */
function stubSql(script: {
  plan?: string[];
  counts?: Record<string, number>;
  rows?: Record<string, unknown>[];
  rowsRead?: number;
  streaming?: boolean;
}): SqlStorage {
  return {
    exec(query: string) {
      if (query.startsWith("EXPLAIN QUERY PLAN")) {
        return {
          toArray: () => (script.plan ?? []).map((detail) => ({ detail })),
          one: () => ({}),
        };
      }
      const count = /SELECT count\(\*\) AS n FROM "([^"]+)"/u.exec(query);
      if (count) {
        return {
          toArray: () => [{ n: script.counts?.[count[1]!] ?? 0 }],
          one: () => ({ n: script.counts?.[count[1]!] ?? 0 }),
        };
      }
      const rows = script.rows ?? [];
      const result: Record<string, unknown> = {
        toArray: () => rows,
        one: () => rows[0] ?? {},
        rowsRead: script.rowsRead ?? rows.length,
      };
      if (script.streaming) {
        (result as { [Symbol.iterator]?: () => Iterator<Record<string, unknown>> })[
          Symbol.iterator
        ] = function* () {
          for (const row of rows) yield row;
        };
      }
      return result as never;
    },
  } as unknown as SqlStorage;
}

describe("structural validation", () => {
  it("accepts a single SELECT over the contract", () => {
    expect(
      validateProvenanceQuery("SELECT work_unit_id FROM prov_work_units WHERE kind = 'edit'")
    ).toBeNull();
  });

  it("accepts a non-recursive CTE and its own name as a relation", () => {
    expect(
      validateProvenanceQuery(
        "WITH recent AS (SELECT work_unit_id FROM prov_work_units) SELECT * FROM recent"
      )
    ).toBeNull();
  });

  it("names the offending term for every refusal class", () => {
    expect(validateProvenanceQuery("UPDATE prov_work_units SET kind = 'x'")).toMatchObject({
      code: "not-a-select",
      term: "UPDATE",
    });
    expect(validateProvenanceQuery("SELECT * FROM sqlite_master")).toMatchObject({
      code: "unknown-relation",
      term: "sqlite_master",
    });
    expect(validateProvenanceQuery("SELECT load_extension('x') FROM prov_events")).toMatchObject({
      code: "forbidden-syntax",
      term: "load_extension",
    });
    expect(
      validateProvenanceQuery("SELECT * FROM prov_events WHERE 1 = (SELECT count(*) FROM pragma_table_list)")
    ).toMatchObject({ code: "unknown-relation", term: "pragma_table_list" });
    expect(
      validateProvenanceQuery(
        "WITH RECURSIVE chain(id) AS (SELECT 1) SELECT * FROM chain"
      )
    ).toMatchObject({ code: "recursive-cte", term: "RECURSIVE" });
  });

  it("does not mistake a quoted literal for syntax", () => {
    expect(
      validateProvenanceQuery("SELECT * FROM prov_events WHERE message = 'drop table gad_changes'")
    ).toBeNull();
  });
});

describe("the plan gate", () => {
  it("refuses a full scan of a large relation before any work", () => {
    const result = executeProvenanceQuery(
      stubSql({
        plan: ["SCAN gad_applied_changes"],
        counts: { gad_applied_changes: 500_000 },
      }),
      { query: "SELECT applied_change_id FROM prov_applied_changes", limit: 10 }
    );
    expect(result.refusal).toMatchObject({
      stage: "plan",
      code: "full-scan",
      term: "gad_applied_changes",
    });
    expect(result.rows).toEqual([]);
  });

  it("refuses a plan that fully scans two large relations", () => {
    const result = executeProvenanceQuery(
      stubSql({
        plan: ["SCAN gad_changes", "SCAN gad_work_units"],
        counts: { gad_changes: 5_000, gad_work_units: 4_000 },
      }),
      { query: "SELECT change_id FROM prov_changes, prov_work_units", limit: 10 }
    );
    expect(result.refusal).toMatchObject({ stage: "plan", code: "cartesian-join" });
  });

  it("allows an indexed search over the same relation", () => {
    const result = executeProvenanceQuery(
      stubSql({
        plan: ["SEARCH gad_changes USING INDEX idx_gad_changes_work_unit (work_unit_id=?)"],
        counts: { gad_changes: 500_000 },
        rows: [{ change_id: "change:1" }],
      }),
      { query: "SELECT change_id FROM prov_changes WHERE work_unit_id = 'work-unit:1'", limit: 10 }
    );
    expect(result.refusal).toBeNull();
    expect(result.rows).toEqual([["change:1"]]);
  });

  it("fails closed when the engine cannot produce a plan", () => {
    const result = executeProvenanceQuery(stubSql({ plan: [] }), {
      query: "SELECT work_unit_id FROM prov_work_units",
      limit: 10,
    });
    expect(result.refusal).toMatchObject({ stage: "plan", code: "plan-unavailable" });
  });
});

describe("streamed execution", () => {
  it("aborts mid-flight on the scan budget and returns the partial rows it produced", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ work_unit_id: `work-unit:${index}` }));
    const result = executeProvenanceQuery(
      stubSql({
        plan: ["SEARCH prov_work_units USING INDEX x"],
        rows,
        streaming: true,
        rowsRead: PROVENANCE_QUERY_BUDGET.scanBudget + 1,
      }),
      { query: "SELECT work_unit_id FROM prov_work_units", limit: 10 }
    );
    expect(result.refusal).toMatchObject({ stage: "execution", code: "scan-budget" });
    expect(result.rows.length).toBe(1);
    expect(result.rowsRead).toBeGreaterThan(PROVENANCE_QUERY_BUDGET.scanBudget);
  });

  it("marks truncation without refusing when the row limit is the only bound", () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ work_unit_id: `work-unit:${index}` }));
    const result = executeProvenanceQuery(
      stubSql({ plan: ["SEARCH prov_work_units USING INDEX x"], rows, streaming: true }),
      { query: "SELECT work_unit_id FROM prov_work_units", limit: 5 }
    );
    expect(result.refusal).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(5);
  });

  it("bounds a single cell so content bytes never arrive through the query surface", () => {
    const result = executeProvenanceQuery(
      stubSql({
        plan: ["SEARCH prov_events USING INDEX x"],
        rows: [{ message: "x".repeat(10_000) }],
      }),
      { query: "SELECT message FROM prov_events", limit: 1 }
    );
    expect(String(result.rows[0]![0]).length).toBe(PROVENANCE_QUERY_BUDGET.cellTextLimit);
  });
});
