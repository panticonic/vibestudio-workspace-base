// Pure placement engine for the multi-column panel layout.
// See docs/multi-column-panel-layout-plan.md §4. No React, no Electron,
// no service calls — unit-testable in isolation.

import {
  COLUMN_DIVIDER_WIDTH,
  MIN_COLUMN_WIDTH,
  MIN_PANE_HEIGHT,
  PREFERRED_COLUMN_WIDTH,
  mintColumnId,
  mintPaneId,
} from "./types";
import type {
  LayoutColumn,
  LayoutDropTarget,
  LayoutPane,
  PanelLayout,
  PanelPlacementHint,
  PersistedLayout,
} from "./types";

export type TreeRelation = "self" | "ancestor" | "descendant" | "sibling" | "none";
type ShowPanelOrigin = "tree-click" | "navigation-click" | "navigate-event";

export type LayoutAction =
  | {
      type: "show-panel";
      panelId: string;
      origin: ShowPanelOrigin;
    }
  | { type: "open-child"; panelId: string; parentId: string; hint?: PanelPlacementHint }
  | {
      type: "present-panel";
      panelId: string;
      anchorPanelId?: string;
      hint: PanelPlacementHint;
    }
  | { type: "open-beside"; panelId: string; anchorPaneId: string }
  | { type: "place-panel"; panelId: string; target: LayoutDropTarget }
  | { type: "move-pane-to-new-column"; paneId: string }
  | { type: "split-below"; panelId: string; anchorPaneId: string }
  | { type: "close-pane"; paneId: string }
  | { type: "tree-reconcile"; removed: Array<{ panelId: string; fallbackCandidates: string[] }> }
  | { type: "focus-pane"; paneId: string }
  | { type: "resize-columns"; columnFrs: number[] }
  | { type: "resize-panes"; columnId: string; paneFrs: number[] };

export interface LayoutEnv {
  viewportWidth: number;
  viewportHeight: number; // vertical fit tests (rule 2c/3) need it
  paneChromeHeight: number; // thin drop handle + divider per pane
  firstRootPanelId(): string | null; // seed after closing the last pane; null = empty workspace
  minWidthOf(panelId: string): number; // from placement hints / defaults
  treeRelation(a: string, b: string): TreeRelation;
  nearestVisibleRelative(panelId: string, layout: PanelLayout): string | null; // paneId
}

export interface PaneLocation {
  column: LayoutColumn;
  columnIndex: number;
  pane: LayoutPane;
  paneIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers

function findLocation(
  layout: PanelLayout,
  match: (pane: LayoutPane) => boolean
): PaneLocation | null {
  let columnIndex = 0;
  for (const column of layout.columns) {
    let paneIndex = 0;
    for (const pane of column.panes) {
      if (match(pane)) return { column, columnIndex, pane, paneIndex };
      paneIndex += 1;
    }
    columnIndex += 1;
  }
  return null;
}

export function findPane(layout: PanelLayout, paneId: string): PaneLocation | null {
  return findLocation(layout, (pane) => pane.id === paneId);
}

export function paneForPanel(layout: PanelLayout, panelId: string): PaneLocation | null {
  return findLocation(layout, (pane) => pane.panelId === panelId);
}

function cloneLayout(layout: PanelLayout): PanelLayout {
  return {
    focusedPaneId: layout.focusedPaneId,
    columns: layout.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => ({ ...pane })),
    })),
  };
}

function sanitizeFr(fr: number): number {
  return Number.isFinite(fr) && fr > 0 ? fr : 1;
}

function renormalizeFrs<T>(
  items: T[],
  get: (item: T) => number,
  set: (item: T, fr: number) => void
): void {
  if (items.length === 0) return;
  const frs = items.map((item) => sanitizeFr(get(item)));
  const total = frs.reduce((sum, fr) => sum + fr, 0);
  const scale = items.length / total;
  items.forEach((item, i) => set(item, (frs[i] ?? 1) * scale));
}

/** Prune empty columns, renormalize fractions, and repair dangling focus. */
export function normalizeLayout(layout: PanelLayout): PanelLayout {
  const next = cloneLayout(layout);
  next.columns = next.columns.filter((column) => column.panes.length > 0);
  renormalizeFrs(
    next.columns,
    (c) => c.widthFr,
    (c, fr) => (c.widthFr = fr)
  );
  for (const column of next.columns) {
    renormalizeFrs(
      column.panes,
      (p) => p.heightFr,
      (p, fr) => (p.heightFr = fr)
    );
  }
  const firstPane = next.columns[0]?.panes[0];
  if (firstPane === undefined) {
    next.focusedPaneId = null;
  } else if (next.focusedPaneId === null || findPane(next, next.focusedPaneId) === null) {
    next.focusedPaneId = firstPane.id;
  }
  return next;
}

