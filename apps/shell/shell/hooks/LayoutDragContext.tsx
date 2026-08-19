/**
 * LayoutDragContext — the one owner of "a panel is being dragged into a
 * position".
 *
 * Both drag sources (a tree row, a pane) and both consumers (the tree's own
 * insertion indicator, the layout's blueprint) talk to this context, so the
 * question "does this gesture end as a tree move or as a placement?" has a
 * single answer with a single rule: the pointer is either over the layout or it
 * is not. No collision solver arbitrates between a tree row and a viewport
 * half, and no `window` CustomEvent carries the result sideways into the stack.
 *
 * Blueprint mode. Panel views are native Electron views composited *above* all
 * shell DOM, so while a drag is live the shell cannot draw a preview over a
 * panel — and cannot even see the pointer over one. The shell therefore takes
 * the viewport for the duration of the gesture (`setShellOverlay`, which hides
 * panel views without unbinding them, so nothing reloads and restoring is a
 * repaint) and draws the layout as a blueprint instead. That is deliberate:
 * while you are moving panels around you are editing the layout, so the layout
 * is what you should see.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { DraggedPanelChip } from "../../components/DraggedPanelChip";
import {
  measureLayoutGeometry,
  resolveDropTarget,
  type LayoutGeometry,
  type Point,
} from "../../layout/dropGeometry";
import type { LayoutDropTarget } from "../../layout/types";
import { useShellOverlay } from "../useShellOverlay";

/** What is being dragged: a panel, and the pane it currently occupies if any. */
export interface PanelDragSource {
  panelId: string;
  title: string;
  /** Set when the drag started from a pane, which makes the drop a move. */
  fromPaneId: string | null;
}

/**
 * Registered by the component that renders the columns: the element to measure,
 * the engine's chance to downgrade an impossible target, and the commit.
 */
export interface PlacementHost {
  root: HTMLElement;
  refine: (target: LayoutDropTarget, panelId: string) => LayoutDropTarget;
  commit: (panelId: string, target: LayoutDropTarget) => void;
}

interface LayoutDragContextValue {
  source: PanelDragSource | null;
  /** Live, already-refined drop target; null when the pointer is off the layout. */
  target: LayoutDropTarget | null;
  /** Measured once per drag: the layout cannot move while a drag is in flight. */
  geometry: LayoutGeometry | null;
  beginDrag: (source: PanelDragSource) => void;
  /** Commit the live target if there is one. True when it placed the panel. */
  endDrag: () => boolean;
  cancelDrag: () => void;
  /** Start a drag from a pointerdown on a pane, past a movement threshold. */
  beginPaneDrag: (event: React.PointerEvent<HTMLElement>, source: PanelDragSource) => void;
  registerPlacementHost: (host: PlacementHost | null) => void;
}

const LayoutDragCtx = createContext<LayoutDragContextValue | null>(null);

export function useLayoutDrag(): LayoutDragContextValue {
  const context = useContext(LayoutDragCtx);
  if (!context) throw new Error("useLayoutDrag must be used within a LayoutDragProvider");
  return context;
}

/** Pointer travel before a press on a pane becomes a drag rather than a click. */
const PANE_DRAG_THRESHOLD_PX = 5;

