/**
 * The "already open" panel index the command sheet's `@` scope and `panel`
 * arguments rank over (quickfire-overlay-spec §4.1, §7.1).
 *
 * Read straight out of the shared panel tree cache — the same source the drawer
 * renders — so the sheet never issues its own tree RPCs and never disagrees
 * with the drawer about what is open. Nodes the cache has not loaded are simply
 * absent: the sheet offers what the app already knows, and typing a query that
 * needs a deeper page is what the durable tree search is for.
 */
import type { OpenPanelEntry } from "@workspace/omnibox-core";
import type {
  PanelTreeGroup,
  PanelTreeNode,
} from "@vibestudio/shared/panel/treeIndex";

/** The slice of `PanelTreeCache` this walk needs. */
export interface OpenPanelTreeSource {
  getRootGroups(): { groups: Array<{ ownerUserId: string | null }> };
  getGroup(group: PanelTreeGroup): { nodes: readonly PanelTreeNode[] } | null;
}

/** Upper bound so a huge workspace cannot stall opening the sheet. */
export const MAX_OPEN_PANELS = 300;

export function collectMobileOpenPanels(
  source: OpenPanelTreeSource,
  limit = MAX_OPEN_PANELS
): OpenPanelEntry[] {
  const entries: OpenPanelEntry[] = [];
  const seen = new Set<string>();

  const visit = (node: PanelTreeNode, parentTitle: string | undefined): void => {
    if (entries.length >= limit || seen.has(node.slotId)) return;
    seen.add(node.slotId);
    entries.push({
      id: node.slotId,
      title: node.title,
      source: node.source ?? "",
      ...(node.icon ? { icon: node.icon } : {}),
      ...(parentTitle ? { location: parentTitle } : {}),
    });
    if (node.childCount <= 0) return;
    const children = source.getGroup({ kind: "children", parentSlotId: node.slotId })?.nodes ?? [];
    for (const child of children) visit(child, node.title);
  };

  for (const group of source.getRootGroups().groups) {
    const roots = source.getGroup({ kind: "roots", ownerUserId: group.ownerUserId })?.nodes ?? [];
    for (const root of roots) visit(root, undefined);
  }
  return entries;
}
