import { describe, expect, it, vi } from "vitest";
import type { BrowserDataClient, ImportJobSnapshot } from "@vibestudio/browser-data/client";
import {
  cancelSelectedImports,
  observeSensitiveCheckpoint,
  previewSelectedImports,
  startSelectedImports,
  type SensitiveImportCheckpoint,
} from "./importWorkflow";

function harness() {
  let checkpoint: SensitiveImportCheckpoint | null = null;
  const store = {
    read: vi.fn(() => checkpoint),
    write: vi.fn((next: SensitiveImportCheckpoint) => {
      checkpoint = next;
    }),
  };
  const client = {
    previewImport: vi.fn(),
    previewSensitiveImport: vi.fn(),
    startImport: vi.fn(),
    startSensitiveImport: vi.fn(),
    observeSensitiveImport: vi.fn(),
    cancelImport: vi.fn(),
    getImportJob: vi.fn(),
    cancelSensitiveImport: vi.fn(),
  } as unknown as BrowserDataClient;
  return {
    client,
    store,
    get checkpoint() {
      return checkpoint;
    },
  };
}

const publicSelection = {
  hostId: "desktop-1",
  sourceId: "chrome",
  dataTypes: ["bookmarks" as const],
};
const sensitiveSelection = {
  hostId: "desktop-1",
  sourceId: "chrome",
  dataTypes: ["passwords" as const],
};
const publicJob = {
  jobId: "public-1",
  hostId: "desktop-1",
  sourceId: "chrome",
  phase: "copying" as const,
  requestedDataTypes: ["bookmarks" as const],
  startedAt: 1,
  updatedAt: 1,
  progress: [],
  warnings: [],
  resumable: true,
};