export function LayoutDragProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<PanelDragSource | null>(null);
  const [target, setTarget] = useState<LayoutDropTarget | null>(null);
  const [geometry, setGeometry] = useState<LayoutGeometry | null>(null);

  const hostRef = useRef<PlacementHost | null>(null);
  const sourceRef = useRef<PanelDragSource | null>(null);
  const targetRef = useRef<LayoutDropTarget | null>(null);
  const geometryRef = useRef<LayoutGeometry | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<Point | null>(null);

  // The whole viewport is the shell's while a drag is live.
  useShellOverlay(source !== null);

  const registerPlacementHost = useCallback((host: PlacementHost | null) => {
    hostRef.current = host;
  }, []);

  const applyPointer = useCallback((point: Point) => {
    pointerRef.current = point;
    const chip = chipRef.current;
    if (chip) chip.style.transform = `translate3d(${point.x + 12}px, ${point.y + 12}px, 0)`;
    const currentGeometry = geometryRef.current;
    const host = hostRef.current;
    const currentSource = sourceRef.current;
    if (!currentGeometry || !host || !currentSource) return;
    const resolved = resolveDropTarget(point, currentGeometry);
    const refined = resolved ? host.refine(resolved, currentSource.panelId) : null;
    if (sameTarget(targetRef.current, refined)) return;
    targetRef.current = refined;
    setTarget(refined);
  }, []);

  const reset = useCallback(() => {
    sourceRef.current = null;
    targetRef.current = null;
    geometryRef.current = null;
    pointerRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setSource(null);
    setTarget(null);
    setGeometry(null);
  }, []);

  const beginDrag = useCallback((next: PanelDragSource) => {
    const host = hostRef.current;
    const measured = host ? measureLayoutGeometry(host.root) : null;
    sourceRef.current = next;
    geometryRef.current = measured;
    targetRef.current = null;
    setSource(next);
    setGeometry(measured);
    setTarget(null);
  }, []);

  const endDrag = useCallback((): boolean => {
    const currentSource = sourceRef.current;
    const currentTarget = targetRef.current;
    const host = hostRef.current;
    reset();
    if (!currentSource || !currentTarget || !host) return false;
    host.commit(currentSource.panelId, currentTarget);
    return true;
  }, [reset]);

  const cancelDrag = useCallback(() => reset(), [reset]);

  // One pointer listener for every drag source. Coalesced to a frame: the
  // resolve is cheap, but the highlight only ever needs to be right per paint.
  useEffect(() => {
    if (source === null) return;
    const handleMove = (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      if (frameRef.current !== null) {
        pointerRef.current = point;
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        applyPointer(pointerRef.current ?? point);
      });
      pointerRef.current = point;
    };
    window.addEventListener("pointermove", handleMove, true);
    return () => window.removeEventListener("pointermove", handleMove, true);
  }, [source, applyPointer]);

  // Escape abandons the gesture wherever it started.
  useEffect(() => {
    if (source === null) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelDrag();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [source, cancelDrag]);

  const beginPaneDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, next: PanelDragSource) => {
      if (event.button !== 0) return;
      const origin = { x: event.clientX, y: event.clientY };
      const element = event.currentTarget;
      let started = false;
      const handleMove = (move: PointerEvent) => {
        if (started) return;
        const travelled = Math.hypot(move.clientX - origin.x, move.clientY - origin.y);
        if (travelled < PANE_DRAG_THRESHOLD_PX) return;
        started = true;
        beginDrag(next);
        applyPointer({ x: move.clientX, y: move.clientY });
      };
      const finish = (commit: boolean) => {
        window.removeEventListener("pointermove", handleMove, true);
        window.removeEventListener("pointerup", handleUp, true);
        window.removeEventListener("pointercancel", handleCancel, true);
        if (element.hasPointerCapture?.(event.pointerId)) {
          element.releasePointerCapture(event.pointerId);
        }
        if (!started) return;
        if (commit) endDrag();
        else cancelDrag();
      };
      const handleUp = () => finish(true);
      const handleCancel = () => finish(false);
      element.setPointerCapture?.(event.pointerId);
      window.addEventListener("pointermove", handleMove, true);
      window.addEventListener("pointerup", handleUp, true);
      window.addEventListener("pointercancel", handleCancel, true);
    },
    [applyPointer, beginDrag, cancelDrag, endDrag]
  );

  const value = useMemo<LayoutDragContextValue>(
    () => ({
      source,
      target,
      geometry,
      beginDrag,
      endDrag,
      cancelDrag,
      beginPaneDrag,
      registerPlacementHost,
    }),
    [source, target, geometry, beginDrag, endDrag, cancelDrag, beginPaneDrag, registerPlacementHost]
  );

  return (
    <LayoutDragCtx.Provider value={value}>
      {children}
      {source?.fromPaneId ? (
        <div
          ref={chipRef}
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            zIndex: 60,
            pointerEvents: "none",
            willChange: "transform",
          }}
        >
          <DraggedPanelChip title={source.title} />
        </div>
      ) : null}
    </LayoutDragCtx.Provider>
  );
}

function sameTarget(a: LayoutDropTarget | null, b: LayoutDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "new-column" && b.kind === "new-column") {
    return a.afterColumnId === b.afterColumnId;
  }
  if (a.kind === "pane-center" && b.kind === "pane-center") return a.paneId === b.paneId;
  if (a.kind === "pane-edge" && b.kind === "pane-edge") {
    return a.paneId === b.paneId && a.edge === b.edge;
  }
  return false;
}
