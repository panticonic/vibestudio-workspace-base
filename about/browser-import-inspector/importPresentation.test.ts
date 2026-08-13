import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  panel: {
    stateArgs: { get: () => ({}), set: () => undefined },
  },
  browserData: {},
}));
import type { ImportJobSnapshot } from "@vibestudio/browser-data/client";
import {
  categoryProgressPresentation,
  importStatusPresentation,
  isMigrationStepComplete,
  isSuccessfulImportPhase,
  isTerminalImportPhase,
  shouldShowImportOptions,
} from "./importPresentation";
import { mergeImportPreviews, sensitiveStatusAsJob } from "./components/MigrateTab";

const desktopSelection = {
  host: {
    hostId: "desktop-1",
    displayName: "This device",
    platform: "linux" as const,
    location: "desktop" as const,
    connected: true,
  },
  source: {
    sourceId: "chrome-default",
    browser: "chrome" as const,
    displayName: "Chrome",
    status: "readable" as const,
    localDataSetCount: 1,
    supportedDataTypes: ["bookmarks" as const, "passwords" as const],
    warnings: [],
  },
};

type CategoryProgress = ImportJobSnapshot["progress"][number];

const progress = (overrides: Partial<CategoryProgress> = {}): CategoryProgress => ({
  dataType: "bookmarks",
  itemsProcessed: 0,
  totalItems: 0,
  stored: 0,
  skipped: 0,
  errors: 0,
  ...overrides,
});

describe("categoryProgressPresentation", () => {
  it("treats skipped records as processed outcomes for a completed import", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 29,
          totalItems: 29,
          stored: 29,
          skipped: 1_057,
        }),
        "complete"
      )
    ).toEqual({
      value: 100,
      processed: 1_086,
      total: 1_086,
      label: "1086 records considered",
    });
  });

  it("shows work processed rather than records stored while running", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 543,
          totalItems: 1_086,
          stored: 29,
          skipped: 514,
        }),
        "storing"
      )
    ).toEqual({
      value: 50,
      processed: 543,
      total: 1_086,
      label: "543 of 1086 processed",
    });
  });

  it("leaves progress indeterminate when a running job has no total", () => {
    expect(
      categoryProgressPresentation(
        progress({
          itemsProcessed: 7,
          totalItems: undefined,
          stored: 4,
          skipped: 3,
        }),
        "reading"
      )
    ).toEqual({
      value: undefined,
      processed: 7,
      label: "7 processed",
    });
  });
});

describe("import state presentation", () => {
  it("makes a completed import explicit", () => {
    expect(importStatusPresentation("complete")).toMatchObject({
      heading: "Import complete",
      badge: "complete",
      color: "green",
    });
    expect(importStatusPresentation("complete").note).toContain("not work left to finish");
  });

  it("distinguishes terminal and successful phases", () => {
    expect(isTerminalImportPhase("complete")).toBe(true);
    expect(isTerminalImportPhase("failed")).toBe(true);
    expect(isTerminalImportPhase("storing")).toBe(false);
    expect(isSuccessfulImportPhase("partial")).toBe(true);
    expect(isSuccessfulImportPhase("cancelled")).toBe(false);
  });

  it("replaces the chooser with the result until the user asks to import again", () => {
    expect(shouldShowImportOptions(null, false)).toBe(true);
    expect(shouldShowImportOptions("storing", false)).toBe(false);
    expect(shouldShowImportOptions("complete", false)).toBe(false);
    expect(shouldShowImportOptions("complete", true)).toBe(true);
    expect(shouldShowImportOptions("failed", false)).toBe(true);
  });

  it("keeps the data step checked even while it remains selected", () => {
    expect(isMigrationStepComplete("data", true)).toBe(true);
    expect(isMigrationStepComplete("tabs", true)).toBe(false);
  });
});

describe("sealed sensitive import presentation", () => {
  it("supports a protected-only aggregate review without inventing plaintext samples", () => {
    const merged = mergeImportPreviews(
      null,
      {
        dataTypes: [
          {
            dataType: "passwords",
            itemsProcessed: 4,
            totalItems: 4,
            stored: 0,
            skipped: 0,
            errors: 0,
          },
        ],
        warnings: [],
        breakdowns: [
          {
            dataType: "passwords",
            groupedBy: "site",
            total: 4,
            groups: [{ label: "example.com", count: 4 }],
            otherGroups: 0,
            otherItems: 0,
          },
        ],
        openTabCount: 0,
        localDataSetCount: 1,
      },
      desktopSelection
    );

    expect(merged.job.requestedDataTypes).toEqual(["passwords"]);
    expect(merged.job.progress).toEqual([
      expect.objectContaining({ dataType: "passwords", itemsProcessed: 4 }),
    ]);
    expect(merged.breakdowns).toEqual([
      expect.objectContaining({ dataType: "passwords", total: 4 }),
    ]);
  });

  it("projects durable running, cancelled, and complete statuses through the same progress card", () => {
    const request = {
      hostId: "desktop-1",
      sourceId: "chrome-default",
      dataTypes: ["passwords" as const],
      operationId: "sensitive-1",
    };
    const count = {
      dataType: "passwords" as const,
      read: 4,
      stored: 3,
      skipped: 1,
      errors: 0,
    };

    expect(
      sensitiveStatusAsJob(
        { operationId: "sensitive-1", state: "running", counts: [count] },
        request,
        desktopSelection
      )
    ).toMatchObject({
      jobId: "sensitive-1",
      phase: "copying",
      resumable: true,
      progress: [{ itemsProcessed: 4, stored: 3, skipped: 1 }],
    });
    expect(
      sensitiveStatusAsJob(
        { operationId: "sensitive-1", state: "cancelled", counts: [count] },
        request,
        desktopSelection
      ).phase
    ).toBe("cancelled");
    expect(
      sensitiveStatusAsJob(
        { operationId: "sensitive-1", state: "complete", counts: [count] },
        request,
        desktopSelection
      ).phase
    ).toBe("complete");
    expect(
      sensitiveStatusAsJob(
        {
          operationId: "sensitive-1",
          state: "failed",
          counts: [count],
          error: "vault write failed",
        },
        request,
        desktopSelection
      )
    ).toMatchObject({
      phase: "failed",
      error: "vault write failed",
      progress: [
        {
          dataType: "passwords",
          itemsProcessed: 4,
          stored: 3,
          skipped: 1,
        },
      ],
    });
  });
});
