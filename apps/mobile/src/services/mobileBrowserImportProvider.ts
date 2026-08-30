import { Platform } from "react-native";
import type {
  BrowserImportAcquisitionOption,
  BrowserImportAcquisitionResult,
  BrowserImportDataType,
  BrowserImportSource,
  ImportCategoryBreakdown,
  ImportCategoryProgress,
  ImportHostSummary,
  SensitiveBrowserImportCount,
  SensitiveBrowserImportDataType,
  SensitiveBrowserImportStatus,
} from "@vibestudio/browser-data";
import {
  inspectBrowserExport,
  parseSelectedBrowserExport,
  type ArchiveEntry,
  type ArchiveImportDataType,
} from "@vibestudio/browser-import-archive";
import type { MobileRpcClient } from "./mobileTransport";
import { openExternalUrl } from "./nativeCapabilities";
import {
  openSafariBrowserDataExport,
  pickBrowserImportArchive,
  readBrowserImportArchive,
  releaseBrowserImportArchive,
  type NativeBrowserImportArchive,
} from "./mobileBrowserImportNative";
import { getNativeAppStorage, type NativeAppStorage } from "./nativeAppStorage";
import { browserVaultNativeMethods } from "@vibestudio/service-schemas/browserVaultNative";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";

type PublicDataType = Extract<BrowserImportDataType, "bookmarks" | "history">;
type ProviderFrame =
  | { type: "heartbeat" }
  | {
      type: "batch";
      dataType: PublicDataType;
      batchIndex: number;
      items: unknown[];
    }
  | { type: "progress"; progress: ImportCategoryProgress }
  | {
      type: "complete";
      summary: { dataTypes: ImportCategoryProgress[]; warnings: string[] };
    }
  | { type: "error"; message: string };

interface MobileImportSource {
  archive: NativeBrowserImportArchive;
  source: BrowserImportSource;
  expires: ReturnType<typeof setTimeout>;
}

interface PublicOperation {
  sourceId: string;
  frames: ProviderFrame[];
}

interface SensitiveOperation {
  sourceId: string;
  cancelled: boolean;
  status: SensitiveBrowserImportStatus;
  running: Promise<void>;
}

const SOURCE_TTL_MS = 30 * 60_000;
const FRAME_ITEMS = 50;
const PASSWORD_BATCH_ITEMS = 250;
const LEDGER_PREFIX = "vibestudio.browser-import.mobile-sensitive.v1:";
const PUBLIC_TYPES = new Set<BrowserImportDataType>(["bookmarks", "history"]);

/** Trusted mobile endpoint for user-selected browser export files. */
export class MobileBrowserImportProvider {
  private readonly sources = new Map<string, MobileImportSource>();
  private readonly publicOperations = new Map<string, PublicOperation>();
  private readonly sensitiveOperations = new Map<string, SensitiveOperation>();

  constructor(
    private readonly rpc: MobileRpcClient,
    private readonly deviceId: string,
    private readonly storage: NativeAppStorage = getNativeAppStorage(),
  ) {}

