import type { PanelWebViewHandle } from "./PanelWebView";

/** Deliver recovery only to the exact retained document that still owns its panel. */
export function recoverCurrentPanels<
  Entry extends { panelId: string; managed: boolean },
>(
  kind: "resubscribe" | "cold-recover",
  retained: readonly Entry[],
  handles: ReadonlyMap<string, PanelWebViewHandle | null>,
  isCurrent: (entry: Entry) => boolean,
  reload: (panelId: string, handle: PanelWebViewHandle) => void,
): void {
  for (const entry of retained) {
    if (!entry.managed || !isCurrent(entry)) continue;
    const handle = handles.get(entry.panelId);
    if (!handle) continue;
    if (kind === "resubscribe") handle.deliverRecovery(kind);
    else reload(entry.panelId, handle);
  }
}