describe("browser import workflow", () => {
  it("reviews a protected-only selection through aggregate preview", async () => {
    const h = harness();
    vi.mocked(h.client.previewSensitiveImport).mockResolvedValue({
      dataTypes: [],
      warnings: [],
      breakdowns: [],
      openTabCount: 0,
      localDataSetCount: 1,
    });

    await expect(previewSelectedImports(h.client, null, sensitiveSelection)).resolves.toMatchObject(
      { publicPreview: null, sensitivePreview: {} }
    );
    expect(h.client.previewImport).not.toHaveBeenCalled();
    expect(h.client.previewSensitiveImport).toHaveBeenCalledWith(sensitiveSelection);
  });

  it("persists an operation id before start and starts mixed public/protected work", async () => {
    const h = harness();
    vi.mocked(h.client.startImport).mockResolvedValue(publicJob);
    vi.mocked(h.client.startSensitiveImport).mockImplementation(async (request) => {
      expect(h.checkpoint).toEqual({
        request,
        status: { operationId: "sealed-1", state: "running", counts: [] },
      });
      return { operationId: request.operationId, state: "running", counts: [] };
    });

    const result = await startSelectedImports(
      h.client,
      h.store,
      publicSelection,
      sensitiveSelection,
      () => "sealed-1",
      vi.fn()
    );

    expect(h.client.startImport).toHaveBeenCalledWith(publicSelection, "sealed-1");
    expect(h.client.startSensitiveImport).toHaveBeenCalledWith({
      ...sensitiveSelection,
      operationId: "sealed-1",
    });
    expect(result).toMatchObject({
      job: { jobId: "public-1" },
      sensitiveStatus: { operationId: "sealed-1", state: "running" },
      errors: [],
    });
  });

  it("waits for asynchronous checkpoint persistence before starting either import", async () => {
    const h = harness();
    let releaseSave!: () => void;
    const saving = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const store = {
      read: h.store.read,
      write: vi.fn(async (checkpoint: SensitiveImportCheckpoint) => {
        await saving;
        h.store.write(checkpoint);
      }),
    };
    const status = { operationId: "sealed-1", state: "complete" as const, counts: [] };
    vi.mocked(h.client.startImport).mockResolvedValue(publicJob);
    vi.mocked(h.client.startSensitiveImport).mockResolvedValue(status);
    const report = vi.fn();
    const starting = startSelectedImports(
      h.client,
      store,
      publicSelection,
      sensitiveSelection,
      () => "sealed-1",
      report
    );

    expect(store.write).toHaveBeenCalledOnce();
    expect(store.read()).toBeNull();
    expect(h.client.startImport).not.toHaveBeenCalled();
    expect(h.client.startSensitiveImport).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    releaseSave();

    await expect(starting).resolves.toMatchObject({ errors: [], sensitiveStatus: status });
    expect(report).toHaveBeenCalledWith({
      sensitiveStatus: {
        operationId: "sealed-1",
        state: "running",
        counts: [],
      },
    });
    expect(h.checkpoint?.status).toEqual(status);
  });

  it("reports protected completion while the public import is still running", async () => {
    const h = harness();
    let finishPublic!: (job: ImportJobSnapshot) => void;
    vi.mocked(h.client.startImport).mockReturnValue(
      new Promise((resolve) => {
        finishPublic = resolve;
      })
    );
    const status = { operationId: "sealed-1", state: "complete" as const, counts: [] };
    vi.mocked(h.client.startSensitiveImport).mockResolvedValue(status);
    const report = vi.fn();
    let settled = false;
    const starting = startSelectedImports(
      h.client,
      h.store,
      publicSelection,
      sensitiveSelection,
      () => "sealed-1",
      report
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith({ sensitiveStatus: status }));
    expect(report).toHaveBeenCalledWith({ publicOperationId: "sealed-1" });
    expect(h.checkpoint?.status).toEqual(status);
    expect(settled).toBe(false);
    finishPublic(publicJob);
    await expect(starting).resolves.toMatchObject({ errors: [], sensitiveStatus: status });
  });

  it("does not start either import if its retry checkpoint cannot be saved", async () => {
    const h = harness();
    const store = {
      read: h.store.read,
      write: vi.fn(async () => {
        throw new Error("Checkpoint save failed");
      }),
    };
    await expect(
      startSelectedImports(
        h.client,
        store,
        publicSelection,
        sensitiveSelection,
        () => "sealed-1",
        vi.fn()
      )
    ).rejects.toThrow("Checkpoint save failed");
    expect(h.client.startImport).not.toHaveBeenCalled();
    expect(h.client.startSensitiveImport).not.toHaveBeenCalled();
  });

  it("reuses the persisted id after a lost start response and remount observation resumes it", async () => {
    const h = harness();
    vi.mocked(h.client.startSensitiveImport).mockRejectedValueOnce(new Error("response lost"));
    const first = await startSelectedImports(
      h.client,
      h.store,
      null,
      sensitiveSelection,
      () => "sealed-1",
      vi.fn()
    );
    expect(first.sensitiveStatus).toMatchObject({
      operationId: "sealed-1",
      state: "running",
    });
    expect(first.errors).toHaveLength(1);

    vi.mocked(h.client.startSensitiveImport).mockResolvedValueOnce({
      operationId: "sealed-1",
      state: "running",
      counts: [],
    });
    await startSelectedImports(
      h.client,
      h.store,
      null,
      sensitiveSelection,
      () => "must-not-be-used",
      vi.fn()
    );
    expect(h.client.startSensitiveImport).toHaveBeenLastCalledWith({
      ...sensitiveSelection,
      operationId: "sealed-1",
    });

    vi.mocked(h.client.observeSensitiveImport).mockResolvedValue({
      operationId: "sealed-1",
      state: "complete",
      counts: [],
    });
    await expect(observeSensitiveCheckpoint(h.client, h.store)).resolves.toMatchObject({
      state: "complete",
    });
    expect(h.checkpoint?.status.state).toBe("complete");
  });

  it("attempts public and protected cancellation independently and preserves each result", async () => {
    const h = harness();
    h.store.write({
      request: { ...sensitiveSelection, operationId: "sealed-1" },
      status: { operationId: "sealed-1", state: "running", counts: [] },
    });
    vi.mocked(h.client.cancelImport).mockRejectedValue(new Error("public failed"));
    vi.mocked(h.client.cancelSensitiveImport).mockResolvedValue({
      operationId: "sealed-1",
      state: "cancelled",
      counts: [],
    });

    const result = await cancelSelectedImports(
      h.client,
      h.store,
      publicJob as ImportJobSnapshot,
      h.checkpoint!.status
    );
    expect(h.client.cancelImport).toHaveBeenCalledWith("public-1");
    expect(h.client.cancelSensitiveImport).toHaveBeenCalledWith("sealed-1");
    expect(result.errors).toHaveLength(1);
    expect(result.sensitiveStatus?.state).toBe("cancelled");
    expect(h.checkpoint?.status.state).toBe("cancelled");
  });
});
