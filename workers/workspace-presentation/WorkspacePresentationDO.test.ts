import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DURABLE_OBJECT_FRAMEWORK_RPC_METHODS,
  type DurableObjectContext,
  type SqlResult,
} from "@vibestudio/durable";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { workspacePresentationMethods } from "@vibestudio/service-schemas/workspacePresentation";
import type { MethodSchema } from "@vibestudio/shared/typedServiceClient";
import { WorkspacePresentationDO } from "./WorkspacePresentationDO.js";

const createPresentation = () => {
  const db = new DatabaseSync(":memory:");
  const instance = new WorkspacePresentationDO(sqliteContext(db), {});
  (instance as unknown as { ensureReady(): void }).ensureReady();
  return { instance, db };
};

describe("WorkspacePresentationDO", () => {
  it("exposes exactly the Base-owned presentation contract", async () => {
    const { instance, db } = createPresentation();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(workspacePresentationMethods).sort());
    db.close();
  });

  it("resolves every open presentation method without a fictitious source capability", () => {
    const { instance, db } = createPresentation();
    const authority = instance as unknown as {
      rpcAuthorityDeclaration(method: string, schema: MethodSchema): unknown;
    };
    for (const [method, schema] of Object.entries(workspacePresentationMethods)) {
      expect(authority.rpcAuthorityDeclaration(method, schema)).toMatchObject({
        effect: { kind: "open" },
      });
    }
    db.close();
  });

  it("owns entity titles and follows the current slot binding", async () => {
    const { instance, db } = createPresentation();
    instance.bindSlot("slot-1", "entity-1", "panels/chat");
    instance.updatePanelTitle("slot-1", "entity-1", "Support inbox");
    expect(instance.titlesForSlots(["slot-1"])).toEqual({ "slot-1": "Support inbox" });

    instance.setEntityTitle("entity-2", "Calendar");
    instance.bindSlot("slot-1", "entity-2", "panels/calendar");
    expect(instance.titlesForSlots(["slot-1"])).toEqual({ "slot-1": "Calendar" });
    expect(instance.listEntityTitles()).toEqual([
      { id: "entity-1", title: "Support inbox", explicit: false },
      { id: "entity-2", title: "Calendar", explicit: false },
    ]);
    db.close();
  });

  it("keeps durable search facts and rebuilds only the derived FTS projection", async () => {
    const { instance, db } = createPresentation();
    instance.indexPanel(
      {
        id: "slot-1",
        source: "panels/chat",
        title: "Support inbox",
        path: "panels/chat",
        tags: ["mail"],
      },
      "entity-1"
    );
    instance.incrementAccess("slot-1");
    instance.rebuildIndex();

    expect(instance.search("support").results).toEqual([
      expect.objectContaining({ id: "slot-1", title: "Support inbox", accessCount: 1 }),
    ]);
    expect(instance.sourceUsage()).toEqual([
      expect.objectContaining({ source: "panels/chat", accessCount: 1 }),
    ]);

    instance.removeSlots(["slot-1"]);
    expect(instance.search("support").results).toEqual([]);
    db.close();
  });

  it("owns explicit-title precedence without a host-side hook", () => {
    const { instance, db } = createPresentation();
    instance.bindSlot("slot-1", "entity-1", "panels/chat");
    instance.updatePanelTitle("slot-1", "entity-1", "Pinned", { explicit: true });
    instance.updatePanelTitle("slot-1", "entity-1", "Inferred");

    expect(instance.isEntityTitleExplicit("entity-1")).toBe(true);
    expect(instance.titlesForSlots(["slot-1"])).toEqual({ "slot-1": "Pinned" });
    db.close();
  });
});

function sqliteContext(db: DatabaseSync): DurableObjectContext {
  const sql = {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      if (bindings.length === 0 && /^\s*CREATE\b/i.test(query) && query.includes(";")) {
        db.exec(query);
        return {
          toArray: () => [],
          one: () => {
            throw new Error("Expected one row, received 0");
          },
        };
      }
      const statement = db.prepare(query);
      const rows =
        /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(query) || /\bRETURNING\b/i.test(query)
          ? (statement.all(...(bindings as [])) as Record<string, unknown>[])
          : (statement.run(...(bindings as [])), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected one row, received ${rows.length}`);
          return rows[0]!;
        },
      };
    },
  };
  return {
    id: { toString: () => "workspace-presentation-test", name: "workspace-presentation-test" },
    storage: {
      sql,
      setAlarm() {},
      async getAlarm() {
        return null;
      },
      deleteAlarm() {},
      transactionSync<T>(callback: () => T): T {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    acceptWebSocket() {},
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn) => fn(),
  };
}
