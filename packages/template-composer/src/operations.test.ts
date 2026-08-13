import { describe, expect, it, vi } from "vitest";
import type { TemplateCompositionPlan } from "./resolver.js";
import type { WorkspaceTemplateState } from "@vibestudio/workspace-contracts/types";
import {
  canonicalTemplateNodeId,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import {
  applyTemplateOperation,
  inspectTemplateOperation,
  publishPreparedTemplateOperation,
  stageTemplateOperation,
  templateStatus,
} from "./operations.js";

const exactRoot = {
  url: "https://github.com/vibestudio/workspace-base.git",
  ref: "refs/tags/v1.0.0",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"a".repeat(64)}` as const,
};

const currentRoot = {
  url: "https://github.com/vibestudio/current-root.git",
  ref: "refs/tags/v1.0.0",
  commit: "c".repeat(40),
  snapshot: `v1-sha256:${"c".repeat(64)}` as const,
};

function currentWorkspace() {
  const nodeId = canonicalTemplateNodeId(currentRoot.url, currentRoot.commit);
  const fragment = "systemEpoch: 59\n";
  const state: WorkspaceTemplateState = {
    version: 1,
    roots: [{ url: currentRoot.url }],
    overrides: {},
    nodes: [
      {
        nodeId,
        alias: templateAliasFromUrl(currentRoot.url),
        pin: currentRoot,
        parents: [],
        fragment,
        suggestions: {},
      },
    ],
    repositories: {},
  };
  return {
    roots: state.roots,
    state,
    installedLayers: { [nodeId]: fragment },
    localRepoPaths: new Set<string>(),
    expectedSystemEpoch: 59,
  };
}

describe("template operations", () => {
  it("projects exact unresolved suggestions from the local state only", () => {
    const digest = `v1-sha256:${"b".repeat(64)}` as const;
    const state = {
      nodes: [
        {
          nodeId: "t-base",
          alias: "base",
          pin: exactRoot,
          parents: [],
          suggestions: {
            trust: { digest, value: { chromeApps: ["apps/base"] } },
          },
        },
      ],
    } as unknown as WorkspaceTemplateState;

    expect(
      templateStatus([{ url: exactRoot.url }], state).excludedSuggestions,
    ).toEqual([
      {
        nodeId: "t-base",
        alias: "base",
        trust: { chromeApps: ["apps/base"] },
      },
    ]);
    expect(
      templateStatus([{ url: exactRoot.url }], state, {
        "t-base:trust": { digest, decision: "declined" },
      }).excludedSuggestions,
    ).toEqual([]);
  });

  it("rejects a composition with no template root", async () => {
    await expect(
      inspectTemplateOperation({
        kind: "recompose",
        workspace: { ...currentWorkspace(), roots: [] },
        sources: {
          resolvePromoted: vi.fn(),
          acquire: vi.fn(),
        },
      }),
    ).rejects.toThrow("retain at least one template root");
  });

  it("adopts an exact ordinary release without resolving its root from a registry", async () => {
    const resolvePromoted = vi.fn(async () => {
      throw new Error("registry should not resolve the adopted root");
    });
    const manifest = new TextEncoder().encode(
      "systemEpoch: 59\ntemplate:\n  repositories: [packages/runtime]\n  files: []\n",
    );
    const inspection = await inspectTemplateOperation({
      kind: "adopt",
      pin: exactRoot,
      workspace: currentWorkspace(),
      sources: {
        resolvePromoted,
        acquire: async (pin) => ({
          commit: pin.commit,
          snapshot: pin.snapshot,
          files: [
            {
              path: "meta/template.yml",
              contentHash: "a".repeat(64),
              size: manifest.byteLength,
              mode: 0o644,
            },
            {
              path: "packages/runtime/index.ts",
              contentHash: "b".repeat(64),
              size: 1,
              mode: 0o644,
            },
          ],
          readFile: (path) => (path === "meta/template.yml" ? manifest : null),
        }),
      },
    });

    expect(resolvePromoted).not.toHaveBeenCalled();
    expect(inspection.kind).toBe("adopt");
    expect(inspection.nextTemplates?.use).toEqual([
      { url: "git+https://github.com/vibestudio/current-root.git" },
      { url: "git+https://github.com/vibestudio/workspace-base.git" },
    ]);
    expect(inspection.plan.repositories["packages/runtime"]).toBeDefined();
  });

  it("uses protected publication as the only validation gate", async () => {
    const publish = vi.fn(async () => ({ mainEventId: "event-2" }));
    const discard = vi.fn(async () => undefined);
    const plan = { repositories: {} } as TemplateCompositionPlan;

    await expect(
      applyTemplateOperation({
        operationId: "op-1",
        expectedMainEventId: "event-1",
        inspection: { kind: "add", plan, nextTemplates: { use: [] } },
        ports: {
          openContext: async () => ({
            contextId: "template-composer-operation-op-1",
          }),
          stageComposition: async () => ({
            affectedRepoPaths: ["panels/news"],
          }),
          publish,
          discard,
        },
      }),
    ).resolves.toEqual({ mainEventId: "event-2" });

    expect(publish).toHaveBeenCalledWith(
      "template-composer-operation-op-1",
      "event-1",
    );
    expect(discard).not.toHaveBeenCalled();
  });

  it("stages once and publishes the retained context without an intermediate build", async () => {
    const discard = vi.fn();
    const publish = vi.fn(async () => ({ mainEventId: "event-2" }));
    const ports = {
      openContext: async () => ({
        contextId: "template-composer-operation-op-2",
      }),
      stageComposition: async () => ({ affectedRepoPaths: ["panels/news"] }),
      publish,
      discard,
    };
    const inspection = {
      kind: "add" as const,
      plan: { repositories: {} } as TemplateCompositionPlan,
      nextTemplates: { use: [] },
    };

    const prepared = await stageTemplateOperation({
      operationId: "op-2",
      inspection,
      ports,
    });
    expect(discard).not.toHaveBeenCalled();
    await publishPreparedTemplateOperation(prepared, "event-1", ports);
    expect(publish).toHaveBeenCalledWith(
      "template-composer-operation-op-2",
      "event-1",
    );
  });
});