  expose(): void {
    const expose = (
      method: string,
      handler: (args: unknown[]) => unknown | Promise<unknown>,
    ) =>
      this.rpc.expose(`browserEnvironment.${method}`, ({ args }) =>
        handler(args),
      );
    expose("listImportHosts", () => [this.summary()]);
    expose("listImportAcquisitionOptions", ([hostId]) => {
      this.requireHost(hostId);
      return this.listAcquisitionOptions();
    });
    expose("beginImportAcquisition", ([hostId, acquisitionId]) => {
      this.requireHost(hostId);
      return this.beginAcquisition(String(acquisitionId));
    });
    expose("releaseImportSource", ([hostId, sourceId]) => {
      this.requireHost(hostId);
      return this.releaseSource(String(sourceId));
    });
    expose("listImportSources", ([hostId]) => {
      this.requireHost(hostId);
      return [...this.sources.values()].map((entry) => entry.source);
    });
    expose("previewImportSource", ([hostId, sourceId, dataTypes]) => {
      this.requireHost(hostId);
      return this.preview(String(sourceId), this.dataTypes(dataTypes));
    });
    expose("startImportRead", ([hostId, sourceId, dataTypes]) => {
      this.requireHost(hostId);
      return this.startImportRead(
        String(sourceId),
        this.publicDataTypes(dataTypes),
      );
    });
    expose("nextImportFrame", ([operationId]) =>
      this.nextFrame(String(operationId)),
    );
    expose("cancelImportRead", ([operationId]) =>
      this.cancelRead(String(operationId)),
    );
    expose("listImportOpenTabs", ([hostId, sourceId]) => {
      this.requireHost(hostId);
      this.requireSource(String(sourceId));
      return [];
    });
    expose(
      "startSensitiveImport",
      ([hostId, sourceId, dataTypes, operationId]) => {
        this.requireHost(hostId);
        return this.startSensitiveImport(
          String(sourceId),
          this.sensitiveDataTypes(dataTypes),
          String(operationId),
        );
      },
    );
    expose("observeSensitiveImport", ([operationId]) =>
      this.observeSensitiveImport(String(operationId)),
    );
    expose("cancelSensitiveImport", ([operationId]) =>
      this.cancelSensitiveImport(String(operationId)),
    );
  }

  summary(): ImportHostSummary {
    const ios = Platform.OS === "ios";
    return {
      hostId: `device:${this.deviceId}`,
      displayName: ios ? "This iPhone or iPad" : "This Android device",
      platform: ios ? "ios" : "android",
      location: "device",
      connected: true,
    };
  }

  listAcquisitionOptions(): BrowserImportAcquisitionOption[] {
    return Platform.OS === "ios"
      ? [
          {
            acquisitionId: "safari-export",
            browser: "safari",
            displayName: "Export from Safari",
            description: "Open Apple's protected Safari export sheet.",
            kind: "system-export",
            primary: true,
          },
          {
            acquisitionId: "choose-export",
            browser: "safari",
            displayName: "Choose an exported file",
            description:
              "Choose a Safari, Chrome, or password-manager export from Files.",
            kind: "file-picker",
            primary: false,
          },
        ]
      : [
          {
            acquisitionId: "chrome-takeout",
            browser: "chrome",
            displayName: "Create a Chrome export",
            description: "Open Google Takeout with Chrome data selected.",
            kind: "external-export",
            primary: true,
          },
          {
            acquisitionId: "chrome-passwords",
            browser: "chrome",
            displayName: "Export Chrome passwords",
            description:
              "Open Google Password Manager to create a password CSV.",
            kind: "external-export",
            primary: false,
          },
          {
            acquisitionId: "choose-export",
            browser: "chrome",
            displayName: "Choose an exported file",
            description:
              "Choose a Chrome Takeout ZIP, bookmark HTML, or password CSV.",
            kind: "file-picker",
            primary: false,
          },
        ];
  }

