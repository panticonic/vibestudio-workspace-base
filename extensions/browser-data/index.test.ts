import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  BROWSER_ENVIRONMENT_KEY_VERSION,
  browserEnvironmentKeyMaterial,
} from "@vibestudio/browser-data";

const orchestrationMocks = vi.hoisted(() => ({
  launchCollectionTask: vi.fn(async () => undefined),
}));

vi.mock("@workspace/collection-orchestration", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/collection-orchestration")
  >("@workspace/collection-orchestration");
  return {
    ...actual,
    launchCollectionTask: orchestrationMocks.launchCollectionTask,
  };
});

vi.mock("@vibestudio/browser-import", async () => {
  const actual = await vi.importActual<
    typeof import("@vibestudio/browser-import")
  >("@vibestudio/browser-import");
  return {
    ...actual,
    LocalBrowserImportProvider: class {
      async listSources() {
        return [
          {
            sourceId: "opaque-chrome",
            browser: "chrome",
            displayName: "Chrome",
            status: "readable",
            localDataSetCount: 2,
            supportedDataTypes: ["bookmarks", "history", "cookies"],
            warnings: [],
          },
        ];
      }
      async preview() {
        return {
          dataTypes: [],
          openTabCount: 2,
          localDataSetCount: 2,
          warnings: [],
        };
      }
      async openImport(sourceId: string, dataTypes: string[]) {
        return {
          consume: async (sink: {
            store(batch: unknown): Promise<void>;
            progress(progress: unknown): Promise<void>;
          }) => {
            const progress = [];
            if (dataTypes.includes("bookmarks")) {
              await sink.store({
                jobId: "",
                sourceId,
                dataType: "bookmarks",
                batchIndex: 0,
                idempotencyKey: "",
                items: [{ title: "Example", url: "https://example.com" }],
              });
              const bookmarks = {
                dataType: "bookmarks",
                itemsProcessed: 1,
                stored: 1,
                skipped: 0,
                errors: 0,
              };
              await sink.progress(bookmarks);
              progress.push(bookmarks);
            }
            if (dataTypes.includes("cookies")) {
              await sink.store({
                jobId: "",
                sourceId,
                dataType: "cookies",
                batchIndex: 0,
                idempotencyKey: "",
                items: [
                  {
                    name: "session",
                    value: "opaque",
                    domain: "example.com",
                    hostOnly: true,
                    path: "/",
                    secure: true,
                    httpOnly: true,
                    sameSite: "lax",
                  },
                ],
              });
              const cookies = {
                dataType: "cookies",
                itemsProcessed: 1,
                stored: 1,
                skipped: 0,
                errors: 0,
              };
              await sink.progress(cookies);
              progress.push(cookies);
            }
            return {
              dataTypes: progress,
              warnings: [],
            };
          },
        };
      }
      async listOpenTabs() {
        return [
          {
            tabId: "tab-1",
            url: "https://example.com/",
            title: "Example",
            active: true,
            windowId: "win-a",
            windowOrdinal: 1,
          },
          {
            tabId: "tab-2",
            url: "chrome://settings/",
            title: "Settings",
            active: false,
            windowId: "win-a",
            windowOrdinal: 1,
          },
          {
            tabId: "tab-3",
            url: "https://example.org/",
            title: "Other",
            active: false,
            windowId: "win-b",
            windowOrdinal: 2,
          },
        ];
      }
    },
  };
});

vi.mock("@vibestudio/browser-data", async () => {
  const actual = await vi.importActual<
    typeof import("@vibestudio/browser-data")
  >("@vibestudio/browser-data");
  const browserImport = await import("@vibestudio/browser-import");
  return {
    ...actual,
    RemoteBrowserImportProvider: browserImport.LocalBrowserImportProvider,
  };
});

import { activate } from "./index.js";

const browserEnvironmentMaterial = browserEnvironmentKeyMaterial(
  "workspace-1",
  "user-1",
);
const EXPECTED_BROWSER_ENVIRONMENT_KEY = `${BROWSER_ENVIRONMENT_KEY_VERSION}_${createHash(
  "sha256",
)
  .update(browserEnvironmentMaterial.material)
  .digest("base64url")}`;
