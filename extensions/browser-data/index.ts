import {
  exportChromiumBookmarks,
  exportNetscapeBookmarks,
  LocalBrowserImportProvider,
} from "@vibestudio/browser-import";
import {
  BROWSER_ENVIRONMENT_KEY_VERSION,
  BrowserImportCoordinator,
  RemoteBrowserImportProvider,
  type BrowserEnvironmentIdentity,
  type BrowserImportDataType,
  type BrowserImportSelection,
  type BrowserImportSource,
  type BrowserImportStore,
  type ImportBatch,
  type ImportedBookmark,
  type ImportJobSnapshot,
  type ImportHostSummary,
  type OpenTabsAsPanelsRequest,
  type OpenTabsAsPanelsResult,
  browserEnvironmentKeyMaterial,
} from "@vibestudio/browser-data";
import { createHash } from "node:crypto";
import type {
  BrowserPrivacySection,
  SensitiveBrowserImportDataType,
  SensitiveBrowserImportRequest,
  SensitiveBrowserImportSelection,
  SensitiveBrowserImportStatus,
} from "@vibestudio/browser-data/client";
import {
  createCollectionSession,
  launchCollectionTask,
  promptForCollectionStartupTask,
  type CollectionOrchestrationRpc,
  type CollectionSessionDescriptor,
  type CollectionStartupTask,
} from "@workspace/collection-orchestration";
import { createPanelRuntime } from "@workspace/runtime/panel-runtime";

interface InvocationLike {
  current(): {
    caller: {
      callerId?: string;
      callerKind: string;
      callerTitle?: string;
      userId?: string;
      workspaceId?: string;
    };
    chainCaller?: { callerId: string; callerKind: string };
  } | null;
  signal?(): AbortSignal | null;
}

interface ResolvedBuiltinService {
  kind: "durable-object";
  targetId: string;
  objectKey?: string;
}

interface ExtensionContextLike {
  rpc: {
    call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
    stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal }
    ): Promise<Response>;
  };
  workers: {
    resolveService(protocol: string, objectKey?: string): Promise<ResolvedBuiltinService>;
  };
  invocation: InvocationLike;
  log: {
    info(message: string): void;
    warn?(message: string): void;
  };
  health?: {
    healthy(detail?: { summary: string }): void;
    degraded(detail: { summary: string; reasons?: string[] }): void;
    unhealthy(detail: { summary: string; reasons?: string[] }): void;
  };
  emit(event: string, payload: unknown): void;
}

const BROWSER_DATA_PROTOCOL = "vibestudio.browser-data.v1";
const TRUSTED_CALLER_KINDS = new Set(["shell", "server"]);
const NON_SENSITIVE_IMPORT_DATA_TYPES = new Set<BrowserImportDataType>([
  "bookmarks",
  "history",
  "searchEngines",
  "favicons",
]);
const SENSITIVE_IMPORT_DATA_TYPES = new Set<SensitiveBrowserImportDataType>([
  "cookies",
  "passwords",
  "formFill",
]);
const BROWSER_DATA_STORE_METHODS = [
  "getSitePreferences",
  "setSiteZoom",
  "getBookmarks",
  "addBookmark",
  "updateBookmark",
  "deleteBookmark",
  "moveBookmark",
  "searchBookmarks",
  "getHistory",
  "deleteHistoryEntry",
  "deleteHistoryRange",
  "clearAllHistory",
  "searchHistory",
  "searchHistoryForAutocomplete",
  "recordHistoryVisit",
  "updateHistoryTitle",
  "getSearchEngines",
  "setDefaultEngine",
  "listDownloadRecords",
  "upsertDownloadRecord",
  "putPageFavicon",
  "getPageFavicon",
] as const;

function collectionOrchestrationRpc(ctx: ExtensionContextLike): CollectionOrchestrationRpc {
  return {
    selfId: "@workspace-extensions/browser-data",
    call: (targetId, method, args) => ctx.rpc.call(targetId, method, ...args),
    stream: (targetId, method, args, options) => ctx.rpc.stream(targetId, method, args, options),
  };
}

