/**
 * Placement-drag hit-testing: a pointer position plus the measured layout
 * geometry resolves to exactly one `LayoutDropTarget`.
 *
 * The drop vocabulary is derived from the layout itself — columns of panes — so
 * every target is a rectangle the user is already looking at. Hit-testing those
 * rectangles directly means the boundary between two targets is the boundary
 * the user sees, and it means the preview and the outcome are the same function
 * of the pointer. (The previous design registered three overlapping droppables
 * — left half, right half, whole viewport — and let a nearest-centre collision
 * solver arbitrate between them and the tree rows, so the drop that fired near
 * a boundary was not predictable from anything on screen.)
 *
 * Pure apart from `measureLayoutGeometry`, which is the one DOM read.
 */

import type { LayoutDropTarget, PaneEdge } from "./types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface PaneGeometry {
  paneId: string;
  panelId: string;
  columnId: string;
  rect: Rect;
}

export interface ColumnGeometry {
  columnId: string;
  rect: Rect;
}

export interface LayoutGeometry {
  /** The column row's own box: outside it there is no layout drop. */
  viewport: Rect;
  /** Resident columns in visual order. */
  columns: ColumnGeometry[];
  /** Resident panes in visual order, column-major. */
  panes: PaneGeometry[];
}

/**
 * How much of a pane counts as its edge. Fractional so the split zones scale
 * with the pane, clamped in pixels so a tall narrow pane still has a usable
 * centre and a short wide one still has a grabbable edge.
 */
const EDGE_BAND_FRACTION = 0.25;
const MIN_EDGE_BAND_PX = 20;
const MAX_EDGE_BAND_PX = 140;

/** Width of the insertion bar drawn for a new-column drop. */
export const INSERTION_BAR_WIDTH = 5;

function edgeBand(size: number): number {
  const clamped = Math.min(Math.max(size * EDGE_BAND_FRACTION, MIN_EDGE_BAND_PX), MAX_EDGE_BAND_PX);
  // Never let the four bands swallow the centre.
  return Math.min(clamped, size * 0.4);
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function rightEdge(rect: Rect): number {
  return rect.x + rect.width;
}

function bottomEdge(rect: Rect): number {
  return rect.y + rect.height;
}

/** The column the point is horizontally inside, if any. */
function columnAt(geometry: LayoutGeometry, point: Point): ColumnGeometry | null {
  return (
    geometry.columns.find(
      (column) => point.x >= column.rect.x && point.x <= rightEdge(column.rect)
    ) ?? null
  );
}

/** Insert after the last column the point has fully passed horizontally. */
function newColumnAt(geometry: LayoutGeometry, point: Point): LayoutDropTarget {
  let afterColumnId: string | null = null;
  for (const column of geometry.columns) {
    if (point.x >= column.rect.x + column.rect.width / 2) afterColumnId = column.columnId;
  }
  return { kind: "new-column", afterColumnId };
}

/**
 * A point inside a column but not inside a pane is in a pane divider (or the
 * slack above/below the stack): that reads as "between these two panes".
 */
function resolveInsideColumn(
  geometry: LayoutGeometry,
  column: ColumnGeometry,
  point: Point
): LayoutDropTarget {
  const panes = geometry.panes.filter((pane) => pane.columnId === column.columnId);
  const first = panes[0];
  if (!first) return { kind: "new-column", afterColumnId: column.columnId };
  let above: PaneGeometry | null = null;
  for (const pane of panes) {
    if (bottomEdge(pane.rect) <= point.y) above = pane;
  }
  if (!above) return { kind: "pane-edge", paneId: first.paneId, edge: "top" };
  return { kind: "pane-edge", paneId: above.paneId, edge: "bottom" };
}

function resolveInsidePane(pane: PaneGeometry, point: Point): LayoutDropTarget {
  const { rect } = pane;
  const horizontalBand = edgeBand(rect.width);
  const verticalBand = edgeBand(rect.height);
  // Each distance is scored against its own band so the nearest *proportional*
  // edge wins; corners therefore resolve to whichever split is more deliberate.
  const scores: Array<{ edge: PaneEdge; score: number }> = [
    { edge: "left", score: (point.x - rect.x) / horizontalBand },
    { edge: "right", score: (rightEdge(rect) - point.x) / horizontalBand },
    { edge: "top", score: (point.y - rect.y) / verticalBand },
    { edge: "bottom", score: (bottomEdge(rect) - point.y) / verticalBand },
  ];
  let best = scores[0]!;
  for (const candidate of scores) {
    if (candidate.score < best.score) best = candidate;
  }
  if (best.score > 1) return { kind: "pane-center", paneId: pane.paneId };
  return { kind: "pane-edge", paneId: pane.paneId, edge: best.edge };
}

/** The one hit test. Returns null when the pointer is not over the layout. */
export function resolveDropTarget(point: Point, geometry: LayoutGeometry): LayoutDropTarget | null {
  if (!containsPoint(geometry.viewport, point)) return null;
  if (geometry.columns.length === 0) return { kind: "new-column", afterColumnId: null };
  const pane = geometry.panes.find((candidate) => containsPoint(candidate.rect, point));
  if (pane) return resolveInsidePane(pane, point);
  const column = columnAt(geometry, point);
  if (column) return resolveInsideColumn(geometry, column, point);
  return newColumnAt(geometry, point);
}

export type DropPreview =
  /** The area the panel will occupy. */
  | { kind: "region"; rect: Rect }
  /** A seam where a new column will be inserted. */
  | { kind: "insertion"; rect: Rect };

function leftHalf(rect: Rect): Rect {
  return { ...rect, width: rect.width / 2 };
}

function rightHalf(rect: Rect): Rect {
  return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 };
}