export function columnMinWidth(column: LayoutColumn, env: LayoutEnv): number {
  let min = MIN_COLUMN_WIDTH;
  for (const pane of column.panes) {
    min = Math.max(min, env.minWidthOf(pane.panelId), pane.minWidthOverride ?? 0);
  }
  return min;
}

function setPaneMinWidth(pane: LayoutPane, minWidth: number | undefined): void {
  if (minWidth === undefined) delete pane.minWidthOverride;
  else pane.minWidthOverride = minWidth;
}

function setPanePanel(
  pane: LayoutPane,
  panelId: string,
  hint?: Pick<PanelPlacementHint, "minWidth">
): void {
  pane.panelId = panelId;
  setPaneMinWidth(pane, hint?.minWidth);
}

function newPane(panelId: string, heightFr = 1, minWidth?: number): LayoutPane {
  return {
    id: mintPaneId(),
    heightFr,
    panelId,
    ...(minWidth !== undefined ? { minWidthOverride: minWidth } : {}),
  };
}

function newColumn(panelId: string, widthFr = 1): LayoutColumn {
  return { id: mintColumnId(), widthFr, panes: [newPane(panelId)] };
}

function isolatePanel(next: PanelLayout, panelId: string): PanelLayout {
  const existing = paneForPanel(next, panelId);
  const pane = existing?.pane ?? newPane(panelId);
  pane.heightFr = 1;
  return normalizeLayout({
    columns: [
      {
        id: existing?.column.id ?? mintColumnId(),
        widthFr: 1,
        panes: [pane],
      },
    ],
    focusedPaneId: pane.id,
  });
}

// ---------------------------------------------------------------------------
// Viewport residency (§3.1 / D10) — parking is derived, never stored.

export function computeViewport(
  layout: PanelLayout,
  env: LayoutEnv
): { residentColumnIds: string[]; parkedLeft: string[]; parkedRight: string[] } {
  const columns = layout.columns;
  if (columns.length === 0) {
    return { residentColumnIds: [], parkedLeft: [], parkedRight: [] };
  }
  const focusedLoc = layout.focusedPaneId ? findPane(layout, layout.focusedPaneId) : null;
  const focusIndex = focusedLoc ? focusedLoc.columnIndex : 0;

  const minWidths = columns.map((column) => columnMinWidth(column, env));
  const cumulativeMinWidths = [0];
  for (const minWidth of minWidths) {
    cumulativeMinWidths.push((cumulativeMinWidths.at(-1) ?? 0) + minWidth);
  }
  const requiredWidth = (candidateStart: number, candidateEnd: number): number => {
    let width =
      (cumulativeMinWidths[candidateEnd + 1] ?? 0) - (cumulativeMinWidths[candidateStart] ?? 0);
    width += Math.max(0, candidateEnd - candidateStart) * COLUMN_DIVIDER_WIDTH;
    return width;
  };

  // Choose the largest contiguous run containing the focused column. On an
  // equal-size tie, keep more columns to its left: a newly created child is
  // inserted immediately to its parent's right, so this retains the semantic
  // parent/child pair without storing a second presentation anchor.
  let bestStart = focusIndex;
  let bestEnd = focusIndex;
  for (let candidateStart = 0; candidateStart <= focusIndex; candidateStart += 1) {
    for (let candidateEnd = focusIndex; candidateEnd < columns.length; candidateEnd += 1) {
      if (requiredWidth(candidateStart, candidateEnd) > env.viewportWidth) continue;
      const candidateCount = candidateEnd - candidateStart + 1;
      const bestCount = bestEnd - bestStart + 1;
      const candidateRightSpan = candidateEnd - focusIndex;
      const bestRightSpan = bestEnd - focusIndex;
      if (
        candidateCount > bestCount ||
        (candidateCount === bestCount && candidateRightSpan < bestRightSpan)
      ) {
        bestStart = candidateStart;
        bestEnd = candidateEnd;
      }
    }
  }
  return {
    residentColumnIds: columns.slice(bestStart, bestEnd + 1).map((c) => c.id),
    parkedLeft: columns.slice(0, bestStart).map((c) => c.id),
    parkedRight: columns.slice(bestEnd + 1).map((c) => c.id),
  };
}