  async beginAcquisition(
    acquisitionId: string,
  ): Promise<BrowserImportAcquisitionResult> {
    if (acquisitionId === "safari-export") {
      return {
        state: "presented",
        message: await openSafariBrowserDataExport(),
      };
    }
    if (acquisitionId === "chrome-takeout") {
      await openExternalUrl(
        "https://takeout.google.com/settings/takeout/custom/chrome?dest=download&frequency=once",
      );
      return {
        state: "presented",
        message:
          "Create and download the Chrome archive, then return and choose it here.",
      };
    }
    if (acquisitionId === "chrome-passwords") {
      await openExternalUrl("https://passwords.google.com/options");
      return {
        state: "presented",
        message:
          "Export passwords as CSV, then return and choose the file here.",
      };
    }
    if (acquisitionId !== "choose-export") {
      throw new Error("This browser export action is no longer available.");
    }
    const archive = await pickBrowserImportArchive();
    if (!archive) return { state: "cancelled" };
    try {
      const entries = await readBrowserImportArchive(archive);
      const inspection = inspectBrowserExport(entries);
      if (inspection.errors.length > 0)
        throw new Error(inspection.errors[0]!.message);
      if (
        inspection.browser === "unknown" ||
        inspection.supportedDataTypes.length === 0
      ) {
        throw new Error("The selected file is not a supported browser export.");
      }
      const sourceId = `mobile-export:${crypto.randomUUID()}`;
      const browser = inspection.browser === "safari" ? "safari" : "chrome";
      const source: BrowserImportSource = {
        sourceId,
        browser,
        displayName: inspection.displayName,
        status: "readable",
        localDataSetCount: inspection.localDataSetCount,
        supportedDataTypes: inspection.supportedDataTypes,
        lastActivityAt: Date.now(),
        transient: true,
        warnings: [
          ...inspection.warnings.map((warning) => warning.message),
          "The selected export may contain unencrypted browser data. Delete the original after import.",
        ],
      };
      const expires = setTimeout(
        () => void this.releaseSource(sourceId),
        SOURCE_TTL_MS,
      );
      this.sources.set(sourceId, { archive, source, expires });
      return { state: "selected", source };
    } catch (error) {
      await releaseBrowserImportArchive(archive.handle).catch(() => undefined);
      throw error;
    }
  }

  async preview(sourceId: string, requested: BrowserImportDataType[]) {
    const selected = this.archiveDataTypes(requested);
    const parsed = await this.parse(sourceId, selected);
    const dataTypes = selected.map((dataType) =>
      this.progress(dataType, parsed.items[dataType].length, 0),
    );
    return {
      dataTypes,
      breakdowns: selected.map((dataType) =>
        this.breakdown(dataType, parsed.items[dataType]),
      ),
      openTabCount: 0,
      localDataSetCount: parsed.localDataSetCount,
      warnings: parsed.warnings.map((warning) => warning.message),
    };
  }

  async startImportRead(
    sourceId: string,
    dataTypes: PublicDataType[],
  ): Promise<string> {
    const parsed = await this.parse(sourceId, dataTypes);
    const operationId = crypto.randomUUID();
    const frames: ProviderFrame[] = [];
    const summary: ImportCategoryProgress[] = [];
    for (const dataType of dataTypes) {
      const items = parsed.items[dataType];
      let batchIndex = 0;
      for (let start = 0; start < items.length; start += FRAME_ITEMS) {
        const batch = items.slice(start, start + FRAME_ITEMS);
        frames.push({ type: "batch", dataType, batchIndex, items: batch });
        frames.push({
          type: "progress",
          progress: this.progress(
            dataType,
            Math.min(start + batch.length, items.length),
            0,
          ),
        });
        batchIndex += 1;
      }
      summary.push(this.progress(dataType, items.length, 0));
    }
    frames.push({
      type: "complete",
      summary: {
        dataTypes: summary,
        warnings: parsed.warnings.map((warning) => warning.message),
      },
    });
    this.publicOperations.set(operationId, { sourceId, frames });
    return operationId;
  }

  nextFrame(operationId: string): ProviderFrame {
    const operation = this.publicOperations.get(operationId);
    if (!operation) throw new Error("Browser import operation is unavailable.");
    const frame = operation.frames.shift() ?? { type: "heartbeat" as const };
    if (frame.type === "complete" || frame.type === "error") {
      this.publicOperations.delete(operationId);
    }
    return frame;
  }

  cancelRead(operationId: string): void {
    this.publicOperations.delete(operationId);
  }

