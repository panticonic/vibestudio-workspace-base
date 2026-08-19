import { useState } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import { Box, Flex, IconButton, Tooltip } from "@radix-ui/themes";
import { useTouchDevice } from "@workspace/react/responsive";

import { useLayoutDrag } from "../shell/hooks/LayoutDragContext";
import { PaneContent } from "./PaneContent";
import { PANE_RAIL_EXPANDED_HEIGHT, PANE_RAIL_REST_HEIGHT, type LayoutPane } from "../layout/types";

/** The grip is a move handle once focused, so plain arrows place the pane. */
const ARROW_DIRECTIONS: Record<string, "left" | "right" | "up" | "down" | undefined> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

interface PaneViewProps {
  pane: LayoutPane;
  focused: boolean;
  /**
   * Whether focus is worth drawing at all — false when this is the only pane on
   * screen. Separate from `focused`, which stays true regardless because it also
   * drives native slot binding.
   */
  showPaneFocus: boolean;
  /** The panel's title, shown on the chip while this pane is being dragged. */
  title: string;
  resident: boolean;
  layoutEpoch: number;
  unresponsive: boolean;
  onDismissUnresponsive: (panelId: string) => void;
  onFocusPane: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
  /** Arrow-key placement while the grip has keyboard focus. */
  onMovePane: (paneId: string, direction: "left" | "right" | "up" | "down") => void;
}

/**
 * One pane: a native-view content state machine under a rail that is a seam at
 * rest and a header while the pointer is on it.
 *
 * Native panel views composite above ordinary shell DOM, so pane-local controls
 * cannot float over the panel and the rail cannot collapse to nothing: whatever
 * the shell reserves is the only surface a pointer can reach. A true notch —
 * chrome that costs no layout at rest — is therefore impossible, so the rail
 * commits in the other direction instead of splitting the difference. At rest
 * it is a 4px seam that carries only the focus mark; on hover, keyboard focus,
 * or touch it becomes a real pane header, and the panel below shifts down by
 * that difference exactly once per hover (one native geometry update, the same
 * path a divider drag uses every frame).
 *
 * The header is deliberately styled as a header — full-bleed, seated on the
 * pane, with its own bottom edge — rather than a capsule hovering in dead space.
 */
