import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DURABLE_OBJECT_FRAMEWORK_RPC_METHODS,
  type DurableObjectContext,
  type SqlResult,
} from "@vibestudio/durable";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { browserProductMethods } from "@vibestudio/service-schemas/browserData";
import { BrowserDataDO } from "./BrowserDataDO.js";

describe("BrowserDataDO schema", () => {
  it("has one typed declaration for every exposed data method", () => {
    const db = new DatabaseSync(":memory:");
    const instance = createBrowserDataDO(db);
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(browserProductMethods).sort());
  });

  it("creates the one canonical pre-release schema directly", () => {
    const db = new DatabaseSync(":memory:");
    createBrowserDataDO(db);

    expect(db.prepare(`SELECT singleton, version FROM _vibestudio_schema`).get()).toEqual({
      singleton: 1,
      version: 1,
    });
    expect(db.prepare(`SELECT 1 FROM state WHERE key = 'schema_version'`).get()).toBeUndefined();
    expect(
      db
        .prepare(`PRAGMA table_info(page_favicons)`)
        .all()
        .map((column) => column["name"])
    ).toContain("image_data");
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE name = 'passwords'`).get()
    ).toBeUndefined();
    db.close();
  });

  it("enforces tier, sensitivity, and principals from the typed method table", () => {
    const db = new DatabaseSync(":memory:");
    const instance = createBrowserDataDO(db, {
      BROWSER_DATA_BROKER_SOURCE: "extensions/browser-data",
    });
    const resolve = (
      method: keyof typeof browserProductMethods
    ): import("@vibestudio/rpc").ResolvedRpcAuthority | null =>
      (
        instance as unknown as {
          rpcAuthorityDeclaration(
            name: string,
            schema: (typeof browserProductMethods)[keyof typeof browserProductMethods]
          ): import("@vibestudio/rpc").ResolvedRpcAuthority | null;
        }
      ).rpcAuthorityDeclaration(method, browserProductMethods[method]!);

    expect(resolve("listDownloadRecords")).toMatchObject({
      tier: "open",
      sensitivity: "read",
      effect: { kind: "host-capability", capability: "browser-data.read" },
    });
    expect(resolve("clearAllHistory")).toMatchObject({
      tier: "gated",
      sensitivity: "destructive",
      effect: { kind: "host-capability", capability: "browser-data.delete" },
    });
    expect(resolve("getHistory")).toMatchObject({
      requires: {
        kind: "any",
        requirements: expect.arrayContaining([
          {
            kind: "all",
            requirements: expect.arrayContaining([
              {
                kind: "relationship",
                name: "code-source",
                value: "extensions/browser-data",
              },
            ]),
          },
        ]),
      },
    });
    db.close();
  });
});

describe("BrowserDataDO canonical history", () => {
  it("returns an empty history before any native visits or imports", () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserDataDO(db);

    expect(store.getHistory({ limit: 10 })).toEqual([]);
    db.close();
  });

  it("combines native and imported visits in one history summary", async () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserDataDO(db);
    const url = "https://example.test/docs";

    store.recordHistoryVisit({
      url,
      title: "Native title",
      visitTime: 100,
      transition: "typed",
      typed: true,
      panelId: "panel-1",
    });
    await store.addHistoryBatch(
      [
        {
          url,
          title: "Imported title",
          visitCount: 1,
          lastVisitTime: 200,
        },
      ],
      { sourceId: "chromium-profile" }
    );

    expect(store.getHistory({ limit: 10 })).toEqual([
      expect.objectContaining({
        url,
        title: "Imported title",
        visit_count: 2,
        typed_count: 1,
        first_visit: 100,
        last_visit: 200,
      }),
    ]);
    db.close();
  });
});

describe("BrowserDataDO download metadata", () => {
  it("persists download metadata by host inside the canonical environment", () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserDataDO(db);
    const record = {
      id: "download-1",
      environmentKey: "environment-1",
      hostId: "desktop:host-1",
      panelId: "panel-1",
      origin: "https://example.test",
      url: "https://example.test/archive.zip",
      filename: "archive.zip",
      savePath: "/tmp/archive.zip",
      receivedBytes: 25,
      totalBytes: 100,
      state: "progressing" as const,
      startedAt: 100,
      updatedAt: 110,
    };

    store.upsertDownloadRecord(record);
    store.upsertDownloadRecord({
      ...record,
      receivedBytes: 100,
      state: "completed",
      updatedAt: 120,
    });

    expect(store.listDownloadRecords("desktop:host-1")).toEqual([
      {
        ...record,
        receivedBytes: 100,
        state: "completed",
        updatedAt: 120,
      },
    ]);
    expect(store.listDownloadRecords("desktop:other-host")).toEqual([]);
    db.close();
  });
});

describe("BrowserDataDO native favicon formats", () => {
  it("stores validated source bytes and serves them by page or origin", () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserDataDO(db);
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);

    store.putPageFavicon({
      pageUrl: "https://example.test/one",
      origin: "https://example.test",
      sourceUrl: "https://example.test/favicon.svg",
      data: svg.toString("base64"),
      mimeType: "image/svg+xml",
      updatedAt: 123,
    });

    expect(store.getPageFavicon("https://example.test/one")).toMatchObject({
      page_url: "https://example.test/one",
      image_data: svg.toString("base64"),
      mime_type: "image/svg+xml",
      updated_at: 123,
    });
    expect(store.getPageFavicon("https://example.test/two")).toMatchObject({
      page_url: "https://example.test/one",
      mime_type: "image/svg+xml",
    });
    db.close();
  });

  it("rejects MIME labels that disagree with the icon bytes", () => {
    const db = new DatabaseSync(":memory:");
    const store = createBrowserDataDO(db);
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

    expect(() =>
      store.putPageFavicon({
        pageUrl: "https://example.test/",
        origin: "https://example.test",
        data: ico.toString("base64"),
        mimeType: "image/png",
        updatedAt: 123,
      })
    ).toThrow(/bytes are image\/x-icon, not image\/png/);
    db.close();
  });
});

function createBrowserDataDO(db: DatabaseSync, env: Record<string, unknown> = {}): BrowserDataDO {
  const instance = new BrowserDataDO(sqliteContext(db), env);
  (instance as unknown as { ensureReady(): void }).ensureReady();
  return instance;
}

function sqliteContext(db: DatabaseSync): DurableObjectContext {
  const sql = {
    exec(query: string, ...bindings: unknown[]): SqlResult {
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
    id: { toString: () => "browser-data-test", name: "browser-data-test" },
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
