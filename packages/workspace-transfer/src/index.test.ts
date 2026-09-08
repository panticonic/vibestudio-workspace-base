import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@vibestudio/durable/test-utils";
import {
  vcsMethods,
  type VcsImportSnapshotResult,
  type VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { createSemanticVcsSchema } from "../../../workers/workspace-source/semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchResult,
} from "../../../workers/workspace-source/semanticWorkspace.js";
import { SemanticVcsStore } from "../../../workers/workspace-source/semanticVcsStore.js";
import {
  prepareSelectedTransfer,
  MAX_SELECTED_TRANSFER_BYTES,
  MAX_SELECTED_TRANSFER_FILES,
  type SelectedTransferInput,
  type TransferWorkspaceClient,
} from "./index.js";

/** Two independent production semantic databases, with workspace-local blob maps
 * standing in for the existing authenticated RPC and filesystem effect boundary. */
async function workspace(workspaceId: string) {
  const sql = await createInMemorySql();
  createSemanticVcsSchema(sql);
  const now = () => "2026-09-07T00:00:00.000Z";
  const store = new SemanticVcsStore(sql, now);
  const semantic = new SemanticWorkspace({
    workspaceId,
    sql,
    store,
    now,
    transaction: (fn) => sql.transactionSync(fn),
  });
  const contextId = `context:${workspaceId}`;
  const initial = store.initializeWorkspace(
    contextId,
    `genesis:${workspaceId}`,
  );
  const blobs = new Map<string, Uint8Array>();
  let allowed = true;
  let corruptRead = false;
  const calls: Array<{ method: string; input: unknown }> = [];
  const authorize = () => {
    if (!allowed) throw new Error("EACCES: membership revoked");
  };
  const bytes = (hash: string) => {
    const value = blobs.get(hash);
    if (!value) throw new Error(`Missing fixture blob ${hash}`);
    return value;
  };
  function drain(initialResult: SemanticDispatchResult): unknown {
    let result = initialResult;
    while (result.kind !== "complete") {
      if (result.kind === "host-read") {
        const request = result.request;
        if (request["kind"] === "read-semantic-blob") {
          const { kind: _kind, state: _state, ...file } = request;
          return {
            ...file,
            content: {
              kind: "bytes",
              base64: Buffer.from(
                bytes(String(request["contentHash"])),
              ).toString("base64"),
            },
          };
        }
        result = semantic.acknowledgeHostRead({
          request,
          files: (request["contentHashes"] as string[]).map((contentHash) => ({
            contentHash,
            text: new TextDecoder().decode(bytes(contentHash)),
          })),
        });
        continue;
      }
      if (result.kind === "host-content") {
        const request = result.request;
        const prepared = request["blobs"] as Array<{
          contentHash: string;
          base64: string;
        }>;
        for (const blob of prepared) {
          const value = Buffer.from(blob.base64, "base64");
          expect(sha256Hex(value)).toBe(blob.contentHash);
          blobs.set(blob.contentHash, value);
        }
        result = semantic.acknowledgeContent({
          request,
          contentHashes: prepared.map((blob) => blob.contentHash).sort(),
        });
        continue;
      }
      const effect = result.effects[0]!;
      let receipt: Record<string, unknown>;
      if (effect.kind === "observe-content") {
        receipt = {
          files: (
            effect.payload["files"] as Array<{ contentHash: string }>
          ).map(({ contentHash }) => {
            const value = bytes(contentHash);
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(
                value,
              );
              return {
                contentHash,
                contentKind: "text",
                byteLength: value.length,
                coordinateExtent: text.length,
              };
            } catch {
              return {
                contentHash,
                contentKind: "bytes",
                byteLength: value.length,
                coordinateExtent: value.length,
              };
            }
          }),
        };
      } else {
        expect(effect.kind).toBe("materialize-context");
        const repositories = effect.payload["repositories"] as Array<{
          repositoryId: string;
          repoPath: string;
          presence: string;
        }>;
        receipt = {
          materializationId: effect.effectId,
          contextId: effect.payload["contextId"],
          targetState: effect.payload["targetState"],
          payloadDigest: effect.payload["payloadDigest"],
          repositories: repositories
            .filter((repo) => repo.presence === "present")
            .map(({ repositoryId, repoPath }) => ({
              repositoryId,
              repoPath,
              contentRoot: `state:${"0".repeat(64)}`,
            })),
        };
      }
      result = semantic.acknowledgeEffect({
        effectId: effect.effectId,
        payloadDigest: effect.payloadDigest,
        receipt,
      });
    }
    return result.result;
  }
  async function call(
    method: keyof typeof vcsMethods,
    input: unknown,
  ): Promise<unknown> {
    authorize();
    calls.push({ method, input });
    const parsed = vcsMethods[method].args.parse([input])[0];
    const result = drain(
      await semantic.dispatch(method, {
        input: parsed,
        ingress: {
          causalParent: null,
          contextIntegrity: { class: "internal", externalKeys: [] },
        },
      }),
    );
    return vcsMethods[method].returns.parse(result);
  }
  const putBase64 = vi.fn(async (base64: string) => {
    authorize();
    const value = Uint8Array.from(Buffer.from(base64, "base64"));
    const digest = sha256Hex(value);
    blobs.set(digest, value);
    return { digest, size: value.length };
  });
  const client: TransferWorkspaceClient = {
    workspaceId,
    vcs: Object.fromEntries(
      [
        "listFiles",
        "status",
        "importSnapshot",
        "registerExternalDelta",
        "compare",
        "merge",
      ].map((method) => [
        method,
        (input: unknown) => call(method as keyof typeof vcsMethods, input),
      ]),
    ) as unknown as TransferWorkspaceClient["vcs"],
    blobstore: {
      putBase64,
      getBase64: async (digest) => {
        authorize();
        return corruptRead
          ? Buffer.from("corrupt").toString("base64")
          : Buffer.from(bytes(digest)).toString("base64");
      },
    },
  };
  async function seed(files: Record<string, string>) {
    const descriptors = [];
    for (const [path, text] of Object.entries(files).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const stored = await putBase64(Buffer.from(text).toString("base64"));
      descriptors.push({ path, contentHash: stored.digest, mode: 0o644 });
    }
    const result = (await call("importSnapshot", {
      contextId,
      commandId: `seed:${workspaceId}`,
      expectedWorkingHead: initial.working.ref,
      source: {
        kind: "upload",
        uri: `fixture://${workspaceId}/`,
        snapshotRevision: "v1",
      },
      repositories: [{ repoPath: "projects/example", files: descriptors }],
    })) as VcsImportSnapshotResult;
    calls.length = 0;
    putBase64.mockClear();
    return {
      result,
      state: { kind: "event", eventId: result.eventId } as VcsStateNodeRef,
      repositoryId: result.importedRepositoryIds[0]!,
    };
  }
  return {
    client,
    contextId,
    initial,
    blobs,
    calls,
    putBase64,
    seed,
    call,
    sql,
    revoke: () => {
      allowed = false;
    },
    corrupt: () => {
      corruptRead = true;
    },
  };
}