const EXPECTED_BROWSER_DATA_TARGET = `do:workers/browser-data:BrowserDataDO:${EXPECTED_BROWSER_ENVIRONMENT_KEY}`;

function makeContext(callerKind: string | null = "shell", callerId = "shell") {
  let createdPanels = 0;
  const workspaceStateTarget = "do:vibestudio/internal:WorkspaceDO:workspace-1";
  const entities = new Map<
    string,
    {
      id: string;
      contextId: string;
      source: { effectiveVersion: string };
      buildKey: string;
    }
  >();
  const slots = new Map<
    string,
    {
      parentId: string | null;
      title: string;
      source: string;
      contextId: string;
      entityId: string;
    }
  >();
  const rpcCall = vi.fn(
    async (
      _targetId: string,
      method: string,
      ...args: unknown[]
    ): Promise<unknown> => {
      if (method === "browserEnvironment.getImportHost") {
        return {
          hostId: "server:workspace-1",
          displayName: "Server",
          platform: "linux",
          location: "server",
          connected: true,
        };
      }
      if (method === "addBookmarksBatch") return 1;
      if (method === "addBookmark") return 42;
      if (method === "getBookmarks") return [{ id: 1, title: "Example" }];
      if (method === "workers.resolveService") {
        return { kind: "durable-object", targetId: workspaceStateTarget };
      }
      if (method === "titlesForSlots") {
        return Object.fromEntries(
          (args[0] as string[]).map((slotId) => [
            slotId,
            slots.get(slotId)?.title ?? slotId,
          ]),
        );
      }
      if (method === "updatePanelTitle") {
        const slot = slots.get(String(args[0]));
        if (slot) slot.title = String(args[2]);
        return undefined;
      }
      if (
        [
          "bindSlot",
          "indexPanel",
          "incrementAccess",
          "rebuildIndex",
          "removeSlots",
        ].includes(method)
      ) {
        return undefined;
      }
      if (method === "build.getPanelMetadata") return { title: "Collection" };
      if (
        method === "runtime.reserveEntity" ||
        method === "runtime.createEntity"
      ) {
        createdPanels += 1;
        const spec = args[0] as { key: string; contextId?: string };
        const entity = {
          id: `panel:nav-fixture-${createdPanels}`,
          contextId: spec.contextId ?? `ctx-panel-${createdPanels}`,
          source: { effectiveVersion: "test-version" },
          buildKey: `build-${createdPanels}`,
        };
        entities.set(spec.key, entity);
        return entity;
      }
      if (method === "runtime.activateReservedEntity") {
        const spec = args[0] as { key: string };
        return entities.get(spec.key);
      }
      if (method === "workspace-state.slot.create") {
        const input = args[0] as {
          slotId: string;
          parentSlotId: string | null;
          initialEntry: {
            entityId: string;
            source: string;
            contextId: string;
          };
        };
        slots.set(input.slotId, {
          parentId: input.parentSlotId,
          title: input.slotId,
          source: input.initialEntry.source,
          contextId: input.initialEntry.contextId,
          entityId: input.initialEntry.entityId,
        });
        return undefined;
      }
      if (method === "workspace-state.panelTree.detail") {
        const id = String(args[0]);
        const slot = slots.get(id) ?? {
          parentId: null,
          title: id,
          source: "panels/caller",
          contextId: "ctx-caller",
          entityId: `entity:${id}`,
        };
        return {
          slot: {
            parent_slot_id: slot.parentId,
          },
          currentHistory: {
            source: slot.source,
            context_id: slot.contextId,
            state_args: "{}",
            options: "{}",
          },
          entity: {
            id: slot.entityId,
            source: { effectiveVersion: "test-version" },
            activeBuildKey: "test-build",
          },
        };
      }
      if (method === "panelRuntime.ensureSlot") {
        const panelId = String(args[0]);
        const runtimeEntityId = String(args[1]);
        return {
          status: "assigned",
          lease: null,
          attempt: {
            epoch: "test",
            attemptId: `attempt:${runtimeEntityId}`,
            slotId: panelId,
            runtimeEntityId,
            phase: "ready",
            revision: 1,
            reporter: "renderer",
            updatedAt: 1,
          },
        };
      }
      if (method === "panelRuntime.observeSlot") {
        const panelId = String(args[0]);
        const slot = slots.get(panelId) ?? { entityId: `entity:${panelId}` };
        return {
          version: { epoch: "test", counter: 1 },
          attempt: {
            epoch: "test",
            attemptId: `attempt:${slot.entityId}`,
            slotId: panelId,
            runtimeEntityId: slot.entityId,
            phase: "ready",
            revision: 1,
            reporter: "renderer",
            updatedAt: 1,
          },
          route: {
            reachable: true,
            connectionId: `route:${panelId}`,
            holderLabel: "Test",
            platform: "headless",
            supportsCdp: true,
            view: { url: "http://panel.test/", loading: false },
          },
        };
      }
      if (method === "workspace-state.slot.close")
        return { closeId: `close:${String(args[0])}`, closedCount: 1 };
      if (method === "workspace-state.slot.closeCleanupPage")
        return { items: [], nextCursor: null };
      if (method === "runtime.retireEntity") return undefined;
      return [];
    },
  );
  const emit = vi.fn();
  const rpcStream = vi.fn(async () => new Response());
  const health = { healthy: vi.fn(), degraded: vi.fn(), unhealthy: vi.fn() };
  const resolveService = vi.fn(
    async (_protocol: string, objectKey: string) => ({
      kind: "durable-object" as const,
      targetId: `do:workers/browser-data:BrowserDataDO:${objectKey}`,
      objectKey,
    }),
  );
  return {
    ctx: {
      rpc: { call: rpcCall, stream: rpcStream },
      workers: { resolveService },
      invocation: {
        current: () =>
          callerKind === null
            ? null
            : {
                caller: {
                  callerId,
                  callerKind,
                  userId: "user-1",
                  workspaceId: "workspace-1",
                },
              },
        signal: () => null,
      },
      log: { info: vi.fn(), warn: vi.fn() },
      health,
      emit,
    },
    rpcCall,
    rpcStream,
    resolveService,
    emit,
    health,
  };
}

