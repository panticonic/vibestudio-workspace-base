import { isRpcConnectionLost } from "@vibestudio/rpc";
import { useShellWorkspaceClient, useWorkspaceVisible } from "../shell/workspaceContext";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Box } from "@radix-ui/themes";

import { type NativePanelSlotBounds } from "../shell/client";

interface PanelSurfaceProps {
  nativeSlotId: string;
  panelId: string;
  focused: boolean;
  className?: string;
  layoutEpoch?: number;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  children?: React.ReactNode;
}

function sameBounds(
  a: NativePanelSlotBounds | null,
  b: NativePanelSlotBounds
): boolean {
  return (
    !!a &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function readBounds(element: HTMLElement | null): NativePanelSlotBounds | null {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Declares shell-owned geometry. Electron may accept this before a panel
 * WebContents exists; presentation readiness is deliberately not inferred here.
 */
export function PanelSurface({
  nativeSlotId,
  panelId,
  focused,
  className,
  layoutEpoch,
  onPointerDown,
  children,
}: PanelSurfaceProps) {
  const { view } = useShellWorkspaceClient();
  const visible = useWorkspaceVisible();

  const elementRef = useRef<HTMLDivElement | null>(null);
  const [bindingId] = useState(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `panel-slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const declaredRef = useRef(false);
  const mountedRef = useRef(false);
  const lastBoundsRef = useRef<NativePanelSlotBounds | null>(null);
  const rafRef = useRef<number | null>(null);

  const sync = useCallback(() => {
    if (!visibleRef.current) return;
    const bounds = readBounds(elementRef.current);
    if (!bounds) return;
    const request = {
      nativeSlotId,
      bindingId,
      bounds,
      focused: focusedRef.current,
    };
    if (!declaredRef.current) {
      declaredRef.current = true;
      lastBoundsRef.current = bounds;
      void view
        .bindNativePanelSlot({ ...request, panelId })
        .catch((error: unknown) => {
          if (!mountedRef.current) return;
          declaredRef.current = false;
          if (!isRpcConnectionLost(error)) console.warn("[PanelSurface] declaration failed:", error);
        });
      return;
    }
    if (sameBounds(lastBoundsRef.current, bounds)) return;
    lastBoundsRef.current = bounds;
    void view.updateNativePanelSlot(request).catch((error: unknown) => {
      if (!isRpcConnectionLost(error)) console.warn("[PanelSurface] geometry update failed:", error);
    });
  }, [bindingId, nativeSlotId, panelId, visible, view]);

  const scheduleSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      sync();
    });
  }, [sync]);

  useLayoutEffect(() => {
    if (!visible) return;
    mountedRef.current = true;
    sync();
    const element = elementRef.current;
    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleSync)
        : null;
    if (element) observer?.observe(element);
    window.addEventListener("resize", scheduleSync);
    return () => {
      mountedRef.current = false;
      observer?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (rafRef.current !== null)
        window.cancelAnimationFrame?.(rafRef.current);
      rafRef.current = null;
      if (!declaredRef.current) return;
      declaredRef.current = false;
      void view
        .clearNativePanelSlot({
          nativeSlotId,
          bindingId,
        })
        .catch((error: unknown) => {
          if (!isRpcConnectionLost(error)) console.warn("[PanelSurface] declaration cleanup failed:", error);
        });
    };
  }, [bindingId, nativeSlotId, scheduleSync, sync, visible, view]);

  useEffect(() => {
    if (!declaredRef.current) {
      scheduleSync();
      return;
    }
    void view
      .updateNativePanelSlot({
        nativeSlotId,
        bindingId,
        focused,
      })
      .catch((error: unknown) => {
        if (!isRpcConnectionLost(error)) console.warn("[PanelSurface] focus update failed:", error);
      });
  }, [bindingId, focused, nativeSlotId, scheduleSync]);

  useEffect(scheduleSync, [layoutEpoch, scheduleSync]);

  return (
    <Box
      ref={elementRef}
      className={className}
      data-native-panel-slot-id={nativeSlotId}
      data-panel-id={panelId}
      onPointerDown={onPointerDown}
      style={{ flex: "1 1 0", position: "relative", minHeight: 0, minWidth: 0 }}
    >
      {children}
    </Box>
  );
}