function topHalf(rect: Rect): Rect {
  return { ...rect, height: rect.height / 2 };
}

function bottomHalf(rect: Rect): Rect {
  return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
}

/**
 * The area the drop will fill, from the same target the drop will apply — so
 * the highlight cannot promise a placement the engine will not perform.
 */
export function dropPreview(
  target: LayoutDropTarget,
  geometry: LayoutGeometry
): DropPreview | null {
  if (target.kind === "new-column") {
    const after = target.afterColumnId
      ? geometry.columns.find((column) => column.columnId === target.afterColumnId)
      : null;
    const seamX = after ? rightEdge(after.rect) : geometry.viewport.x;
    return {
      kind: "insertion",
      rect: {
        x: Math.min(
          Math.max(seamX - INSERTION_BAR_WIDTH / 2, geometry.viewport.x),
          rightEdge(geometry.viewport) - INSERTION_BAR_WIDTH
        ),
        y: geometry.viewport.y,
        width: INSERTION_BAR_WIDTH,
        height: geometry.viewport.height,
      },
    };
  }
  const pane = geometry.panes.find((candidate) => candidate.paneId === target.paneId);
  if (!pane) return null;
  if (target.kind === "pane-center") return { kind: "region", rect: pane.rect };
  if (target.edge === "top") return { kind: "region", rect: topHalf(pane.rect) };
  if (target.edge === "bottom") return { kind: "region", rect: bottomHalf(pane.rect) };
  // A side split becomes a new column beside this pane's column, so the honest
  // preview is half of the column, not half of the pane.
  const column = geometry.columns.find((candidate) => candidate.columnId === pane.columnId);
  const rect = column?.rect ?? pane.rect;
  return { kind: "region", rect: target.edge === "left" ? leftHalf(rect) : rightHalf(rect) };
}

function toRect(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/**
 * Read the live layout geometry in client coordinates. Measured once when a
 * drag starts: the layout cannot change mid-drag, so re-measuring per pointer
 * move would only cost forced reflows.
 */
export function measureLayoutGeometry(root: HTMLElement): LayoutGeometry {
  const columns: ColumnGeometry[] = [];
  const panes: PaneGeometry[] = [];
  for (const columnElement of root.querySelectorAll<HTMLElement>("[data-column-id]")) {
    const columnId = columnElement.getAttribute("data-column-id");
    if (!columnId) continue;
    columns.push({ columnId, rect: toRect(columnElement) });
    for (const paneElement of columnElement.querySelectorAll<HTMLElement>("[data-pane-id]")) {
      const paneId = paneElement.getAttribute("data-pane-id");
      const panelId = paneElement.getAttribute("data-pane-panel-id");
      if (!paneId || !panelId) continue;
      panes.push({ paneId, panelId, columnId, rect: toRect(paneElement) });
    }
  }
  return { viewport: toRect(root), columns, panes };
}