/** Public API surface of this extension. */
export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("browser-data extension activating");

  const resolvedStores = new Map<
    string,
    Promise<{ identity: BrowserEnvironmentIdentity; dataTargetId: string }>
  >();
  const targetsByEnvironment = new Map<string, string>();
  const unregisterServerHosts = new Map<string, () => void>();
  const desktopHosts = new Map<string, { hostId: string; unregister: () => void }>();
  const hostLabels = new Map<string, string>();
  const sourceBrowsers = new Map<string, string>();
  const provider = new LocalBrowserImportProvider();

  const currentIdentity = async (): Promise<{
    identity: BrowserEnvironmentIdentity;
    dataTargetId: string;
  }> => {
    const invocation = ctx.invocation.current();
    const userId = invocation?.caller.userId?.trim();
    const workspaceId = invocation?.caller.workspaceId?.trim();
    if (!userId || !workspaceId || userId === "system") {
      throw Object.assign(new Error("Browser data requires a verified user and workspace"), {
        code: "ENOCALLER",
      });
    }
    const cacheKey = `${workspaceId}\x00${userId}`;
    let pending = resolvedStores.get(cacheKey);
    if (!pending) {
      const normalized = browserEnvironmentKeyMaterial(workspaceId, userId);
      const environmentKey = `${BROWSER_ENVIRONMENT_KEY_VERSION}_${createHash("sha256")
        .update(normalized.material)
        .digest("base64url")}`;
      pending = ctx.workers
        .resolveService(BROWSER_DATA_PROTOCOL, environmentKey)
        .then((dataTarget) => {
          if (dataTarget.kind !== "durable-object") {
            throw new Error("browser.data did not resolve to a Durable Object");
          }
          if (dataTarget.objectKey !== environmentKey) {
            throw new Error("Server resolved a different browser environment key");
          }
          const identity = {
            workspaceId: normalized.workspaceId,
            ownerUserId: normalized.ownerUserId,
            environmentKey,
          };
          targetsByEnvironment.set(environmentKey, dataTarget.targetId);
          return { identity, dataTargetId: dataTarget.targetId };
        })
        .catch((error: unknown) => {
          resolvedStores.delete(cacheKey);
          ctx.health?.degraded({
            summary: "Browser environment storage unavailable",
            reasons: [error instanceof Error ? error.message : String(error)],
          });
          throw error;
        });
      resolvedStores.set(cacheKey, pending);
    }
    return pending;
  };

  const callStoreForIdentity = <T>(
    identity: BrowserEnvironmentIdentity,
    method: string,
    ...args: unknown[]
  ): Promise<T> => {
    const targetId = targetsByEnvironment.get(identity.environmentKey);
    if (!targetId) throw new Error("Browser environment target is not resolved");
    return ctx.rpc
      .call<T>(targetId, method, ...args)
      .then((result) => {
        ctx.health?.healthy({ summary: "Browser environment storage ready" });
        return result;
      })
      .catch((error: unknown) => {
        ctx.health?.degraded({
          summary: "Browser environment storage unavailable",
          reasons: [error instanceof Error ? error.message : String(error)],
        });
        throw error;
      });
  };

  const store: BrowserImportStore = {
    async storeBatch(identity, batch) {
      assertNonSensitiveImportDataType(batch.dataType);
      await storeImportBatch(batch, (method, ...args) =>
        callStoreForIdentity(identity, method, ...args)
      );
      await callStoreForIdentity(identity, "recordImportBatch", {
        jobId: batch.jobId,
        dataType: batch.dataType,
        batchIndex: batch.batchIndex,
        idempotencyKey: batch.idempotencyKey,
        itemCount: batch.items.length,
      });
      ctx.emit("data-changed", { dataType: batch.dataType });
    },
    persistJob(identity, job) {
      return callStoreForIdentity(identity, "upsertImportJob", {
        jobId: job.jobId,
        hostId: job.hostId,
        hostLabel: hostLabels.get(job.hostId) ?? "Browser host",
        sourceId: job.sourceId,
        browser: sourceBrowsers.get(job.sourceId) ?? "unknown",
        phase: job.phase,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        dataTypes: job.requestedDataTypes,
        progress: job.progress,
        warnings: job.warnings,
        error: job.error,
        resumable: job.resumable,
      });
    },
    getJob(identity, jobId) {
      return callStoreForIdentity(identity, "getImportJob", jobId);
    },
  };
  const coordinator = new BrowserImportCoordinator(store, (identity, job) => {
    ctx.emit("import-job-changed", {
      environmentKey: identity.environmentKey,
      job,
    });
  });

  const ensureServerHost = (identity: BrowserEnvironmentIdentity): void => {
    if (unregisterServerHosts.has(identity.environmentKey)) return;
    const unregister = coordinator.registerHost({
      hostId: `server:${identity.workspaceId}`,
      ownerUserId: identity.ownerUserId,
      displayName: "Server",
      platform: normalizedPlatform(),
      location: "server",
      connected: true,
      provider,
    });
    unregisterServerHosts.set(identity.environmentKey, unregister);
    hostLabels.set(`server:${identity.workspaceId}`, "Server");
  };

  const ensureDesktopHost = async (
    identity: BrowserEnvironmentIdentity
  ): Promise<ImportHostSummary | null> => {
    try {
      const summary = await ctx.rpc.call<ImportHostSummary>(
        "main",
        "browserEnvironment.getImportHost"
      );
      const current = desktopHosts.get(identity.environmentKey);
      if (current?.hostId === summary.hostId) return summary;
      current?.unregister();
      const remoteProvider = new RemoteBrowserImportProvider((method, ...args) =>
        ctx.rpc.call("main", `browserEnvironment.${method}`, ...args)
      );
      const unregister = coordinator.registerHost({
        ...summary,
        ownerUserId: identity.ownerUserId,
        provider: remoteProvider,
      });
      desktopHosts.set(identity.environmentKey, {
        hostId: summary.hostId,
        unregister,
      });
      hostLabels.set(summary.hostId, summary.displayName);
      return summary;
    } catch {
      desktopHosts.get(identity.environmentKey)?.unregister();
      desktopHosts.delete(identity.environmentKey);
      return null;
    }
  };

  const ensureImportHosts = async (identity: BrowserEnvironmentIdentity): Promise<void> => {
    ensureServerHost(identity);
    await ensureDesktopHost(identity);
  };

  const guarded =
    <Args extends unknown[], Result>(_method: string, fn: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      return fn(...args);
    };

  const callStore = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const { identity } = await currentIdentity();
    return callStoreForIdentity<T>(identity, method, ...args);
  };
  const storeMethods = Object.fromEntries(
    BROWSER_DATA_STORE_METHODS.map((method) => [
      method,
      guarded(method, (...args: unknown[]) => callStore(method, ...args)),
    ])
  ) as {
    [Method in (typeof BROWSER_DATA_STORE_METHODS)[number]]: (
      ...args: unknown[]
    ) => Promise<unknown>;
  };
  const browserData = {
    getBrowserEnvironment: guarded("getBrowserEnvironment", async () => {
      const invocation = ctx.invocation.current();
      if (!invocation || !TRUSTED_CALLER_KINDS.has(invocation.caller.callerKind)) {
        throw Object.assign(
          new Error("Browser environment identity is available only to the trusted host"),
          { code: "EACCES" }
        );
      }
      return (await currentIdentity()).identity;
    }),
    listImportHosts: guarded("listImportHosts", async () => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      return coordinator.listHosts(identity);
    }),
    listImportSources: guarded("listImportSources", async (hostId: string) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const sources = await coordinator.listSources(
        identity,
        hostId,
        ctx.invocation.signal?.() ?? undefined
      );
      const host = coordinator.listHosts(identity).find((candidate) => candidate.hostId === hostId);
      const availableSources = sources.map((source) =>
        withAvailableSensitiveImportPath(source, host?.location === "desktop")
      );
      for (const source of availableSources) {
        sourceBrowsers.set(source.sourceId, source.browser);
      }
      return availableSources;
    }),
    previewImport: guarded("previewImport", async (selection: BrowserImportSelection) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      assertNonSensitiveImportSelection(selection);
      return coordinator.preview(identity, selection, ctx.invocation.signal?.() ?? undefined);
    }),
    previewSensitiveImport: guarded(
      "previewSensitiveImport",
      async (request: SensitiveBrowserImportSelection) => {
        const { identity } = await currentIdentity();
        const host = await ensureDesktopHost(identity);
        assertSelectedDesktopHost(host, request.hostId);
        assertSensitiveImportSelection(request);
        return ctx.rpc.call(
          "main",
          "browserEnvironment.previewSensitiveImport",
          request.sourceId,
          request.dataTypes
        );
      }
    ),
    startImport: guarded("startImport", async (selection: BrowserImportSelection) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      assertNonSensitiveImportSelection(selection);
      const started = coordinator.start(identity, selection);
      void coordinator.waitForJob(identity, started.jobId).then((completed) => {
        reportImportHealth(ctx, completed);
        ctx.emit("import-complete", completed);
      });
      return started;
    }),
    startSensitiveImport: guarded(
      "startSensitiveImport",
      async (request: SensitiveBrowserImportRequest): Promise<SensitiveBrowserImportStatus> => {
        const { identity } = await currentIdentity();
        const host = await ensureDesktopHost(identity);
        assertSelectedDesktopHost(host, request.hostId);
        assertSensitiveImportRequest(request);
        return ctx.rpc.call<SensitiveBrowserImportStatus>(
          "main",
          "browserEnvironment.startSensitiveImport",
          request.sourceId,
          request.dataTypes,
          request.operationId
        );
      }
    ),
    observeSensitiveImport: guarded(
      "observeSensitiveImport",
      async (operationId: string): Promise<SensitiveBrowserImportStatus> => {
        const { identity } = await currentIdentity();
        await ensureDesktopHost(identity);
        assertSensitiveImportOperationId(operationId);
        return ctx.rpc.call("main", "browserEnvironment.observeSensitiveImport", operationId);
      }
    ),
    cancelSensitiveImport: guarded(
      "cancelSensitiveImport",
      async (operationId: string): Promise<SensitiveBrowserImportStatus> => {
        const { identity } = await currentIdentity();
        await ensureDesktopHost(identity);
        assertSensitiveImportOperationId(operationId);
        return ctx.rpc.call("main", "browserEnvironment.cancelSensitiveImport", operationId);
      }
    ),
    openBrowserPrivacyManager: guarded(
      "openBrowserPrivacyManager",
      async (section?: BrowserPrivacySection): Promise<void> => {
        await currentIdentity();
        await ctx.rpc.call("main", "browserPrivacyPresentation.open", section);
      }
    ),
    cancelImport: guarded("cancelImport", async (jobId: string) => {
      const { identity } = await currentIdentity();
      coordinator.cancel(identity, jobId);
    }),
    resumeImport: guarded("resumeImport", async (jobId: string) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const existing =
        coordinator.getJob(identity, jobId) ??
        (await callStore<ImportJobSnapshot | null>("getImportJob", jobId));
      if (!existing) throw new Error(`Browser import job was not found: ${jobId}`);
      assertNonSensitiveImportDataTypes(existing.requestedDataTypes);
      const resumed = await coordinator.resume(identity, jobId);
      void coordinator.waitForJob(identity, resumed.jobId).then((completed) => {
        reportImportHealth(ctx, completed);
        ctx.emit("import-complete", completed);
      });
      return resumed;
    }),
    getImportJob: guarded("getImportJob", async (jobId: string) => {
      const { identity } = await currentIdentity();
      const live = coordinator.getJob(identity, jobId);
      if (live) return live;
      const persisted = await callStore<ImportJobSnapshot | null>("getImportJob", jobId);
      return persisted ? orphanedImportJob(persisted) : null;
    }),
    listImportJobs: guarded("listImportJobs", async () => {
      const { identity } = await currentIdentity();
      const live = coordinator.listJobs(identity);
      return live.length > 0
        ? live
        : (await callStore<ImportJobSnapshot[]>("listImportJobs")).map(orphanedImportJob);
    }),
    listOpenTabs: guarded("listOpenTabs", async (request: { hostId: string; sourceId: string }) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      return coordinator.listOpenTabs(
        identity,
        request.hostId,
        request.sourceId,
        ctx.invocation.signal?.() ?? undefined
      );
    }),
    openTabsAsPanels: guarded("openTabsAsPanels", async (request: OpenTabsAsPanelsRequest) => {
      const { identity } = await currentIdentity();
      await ensureImportHosts(identity);
      const tabs = await coordinator.listOpenTabs(
        identity,
        request.hostId,
        request.sourceId,
        ctx.invocation.signal?.() ?? undefined
      );
      const chosen =
        request.selection.length > 0
          ? tabs.filter((tab) => request.selection.includes(tab.tabId))
          : tabs;
      const sources = await coordinator.listSources(
        identity,
        request.hostId,
        ctx.invocation.signal?.() ?? undefined
      );
      const sourceName =
        sources.find((source) => source.sourceId === request.sourceId)?.displayName ?? "Browser";
      return openTabsAsPanels(chosen, ctx, {
        destination: request.destination ?? "new-root",
        groupBy: request.groupBy ?? "window",
        sourceName,
      });
    }),

    // The Base broker owns only non-sensitive browser product records. Protected
    // browser material remains behind host-native effects and never enters this
    // provider or its Durable Object.
    ...storeMethods,

    exportBookmarks: guarded("exportBookmarks", async (format: "html" | "json" | "chrome-json") =>
      exportBookmarks(format, await callStore<Array<Record<string, unknown>>>("getAllBookmarks"))
    ),
  };

  return { providerContracts: { browserData } };
}

