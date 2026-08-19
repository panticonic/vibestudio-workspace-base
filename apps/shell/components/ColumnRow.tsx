import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex } from "@radix-ui/themes";

import {
  MIN_COLUMN_WIDTH,
  type LayoutColumn,
  type LayoutDropTarget,
  type PanelLayout,
} from "../layout/types";
import { usePanelTree } from "../shell/hooks/PanelTreeContext";
import { useLayoutDrag } from "../shell/hooks/LayoutDragContext";
import { LayoutBlueprint } from "./LayoutBlueprint";
import { PaneColumn } from "./PaneColumn";
import { ResizableDivider } from "./ResizableDivider";
import { minWidthOfPanel } from "../layout/treeEnv";

interface ColumnRowProps {
  layout: PanelLayout;
  residentColumnIds: string[];
  layoutEpoch: number;
  unresponsivePanels: Set<string>;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onResizeColumns: (columnFrs: number[]) => void;
  onResizePanes: (columnId: string, paneFrs: number[]) => void;
  /** Called when a residency transition settles, to force a surface resync (§5.4). */
  onTransitionSettled: () => void;
  /** Apply a drag placement; the engine owns what the coordinate means. */
  onPlacePanel: (panelId: string, target: LayoutDropTarget) => void;
  /** Engine's chance to downgrade a target the layout cannot honor. */
  onRefineDropTarget: (target: LayoutDropTarget, panelId: string) => LayoutDropTarget;
  /** Keyboard placement from a pane's grip. */
  onMovePane: (paneId: string, direction: "left" | "right" | "up" | "down") => void;
}

const COLUMN_TRANSITION_MS = 150;

/**
 * Flex row of the viewport-resident columns interleaved with dividers. Columns
 * that do not fit stay available through the panel tree without consuming a
 * sliver of viewport space. During a residency/column-count transition,
 * surfaces are briefly non-resident (slots cleared) so live native views never
 * translate (§6); the settle callback bumps the layout epoch as the commit
 * point.
 */
