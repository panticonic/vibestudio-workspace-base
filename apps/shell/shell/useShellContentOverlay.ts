import {
  useShellWorkspaceClient,
  useWorkspaceVisible,
} from "./workspaceContext";
/**
 * Reusable chrome-side driver for the content overlay (the rich sibling of
 * `useNativeShellOverlay`). Any chrome component can float a registered surface
 * above the panels by passing `{ surface, open, bounds, props, theme }`; intents
 * the surface emits come back through `onIntent`. The owning component keeps the
 * authority (state + RPC) — the overlay is pure presentation.
 */
import { useEffect, useRef } from "react";

import type { OverlaySurfaceKey, OverlayThemeInfo } from "../overlay/types";

export interface ContentOverlayBounds {
  /** Anchor region (the panel viewport rect). Main floats the surface at its
   *  top-right corner and sizes it to the surface's reported content height. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellContentOverlayOptions {
  surface: OverlaySurfaceKey;
  open: boolean;
  bounds: ContentOverlayBounds;
  props: unknown;
  theme: OverlayThemeInfo;
  /**
   * Opaque identity for a one-shot focus request. Keeping this stable while
   * props refresh prevents a visible overlay from repeatedly taking focus;
   * changing it deliberately requests focus again.
   */
  focusRequest?: string;
}

const presentationOwners = new Map<OverlaySurfaceKey, symbol>();

export function useShellContentOverlay(
  options: ShellContentOverlayOptions | null,
  onIntent?: (payload: unknown) => void,
): void {
  const { contentOverlay, view } = useShellWorkspaceClient();
  const visible = useWorkspaceVisible();
  const owner = useRef(Symbol("workspace-overlay")).current;

  const shownRef = useRef(false);
  /** The surface currently shown, so teardown can name the instance to hide.
   *  Overlays are per-surface instances in main, so `hide` is surface-scoped. */
  const shownSurfaceRef = useRef<OverlaySurfaceKey | null>(null);
  const consumedFocusRequestRef = useRef<string | undefined>(undefined);
  const onIntentRef = useRef(onIntent);
  onIntentRef.current = onIntent;

  // Forwarded surface intents (subscribe once for the component's lifetime).
  useEffect(
    () =>
      contentOverlay.on((payload) => {
        const surface = shownSurfaceRef.current;
        if (surface && presentationOwners.get(surface) === owner)
          onIntentRef.current?.(payload);
      }),
    [contentOverlay, owner],
  );

  const open = visible && options?.open === true;
  const surface = options?.surface;
  const bounds = options?.bounds;
  const props = options?.props;
  const theme = options?.theme;
  const focusRequest = options?.focusRequest;
  useEffect(() => {
    if (!open || !surface || !bounds || !theme) {
      const shownSurface = shownSurfaceRef.current;
      if (shownRef.current && shownSurface) {
        shownRef.current = false;
        shownSurfaceRef.current = null;
        if (presentationOwners.get(shownSurface) === owner) {
          presentationOwners.delete(shownSurface);
          void view.hideContentOverlay(shownSurface);
        }
      }
      return;
    }
    const shouldFocus =
      focusRequest !== undefined &&
      focusRequest !== consumedFocusRequestRef.current;
    if (shouldFocus) consumedFocusRequestRef.current = focusRequest;
    const payload = {
      surface,
      bounds,
      props,
      theme,
      focus: shouldFocus,
    };
    if (
      !shownRef.current ||
      shownSurfaceRef.current !== surface ||
      presentationOwners.get(surface) !== owner
    ) {
      presentationOwners.set(surface, owner);
      shownRef.current = true;
      shownSurfaceRef.current = surface;
      void view.showContentOverlay(payload);
      return;
    }
    void view.updateContentOverlay(payload);
  }, [
    bounds?.height,
    bounds?.width,
    bounds?.x,
    bounds?.y,
    focusRequest,
    open,
    props,
    surface,
    theme,
  ]);

  // Ensure the overlay is torn down if the owner unmounts while open.
  useEffect(
    () => () => {
      const shownSurface = shownSurfaceRef.current;
      if (shownRef.current && shownSurface) {
        shownRef.current = false;
        shownSurfaceRef.current = null;
        if (presentationOwners.get(shownSurface) === owner) {
          presentationOwners.delete(shownSurface);
          void view.hideContentOverlay(shownSurface);
        }
      }
      consumedFocusRequestRef.current = undefined;
    },
    [],
  );
}