  async startSensitiveImport(
    sourceId: string,
    dataTypes: SensitiveBrowserImportDataType[],
    operationId: string,
  ): Promise<SensitiveBrowserImportStatus> {
    const existing = this.sensitiveOperations.get(operationId);
    if (existing) {
      if (existing.sourceId !== sourceId)
        throw new Error("Protected import inputs changed.");
      return existing.status;
    }
    const persisted = await this.readLedger(operationId);
    if (persisted && persisted.state !== "running") return persisted;
    if (dataTypes.some((dataType) => dataType !== "passwords")) {
      throw new Error(
        "This mobile export does not contain that protected browser category.",
      );
    }
    const status: SensitiveBrowserImportStatus = {
      operationId,
      state: "running",
      counts: dataTypes.map((dataType) => this.sensitiveCount(dataType)),
    };
    const operation: SensitiveOperation = {
      sourceId,
      cancelled: false,
      status,
      running: Promise.resolve(),
    };
    operation.running = this.runSensitive(operation);
    this.sensitiveOperations.set(operationId, operation);
    await this.writeLedger(status);
    return status;
  }

  async observeSensitiveImport(
    operationId: string,
  ): Promise<SensitiveBrowserImportStatus> {
    return (
      this.sensitiveOperations.get(operationId)?.status ??
      (await this.readLedger(operationId)) ??
      this.missingSensitive(operationId)
    );
  }

  async cancelSensitiveImport(
    operationId: string,
  ): Promise<SensitiveBrowserImportStatus> {
    const operation = this.sensitiveOperations.get(operationId);
    if (!operation)
      return (
        (await this.readLedger(operationId)) ??
        this.missingSensitive(operationId)
      );
    operation.cancelled = true;
    operation.status = { ...operation.status, state: "cancelled" };
    await this.writeLedger(operation.status);
    return operation.status;
  }