export function ColumnRow({
  layout,
  residentColumnIds,
  layoutEpoch,
  unresponsivePanels,
  onDismissUnresponsive,
  onFocusPane,
  onClosePane,
  onResizeColumns,
  onResizePanes,
  onTransitionSettled,
  onPlacePanel,
  onRefineDropTarget,
  onMovePane,
}: ColumnRowProps) {
  const { panelMap, parentMap } = usePanelTree();
  const {
    source: dragSource,
    target: dropTarget,
    geometry: dragGeometry,
    registerPlacementHost,
  } = useLayoutDrag();
  const residentSet = useMemo(() => new Set(residentColumnIds), [residentColumnIds]);
  const residentColumns = layout.columns.filter((column) => residentSet.has(column.id));
  const layoutPaneCount = layout.columns.reduce((total, column) => total + column.panes.length, 0);
  // With a single pane on screen there is nothing for a focus rail to
  // distinguish it from, so it would be decoration on every panel.
  const showPaneFocus =
    residentColumns.reduce((total, column) => total + column.panes.length, 0) > 1;
  const paneTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const column of layout.columns) {
      for (const pane of column.panes) {
        titles.set(pane.panelId, panelMap.get(pane.panelId)?.title ?? "Panel");
      }
    }
    return titles;
  }, [layout, panelMap]);
  const columnMinWidths = residentColumns.map((column) =>
    column.panes.reduce(
      (minimum, pane) =>
        Math.max(
          minimum,
          minWidthOfPanel({ panelMap, parentMap }, pane.panelId),
          pane.minWidthOverride ?? 0
        ),
      MIN_COLUMN_WIDTH
    )
  );

  // Residency transitions (park/un-park, column enter/exit) hide surfaces for
  // one animation beat; pure resizes never do.
  const residencyKey = residentColumnIds.join("|");
  const lastResidencyKeyRef = useRef(residencyKey);
  const [transitioning, setTransitioning] = useState(false);
  useEffect(() => {
    if (lastResidencyKeyRef.current === residencyKey) return;
    lastResidencyKeyRef.current = residencyKey;
    setTransitioning(true);
    const timer = window.setTimeout(() => {
      setTransitioning(false);
      onTransitionSettled();
    }, COLUMN_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [residencyKey, onTransitionSettled]);

  const [liveFrs, setLiveFrs] = useState<number[] | null>(null);
  const liveFrsRef = useRef<number[] | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // The column row is what a placement drag is measured and drawn against.
  const placeRef = useRef(onPlacePanel);
  placeRef.current = onPlacePanel;
  const refineRef = useRef(onRefineDropTarget);
  refineRef.current = onRefineDropTarget;
  const attachViewport = useCallback(
    (element: HTMLDivElement | null) => {
      viewportRef.current = element;
      registerPlacementHost(
        element
          ? {
              root: element,
              refine: (target, panelId) => refineRef.current(target, panelId),
              commit: (panelId, target) => placeRef.current(panelId, target),
            }
          : null
      );
    },
    [registerPlacementHost]
  );
  const dragColumnWidthsRef = useRef<number[] | null>(null);

  const frs = liveFrs ?? residentColumns.map((column) => column.widthFr);
  const totalFr = frs.reduce((sum, fr) => sum + fr, 0);

  const prepareDrag = () => {
    const elements = rowRef.current?.querySelectorAll<HTMLElement>("[data-column-id]");
    const widths = residentColumns.map(
      (_column, columnIndex) => elements?.[columnIndex]?.getBoundingClientRect().width ?? 0
    );
    dragColumnWidthsRef.current = widths.every((width) => width > 0) ? widths : null;
  };

  const dragBetween = (index: number, deltaPx: number) => {
    const widths = dragColumnWidthsRef.current;
    if (!widths) return;
    const columnsWidth = widths.reduce((sum, width) => sum + width, 0);
    const current = liveFrsRef.current ?? residentColumns.map((column) => column.widthFr);
    const total = current.reduce((sum, fr) => sum + fr, 0);
    const beforeWidth = widths[index] ?? 0;
    const afterWidth = widths[index + 1] ?? 0;
    if (beforeWidth <= 0 || afterWidth <= 0) return;
    const beforeMin = columnMinWidths[index] ?? MIN_COLUMN_WIDTH;
    const afterMin = columnMinWidths[index + 1] ?? MIN_COLUMN_WIDTH;
    const appliedPx = Math.max(
      Math.min(deltaPx, afterWidth - afterMin),
      -(beforeWidth - beforeMin)
    );
    const deltaFr = (appliedPx / columnsWidth) * total;
    const next = [...current];
    const before = next[index];
    const after = next[index + 1];
    if (before === undefined || after === undefined) return;
    widths[index] = beforeWidth + appliedPx;
    widths[index + 1] = afterWidth - appliedPx;
    next[index] = before + deltaFr;
    next[index + 1] = after - deltaFr;
    liveFrsRef.current = next;
    setLiveFrs(next);
  };

  const commit = () => {
    const live = liveFrsRef.current;
    liveFrsRef.current = null;
    dragColumnWidthsRef.current = null;
    setLiveFrs(null);
    if (!live) return;
    // Merge live resident frs back into the full column list (parked columns
    // keep their stored fractions).
    let cursor = 0;
    onResizeColumns(
      layout.columns.map((column) =>
        residentSet.has(column.id) ? (live[cursor++] ?? column.widthFr) : column.widthFr
      )
    );
  };

  return (
    <Flex
      ref={attachViewport}
      direction="column"
      style={{ flex: "1 1 0", minHeight: 0, minWidth: 0, position: "relative" }}
    >
      {dragSource && dragGeometry && (
        <LayoutBlueprint
          geometry={dragGeometry}
          target={dropTarget}
          sourcePaneId={dragSource.fromPaneId}
          sourcePanelId={dragSource.panelId}
          sourceTitle={dragSource.title}
        />
      )}
      <Flex ref={rowRef} gap="0" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
        {residentColumns.map((column, index) => (
          <Fragment key={column.id}>
            {index > 0 && (
              <ResizableDivider
                orientation="vertical"
                label={`Resize columns ${index} and ${index + 1}`}
                valueNow={(frs.slice(0, index).reduce((sum, fr) => sum + fr, 0) / totalFr) * 100}
                onDragStart={prepareDrag}
                onDrag={(deltaPx) => dragBetween(index - 1, deltaPx)}
                onDragEnd={commit}
                onKeyboardStep={(deltaPx) => {
                  prepareDrag();
                  dragBetween(index - 1, deltaPx);
                  commit();
                }}
                onReset={() => onResizeColumns(layout.columns.map(() => 1))}
              />
            )}
            <PaneColumn
              column={{ ...column, widthFr: frs[index] } as LayoutColumn}
              minWidth={columnMinWidths[index] ?? MIN_COLUMN_WIDTH}
              focusedPaneId={layout.focusedPaneId}
              showPaneFocus={showPaneFocus}
              paneTitles={paneTitles}
              resident={!transitioning}
              layoutEpoch={layoutEpoch}
              unresponsivePanels={unresponsivePanels}
              onDismissUnresponsive={onDismissUnresponsive}
              onFocusPane={onFocusPane}
              onClosePane={layoutPaneCount > 1 ? onClosePane : undefined}
              onMovePane={onMovePane}
              onResizePanes={onResizePanes}
            />
          </Fragment>
        ))}
      </Flex>
    </Flex>
  );
}