async function storeImportBatch(
  batch: ImportBatch,
  callStore: <T>(method: string, ...args: unknown[]) => Promise<T>
): Promise<void> {
  const source = { sourceId: batch.sourceId };
  switch (batch.dataType) {
    case "bookmarks":
      await callStore("addBookmarksBatch", batch.items, source);
      return;
    case "history":
      await callStore("addHistoryBatch", batch.items, source);
      return;
    case "searchEngines":
      await callStore("addSearchEnginesBatch", batch.items, source);
      return;
    case "favicons":
      await callStore("addFaviconsBatch", batch.items);
  }
}

function assertNonSensitiveImportSelection(selection: BrowserImportSelection): void {
  assertNonSensitiveImportDataTypes(selection.dataTypes);
}

function orphanedImportJob(job: ImportJobSnapshot): ImportJobSnapshot {
  if (["complete", "cancelled", "failed", "partial"].includes(job.phase)) return job;
  return {
    ...job,
    phase: "failed",
    finishedAt: job.updatedAt,
    error: "The browser import stopped before it completed. Start the import again to retry.",
    resumable: true,
  };
}

function withAvailableSensitiveImportPath(
  source: BrowserImportSource,
  allowSensitive: boolean
): BrowserImportSource {
  if (allowSensitive) return source;
  return {
    ...source,
    supportedDataTypes: source.supportedDataTypes.filter(
      (dataType) => !SENSITIVE_IMPORT_DATA_TYPES.has(dataType as SensitiveBrowserImportDataType)
    ),
  };
}

