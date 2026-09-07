import { describe, expect, it, vi } from "vitest";
import { loadOptionalTemplateSnapshot } from "./templates.js";

describe("optional onboarding templates", () => {
  it("presents recommended catalog entries as new workspaces", async () => {
    const catalog = vi.fn(async () => ({
      version: 1 as const, revision: "2026-09-07.1", systemEpoch: 1,
      coordinates: { url: "https://example.test/catalog.git", ref: "refs/heads/main", commit: "a".repeat(40), snapshot: `v1-sha256:${"b".repeat(64)}` },
      source: "verified" as const, stale: false, verifiedAt: "2026-09-07T00:00:00.000Z",
      entries: [{
        id: "news", name: "News", description: "News workspace", tags: [], recommended: true,
        url: "https://example.test/news.git",
        promoted: { ref: "refs/tags/v1", commit: "c".repeat(40), snapshot: `v1-sha256:${"d".repeat(64)}` },
      }],
    }));
    const rows = await loadOptionalTemplateSnapshot({ catalog, refreshCatalog: false });
    expect(rows).toEqual([expect.objectContaining({
      id: "template.news", state: "available",
      summary: "Available to inspect and open as a new workspace.",
      selection: { catalogId: "news", registryCommit: "a".repeat(40), registrySnapshot: `v1-sha256:${"b".repeat(64)}` },
    })]);
  });
});