export function PaneView({
  pane,
  focused,
  showPaneFocus,
  title,
  resident,
  layoutEpoch,
  unresponsive,
  onDismissUnresponsive,
  onFocusPane,
  onClosePane,
  onMovePane,
}: PaneViewProps) {
  const isTouch = useTouchDevice();
  const { beginPaneDrag, source: dragSource } = useLayoutDrag();
  const [railHovered, setRailHovered] = useState(false);
  const [railFocusWithin, setRailFocusWithin] = useState(false);
  const markFocused = focused && showPaneFocus;
  // With a single pane there is nothing to focus away from and nothing to
  // close, so the rail stays a seam and never steals a pixel from the panel.
  const railInteractive = Boolean(onClosePane);
  const dragging = dragSource?.fromPaneId === pane.id;
  // The header is the pane's handle: while a drag is live it must stay up, or
  // the grip would vanish from under the pointer that grabbed it.
  const expanded = railInteractive && (railHovered || railFocusWithin || isTouch || dragging);

  return (
    <Flex
      direction="column"
      data-pane-id={pane.id}
      data-pane-panel-id={pane.panelId}
      style={{
        flex: `${pane.heightFr} 1 0`,
        minHeight: 0,
        minWidth: 0,
        // Square, deliberately. A radius here only ever reached the top two
        // corners: the top strip is shell DOM and gets clipped, while the rest
        // of the pane is a natively composited view that `overflow: hidden`
        // cannot touch — so the frame read rounded above and square below.
        // Rounding both would mean rounding the native view host-side; flush is
        // the house style for structural panes anyway (see overrides.css, where
        // the sidebar card sets border-radius: 0 for the same reason).
        borderRadius: 0,
        overflow: "hidden",
      }}
    >
      <Box
        data-pane-rail={pane.id}
        data-pane-rail-expanded={expanded ? "true" : "false"}
        onPointerEnter={() => setRailHovered(true)}
        onPointerLeave={() => setRailHovered(false)}
        onFocusCapture={() => setRailFocusWithin(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setRailFocusWithin(false);
          }
        }}
        style={{
          // Snapped, not animated: each intermediate height would be another
          // native view resize, and the panel underneath would reflow through
          // every frame of the transition for no legibility gained.
          height: expanded ? PANE_RAIL_EXPANDED_HEIGHT : PANE_RAIL_REST_HEIGHT,
          flexShrink: 0,
          position: "relative",
          // The seam is the focus mark. Unfocused panes leave it empty so the
          // rail reads as the edge of the pane rather than a strip of chrome.
          // While the header is up it owns the whole rail, so the mark steps
          // aside — the header is opaque and would otherwise tint accent.
          backgroundColor: markFocused && !expanded ? "var(--accent-9)" : "transparent",
          overflow: "hidden",
        }}
      >
        <Flex
          align="center"
          style={{
            position: "absolute",
            inset: 0,
            height: PANE_RAIL_EXPANDED_HEIGHT,
            // Opaque, not an alpha wash: the rail underneath carries the
            // accent focus mark, and a translucent header would read as a
            // bright accent bar rather than chrome.
            backgroundColor: "var(--gray-2)",
            borderBottom: "1px solid var(--gray-a6)",
            opacity: expanded ? 1 : 0,
            pointerEvents: expanded ? "auto" : "none",
            transition: "opacity 90ms ease-out",
          }}
        >
          <button
            type="button"
            aria-label={railInteractive ? "Focus or move pane" : "Focus pane"}
            title={
              railInteractive
                ? "Drag to move this pane — or focus it and use the arrow keys"
                : "Focus pane"
            }
            aria-keyshortcuts={
              railInteractive ? "ArrowLeft ArrowRight ArrowUp ArrowDown" : undefined
            }
            tabIndex={railInteractive ? 0 : -1}
            data-pane-drag-handle={pane.id}
            onPointerDown={(event) => {
              if (!railInteractive) return;
              beginPaneDrag(event, {
                panelId: pane.panelId,
                title,
                fromPaneId: pane.id,
              });
            }}
            onClick={() => onFocusPane(pane.id)}
            onKeyDown={(event) => {
              if (!railInteractive) return;
              const direction = ARROW_DIRECTIONS[event.key];
              if (!direction || event.ctrlKey || event.metaKey || event.altKey) return;
              event.preventDefault();
              onMovePane(pane.id, direction);
            }}
            style={{
              flex: "1 1 0",
              height: "100%",
              minWidth: 0,
              padding: 0,
              border: 0,
              background: "transparent",
              cursor: railInteractive ? "grab" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                height: 2,
                width: 32,
                borderRadius: 999,
                backgroundColor: markFocused ? "var(--accent-9)" : "var(--gray-a8)",
              }}
            />
          </button>
          {onClosePane && (
            <Tooltip content="Close pane — panel stays in the tree">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                radius="small"
                aria-label="Close pane"
                data-pane-close={pane.id}
                tabIndex={expanded ? 0 : -1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClosePane(pane.id);
                }}
                style={{
                  width: PANE_RAIL_EXPANDED_HEIGHT - 5,
                  height: PANE_RAIL_EXPANDED_HEIGHT - 5,
                  flexShrink: 0,
                  margin: "0 2px",
                  padding: 0,
                }}
              >
                <Cross2Icon width={12} height={12} />
              </IconButton>
            </Tooltip>
          )}
        </Flex>
      </Box>
      <Flex direction="column" style={{ flex: "1 1 0", minHeight: 0, minWidth: 0 }}>
        <PaneContent
          paneId={pane.id}
          panelId={pane.panelId}
          resident={resident}
          focused={focused}
          layoutEpoch={layoutEpoch}
          unresponsive={unresponsive}
          onDismissUnresponsive={onDismissUnresponsive}
          onFocusPane={onFocusPane}
        />
      </Flex>
    </Flex>
  );
}