  async releaseSource(sourceId: string): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) return;
    if (
      [...this.publicOperations.values()].some(
        (operation) => operation.sourceId === sourceId,
      ) ||
      [...this.sensitiveOperations.values()].some(
        (operation) =>
          operation.sourceId === sourceId &&
          operation.status.state === "running",
      )
    ) {
      throw new Error(
        "Wait for the browser import to finish before removing its temporary copy.",
      );
    }
    clearTimeout(source.expires);
    this.sources.delete(sourceId);
    await releaseBrowserImportArchive(source.archive.handle);
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.sources.keys()].map((sourceId) =>
        this.releaseSource(sourceId).catch(() => undefined),
      ),
    );
  }

  private async parse(
    sourceId: string,
    dataTypes: readonly ArchiveImportDataType[],
  ) {
    const source = this.requireSource(sourceId);
    const entries: ArchiveEntry[] = await readBrowserImportArchive(
      source.archive,
    );
    const parsed = parseSelectedBrowserExport(entries, dataTypes);
    if (parsed.errors.length > 0) throw new Error(parsed.errors[0]!.message);
    return parsed;
  }

  private async runSensitive(operation: SensitiveOperation): Promise<void> {
    try {
      const browserVault = createTypedServiceClient(
        "browserVaultNative",
        browserVaultNativeMethods,
        (service, method, args) =>
          this.rpc.call("main", `${service}.${method}`, args),
      );
      const parsed = await this.parse(operation.sourceId, ["passwords"]);
      const passwords = parsed.items.passwords;
      const count =
        operation.status.counts[0] ?? this.sensitiveCount("passwords");
      count.read = passwords.length;
      for (
        let start = 0;
        start < passwords.length;
        start += PASSWORD_BATCH_ITEMS
      ) {
        if (operation.cancelled) return;
        const batch = passwords.slice(start, start + PASSWORD_BATCH_ITEMS);
        const stored = await browserVault.addPasswordsBatch(batch, {
          sourceId: operation.sourceId,
        });
        count.stored += stored;
        await this.writeLedger(operation.status);
      }
      if (operation.cancelled) return;
      operation.status = {
        ...operation.status,
        state: "complete",
        counts: [count],
      };
    } catch {
      operation.status = {
        ...operation.status,
        state: "failed",
        error:
          "Protected browser data could not be imported from the selected export.",
      };
    } finally {
      await this.writeLedger(operation.status);
    }
  }

  private breakdown(
    dataType: ArchiveImportDataType,
    items: ReadonlyArray<{ url: string }>,
  ): ImportCategoryBreakdown {
    const counts = new Map<string, number>();
    for (const item of items) {
      const value = item.url;
      let label = "Other";
      try {
        label = new URL(value).hostname || "Other";
      } catch {
        // Invalid URLs are filtered by the deterministic parser.
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const groups = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([label, count]) => ({ label, count }));
    const shown = new Set(groups.map((group) => group.label));
    const omitted = [...counts.entries()].filter(
      ([label]) => !shown.has(label),
    );
    return {
      dataType,
      groupedBy: "site",
      total: items.length,
      groups,
      otherGroups: omitted.length,
      otherItems: omitted.reduce((total, [, count]) => total + count, 0),
    };
  }

  private progress(
    dataType: ArchiveImportDataType,
    count: number,
    skipped: number,
  ): ImportCategoryProgress {
    return {
      dataType,
      itemsProcessed: count,
      totalItems: count,
      stored: count,
      skipped,
      errors: 0,
    };
  }

  private sensitiveCount(
    dataType: SensitiveBrowserImportDataType,
  ): SensitiveBrowserImportCount {
    return { dataType, read: 0, stored: 0, skipped: 0, errors: 0 };
  }

  private archiveDataTypes(
    dataTypes: BrowserImportDataType[],
  ): ArchiveImportDataType[] {
    const selected = dataTypes.filter(
      (dataType): dataType is ArchiveImportDataType =>
        dataType === "bookmarks" ||
        dataType === "history" ||
        dataType === "passwords",
    );
    if (selected.length !== dataTypes.length || selected.length === 0) {
      throw new Error(
        "The selected mobile export does not support that browser category.",
      );
    }
    return selected;
  }

  private dataTypes(value: unknown): BrowserImportDataType[] {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      throw new Error("Browser import categories are invalid.");
    }
    return value as BrowserImportDataType[];
  }

  private publicDataTypes(value: unknown): PublicDataType[] {
    const dataTypes = this.dataTypes(value);
    if (
      dataTypes.length === 0 ||
      dataTypes.some((dataType) => !PUBLIC_TYPES.has(dataType))
    ) {
      throw new Error(
        "Protected browser data requires the sealed import path.",
      );
    }
    return dataTypes as PublicDataType[];
  }

  private sensitiveDataTypes(value: unknown): SensitiveBrowserImportDataType[] {
    const dataTypes = this.dataTypes(value);
    if (
      dataTypes.length === 0 ||
      dataTypes.some((dataType) => dataType !== "passwords")
    ) {
      throw new Error(
        "This mobile export supports protected password import only.",
      );
    }
    return dataTypes as SensitiveBrowserImportDataType[];
  }

  private requireHost(value: unknown): void {
    if (value !== this.summary().hostId)
      throw new Error("Browser import device is unavailable.");
  }

  private requireSource(sourceId: string): MobileImportSource {
    const source = this.sources.get(sourceId);
    if (!source)
      throw new Error("The selected browser export is no longer available.");
    clearTimeout(source.expires);
    source.expires = setTimeout(
      () => void this.releaseSource(sourceId),
      SOURCE_TTL_MS,
    );
    return source;
  }

  private async readLedger(
    operationId: string,
  ): Promise<SensitiveBrowserImportStatus | null> {
    const value = await this.storage.getItem(`${LEDGER_PREFIX}${operationId}`);
    if (!value) return null;
    try {
      const status = JSON.parse(value) as SensitiveBrowserImportStatus;
      if (status.operationId !== operationId) return null;
      return status.state === "running"
        ? {
            ...status,
            state: "failed",
            error:
              "The mobile app stopped before the protected import completed. Choose the export again to retry.",
          }
        : status;
    } catch {
      return null;
    }
  }

  private writeLedger(status: SensitiveBrowserImportStatus): Promise<void> {
    return this.storage.setItem(
      `${LEDGER_PREFIX}${status.operationId}`,
      JSON.stringify(status),
    );
  }

  private missingSensitive(operationId: string): SensitiveBrowserImportStatus {
    return {
      operationId,
      state: "failed",
      counts: [],
      error: "Protected browser import operation is unavailable.",
    };
  }
}