describe("@workspace-extensions/browser-data", () => {
  beforeEach(() => {
    orchestrationMocks.launchCollectionTask.mockReset();
    orchestrationMocks.launchCollectionTask.mockResolvedValue(undefined);
  });

  it("matches the manifest-declared provider and contains no retired import methods", async () => {
    const { ctx } = makeContext();
    const activated = await activate(ctx as never);
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as {
      vibestudio: {
        authority: {
          requests: Array<{ capability: string }>;
          provides: Array<{ name: string }>;
        };
        extension: {
          providerContracts: { browserData: { methods: string[] } };
          methodAuthority: Record<
            string,
            { effect: { kind: string; capability?: string } }
          >;
        };
      };
    };
    const methods = Object.keys(activated.providerContracts.browserData);
    expect(methods).toEqual(
      manifest.vibestudio.extension.providerContracts.browserData.methods,
    );
    expect(methods).not.toEqual(
      expect.arrayContaining([
        "detectBrowsers",
        "getProfileImportState",
        "getAutofillSuggestions",
        "getPasswords",
        "getCookieSnapshot",
        "listPasswordSummaries",
        "getPasswordForSite",
        "getFormFillSuggestions",
        "getCookiesForOrigin",
        "exportPasswords",
        "exportCookies",
      ]),
    );
    const downstreamSensitiveCapabilities = new Set([
      "service:browserEnvironment.previewSensitiveImport",
      "service:browserEnvironment.startSensitiveImport",
      "service:browserEnvironment.observeSensitiveImport",
      "service:browserEnvironment.cancelSensitiveImport",
      "service:browserPrivacyPresentation.open",
    ]);
    expect(
      manifest.vibestudio.authority.requests
        .filter((request) =>
          downstreamSensitiveCapabilities.has(request.capability),
        )
        .map((request) => request.capability),
    ).toEqual([
      "service:browserEnvironment.previewSensitiveImport",
      "service:browserEnvironment.startSensitiveImport",
      "service:browserEnvironment.observeSensitiveImport",
      "service:browserEnvironment.cancelSensitiveImport",
    ]);
    expect(manifest.vibestudio.authority.provides).toEqual([]);
    expect(manifest.vibestudio.extension.methodAuthority).toEqual({});
  });

  it("requires a verified user and workspace", async () => {
    const { ctx } = makeContext(null);
    const api = (await activate(ctx as never)).providerContracts.browserData;
    await expect(api.listImportJobs()).rejects.toMatchObject({
      code: "ENOCALLER",
    });
  });

  it("uses protocol resolution and the server-derived environment key", async () => {
    const { ctx, rpcCall, resolveService, health } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    expect(health.healthy).not.toHaveBeenCalled();
    await api.listImportJobs();
    expect(resolveService).toHaveBeenCalledWith(
      "vibestudio.browser-data.v1",
      EXPECTED_BROWSER_ENVIRONMENT_KEY,
    );
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledWith(
      EXPECTED_BROWSER_DATA_TARGET,
      "listImportJobs",
    );
    expect(health.healthy).toHaveBeenCalledWith({
      summary: "Browser environment storage ready",
    });
  });

  it("brokers canonical history reads through its admitted Durable Object source", async () => {
    const { ctx, rpcCall } = makeContext("panel");
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.getHistory({ limit: 60 })).resolves.toEqual([]);
    expect(rpcCall).toHaveBeenCalledWith(
      EXPECTED_BROWSER_DATA_TARGET,
      "getHistory",
      { limit: 60 },
    );
  });

  it("does not resolve or forward to protected browser storage", async () => {
    const { ctx, rpcCall, resolveService } = makeContext("panel");
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await api.getHistory({ limit: 1 });
    expect(resolveService).toHaveBeenCalledTimes(1);
    expect(resolveService).not.toHaveBeenCalledWith(
      "vibestudio.browser-vault.v1",
    );
    expect(rpcCall.mock.calls.map((call) => call[0])).not.toContain(
      "do:vibestudio/internal:BrowserVaultDO:environment-key",
    );
  });

  it("degrades health on store resolution failure and retries the dependency", async () => {
    const { ctx, resolveService, health } = makeContext();
    resolveService.mockRejectedValueOnce(new Error("backing store refused"));
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.listImportJobs()).rejects.toThrow("backing store refused");
    expect(health.degraded).toHaveBeenCalledWith({
      summary: "Browser environment storage unavailable",
      reasons: ["backing store refused"],
    });

    await expect(api.listImportJobs()).resolves.toEqual([]);
    expect(resolveService).toHaveBeenCalledTimes(2);
    expect(health.healthy).toHaveBeenCalledWith({
      summary: "Browser environment storage ready",
    });
  });

  it("does not report healthy when the resolved store refuses a call", async () => {
    const { ctx, rpcCall, health } = makeContext();
    rpcCall.mockRejectedValueOnce(new Error("store authority refused"));
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.listImportJobs()).rejects.toThrow(
      "store authority refused",
    );
    expect(health.healthy).not.toHaveBeenCalled();
    expect(health.degraded).toHaveBeenCalledWith({
      summary: "Browser environment storage unavailable",
      reasons: ["store authority refused"],
    });
  });

  it("surfaces persisted nonterminal jobs as orphaned after an extension restart", async () => {
    const { ctx, rpcCall } = makeContext();
    const orphaned = {
      jobId: "orphaned-job",
      hostId: "server:workspace-1",
      hostLabel: "Server",
      sourceId: "opaque-chrome",
      browser: "chrome",
      phase: "discovering",
      requestedDataTypes: ["bookmarks"],
      startedAt: 1,
      updatedAt: 2,
      progress: [],
      warnings: [],
      resumable: true,
    };
    rpcCall.mockImplementation(async (_targetId: string, method: string) => {
      if (method === "getImportJob") return orphaned;
      if (method === "listImportJobs") return [orphaned];
      return [];
    });
    const api = (await activate(ctx as never)).providerContracts.browserData;

    await expect(api.getImportJob(orphaned.jobId)).resolves.toMatchObject({
      phase: "failed",
      finishedAt: 2,
      resumable: true,
      error:
        "The browser import stopped before it completed. Start the import again to retry.",
    });
    await expect(api.listImportJobs()).resolves.toEqual([
      expect.objectContaining({ jobId: orphaned.jobId, phase: "failed" }),
    ]);
  });

  it("discovers opaque sources without returning paths or profiles", async () => {
    const { ctx } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const sources = await api.listImportSources(host!.hostId);
    expect(sources).toEqual([
      expect.objectContaining({
        sourceId: "opaque-chrome",
        localDataSetCount: 2,
        supportedDataTypes: ["bookmarks", "history", "cookies"],
      }),
    ]);
    expect(JSON.stringify(sources)).not.toMatch(
      /profile|[/\\\\]Users[/\\\\]|[/\\\\]home[/\\\\]/i,
    );
  });

  it("stores imports as idempotent source-scoped batches", async () => {
    const { ctx, rpcCall, emit, health } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.startImport({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      dataTypes: ["bookmarks"],
    });
    expect(["queued", "discovering", "reading"]).toContain(result.phase);
    await vi.waitFor(async () => {
      expect(
        ((await api.getImportJob(result.jobId)) as { phase?: string } | null)
          ?.phase,
      ).toBe("complete");
    });
    expect(rpcCall).toHaveBeenCalledWith(
      EXPECTED_BROWSER_DATA_TARGET,
      "addBookmarksBatch",
      [{ title: "Example", url: "https://example.com" }],
      { sourceId: "opaque-chrome" },
    );
    expect(rpcCall).toHaveBeenCalledWith(
      EXPECTED_BROWSER_DATA_TARGET,
      "recordImportBatch",
      expect.objectContaining({ dataType: "bookmarks", batchIndex: 0 }),
    );
    expect(emit).toHaveBeenCalledWith(
      "import-complete",
      expect.objectContaining({ phase: "complete" }),
    );
    expect(health.healthy).toHaveBeenLastCalledWith({
      summary: "Browser data import completed",
    });
  });

  it("rejects sensitive categories before the public import coordinator reads them", async () => {
    const { ctx, rpcCall } = makeContext();
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    await expect(
      api.startImport({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        dataTypes: ["cookies"],
      }),
    ).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    expect(rpcCall.mock.calls.map((call) => call[1])).not.toContain(
      "addCookiesBatch",
    );
  });

  it("delegates sensitive preview and durable import control to sealed host effects", async () => {
    const { ctx, rpcCall } = makeContext();
    rpcCall.mockImplementation(
      async (_targetId: string, method: string, ...args: unknown[]) => {
        if (method === "browserEnvironment.getImportHost") {
          return {
            hostId: "desktop-1",
            displayName: "This device",
            platform: "linux",
            location: "desktop",
            connected: true,
          };
        }
        if (method === "browserEnvironment.previewSensitiveImport") {
          return {
            dataTypes: [
              {
                dataType: "cookies",
                itemsProcessed: 2,
                read: 2,
                stored: 0,
                skipped: 0,
                errors: 0,
              },
            ],
            warnings: [],
            breakdowns: [],
            openTabCount: 0,
            localDataSetCount: 0,
          };
        }
        if (method === "browserEnvironment.startSensitiveImport") {
          return {
            operationId: args[2],
            state: "running",
            counts: [
              {
                dataType: "cookies",
                read: 2,
                stored: 2,
                skipped: 0,
                errors: 0,
              },
            ],
          };
        }
        if (method === "browserEnvironment.observeSensitiveImport") {
          return { operationId: args[0], state: "complete", counts: [] };
        }
        if (method === "browserEnvironment.cancelSensitiveImport") {
          return { operationId: args[0], state: "cancelled", counts: [] };
        }
        return [];
      },
    );
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const hosts = await api.listImportHosts();
    const desktop = hosts.find((host) => host.hostId === "desktop-1");
    await expect(
      api.previewSensitiveImport({
        hostId: desktop!.hostId,
        sourceId: "opaque-chrome",
        dataTypes: ["cookies"],
      }),
    ).resolves.toMatchObject({
      dataTypes: [{ dataType: "cookies", itemsProcessed: 2 }],
    });
    const started = await api.startSensitiveImport({
      hostId: desktop!.hostId,
      sourceId: "opaque-chrome",
      dataTypes: ["cookies"],
      operationId: "sensitive-op-1",
    });

    expect(started).toEqual({
      operationId: "sensitive-op-1",
      state: "running",
      counts: [
        { dataType: "cookies", read: 2, stored: 2, skipped: 0, errors: 0 },
      ],
    });
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "browserEnvironment.startSensitiveImport",
      "opaque-chrome",
      ["cookies"],
      "sensitive-op-1",
    );
    await expect(api.observeSensitiveImport("sensitive-op-1")).resolves.toEqual(
      {
        operationId: "sensitive-op-1",
        state: "complete",
        counts: [],
      },
    );
    await expect(api.cancelSensitiveImport("sensitive-op-1")).resolves.toEqual({
      operationId: "sensitive-op-1",
      state: "cancelled",
      counts: [],
    });
    await expect(
      api.openBrowserPrivacyManager("export"),
    ).resolves.toBeUndefined();
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "browserPrivacyPresentation.open",
      "export",
    );
  });

  it("can keep selected HTTP tabs directly under the calling panel", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel:tree/panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    await expect(
      api.openTabsAsPanels({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        selection: ["tab-1", "tab-2"],
        destination: "caller",
        groupBy: "none",
      }),
    ).resolves.toMatchObject({ tabsFound: 2, panelsOpened: 1 });
    // Imported browser tabs are deferred slots. The only readiness observation
    // here is for the caller anchor; the tab itself must not wait for the
    // external document to load.
    expect(
      rpcCall.mock.calls.filter(
        (call) => call[1] === "panelRuntime.observeSlot",
      ),
    ).toHaveLength(1);
    expect(
      rpcCall.mock.calls.some((call) => call[1] === "panelRuntime.ensureSlot"),
    ).toBe(false);
    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.createEntity", {
      kind: "panel",
      execution: { surface: "external", url: "https://example.com/" },
      key: expect.stringMatching(/^nav-/),
      contextId: "ctx-caller",
      stateArgs: {},
    });
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "workspace-state.slot.create",
      expect.objectContaining({ parentSlotId: "panel:tree/panel-parent" }),
    );
    expect(orchestrationMocks.launchCollectionTask).not.toHaveBeenCalled();
  });

  it("defaults to a new root with nested window collections and deferred tabs", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel:tree/panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-2", "tab-3"],
    });

    expect(result).toMatchObject({ tabsFound: 3, panelsOpened: 2 });
    expect(result.root).toMatchObject({ panelsOpened: 2 });
    expect(result.collections).toHaveLength(2);
    expect(result.collections.map((entry) => entry.panelsOpened)).toEqual([
      1, 1,
    ]);

    const collectionCalls = rpcCall.mock.calls.filter(
      (call) =>
        call[1] === "workspace-state.slot.create" &&
        (call[2] as { initialEntry?: { source?: string } })?.initialEntry
          ?.source === "about/collection",
    );
    expect(collectionCalls).toHaveLength(3);
    expect(collectionCalls[0]?.[2]).toMatchObject({
      parentSlotId: null,
      initialEntry: {
        stateArgs: {
          title: "Chrome \u00b7 Imported Tabs",
          origin: "Chrome \u00b7 browser import",
          startupTask: {
            kind: "title-browser-import-windows",
            sourceName: "Chrome",
          },
          agentConfig: { approvalLevel: 2 },
          channelName: expect.stringMatching(/^collection-/),
          agentKey: expect.stringMatching(/^conductor-/),
        },
      },
    });
    expect(collectionCalls[1]?.[2]).toMatchObject({
      parentSlotId: result.root!.id,
      initialEntry: {
        contextId: "ctx-panel-1",
        stateArgs: { title: "Window 1" },
      },
    });
    expect(collectionCalls[2]?.[2]).toMatchObject({
      parentSlotId: result.root!.id,
      initialEntry: {
        contextId: "ctx-panel-1",
        stateArgs: { title: "Window 2" },
      },
    });

    const tabParents = rpcCall.mock.calls
      .filter(
        (call) =>
          call[1] === "workspace-state.slot.create" &&
          (
            call[2] as { initialEntry?: { source?: string } }
          )?.initialEntry?.source?.startsWith("browser:"),
      )
      .map((call) => (call[2] as { parentSlotId?: string }).parentSlotId);
    expect(new Set(tabParents).size).toBe(2);
    expect(tabParents).not.toContain(result.root!.id);
    expect(tabParents).not.toContain("panel:tree/panel-parent");
    const tabContexts = rpcCall.mock.calls
      .filter(
        (call) =>
          call[1] === "workspace-state.slot.create" &&
          (
            call[2] as { initialEntry?: { source?: string } }
          )?.initialEntry?.source?.startsWith("browser:"),
      )
      .map(
        (call) =>
          (call[2] as { initialEntry?: { contextId?: string } }).initialEntry
            ?.contextId,
      );
    expect(new Set(tabContexts)).toEqual(new Set(["ctx-panel-1"]));
    const rootState = (
      collectionCalls[0]?.[2] as {
        initialEntry: { stateArgs: { channelName: string; agentKey: string } };
      }
    ).initialEntry.stateArgs;
    expect(orchestrationMocks.launchCollectionTask).toHaveBeenCalledOnce();
    expect(orchestrationMocks.launchCollectionTask).toHaveBeenCalledWith(
      expect.objectContaining({ selfId: "@workspace-extensions/browser-data" }),
      expect.objectContaining({
        rootPanelId: result.root!.id,
        rootTitle: "Chrome · Imported Tabs",
        contextId: "ctx-panel-1",
        session: {
          channelName: rootState.channelName,
          agentKey: rootState.agentKey,
        },
        task: expect.stringContaining("window collection"),
        idempotencyKey: `initial-prompt:${rootState.channelName}`,
      }),
    );
    const lastPanelCreateOrder = Math.max(
      ...rpcCall.mock.invocationCallOrder.filter(
        (_, index) =>
          rpcCall.mock.calls[index]?.[1] === "workspace-state.slot.create",
      ),
    );
    expect(
      orchestrationMocks.launchCollectionTask.mock.invocationCallOrder[0],
    ).toBeGreaterThan(lastPanelCreateOrder);
  });

  it("does not silently flatten tabs when a requested window collection cannot be created", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel:tree/panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    const passthrough = rpcCall.getMockImplementation()!;
    let collectionCreates = 0;
    rpcCall.mockImplementation(
      async (targetId: string, method: string, ...args: unknown[]) => {
        if (method !== "workspace-state.slot.create")
          return passthrough(targetId, method, ...args);
        const [input] = args as [{ initialEntry: { source: string } }];
        if (input.initialEntry.source === "about/collection") {
          collectionCreates += 1;
          if (collectionCreates === 1) {
            return passthrough(targetId, method, ...args);
          }
          throw new Error("Server auth failed: Not a member of this workspace");
        }
        return passthrough(targetId, method, ...args);
      },
    );

    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1"],
    });

    expect(result.panelsOpened).toBe(0);
    expect(result.root).toBeUndefined();
    expect(result.collections).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringContaining("Could not create Window 1"),
    ]);
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "workspace-state.slot.close",
      expect.any(String),
    );
    expect(orchestrationMocks.launchCollectionTask).not.toHaveBeenCalled();
  });

  it("preserves the queued collection task when immediate conductor launch is transiently unavailable", async () => {
    orchestrationMocks.launchCollectionTask.mockRejectedValueOnce(
      new Error("model provider unavailable"),
    );
    const { ctx } = makeContext("panel", "panel:tree/panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();

    await expect(
      api.openTabsAsPanels({
        hostId: host!.hostId,
        sourceId: "opaque-chrome",
        selection: ["tab-1"],
        groupBy: "none",
      }),
    ).resolves.toMatchObject({ panelsOpened: 1 });

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not start collection title assignment"),
    );
  });

  it("uses one new root collection without scattering ungrouped tabs as roots", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel:tree/panel-parent");
    const api = (await activate(ctx as never)).providerContracts.browserData;
    const [host] = await api.listImportHosts();
    const result = await api.openTabsAsPanels({
      hostId: host!.hostId,
      sourceId: "opaque-chrome",
      selection: ["tab-1", "tab-3"],
      groupBy: "none",
    });
    expect(result.root).toMatchObject({ panelsOpened: 2 });
    expect(result.collections).toEqual([]);
    const createCalls = rpcCall.mock.calls.filter(
      (call) => call[1] === "workspace-state.slot.create",
    );
    expect(createCalls).toHaveLength(3);
    expect(createCalls[0]?.[2]).toMatchObject({ parentSlotId: null });
    expect(
      createCalls
        .slice(1)
        .map((call) => (call[2] as { parentSlotId?: string }).parentSlotId),
    ).toEqual([result.root!.id, result.root!.id]);
  });
});