async function pair(existing = false) {
  const source = await workspace("source");
  const destination = await workspace("destination");
  const seeded = await source.seed({
    "selected.txt": "selected bytes",
    "private.txt": "private canary",
  });
  const targetSeed = existing
    ? await destination.seed({
        "selected.txt": "old destination",
        "unselected.txt": "keep me",
      })
    : null;
  const input: SelectedTransferInput = {
    operationId: "copy:one",
    source: {
      workspaceId: "source",
      state: seeded.state,
      files: [{ repositoryId: seeded.repositoryId, path: "selected.txt" }],
    },
    target: {
      workspaceId: "destination",
      contextId: destination.contextId,
      expectedWorkingHead: targetSeed?.state ?? destination.initial.working.ref,
      repoPath: "projects/example",
      ...(targetSeed ? { repositoryId: targetSeed.repositoryId } : {}),
    },
    attribution: {
      sourceLabel: "Personal",
      destinationLabel: "Project",
      audience: ["Alice", "Bob"],
    },
  };
  const getClient = async (id: string) =>
    id === "source" ? source.client : destination.client;
  return { source, destination, input, getClient, seeded, targetSeed };
}

describe("selected source transfer", () => {
  it("previews locally, then copies only selected bytes into a fresh semantic boundary", async () => {
    const { source, destination, input, getClient, seeded } = await pair();
    const prepared = await prepareSelectedTransfer(input, getClient);
    expect(prepared.preview).toMatchObject({
      operation: "copy",
      totalBytes: 14,
      audience: ["Alice", "Bob"],
      files: [{ sourcePath: "selected.txt", size: 14 }],
    });
    expect(destination.calls).toEqual([]);
    expect(destination.blobs.size).toBe(0);
    input.source.files[0]!.path = "private.txt";
    const result = await prepared.execute();
    expect(result.kind).toBe("imported");
    expect(await prepared.execute()).toBe(result);
    expect(destination.putBase64).toHaveBeenCalledTimes(1);
    expect([...destination.blobs.keys()]).toEqual([
      sha256Hex(new TextEncoder().encode("selected bytes")),
    ]);
    expect(
      destination.blobs.has(
        sha256Hex(new TextEncoder().encode("private canary")),
      ),
    ).toBe(false);
    const disclosed = JSON.stringify(destination.calls);
    expect(disclosed).not.toContain(
      seeded.state.kind === "event" ? seeded.state.eventId : "unexpected",
    );
    expect(disclosed).not.toContain(seeded.repositoryId);
    expect(disclosed).not.toContain("private.txt");
    expect(disclosed).not.toContain(seeded.result.workUnitId);
    const status = await destination.client.vcs.status({
      contextId: destination.contextId,
    });
    expect(status.mainEventId).toBe(destination.initial.committed.ref.eventId);
    expect(source.blobs.size).toBe(2);
  });

  it("uses the real external delta merge and preserves unselected destination files", async () => {
    const { destination, input, getClient, targetSeed } = await pair(true);
    const prepared = await prepareSelectedTransfer(input, getClient);
    const result = await prepared.execute();
    expect(result.kind).toBe("merge");
    if (result.kind !== "merge") throw new Error("expected merge");
    expect(result.result.resolution.complete).toBe(true);
    expect(result.result.conflicts).toEqual([]);
    const read = async (path: string) =>
      destination.call("readFile", {
        state: result.result.workingHead,
        repositoryId: targetSeed!.repositoryId,
        file: { kind: "path", path },
      }) as Promise<
        import("@vibestudio/service-schemas/vcs").VcsReadFileResult
      >;
    expect((await read("selected.txt"))?.contentHash).toBe(
      sha256Hex(new TextEncoder().encode("selected bytes")),
    );
    expect((await read("unselected.txt"))?.contentHash).toBe(
      sha256Hex(new TextEncoder().encode("keep me")),
    );
    const deltaCall = destination.calls.find(
      ({ method }) => method === "registerExternalDelta",
    )!;
    expect(JSON.stringify(deltaCall.input)).not.toContain("unselected.txt");
    expect(
      destination.calls.some(
        ({ method }) => method === "commit" || method === "push",
      ),
    ).toBe(false);
    // Existing context-owned semantic lifecycle completes through the same receiver.
    const commit = (await destination.call("commit", {
      contextId: destination.contextId,
      commandId: "finish-copy",
      expectedWorkingHead: result.result.workingHead,
    })) as { event: VcsStateNodeRef };
    await expect(
      destination.call("finalizeExternalDelta", {
        contextId: destination.contextId,
        commandId: "finish-delta",
        expectedWorkingHead: commit.event,
        deltaId: result.delta.deltaId,
      }),
    ).resolves.toMatchObject({ status: "finalized" });
  });

  it.each(["source", "destination", "corrupt"])(
    "revalidates %s before any destination disclosure",
    async (which) => {
      const { source, destination, input, getClient } = await pair();
      const prepared = await prepareSelectedTransfer(input, getClient);
      if (which === "source") source.revoke();
      else if (which === "destination") destination.revoke();
      else source.corrupt();
      await expect(prepared.execute()).rejects.toThrow(
        which === "corrupt" ? "digest mismatch" : "EACCES",
      );
      expect(destination.putBase64).not.toHaveBeenCalled();
      expect(destination.blobs.size).toBe(0);
    },
  );

  it("rejects a stale target before copying and refuses a mismatched workspace client", async () => {
    const { destination, input, getClient } = await pair();
    const prepared = await prepareSelectedTransfer(input, getClient);
    await destination.seed({ "concurrent.txt": "new target" });
    await expect(prepared.execute()).rejects.toThrow("Destination changed");
    expect(destination.putBase64).not.toHaveBeenCalled();
    await expect(
      prepareSelectedTransfer(input, async () => destination.client),
    ).rejects.toThrow("does not match");
  });

  it("bounds selected count before reads and rejects unsupported modes or oversized metadata before fetching bytes", async () => {
    const { source, destination, input, getClient } = await pair();
    const factory = vi.fn(getClient);
    await expect(
      prepareSelectedTransfer(
        {
          ...input,
          source: {
            ...input.source,
            files: Array.from(
              { length: MAX_SELECTED_TRANSFER_FILES + 1 },
              () => input.source.files[0]!,
            ),
          },
        },
        factory,
      ),
    ).rejects.toThrow("Select at most");
    expect(factory).not.toHaveBeenCalled();
    const read = source.client.vcs.listFiles.bind(source.client.vcs);
    const getBytes = vi.spyOn(source.client.blobstore, "getBase64");
    source.client.vcs.listFiles = async (args) => {
      const page = await read(args);
      return {
        ...page,
        files: page.files.map((file) => ({ ...file, mode: 0o600 })),
      };
    };
    await expect(prepareSelectedTransfer(input, getClient)).rejects.toThrow(
      "regular or executable",
    );
    source.client.vcs.listFiles = async (args) => {
      const page = await read(args);
      return {
        ...page,
        files: page.files.map((file) => ({
          ...file,
          byteLength: MAX_SELECTED_TRANSFER_BYTES + 1,
        })),
      };
    };
    await expect(prepareSelectedTransfer(input, getClient)).rejects.toThrow(
      "exceeds",
    );
    expect(getBytes).not.toHaveBeenCalled();
    expect(destination.calls).toEqual([]);
  });

  it("rejects a wrong destination digest before semantic incorporation", async () => {
    const { destination, input, getClient } = await pair();
    const prepared = await prepareSelectedTransfer(input, getClient);
    const put = destination.client.blobstore.putBase64;
    destination.client.blobstore.putBase64 = async (base64) => ({
      ...(await put(base64)),
      digest: "0".repeat(64),
    });
    await expect(prepared.execute()).rejects.toThrow(
      "Destination digest mismatch",
    );
    expect(destination.calls.map(({ method }) => method)).toEqual(["status"]);
  });
});
