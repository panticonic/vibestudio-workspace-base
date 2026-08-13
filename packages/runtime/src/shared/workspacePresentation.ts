import type { RpcCaller } from "@vibestudio/rpc";
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
  PanelSourceUsage,
} from "@vibestudio/shared/panelSearchTypes";
import type {
  WorkspacePanelDetail,
  WorkspacePanelTreePage,
  WorkspacePanelTreePath,
  WorkspacePanelTreeRootGroupPage,
  WorkspacePanelTreeRootGroupPageInput,
  WorkspacePanelTreeSearchInput,
  WorkspacePanelTreeSearchPage,
} from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type { PanelTreeNode, PanelTreePageInput } from "@vibestudio/shared/panel/treeIndex";
import { asPanelSlotId } from "@vibestudio/shared/panel/idValues";
import { createDurableObjectServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
import { callWorkspaceState, createRuntimeWorkspaceStateClient } from "./workspaceStateClient.js";

export const WORKSPACE_PRESENTATION_SERVICE = "workspace.presentation";

/**
 * Base's sole composition boundary for workspace panel presentation.
 * `workspace-state` contributes bounded topology/identity facts; the Base DO
 * contributes durable titles, search facts and usage ranking.
 */
export function createWorkspacePresentationClient(rpc: Pick<RpcCaller, "call">) {
  const state = createRuntimeWorkspaceStateClient(rpc);
  const owner = createDurableObjectServiceClient(rpc, WORKSPACE_PRESENTATION_SERVICE);
  const iconBySource = new Map<string, Promise<string | undefined>>();

  const iconForSource = (source: string | undefined): Promise<string | undefined> => {
    if (!source || source.startsWith("browser:")) return Promise.resolve(undefined);
    let pending = iconBySource.get(source);
    if (!pending) {
      pending = rpc
        .call<{ icon?: string } | null>("main", "build.getPanelMetadata", [source])
        .then((metadata) => metadata?.icon);
      iconBySource.set(source, pending);
    }
    return pending;
  };

  const presentNodes = async (nodes: PanelTreeNode[]): Promise<PanelTreeNode[]> => {
    if (nodes.length === 0) return [];
    const titles = await owner.call<Record<string, string>>(
      "titlesForSlots",
      nodes.map((node) => node.slotId)
    );
    return Promise.all(
      nodes.map(async (node) => {
        const icon = await iconForSource(node.source);
        return {
          ...node,
          title: titles[node.slotId] ?? node.slotId,
          ...(icon ? { icon } : {}),
        };
      })
    );
  };

  const presentPage = async (page: WorkspacePanelTreePage): Promise<WorkspacePanelTreePage> => ({
    ...page,
    nodes: await presentNodes(page.nodes),
  });

  const detail = async (slotId: string): Promise<WorkspacePanelDetail | null> => {
    const value = await state.getPanelDetail(asPanelSlotId(slotId));
    if (!value) return null;
    const [titles, icon] = await Promise.all([
      owner.call<Record<string, string>>("titlesForSlots", [slotId]),
      iconForSource(value.currentHistory.source),
    ]);
    return {
      ...value,
      slot: { ...value.slot, current_entity_title: titles[slotId] ?? null },
      ...(icon ? { icon } : {}),
    };
  };

  const path = async (slotId: string): Promise<WorkspacePanelTreePath | null> => {
    const value = await state.getPanelTreePath(asPanelSlotId(slotId));
    return value ? { ...value, nodes: await presentNodes(value.nodes) } : null;
  };

  const searchTree = async (
    input: WorkspacePanelTreeSearchInput
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
      const ancestors = resultPath.nodes.slice(Math.max(0, ancestorCount - 12), -1);
      hits.push({
        node,
        ancestors,
        ...(ancestorCount > ancestors.length ? { ancestorsTruncated: true } : {}),
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
      current.currentHistory.source
    );
    return current.entity.id;
  };

  const indexPanel = async (
    panel: IndexablePanel,
    options?: { explicit?: boolean }
  ): Promise<string | null> => {
    const current = await state.getPanelDetail(asPanelSlotId(panel.id));
    if (!current) return null;
    return owner.call(
      "indexPanel",
      { ...panel, source: current.currentHistory.source },
      current.entity.id,
      options
    );
  };

  const updatePanelTitle = async (
    slotId: string,
    title: string,
    options?: { explicit?: boolean }
  ): Promise<string | null> => {
    const current = await state.getPanelDetail(asPanelSlotId(slotId));
    if (!current) return null;
    return owner.call(
      "updatePanelTitle",
      slotId,
      current.entity.id,
      title,
      options
    );
  };

  const searchIndex: PanelSearchIndex = {
    indexPanel: async (panel) => {
      await indexPanel(panel);
    },
    search: async (query, limit) =>
      (await owner.call<{ results: PanelSearchResult[] }>("search", query, limit)).results,
    incrementAccessCount: (slotId) => owner.call("incrementAccess", slotId),
    updateTitle: async (slotId, title) => {
      await updatePanelTitle(slotId, title);
    },
    rebuildIndex: () => owner.call("rebuildIndex"),
  };

  const workspaceState = {
    ...state,
    getPanelTreePage: (input: PanelTreePageInput) => state.getPanelTreePage(input).then(presentPage),
    getPanelTreePath: (slotId: Parameters<typeof state.getPanelTreePath>[0]) => path(slotId),
    getPanelDetail: (slotId: Parameters<typeof state.getPanelDetail>[0]) => detail(slotId),
  };

  return {
    owner,
    searchIndex,
    workspaceState,
    rootGroups: (input: WorkspacePanelTreeRootGroupPageInput) =>
      state.getPanelTreeRootGroups(input) as Promise<WorkspacePanelTreeRootGroupPage>,
    rootsForCaller: (input: { cursor?: string; limit?: number }) =>
      callWorkspaceState<WorkspacePanelTreePage>(rpc, "panelTree.rootsForCaller", [input]).then(
        presentPage
      ),
    page: (input: PanelTreePageInput) => state.getPanelTreePage(input).then(presentPage),
    path,
    detail,
    searchTree,
    syncSlot,
    indexPanel,
    updatePanelTitle,
    removeSlots: (slotIds: string[]) => owner.call<void>("removeSlots", slotIds),
    incrementAccess: (slotId: string) => owner.call<void>("incrementAccess", slotId),
    sourceUsage: (limit = 200) => owner.call<PanelSourceUsage[]>("sourceUsage", limit),
    rebuildIndex: () => owner.call<void>("rebuildIndex"),
  };
}

export type WorkspacePresentationClient = ReturnType<typeof createWorkspacePresentationClient>;