// ---------------------------------------------------------------------------
// Persistence validation (§7 / §3.3) — persisted blobs are untrusted input.

export function validateRestoredLayout(
  persisted: unknown,
  existingPanelIds: Set<string>
): PanelLayout | null {
  if (typeof persisted !== "object" || persisted === null) return null;
  const blob = persisted as Partial<PersistedLayout>;
  if (blob.version !== 1) return null;
  const layout = blob.layout;
  if (typeof layout !== "object" || layout === null) return null;
  const rawColumns = (layout as PanelLayout).columns;
  if (!Array.isArray(rawColumns)) return null;
  const rawFocus = (layout as PanelLayout).focusedPaneId;
  if (rawFocus !== null && typeof rawFocus !== "string") return null;

  const seenPanelIds = new Set<string>();
  const seenPaneIds = new Set<string>();
  const seenColumnIds = new Set<string>();
  const columns: LayoutColumn[] = [];
  for (const rawColumn of rawColumns) {
    if (typeof rawColumn !== "object" || rawColumn === null) return null;
    const { id, widthFr, panes } = rawColumn as LayoutColumn;
    if (typeof id !== "string" || id.length === 0 || seenColumnIds.has(id)) return null;
    if (!Number.isFinite(widthFr) || widthFr <= 0) return null;
    if (!Array.isArray(panes)) return null;
    seenColumnIds.add(id);
    const keptPanes: LayoutPane[] = [];
    for (const rawPane of panes) {
      if (typeof rawPane !== "object" || rawPane === null) return null;
      const pane = rawPane as LayoutPane;
      if (typeof pane.id !== "string" || pane.id.length === 0 || seenPaneIds.has(pane.id))
        return null;
      if (typeof pane.panelId !== "string" || pane.panelId.length === 0) return null;
      if (!Number.isFinite(pane.heightFr) || pane.heightFr <= 0) return null;
      if (
        pane.minWidthOverride !== undefined &&
        (!Number.isFinite(pane.minWidthOverride) || pane.minWidthOverride <= 0)
      ) {
        return null;
      }
      seenPaneIds.add(pane.id);
      // Prune panes whose panel no longer exists, and duplicate panelIds (D3).
      if (!existingPanelIds.has(pane.panelId) || seenPanelIds.has(pane.panelId)) continue;
      seenPanelIds.add(pane.panelId);
      keptPanes.push({
        id: pane.id,
        heightFr: pane.heightFr,
        panelId: pane.panelId,
        ...(pane.minWidthOverride !== undefined ? { minWidthOverride: pane.minWidthOverride } : {}),
      });
    }
    if (keptPanes.length > 0) {
      columns.push({ id, widthFr, panes: keptPanes });
    }
  }
  if (columns.length === 0) return null;
  return normalizeLayout({ columns, focusedPaneId: rawFocus });
}

// ---------------------------------------------------------------------------
// Action application

export function applyLayoutAction(
  layout: PanelLayout,
  action: LayoutAction,
  env: LayoutEnv
): PanelLayout {
  switch (action.type) {
    case "focus-pane":
      return applyFocusPane(layout, action.paneId);
    case "show-panel":
      return applyShowPanel(cloneLayout(layout), action.panelId, action.origin, env);
    case "open-child":
      return applyHintedPlacement(
        cloneLayout(layout),
        action.panelId,
        action.parentId,
        action.hint,
        env
      );
    case "present-panel":
      return applyHintedPlacement(
        cloneLayout(layout),
        action.panelId,
        action.anchorPanelId,
        action.hint,
        env
      );
    case "open-beside":
      return applyOpenBeside(cloneLayout(layout), action.panelId, action.anchorPaneId, env);
    case "place-panel":
      return applyPlacePanel(cloneLayout(layout), action.panelId, action.target, env);
    case "move-pane-to-new-column":
      return applyMovePaneToNewColumn(layout, action.paneId);
    case "split-below":
      return applySplitBelow(cloneLayout(layout), action.panelId, action.anchorPaneId, env);
    case "close-pane":
      return applyClosePane(cloneLayout(layout), action.paneId, env);
    case "tree-reconcile":
      return applyTreeReconcile(cloneLayout(layout), action.removed, env);
    case "resize-columns":
      return applyResizeColumns(cloneLayout(layout), action.columnFrs);
    case "resize-panes":
      return applyResizePanes(cloneLayout(layout), action.columnId, action.paneFrs);
  }
}

