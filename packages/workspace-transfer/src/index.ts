import {
  canonicalSnapshotDigest,
  sha256Hex,
  stableSha256Hex,
} from "@vibestudio/content-addressing";
import { base64ToBytes, BRIDGE_STREAM_BUFFER_CAP_BYTES } from "@vibestudio/rpc";
import type { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import {
  vcsReadFileInputSchema,
  vcsListFilesInputSchema,
  vcsImportSnapshotInputSchema,
  vcsRegisterExternalDeltaInputSchema,
  type vcsMethods,
  type VcsStateNodeRef,
  type VcsImportSnapshotResult,
  type VcsExternalDeltaResult,
  type VcsCompareResult,
  type VcsMergeResult,
} from "@vibestudio/service-schemas/vcs";
import type { TypedServiceClient } from "@vibestudio/shared/typedServiceClient";

export interface TransferWorkspaceClient {
  workspaceId: string;
  vcs: Pick<
    TypedServiceClient<typeof vcsMethods>,
    | "listFiles"
    | "status"
    | "importSnapshot"
    | "registerExternalDelta"
    | "compare"
    | "merge"
  >;
  blobstore: Pick<
    TypedServiceClient<typeof blobstoreMethods>,
    "getBase64" | "putBase64"
  >;
}

/** Same bounded selection size as vcs.copy and external-delta change receipts. */
export const MAX_SELECTED_TRANSFER_FILES = 200;
/** Reserve half the native bridge buffer for base64 expansion and RPC metadata. */
export const MAX_SELECTED_TRANSFER_BYTES = BRIDGE_STREAM_BUFFER_CAP_BYTES / 2;

/** The caller binds this factory to the currently authenticated hub/account. */
export type GetWorkspaceClient = (
  workspaceId: string,
) => Promise<TransferWorkspaceClient>;

export interface SelectedTransferInput {
  /** Stable operation identity, retained by the caller for command reconciliation. */
  operationId: string;
  source: {
    workspaceId: string;
    state: VcsStateNodeRef;
    files: Array<{
      repositoryId: string;
      path: string;
      destinationPath?: string;
    }>;
  };
  target: {
    workspaceId: string;
    contextId: string;
    expectedWorkingHead: VcsStateNodeRef;
    repoPath: string;
    /** Absent creates a fresh repository; present changes selected paths only. */
    repositoryId?: string;
  };
  /** Display attribution supplied by the current hub/account selection. */
  attribution: {
    sourceLabel: string;
    destinationLabel: string;
    audience: string[];
  };
}

export interface SelectedTransferPreview {
  readonly previewId: string;
  readonly operation: "copy";
  readonly sourceWorkspaceId: string;
  readonly sourceState: VcsStateNodeRef;
  readonly destinationWorkspaceId: string;
  readonly destinationRepoPath: string;
  readonly sourceLabel: string;
  readonly destinationLabel: string;
  readonly audience: readonly string[];
  readonly files: ReadonlyArray<{
    readonly repositoryId: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly contentHash: string;
    readonly size: number;
    readonly mode: number;
  }>;
  readonly totalBytes: number;
}

export type SelectedTransferResult =
  | { kind: "imported"; result: VcsImportSnapshotResult }
  | {
      kind: "merge";
      delta: VcsExternalDeltaResult;
      comparison: VcsCompareResult;
      result: VcsMergeResult;
    };

export interface PreparedSelectedTransfer {
  readonly preview: SelectedTransferPreview;
  /** Call only after the user confirms this exact preview. No automatic publication. */
  execute(): Promise<SelectedTransferResult>;
}

interface FileBytes {
  path: string;
  contentHash: string;
  mode: number;
  size: number;
  base64: string;
}

async function boundClient(getClient: GetWorkspaceClient, workspaceId: string) {
  const client = await getClient(workspaceId);
  if (client.workspaceId !== workspaceId)
    throw new Error("Workspace client does not match the selection");
  return client;
}

async function readFile(
  client: TransferWorkspaceClient,
  state: VcsStateNodeRef,
  repositoryId: string,
  path: string,
  remainingBytes: number,
): Promise<FileBytes | null> {
  vcsReadFileInputSchema.parse({
    state,
    repositoryId,
    file: { kind: "path", path },
  });
  // Metadata lookup keeps an oversized selected blob out of native UI memory.
  // A prefix is a filter on paged manifests, so an empty page is not absence.
  let cursor: string | undefined;
  do {
    const page = await client.vcs.listFiles(
      vcsListFilesInputSchema.parse({
        state,
        repositoryId,
        prefix: path,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (page.repositoryId !== repositoryId || !sameState(page.state, state))
      throw new Error("Source coordinate mismatch");
    const file = page.files.find((entry) => entry.path === path);
    if (file) {
      if (file.mode !== 0o644 && file.mode !== 0o755)
        throw new Error(
          `Selected copy supports only regular or executable files: ${path}`,
        );
      if (file.byteLength > remainingBytes)
        throw new Error(
          `Selected copy exceeds ${MAX_SELECTED_TRANSFER_BYTES} bytes`,
        );
      const base64 = await client.blobstore.getBase64(file.contentHash);
      if (base64 === null)
        throw new Error(`Selected content is unavailable: ${path}`);
      if (base64.length > 4 * Math.ceil(remainingBytes / 3))
        throw new Error(
          `Selected copy exceeds ${MAX_SELECTED_TRANSFER_BYTES} bytes`,
        );
      const bytes = base64ToBytes(base64);
      if (
        sha256Hex(bytes) !== file.contentHash ||
        bytes.byteLength !== file.byteLength
      )
        throw new Error(`Selected content digest mismatch: ${path}`);
      return {
        path,
        contentHash: file.contentHash,
        mode: file.mode,
        size: bytes.byteLength,
        base64,
      };
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

const descriptor = ({ path, contentHash, mode }: FileBytes) => ({
  path,
  contentHash,
  mode,
});
const snapshot = (files: FileBytes[]) =>
  canonicalSnapshotDigest(
    files.map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      size: file.size,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
    })),
  );
const sameState = (a: VcsStateNodeRef, b: VcsStateNodeRef) =>
  stableSha256Hex(a) === stableSha256Hex(b);

/**
 * Prepare a selected copy locally. Only source bytes are read; no source file
 * names, bytes, semantic graph or grants are sent to the destination here.
 * Existing-repository incorporation uses the selected target bytes as its
 * baseline. This is a copy with ordinary conflict handling, not source ancestry.
 */
export async function prepareSelectedTransfer(
  selection: SelectedTransferInput,
  getClient: GetWorkspaceClient,
): Promise<PreparedSelectedTransfer> {
  if (selection.source.files.length > MAX_SELECTED_TRANSFER_FILES)
    throw new Error(`Select at most ${MAX_SELECTED_TRANSFER_FILES} files`);
  // A later UI edit cannot alter the already reviewed selection.
  const input: SelectedTransferInput = JSON.parse(JSON.stringify(selection));
  if (!input.operationId || !input.source.files.length)
    throw new Error("Select files and an operation identity");
  if (input.target.repositoryId !== undefined && !input.target.repositoryId)
    throw new Error(
      "Select an existing repository identity or a new repository path",
    );
  if (input.source.workspaceId === input.target.workspaceId)
    throw new Error("Use the local VCS copy operation within one workspace");
  const source = await boundClient(getClient, input.source.workspaceId);
  const files: FileBytes[] = [];
  let selectedBytes = 0;
  const previewFiles: SelectedTransferPreview["files"][number][] = [];
  for (const coordinate of input.source.files) {
    const file = await readFile(
      source,
      input.source.state,
      coordinate.repositoryId,
      coordinate.path,
      MAX_SELECTED_TRANSFER_BYTES - selectedBytes,
    );
    if (!file)
      throw new Error(`Selected source file is absent: ${coordinate.path}`);
    selectedBytes += file.size;
    const path = coordinate.destinationPath ?? coordinate.path;
    files.push({ ...file, path });
    previewFiles.push({
      repositoryId: coordinate.repositoryId,
      sourcePath: coordinate.path,
      destinationPath: path,
      contentHash: file.contentHash,
      mode: file.mode,
      size: file.size,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sourceSnapshot = snapshot(files);
  // Validate the destination manifest now without sending it anywhere.
  const importInput = vcsImportSnapshotInputSchema.parse({
    commandId: `${input.operationId}:import`,
    contextId: input.target.contextId,
    expectedWorkingHead: input.target.expectedWorkingHead,
    source: {
      kind: "upload",
      uri: `selection://snapshot/${sourceSnapshot}`,
      snapshotRevision: sourceSnapshot,
      snapshot: sourceSnapshot,
    },
    repositories: [
      { repoPath: input.target.repoPath, files: files.map(descriptor) },
    ],
    message: "Copy selected source",
  });
  const preview: SelectedTransferPreview = Object.freeze({
    previewId: stableSha256Hex({ input, files: previewFiles }),
    operation: "copy",
    sourceWorkspaceId: input.source.workspaceId,
    sourceState: Object.freeze({ ...input.source.state }),
    destinationWorkspaceId: input.target.workspaceId,
    destinationRepoPath: input.target.repoPath,
    sourceLabel: input.attribution.sourceLabel,
    destinationLabel: input.attribution.destinationLabel,
    audience: Object.freeze([...input.attribution.audience]),
    files: Object.freeze(previewFiles.map((file) => Object.freeze(file))),
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  });
  let execution: Promise<SelectedTransferResult> | undefined;
  return Object.freeze({ preview, execute: () => (execution ??= execute()) });

  async function execute(): Promise<SelectedTransferResult> {
    const currentSource = await boundClient(
      getClient,
      input.source.workspaceId,
    );
    // Revalidate every selected coordinate and byte before any disclosure to
    // the destination, even if the client factory retains its connection.
    for (const selected of preview.files) {
      const current = await readFile(
        currentSource,
        input.source.state,
        selected.repositoryId,
        selected.sourcePath,
        selected.size,
      );
      if (
        !current ||
        current.contentHash !== selected.contentHash ||
        current.mode !== selected.mode
      )
        throw new Error(`Selected source changed: ${selected.sourcePath}`);
    }
    const target = await boundClient(getClient, input.target.workspaceId);
    const status = await target.vcs.status({
      contextId: input.target.contextId,
    });
    if (!sameState(status.workingHead, input.target.expectedWorkingHead))
      throw new Error("Destination changed; review a fresh selection");
    if (!input.target.repositoryId && !status.clean)
      throw new Error("Snapshot import requires a clean destination context");
    const oldFiles: FileBytes[] = [];
    let targetBytes = 0;
    if (input.target.repositoryId) {
      for (const file of files) {
        const old = await readFile(
          target,
          input.target.expectedWorkingHead,
          input.target.repositoryId,
          file.path,
          MAX_SELECTED_TRANSFER_BYTES - targetBytes,
        );
        if (old) {
          oldFiles.push(old);
          targetBytes += old.size;
        }
      }
    }
    // Content-addressed puts are the existing transport and idempotency unit.
    for (const file of new Map(
      files.map((file) => [file.contentHash, file]),
    ).values()) {
      const stored = await target.blobstore.putBase64(file.base64);
      if (stored.digest !== file.contentHash || stored.size !== file.size)
        throw new Error(`Destination digest mismatch: ${file.path}`);
    }
    if (!input.target.repositoryId)
      return {
        kind: "imported",
        result: await target.vcs.importSnapshot(importInput),
      };
    const oldSnapshot = snapshot(oldFiles);
    const delta = await target.vcs.registerExternalDelta(
      vcsRegisterExternalDeltaInputSchema.parse({
        commandId: `${input.operationId}:delta`,
        contextId: input.target.contextId,
        expectedWorkingHead: input.target.expectedWorkingHead,
        repositoryId: input.target.repositoryId,
        repoPath: input.target.repoPath,
        oldSource: {
          kind: "upload",
          uri: `selection://snapshot/${oldSnapshot}`,
          snapshotRevision: oldSnapshot,
          snapshot: oldSnapshot,
        },
        newSource: importInput.source,
        oldFiles: oldFiles.map(descriptor),
        newFiles: files.map(descriptor),
        intentSummary: "Copy selected source",
      }),
    );
    const mergeSource = {
      kind: "external-delta" as const,
      deltaId: delta.deltaId,
    };
    const comparison = await target.vcs.compare({
      target: input.target.expectedWorkingHead,
      source: mergeSource,
      limit: 200,
    });
    const result = await target.vcs.merge({
      commandId: `${input.operationId}:merge`,
      contextId: input.target.contextId,
      expectedWorkingHead: input.target.expectedWorkingHead,
      source: mergeSource,
    });
    // A bounded merge may have more pages or conflicts. The native client uses
    // the ordinary VCS review/commit/finalize flow; never silently select theirs.
    return { kind: "merge", delta, comparison, result };
  }
}