function assertNonSensitiveImportDataTypes(dataTypes: readonly BrowserImportDataType[]): void {
  if (dataTypes.length === 0) throw new Error("At least one browser data type is required");
  for (const dataType of dataTypes) assertNonSensitiveImportDataType(dataType);
}

function assertNonSensitiveImportDataType(dataType: BrowserImportDataType): void {
  if (!NON_SENSITIVE_IMPORT_DATA_TYPES.has(dataType)) {
    throw Object.assign(
      new Error(`Sensitive browser data must be imported by the host: ${dataType}`),
      { code: "EUNSUPPORTED" }
    );
  }
}

function assertSensitiveImportRequest(request: SensitiveBrowserImportRequest): void {
  assertSensitiveImportOperationId(request.operationId);
  assertSensitiveImportSelection(request);
}

function assertSensitiveImportSelection(request: SensitiveBrowserImportSelection): void {
  if (
    request.dataTypes.length === 0 ||
    new Set(request.dataTypes).size !== request.dataTypes.length
  ) {
    throw new Error("Sensitive browser import data types must be non-empty and unique");
  }
  for (const dataType of request.dataTypes) {
    if (!SENSITIVE_IMPORT_DATA_TYPES.has(dataType)) {
      throw new Error(`Unsupported sensitive browser import data type: ${dataType}`);
    }
  }
}