function applyFocusPane(layout: PanelLayout, paneId: string): PanelLayout {
  if (findPane(layout, paneId) === null) return layout;
  if (layout.focusedPaneId === paneId) return layout;
  const next = cloneLayout(layout);
  next.focusedPaneId = paneId;
  return next;
}

/**
 * Rule 1: show-panel — focus if visible. Direct tree/breadcrumb navigation
 * replaces the focused slot; programmatic navigation may use the nearest
 * visible relative when no slot was explicitly chosen.
 */
function applyShowPanel(
  next: PanelLayout,
  panelId: string,
  origin: ShowPanelOrigin,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id; // 1a (D3)
    return next;
  }
  const firstPane = next.columns[0]?.panes[0];
  if (firstPane === undefined) {
    next.columns = [newColumn(panelId)];
    return normalizeLayout(next);
  }
  // User navigation is how a slot is retargeted. Do not let tree proximity
  // override the pane the user deliberately focused.
  const targetPaneId =
    origin === "tree-click" || origin === "navigation-click"
      ? next.focusedPaneId
      : (env.nearestVisibleRelative(panelId, next) ?? next.focusedPaneId);
  const targetPane =
    (targetPaneId !== null ? findPane(next, targetPaneId)?.pane : undefined) ?? firstPane;
  // 1c: replace in place; the pane id (position) survives.
  setPanePanel(targetPane, panelId);
  next.focusedPaneId = targetPane.id;
  return next;
}

export function canSplitColumnVertically(
  column: LayoutColumn,
  viewportHeight: number,
  paneChromeHeight: number
): boolean {
  return (column.panes.length + 1) * (MIN_PANE_HEIGHT + paneChromeHeight) <= viewportHeight;
}

function verticalFits(column: LayoutColumn, env: LayoutEnv): boolean {
  return canSplitColumnVertically(column, env.viewportHeight, env.paneChromeHeight);
}

function sideFitsComfortably(
  anchor: PaneLocation,
  panelId: string,
  hint: PanelPlacementHint | undefined,
  env: LayoutEnv
): boolean {
  const anchorWidth = Math.max(columnMinWidth(anchor.column, env), PREFERRED_COLUMN_WIDTH);
  const panelWidth = Math.max(
    env.minWidthOf(panelId),
    hint?.minWidth ?? 0,
    hint?.preferredWidth ?? PREFERRED_COLUMN_WIDTH
  );
  return anchorWidth + panelWidth + COLUMN_DIVIDER_WIDTH <= env.viewportWidth;
}

function insertColumnAfter(
  next: PanelLayout,
  columnIndex: number,
  panelId: string,
  hint?: PanelPlacementHint
): PanelLayout {
  const preferred = hint?.preferredWidth ?? PREFERRED_COLUMN_WIDTH;
  const pane = newPane(panelId, 1, hint?.minWidth);
  const column: LayoutColumn = {
    id: mintColumnId(),
    widthFr: preferred / PREFERRED_COLUMN_WIDTH,
    panes: [pane],
  };
  next.columns.splice(columnIndex + 1, 0, column);
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

function insertPaneBelow(
  next: PanelLayout,
  location: PaneLocation,
  panelId: string,
  hint?: PanelPlacementHint
): PanelLayout {
  const pane = newPane(panelId, 1, hint?.minWidth);
  location.column.panes.splice(location.paneIndex + 1, 0, pane);
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

/** Rule 2: hint-driven placement relative to a semantic parent or presentation anchor. */
function applyHintedPlacement(
  next: PanelLayout,
  panelId: string,
  anchorPanelId: string | undefined,
  hint: PanelPlacementHint | undefined,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    if (hint !== undefined) setPaneMinWidth(existing.pane, hint.minWidth);
    next.focusedPaneId = existing.pane.id; // D3 / rule 9
    return next;
  }
  const focused = next.focusedPaneId ? findPane(next, next.focusedPaneId) : null;
  const semanticAnchor = anchorPanelId ? paneForPanel(next, anchorPanelId) : focused;
  const anchor = semanticAnchor ?? focused;
  const disposition = hint?.disposition ?? "side";

  // 2b: replace is semantic: use the requested anchor, or ordinary show rules
  // when that panel is not visible.
  if (disposition === "replace") {
    if (!semanticAnchor) return applyShowPanel(next, panelId, "navigate-event", env);
    setPanePanel(semanticAnchor.pane, panelId, hint);
    next.focusedPaneId = semanticAnchor.pane.id;
    return next;
  }

  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);

  if (disposition === "side-if-room") {
    return sideFitsComfortably(anchor, panelId, hint, env)
      ? insertColumnAfter(next, anchor.columnIndex, panelId, hint)
      : isolatePanel(next, panelId);
  }

  // Visual placements fall back to the focused pane when their semantic parent
  // is hidden, preserving an explicit beside/below request from a tree menu.
  // 2c: split-below — only if the column has vertical room; else fall through.
  if (disposition === "split-below" && verticalFits(anchor.column, env)) {
    return insertPaneBelow(next, anchor, panelId, hint);
  }

  // 2d: side (default, and split-below fallthrough) always creates the
  // requested logical column. Viewport residency independently decides which
  // contiguous columns can be shown and parks the rest.
  return insertColumnAfter(next, anchor.columnIndex, panelId, hint);
}

