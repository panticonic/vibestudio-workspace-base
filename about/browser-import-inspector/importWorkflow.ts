import type {
  BrowserDataClient,
  ImportJobSnapshot,
  NonSensitiveBrowserImportSelection,
  SensitiveBrowserImportRequest,
  SensitiveBrowserImportSelection,
  SensitiveBrowserImportStatus,
} from "@vibestudio/browser-data/client";

export interface SensitiveImportCheckpoint {
  request: SensitiveBrowserImportRequest;
  status: SensitiveBrowserImportStatus;
}

export interface SensitiveCheckpointStore {
  read(): SensitiveImportCheckpoint | null;
  write(checkpoint: SensitiveImportCheckpoint): void;
}

export interface SelectedImportResult {
  job: ImportJobSnapshot | null;
  sensitiveStatus: SensitiveBrowserImportStatus | null;
  errors: unknown[];
}

export async function previewSelectedImports(
  client: BrowserDataClient,
  publicSelection: NonSensitiveBrowserImportSelection | null,
  sensitiveSelection: SensitiveBrowserImportSelection | null
) {
  if (!publicSelection && !sensitiveSelection) {
    throw new Error("Select at least one browser data category to review.");
  }
  const [publicPreview, sensitivePreview] = await Promise.all([
    publicSelection ? client.previewImport(publicSelection) : Promise.resolve(null),
    sensitiveSelection ? client.previewSensitiveImport(sensitiveSelection) : Promise.resolve(null),
  ]);
  return { publicPreview, sensitivePreview };
}

export async function startSelectedImports(
  client: BrowserDataClient,
  checkpointStore: SensitiveCheckpointStore,
  publicSelection: NonSensitiveBrowserImportSelection | null,
  sensitiveSelection: SensitiveBrowserImportSelection | null,
  createOperationId: () => string
): Promise<SelectedImportResult> {
  const pending = sensitiveSelection
    ? pendingSensitiveRequest(checkpointStore.read(), sensitiveSelection, createOperationId)
    : null;
  if (pending) {
    checkpointStore.write({
      request: pending,
      status: {
        operationId: pending.operationId,
        state: "running",
        counts: [],
      },
    });
  }

  const [publicResult, sensitiveResult] = await Promise.allSettled([
    publicSelection ? client.startImport(publicSelection) : Promise.resolve(null),
    pending ? client.startSensitiveImport(pending) : Promise.resolve(null),
  ]);
  const status =
    sensitiveResult.status === "fulfilled"
      ? sensitiveResult.value
      : pending
        ? (checkpointStore.read()?.status ?? null)
        : null;
  if (pending && status) checkpointStore.write({ request: pending, status });
  return {
    job: publicResult.status === "fulfilled" ? publicResult.value : null,
    sensitiveStatus: status,
    errors: [publicResult, sensitiveResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason),
  };
}

export async function observeSensitiveCheckpoint(
  client: BrowserDataClient,
  checkpointStore: SensitiveCheckpointStore
): Promise<SensitiveBrowserImportStatus | null> {
  const checkpoint = checkpointStore.read();
  if (!checkpoint || checkpoint.status.state !== "running") {
    return checkpoint?.status ?? null;
  }
  const status = await client.observeSensitiveImport(checkpoint.request.operationId);
  checkpointStore.write({ request: checkpoint.request, status });
  return status;
}

export async function cancelSelectedImports(
  client: BrowserDataClient,
  checkpointStore: SensitiveCheckpointStore,
  job: ImportJobSnapshot | null,
  sensitiveStatus: SensitiveBrowserImportStatus | null
): Promise<SelectedImportResult> {
  const publicPromise =
    job && !isTerminal(job.phase)
      ? client.cancelImport(job.jobId).then(() => client.getImportJob(job.jobId))
      : Promise.resolve(job);
  const sensitivePromise =
    sensitiveStatus?.state === "running"
      ? client.cancelSensitiveImport(sensitiveStatus.operationId)
      : Promise.resolve(sensitiveStatus);
  const [publicResult, sensitiveResult] = await Promise.allSettled([
    publicPromise,
    sensitivePromise,
  ]);
  const nextSensitive =
    sensitiveResult.status === "fulfilled" ? sensitiveResult.value : sensitiveStatus;
  const checkpoint = checkpointStore.read();
  if (checkpoint && nextSensitive && checkpoint.request.operationId === nextSensitive.operationId) {
    checkpointStore.write({ request: checkpoint.request, status: nextSensitive });
  }
  return {
    job: publicResult.status === "fulfilled" ? publicResult.value : job,
    sensitiveStatus: nextSensitive,
    errors: [publicResult, sensitiveResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason),
  };
}

function pendingSensitiveRequest(
  checkpoint: SensitiveImportCheckpoint | null,
  selection: SensitiveBrowserImportSelection,
  createOperationId: () => string
): SensitiveBrowserImportRequest {
  if (
    checkpoint &&
    checkpoint.status.state === "running" &&
    sameSelection(checkpoint.request, selection)
  ) {
    return checkpoint.request;
  }
  return { ...selection, operationId: createOperationId() };
}

function sameSelection(
  existing: SensitiveBrowserImportSelection,
  requested: SensitiveBrowserImportSelection
): boolean {
  return (
    existing.hostId === requested.hostId &&
    existing.sourceId === requested.sourceId &&
    existing.dataTypes.length === requested.dataTypes.length &&
    existing.dataTypes.every((dataType, index) => dataType === requested.dataTypes[index])
  );
}

function isTerminal(phase: ImportJobSnapshot["phase"]): boolean {
  return ["complete", "cancelled", "failed", "partial"].includes(phase);
}