function assertSensitiveImportOperationId(operationId: string): void {
  if (!operationId.trim()) throw new Error("Sensitive import operation id is required");
}

function assertSelectedDesktopHost(
  host: ImportHostSummary | null,
  requestedHostId: string
): asserts host is ImportHostSummary {
  if (!host || host.hostId !== requestedHostId) {
    throw new Error("Sensitive browser operations require the selected attached desktop host");
  }
}

interface OpenableTab {
  url: string;
  title?: string;
  windowId?: string;
  windowOrdinal?: number;
}

async function openTabsAsPanels(
  tabs: OpenableTab[],
  ctx: ExtensionContextLike,
  policy: {
    destination: "new-root" | "caller";
    groupBy: "window" | "none";
    sourceName: string;
  }
): Promise<OpenTabsAsPanelsResult> {
  const importStartedAt = Date.now();
  const slotTimings: Array<{
    stage: string;
    durationMs: number;
    outcome: string;
  }> = [];
  const panelRuntime = createPanelRuntime({
    rpc: {
      call: async <T>(target: string, method: string, args: unknown[]): Promise<T> =>
        (await ctx.rpc.call(target, method, ...args)) as T,
      emit: async () => {
        throw new Error("Browser-data panel composition does not emit target events");
      },
      on: () => () => {},
    },
    onCreateSlotTiming: (event) => {
      slotTimings.push(event);
      if (event.durationMs >= 5_000) {
        ctx.log.warn?.(
          `Slow browser panel creation stage ${event.stage}: ${event.durationMs}ms (${event.outcome})`
        );
      }
    },
  });
  const callerId = parentPanelIdFromInvocation(ctx.invocation.current());
  const panels: Array<{ id: string; title: string; url: string }> = [];
  const collections: Array<{
    id: string;
    title: string;
    parentId: string;
    panelsOpened: number;
  }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const openable: OpenableTab[] = [];
  for (const tab of tabs) {
    if (!/^https?:\/\//i.test(tab.url)) {
      skipped.push({
        url: tab.url,
        reason: "unsupported browser-panel URL scheme",
      });
      continue;
    }
    openable.push(tab);
  }

  if (openable.length === 0) {
    return {
      destination: policy.destination,
      groupBy: policy.groupBy,
      tabsFound: tabs.length,
      panelsOpened: 0,
      collections,
      panels,
      skipped,
    };
  }

  const createCollection = async (
    parentId: string | null,
    title: string,
    origin: string,
    options: {
      contextId?: string;
      stateArgs?: Record<string, unknown>;
    } = {}
  ): Promise<{ id: string; title: string; contextId: string }> => {
    const panel = await panelRuntime.openPanel("about/collection", {
      parentId,
      title,
      focus: false,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      stateArgs: { title, origin, ...(options.stateArgs ?? {}) },
    });
    const observation = await panel.observe();
    return {
      id: panel.id,
      // This operation just authored the product title; the raw topology
      // handle may still expose its identity until workspace.presentation has
      // indexed the new slot. Keep the authored fact instead of reading a
      // presentation projection back through the topology channel.
      title,
      contextId: observation.contextId,
    };
  };

  let root: OpenTabsAsPanelsResult["root"];
  let rootOrchestration:
    | {
        id: string;
        title: string;
        contextId: string;
        session: CollectionSessionDescriptor;
        startupTask: CollectionStartupTask;
      }
    | undefined;
  let anchorId: string;
  let orchestrationContextId: string | undefined;
  if (policy.destination === "new-root") {
    const title = `${policy.sourceName} · Imported Tabs`;
    const session = createCollectionSession();
    const startupTask: CollectionStartupTask = {
      kind: "title-browser-import-windows",
      sourceName: policy.sourceName,
    };
    const created = await createCollection(null, title, `${policy.sourceName} · browser import`, {
      stateArgs: {
        ...session,
        startupTask,
        agentConfig: { approvalLevel: 2 },
      },
    });
    root = { id: created.id, title: created.title, panelsOpened: 0 };
    rootOrchestration = {
      id: created.id,
      title: created.title,
      contextId: created.contextId,
      session,
      startupTask,
    };
    anchorId = created.id;
    orchestrationContextId = created.contextId;
  } else {
    if (!callerId) {
      throw new Error("The calling panel is unavailable; choose a new workspace root instead");
    }
    anchorId = callerId;
    const anchor = panelRuntime.getPanelHandle(anchorId);
    orchestrationContextId = (await anchor.observe()).contextId;
  }

  const groups = new Map<string, { title: string; tabs: OpenableTab[] }>();
  for (const tab of openable) {
    const key = policy.groupBy === "window" && tab.windowId ? tab.windowId : "";
    let group = groups.get(key);
    if (!group) {
      const ordinal = tab.windowOrdinal ?? groups.size + 1;
      group = {
        title:
          policy.destination === "new-root"
            ? `Window ${ordinal}`
            : `${policy.sourceName} · Window ${ordinal}`,
        tabs: [],
      };
      groups.set(key, group);
    }
    group.tabs.push(tab);
  }

  const archiveEmptyContainer = async (id: string, title: string) => {
    try {
      await panelRuntime.getPanelHandle(id).archive();
    } catch (error) {
      skipped.push({
        url: "(collection)",
        reason: `Could not remove empty collection ${title}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  };

  for (const [windowId, group] of groups) {
    let panelParentId = anchorId;
    let collection: (typeof collections)[number] | undefined;
    if (policy.groupBy === "window" && windowId) {
      try {
        const created = await createCollection(
          anchorId,
          group.title,
          `${policy.sourceName} · imported browser window`,
          { contextId: orchestrationContextId }
        );
        collection = {
          id: created.id,
          title: created.title,
          parentId: anchorId,
          panelsOpened: 0,
        };
        collections.push(collection);
        panelParentId = created.id;
      } catch (error) {
        const reason = `Could not create ${group.title}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        skipped.push(...group.tabs.map((tab) => ({ url: tab.url, reason })));
        continue;
      }
    }

    for (const tab of group.tabs) {
      const title = (tab.title?.trim() || hostnameFromUrl(tab.url) || "Imported Tab").slice(0, 80);
      try {
        // Browser panels are intentionally deferred: importing a tab records
        // its durable slot and URL, but must not wait for the external page to
        // finish loading. `openPanel` waits up to 90 seconds for browser
        // readiness, which serializes a tab import behind every slow site.
        const created = await panelRuntime.createPanelSlot(tab.url, {
          parentId: panelParentId,
          // A label, not an id: page titles repeat constantly ("New Tab"), and
          // as an id segment they collided.
          title,
          ...(orchestrationContextId ? { contextId: orchestrationContextId } : {}),
        });
        panels.push({
          id: created.id,
          title: created.title ?? title,
          url: tab.url,
        });
        if (collection) collection.panelsOpened += 1;
        if (root) root.panelsOpened += 1;
      } catch (error) {
        skipped.push({
          url: tab.url,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (collection?.panelsOpened === 0) {
      await archiveEmptyContainer(collection.id, collection.title);
    }
  }

  const nonEmptyCollections = collections.filter((entry) => entry.panelsOpened > 0);
  if (root?.panelsOpened === 0) {
    await archiveEmptyContainer(root.id, root.title);
    root = undefined;
    rootOrchestration = undefined;
  }
  if (root && rootOrchestration) {
    const launchStartedAt = Date.now();
    try {
      await launchCollectionTask(collectionOrchestrationRpc(ctx), {
        rootPanelId: rootOrchestration.id,
        rootTitle: rootOrchestration.title,
        contextId: rootOrchestration.contextId,
        session: rootOrchestration.session,
        task: promptForCollectionStartupTask(rootOrchestration.startupTask),
        // The collection UI uses the same key for its queued fallback. A
        // successful immediate publish therefore cannot duplicate on open.
        idempotencyKey: `initial-prompt:${rootOrchestration.session.channelName}`,
        agentConfig: { approvalLevel: 2 },
      });
    } catch (error) {
      // Tab import is already durable. Preserve startupTask as the idempotent
      // fallback when the user later opens the collection, and surface the
      // transient launch problem without misreporting imported tabs as skipped.
      ctx.log.warn?.(
        `Imported tabs, but could not start collection title assignment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      const durationMs = Date.now() - launchStartedAt;
      if (durationMs >= 5_000) {
        ctx.log.warn?.(`Slow post-import collection launch: ${durationMs}ms`);
      }
    }
  }
  const stageTotals = slotTimings.reduce<Record<string, { calls: number; durationMs: number }>>(
    (totals, timing) => {
      const current = totals[timing.stage] ?? { calls: 0, durationMs: 0 };
      current.calls += 1;
      current.durationMs += timing.durationMs;
      totals[timing.stage] = current;
      return totals;
    },
    {}
  );
  ctx.log.info(
    `Browser panel import completed: ${panels.length}/${openable.length} panels in ${
      Date.now() - importStartedAt
    }ms; stages=${JSON.stringify(stageTotals)}`
  );
  return {
    destination: policy.destination,
    groupBy: policy.groupBy,
    tabsFound: tabs.length,
    panelsOpened: panels.length,
    ...(root ? { root } : {}),
    collections: nonEmptyCollections,
    panels,
    skipped,
  };
}

function parentPanelIdFromInvocation(
  invocation: ReturnType<InvocationLike["current"]>
): string | undefined {
  const caller = invocation?.chainCaller ?? invocation?.caller;
  return caller && ["panel", "app", "worker", "do"].includes(caller.callerKind) && caller.callerId
    ? caller.callerId
    : undefined;
}

function exportBookmarks(
  format: "html" | "json" | "chrome-json",
  rows: Array<Record<string, unknown>>
): string {
  const bookmarks: ImportedBookmark[] = rows.map((row) => ({
    title: String(row["title"] ?? ""),
    url: String(row["url"] ?? ""),
    dateAdded: Number(row["date_added"] ?? Date.now()),
    folder: String(row["folder_path"] ?? "/")
      .split("/")
      .filter(Boolean),
    tags: row["tags"] ? String(row["tags"]).split(",").filter(Boolean) : undefined,
    keyword: row["keyword"] ? String(row["keyword"]) : undefined,
  }));
  if (format === "html") return exportNetscapeBookmarks(bookmarks);
  if (format === "chrome-json") return exportChromiumBookmarks(bookmarks);
  return JSON.stringify(bookmarks, null, 2);
}

function reportImportHealth(ctx: ExtensionContextLike, job: ImportJobSnapshot): void {
  if (job.phase === "failed" || job.phase === "cancelled") {
    ctx.health?.degraded({
      summary: job.phase === "cancelled" ? "Browser import cancelled" : "Browser import failed",
      reasons: job.error ? [job.error] : undefined,
    });
  } else if (job.phase === "partial" || job.warnings.length > 0) {
    ctx.health?.degraded({
      summary: "Browser import completed with warnings",
      reasons: job.warnings.slice(0, 8),
    });
  } else {
    ctx.health?.healthy({ summary: "Browser data import completed" });
  }
}

function normalizedPlatform(): "darwin" | "linux" | "win32" {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

function hostnameFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}
