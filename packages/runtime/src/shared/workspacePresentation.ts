import type { RpcCaller } from "@vibestudio/rpc";
import type {
  IndexablePanel,
  PanelSearchResult,
  PanelSourceUsage,
} from "@vibestudio/shared/panelSearchTypes";
import type {
  WorkspacePanelDetail,
  WorkspacePanelTreePage,
  WorkspacePanelTreeNode,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeRootGroupPageInput,
  WorkspacePanelTreeSearchInput,
  WorkspacePanelTreeSearchPage,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type {
  PanelTreeNode,
  PanelTreePage,
  PanelTreePageInput,
  PanelTreePath,
  PanelTreePlacementHint,
} from "@vibestudio/shared/panel/treeIndex";
import { asPanelSlotId } from "@vibestudio/shared/panel/idValues";
import { createDurableObjectServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
import {
  callWorkspaceState,
  createRuntimeWorkspaceStateClient,
} from "./workspaceStateClient.js";

export const WORKSPACE_PRESENTATION_SERVICE = "workspace.presentation";

/**
 * Base's sole composition boundary for workspace panel presentation.
 * `workspace-state` contributes bounded topology/identity facts; the Base DO
 * contributes durable titles, search facts and usage ranking.
 */
export function createWorkspacePresentationClient(
  rpc: Pick<RpcCaller, "call">,
) {
  const state = createRuntimeWorkspaceStateClient(rpc);
  const owner = createDurableObjectServiceClient(
    rpc,
    WORKSPACE_PRESENTATION_SERVICE,
  );
  const iconBySource = new Map<string, Promise<string | undefined>>();

  const iconForSource = (
    source: string | undefined,
  ): Promise<string | undefined> => {
    if (!source || source.startsWith("browser:"))
      return Promise.resolve(undefined);
    let pending = iconBySource.get(source);
    if (!pending) {
      pending = rpc
        .call<{
          icon?: string;
        } | null>("main", "build.getPanelMetadata", [source])
        .then((metadata) => metadata?.icon);
      iconBySource.set(source, pending);
    }
    return pending;
  };

  const presentationOptions = (
    serialized: string | null | undefined,
  ): { placement?: PanelTreePlacementHint; ref?: string } => {
    if (!serialized) return {};
    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      const rawPlacement =
        value["placement"] && typeof value["placement"] === "object"
          ? (value["placement"] as Record<string, unknown>)
          : null;
      const disposition =
        rawPlacement?.["disposition"] === "side" ||
        rawPlacement?.["disposition"] === "side-if-room" ||
        rawPlacement?.["disposition"] === "replace" ||
        rawPlacement?.["disposition"] === "split-below"
          ? rawPlacement["disposition"]
          : undefined;
      const preferredWidth =
        typeof rawPlacement?.["preferredWidth"] === "number" &&
        Number.isFinite(rawPlacement["preferredWidth"]) &&
        rawPlacement["preferredWidth"] > 0
          ? rawPlacement["preferredWidth"]
          : undefined;
      const minWidth =
        typeof rawPlacement?.["minWidth"] === "number" &&
        Number.isFinite(rawPlacement["minWidth"]) &&
        rawPlacement["minWidth"] > 0
          ? rawPlacement["minWidth"]
          : undefined;
      const placement: PanelTreePlacementHint | undefined =
        disposition || preferredWidth !== undefined || minWidth !== undefined
          ? {
              ...(disposition ? { disposition } : {}),
              ...(preferredWidth !== undefined ? { preferredWidth } : {}),
              ...(minWidth !== undefined ? { minWidth } : {}),
            }
          : undefined;
      return {
        ...(placement ? { placement } : {}),
        ...(typeof value["ref"] === "string" ? { ref: value["ref"] } : {}),
      };
    } catch {
      return {};
    }
  };

  const presentNodes = async (
    nodes: WorkspacePanelTreeNode[],
  ): Promise<PanelTreeNode[]> => {
    if (nodes.length === 0) return [];
    const titles = await owner.call<Record<string, string>>(
      "titlesForSlots",
      nodes.map((node) => node.slotId),
    );
    return Promise.all(
      nodes.map(async (node) => {
        const icon = await iconForSource(node.source);
        const { options, ...topology } = node;
        const presentation = presentationOptions(options);
        return {
          ...topology,
          title: titles[node.slotId] ?? node.slotId,
          ...(icon ? { icon } : {}),
          ...(node.source
            ? {
                kind: node.source.startsWith("browser:")
                  ? ("browser" as const)
                  : ("workspace" as const),
              }
            : {}),
          ...presentation,
        };
      }),
    );
  };

  const presentPage = async (
    page: WorkspacePanelTreePage,
  ): Promise<PanelTreePage> => ({
    ...page,
    nodes: await presentNodes(page.nodes),
  });

  const detail = async (
    slotId: string,
  ): Promise<
    | (WorkspacePanelDetail & {
        presentation: { title: string; icon?: string };
      })
    | null
  > => {
    const value = await state.getPanelDetail(asPanelSlotId(slotId));
    if (!value) return null;
    const [titles, icon] = await Promise.all([
      owner.call<Record<string, string>>("titlesForSlots", [slotId]),
      iconForSource(value.currentHistory.source),
    ]);
    return {
      ...value,
      presentation: {
        title: titles[slotId] ?? slotId,
        ...(icon ? { icon } : {}),
      },
    };
  };

  const path = async (slotId: string): Promise<PanelTreePath | null> => {
    const value = await state.getPanelTreePath(asPanelSlotId(slotId));
    return value ? { ...value, nodes: await presentNodes(value.nodes) } : null;
  };

  const searchTree = async (
    input: WorkspacePanelTreeSearchInput,
  ): Promise<WorkspacePanelTreeSearchPage> => {
    const search = await owner.call<{
      results: PanelSearchResult[];
      nextCursor: string | null;
    }>("search", input.query, input.limit, input.cursor);
    let revision = 0;
    const hits: WorkspacePanelTreeSearchPage["hits"] = [];
    for (const result of search.results) {
      const resultPath = await path(result.id);
      if (!resultPath) continue;
      revision = resultPath.revision;
      const node = resultPath.nodes.at(-1);
      if (!node) continue;
      const ancestorCount = Math.max(0, resultPath.nodes.length - 1);
      const ancestors = resultPath.nodes.slice(
        Math.max(0, ancestorCount - 12),
        -1,
      );
      hits.push({
        node,
        ancestors,
        ...(ancestorCount > ancestors.length
          ? { ancestorsTruncated: true }
          : {}),
      });
    }
    return { revision, hits, nextCursor: search.nextCursor };
  };

  const syncSlot = async (slotId: string): Promise<string | null> => {
    const current = await state.getPanelDetail(asPanelSlotId(slotId));
    if (!current) return null;
    await owner.call(
      "bindSlot",
      slotId,
      current.entity.id,
      current.currentHistory.source,
    );
    return current.entity.id;
  };

  const indexPanel = async (
    panel: IndexablePanel,
    options?: { explicit?: boolean },
  ): Promise<string | null> => {
    const current = await state.getPanelDetail(asPanelSlotId(panel.id));
    if (!current) return null;
    return owner.call(
      "indexPanel",
      { ...panel, source: current.currentHistory.source },
      current.entity.id,
      options,
    );
  };

  const updatePanelTitle = async (
    slotId: string,
    title: string,
    options?: { explicit?: boolean },
  ): Promise<string | null> => {
    const current = await state.getPanelDetail(asPanelSlotId(slotId));
    if (!current) return null;
    return owner.call(
      "updatePanelTitle",
      slotId,
      current.entity.id,
      title,
      options,
    );
  };

  const workspaceState = {
    ...state,
    getPanelTreePage: (input: PanelTreePageInput) =>
      state.getPanelTreePage(input).then(presentPage),
    getPanelTreePath: (slotId: Parameters<typeof state.getPanelTreePath>[0]) =>
      path(slotId),
    getPanelDetail: (slotId: Parameters<typeof state.getPanelDetail>[0]) =>
      detail(slotId),
  };

  return {
    owner,
    workspaceState,
    rootGroups: (input: WorkspacePanelTreeRootGroupPageInput) =>
      state.getPanelTreeRootGroups(
        input,
      ) as Promise<WorkspacePanelTreeRootGroupPage>,
    rootsForCaller: (input: { cursor?: string; limit?: number }) =>
      callWorkspaceState<WorkspacePanelTreePage>(
        rpc,
        "panelTree.rootsForCaller",
        [input],
      ).then(presentPage),
    page: (input: PanelTreePageInput) =>
      state.getPanelTreePage(input).then(presentPage),
    path,
    detail,
    searchTree,
    syncSlot,
    indexPanel,
    updatePanelTitle,
    removeSlots: (slotIds: string[]) =>
      owner.call<void>("removeSlots", slotIds),
    incrementAccess: (slotId: string) =>
      owner.call<void>("incrementAccess", slotId),
    sourceUsage: (limit = 200) =>
      owner.call<PanelSourceUsage[]>("sourceUsage", limit),
    rebuildIndex: () => owner.call<void>("rebuildIndex"),
  };
}

export type WorkspacePresentationClient = ReturnType<
  typeof createWorkspacePresentationClient
>;