/** Rule 3: explicit open-beside — always honored (may exceed the fit limit). */
function applyOpenBeside(
  next: PanelLayout,
  panelId: string,
  anchorPaneId: string,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id;
    return next;
  }
  const anchor = findPane(next, anchorPaneId);
  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);
  return insertColumnAfter(next, anchor.columnIndex, panelId);
}

/**
 * Rule 3b: drag placement. One transition for every drop the pointer can
 * express — detach (when the panel is already on screen), then insert at the
 * dropped coordinate.
 *
 * A moved pane keeps its identity: the same `LayoutPane` object is re-inserted,
 * so its pane id — and with it the native slot the host has already bound —
 * survives the move, and the panel is re-bounded rather than torn down and
 * reloaded somewhere else.
 */
function applyPlacePanel(
  next: PanelLayout,
  panelId: string,
  target: LayoutDropTarget,
  env: LayoutEnv
): PanelLayout {
  const source = paneForPanel(next, panelId);

  if (target.kind === "pane-center") {
    const destination = findPane(next, target.paneId);
    if (!destination) return applyShowPanel(next, panelId, "navigate-event", env);
    if (source && source.pane.id === destination.pane.id) {
      return applyFocusPane(next, destination.pane.id);
    }
    if (source) {
      // Both panels stay on screen: the two panes exchange occupants. Nothing
      // is evicted by a gesture the user reads as "put this here".
      const displacedPanelId = destination.pane.panelId;
      const displacedMinWidth = destination.pane.minWidthOverride;
      setPanePanel(destination.pane, panelId);
      setPaneMinWidth(destination.pane, source.pane.minWidthOverride);
      setPanePanel(source.pane, displacedPanelId);
      setPaneMinWidth(source.pane, displacedMinWidth);
    } else {
      // From the tree: the pane is a slot, and this is the same replacement a
      // tree click performs — the displaced panel stays in the tree.
      setPanePanel(destination.pane, panelId);
    }
    next.focusedPaneId = destination.pane.id;
    return normalizeLayout(next);
  }

  if (target.kind === "pane-edge") {
    const destination = findPane(next, target.paneId);
    if (!destination) return applyShowPanel(next, panelId, "navigate-event", env);
    if (source && isPlacementNoop(next, source, target, destination, destination.column)) {
      return applyFocusPane(next, source.pane.id);
    }
    // Held before the detach: the object survives index renumbering.
    const destinationColumn = destination.column;
    const destinationPane = destination.pane;
    const pane = detachOrMintPane(next, source, panelId);
    if (target.edge === "top" || target.edge === "bottom") {
      const paneIndex = destinationColumn.panes.indexOf(destinationPane);
      destinationColumn.panes.splice(paneIndex + (target.edge === "bottom" ? 1 : 0), 0, pane);
      next.focusedPaneId = pane.id;
      return normalizeLayout(next);
    }
    const columnIndex = next.columns.indexOf(destinationColumn);
    return insertColumnWithPane(
      next,
      columnIndex + (target.edge === "right" ? 1 : 0),
      pane,
      destinationColumn.widthFr
    );
  }

  const anchorColumn =
    target.afterColumnId === null
      ? null
      : (next.columns.find((column) => column.id === target.afterColumnId) ?? null);
  if (target.afterColumnId !== null && anchorColumn === null) {
    return applyShowPanel(next, panelId, "navigate-event", env);
  }
  if (source && isPlacementNoop(next, source, target, null, anchorColumn)) {
    return applyFocusPane(next, source.pane.id);
  }
  const anchorWidthFr = anchorColumn?.widthFr ?? 1;
  const pane = detachOrMintPane(next, source, panelId);
  const insertIndex = anchorColumn === null ? 0 : next.columns.indexOf(anchorColumn) + 1;
  return insertColumnWithPane(next, insertIndex, pane, anchorWidthFr);
}

