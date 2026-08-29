import { useCallback, useEffect, useRef } from "react";
import type { PanelPresentationSnapshot } from "@vibestudio/shared/panel/presentation";

import { buildUnits, panel } from "../shell/client";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import { usePanelTree } from "../shell/hooks/PanelTreeContext";
import { useShellEvent } from "../shell/useShellEvent";

const NEXT_PANEL_SOURCE = "about/new";
const IDLE_DEADLINE_MS = 2_000;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Populate BuildV2's canonical cache only after the first resident panel is
 * ready. The readiness boundary prevents speculative compilation from
 * competing with first-panel build, navigation, or boot. The actual panel
 * creation still uses the same build request and joins its single-flight work.
 */
export function NextPanelBuildWarmup() {
  const { initialized } = usePanelTree();
  const scheduled = useRef(false);
  const cancelIdle = useRef<(() => void) | null>(null);

  const cancelScheduled = useCallback(() => {
    cancelIdle.current?.();
    cancelIdle.current = null;
    scheduled.current = false;
  }, []);

  const warm = useCallback(() => {
    cancelIdle.current = null;
    void buildUnits.warmPanel(NEXT_PANEL_SOURCE).catch((error: unknown) => {
      scheduled.current = false;
      console.warn("[PanelApp] Next-panel warmup failed:", error);
    });
  }, []);

  const scheduleAfterReady = useCallback(() => {
    if (scheduled.current) return;
    scheduled.current = true;
    const idleWindow = window as IdleWindow;
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(warm, {
        timeout: IDLE_DEADLINE_MS,
      });
      cancelIdle.current = () => idleWindow.cancelIdleCallback?.(handle);
    } else {
      const handle = window.setTimeout(warm, 0);
      cancelIdle.current = () => window.clearTimeout(handle);
    }
  }, [warm]);

  const acceptPresentation = useCallback(
    (snapshot: PanelPresentationSnapshot) => {
      if (snapshot.presentation.state === "ready") scheduleAfterReady();
    },
    [scheduleAfterReady],
  );

  useDirectShellEvent("panel-local-presentation-changed", acceptPresentation);

  const inspectFocusedPanel = useCallback(() => {
    if (!initialized) return;
    void panel
      .getFocusedPanelId()
      .then((panelId) => (panelId ? panel.getLocalPresentation(panelId) : null))
      .then((snapshot) => {
        if (snapshot) acceptPresentation(snapshot);
      })
      .catch((error: unknown) =>
        console.warn("[PanelApp] Could not inspect first-panel readiness:", error),
      );
  }, [acceptPresentation, initialized]);

  useEffect(inspectFocusedPanel, [inspectFocusedPanel]);
  useShellEvent(
    "server-connection-changed",
    useCallback(
      ({ status }: { status: "connected" | "connecting" | "disconnected" }) => {
        if (status !== "connected") {
          cancelScheduled();
          return;
        }
        inspectFocusedPanel();
      },
      [cancelScheduled, inspectFocusedPanel],
    ),
  );

  useEffect(() => cancelScheduled, [cancelScheduled]);
  return null;
}