/** Remove the dragged pane from its current position, or mint one for a panel that has none. */
function detachOrMintPane(
  next: PanelLayout,
  source: PaneLocation | null,
  panelId: string
): LayoutPane {
  if (!source) return newPane(panelId);
  source.column.panes.splice(source.paneIndex, 1);
  if (source.column.panes.length === 0) {
    const emptyIndex = next.columns.indexOf(source.column);
    if (emptyIndex >= 0) next.columns.splice(emptyIndex, 1);
  }
  source.pane.heightFr = 1;
  return source.pane;
}

function insertColumnWithPane(
  next: PanelLayout,
  index: number,
  pane: LayoutPane,
  widthFr: number
): PanelLayout {
  next.columns.splice(Math.max(0, Math.min(index, next.columns.length)), 0, {
    id: mintColumnId(),
    widthFr,
    panes: [pane],
  });
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

/** Drops that would put the pane back exactly where it already is. */
function isPlacementNoop(
  layout: PanelLayout,
  source: PaneLocation,
  target: LayoutDropTarget,
  destination: PaneLocation | null,
  anchorColumn: LayoutColumn | null
): boolean {
  if (target.kind === "pane-edge") {
    if (destination === null) return false;
    if (destination.pane.id === source.pane.id) return true;
    if (target.edge === "top" || target.edge === "bottom") {
      if (destination.column !== source.column) return false;
      const offset = target.edge === "bottom" ? 1 : -1;
      return destination.paneIndex + offset === source.paneIndex;
    }
    // A side split off a column this pane alone occupies lands it back where it
    // started.
    if (source.column.panes.length > 1) return false;
    const sourceIndex = layout.columns.indexOf(source.column);
    const anchorIndex = layout.columns.indexOf(destination.column);
    return target.edge === "right"
      ? anchorIndex + 1 === sourceIndex
      : anchorIndex - 1 === sourceIndex;
  }
  if (source.column.panes.length > 1) return false;
  const sourceIndex = layout.columns.indexOf(source.column);
  if (anchorColumn === null) return sourceIndex === 0;
  if (anchorColumn === source.column) return true;
  return layout.columns.indexOf(anchorColumn) + 1 === sourceIndex;
}

/**
 * A vertical split needs room the column may not have. Rule 3's documented
 * fallback (split-below degrades to a side column) applies to drags too, and it
 * has to happen before the preview is drawn, not after the drop — otherwise the
 * highlight promises a stacked pane and the engine produces a column.
 */
export function refineDropTarget(
  layout: PanelLayout,
  target: LayoutDropTarget,
  draggedPanelId: string,
  env: Pick<LayoutEnv, "viewportHeight" | "paneChromeHeight">
): LayoutDropTarget {
  if (target.kind !== "pane-edge") return target;
  if (target.edge !== "top" && target.edge !== "bottom") return target;
  const destination = findPane(layout, target.paneId);
  if (!destination) return target;
  const source = paneForPanel(layout, draggedPanelId);
  // Restacking inside its own column adds no pane, so it is always allowed.
  if (source && source.column === destination.column) return target;
  if (canSplitColumnVertically(destination.column, env.viewportHeight, env.paneChromeHeight)) {
    return target;
  }
  return { kind: "pane-edge", paneId: target.paneId, edge: "right" };
}

/** Move an existing pane as one state transition, preserving its position id. */
function applyMovePaneToNewColumn(layout: PanelLayout, paneId: string): PanelLayout {
  const location = findPane(layout, paneId);
  if (!location) return layout;
  if (location.column.panes.length === 1) {
    return applyFocusPane(layout, paneId);
  }
  const next = cloneLayout(layout);
  const nextLocation = findPane(next, paneId);
  if (!nextLocation) return layout;
  const [pane] = nextLocation.column.panes.splice(nextLocation.paneIndex, 1);
  if (!pane) return layout;
  pane.heightFr = 1;
  next.columns.splice(nextLocation.columnIndex + 1, 0, {
    id: mintColumnId(),
    widthFr: nextLocation.column.widthFr,
    panes: [pane],
  });
  next.focusedPaneId = pane.id;
  return normalizeLayout(next);
}

/** Rule 3: explicit split-below — honored iff the vertical fit test passes; else open-beside. */
function applySplitBelow(
  next: PanelLayout,
  panelId: string,
  anchorPaneId: string,
  env: LayoutEnv
): PanelLayout {
  const existing = paneForPanel(next, panelId);
  if (existing) {
    next.focusedPaneId = existing.pane.id;
    return next;
  }
  const anchor = findPane(next, anchorPaneId);
  if (!anchor) return applyShowPanel(next, panelId, "navigate-event", env);
  if (!verticalFits(anchor.column, env)) {
    return applyOpenBeside(next, panelId, anchorPaneId, env);
  }
  return insertPaneBelow(next, anchor, panelId);
}

/** Rule 4: close-pane — layout-only removal with fr redistribution and last-pane reseed. */
function applyClosePane(next: PanelLayout, paneId: string, env: LayoutEnv): PanelLayout {
  const location = findPane(next, paneId);
  if (!location) return next;
  const wasFocused = next.focusedPaneId === paneId;
  location.column.panes.splice(location.paneIndex, 1);

  if (location.column.panes.length === 0) {
    next.columns.splice(location.columnIndex, 1);
  }

  if (next.columns.length === 0) {
    // Closing the last pane reseeds from the first root panel (§4.4).
    const seed = env.firstRootPanelId();
    if (seed === null) {
      return { columns: [], focusedPaneId: null };
    }
    return normalizeLayout({ columns: [newColumn(seed)], focusedPaneId: null });
  }

  if (wasFocused) {
    // Same column first: nearest surviving pane by index; then the left
    // neighbor column (or the new first column when none).
    const neighborIndex = Math.max(0, Math.min(location.columnIndex - 1, next.columns.length - 1));
    const focusPane =
      location.column.panes[Math.min(location.paneIndex, location.column.panes.length - 1)] ??
      next.columns[neighborIndex]?.panes[0];
    next.focusedPaneId = focusPane?.id ?? null;
  }
  return normalizeLayout(next);
}

/** Rule 5 / rule 8: one atomic pass for every panel removed by a tree update. */
function applyTreeReconcile(
  next: PanelLayout,
  removed: Array<{ panelId: string; fallbackCandidates: string[] }>,
  env: LayoutEnv
): PanelLayout {
  const removedIds = new Set(removed.map((entry) => entry.panelId));
  const panesToClose: string[] = [];
  for (const entry of removed) {
    const location = paneForPanel(next, entry.panelId);
    if (!location) continue;
    const candidate = entry.fallbackCandidates.find(
      (candidateId) => !removedIds.has(candidateId) && paneForPanel(next, candidateId) === null
    );
    if (candidate !== undefined) {
      setPanePanel(location.pane, candidate);
    } else {
      panesToClose.push(location.pane.id);
    }
  }
  let result: PanelLayout = next;
  for (const paneId of panesToClose) {
    result = applyClosePane(cloneLayout(result), paneId, env);
  }
  return normalizeLayout(result);
}

/** Rule 6: dividers write fractions; clamping happens at render time. */
function applyResizeColumns(next: PanelLayout, columnFrs: number[]): PanelLayout {
  if (columnFrs.length !== next.columns.length) return next;
  next.columns.forEach((column, i) => {
    column.widthFr = sanitizeFr(columnFrs[i] ?? 1);
  });
  renormalizeFrs(
    next.columns,
    (c) => c.widthFr,
    (c, fr) => (c.widthFr = fr)
  );
  return next;
}

function applyResizePanes(next: PanelLayout, columnId: string, paneFrs: number[]): PanelLayout {
  const column = next.columns.find((c) => c.id === columnId);
  if (!column || paneFrs.length !== column.panes.length) return next;
  column.panes.forEach((pane, i) => {
    pane.heightFr = sanitizeFr(paneFrs[i] ?? 1);
  });
  renormalizeFrs(
    column.panes,
    (p) => p.heightFr,
    (p, fr) => (p.heightFr = fr)
  );
  return next;
}
