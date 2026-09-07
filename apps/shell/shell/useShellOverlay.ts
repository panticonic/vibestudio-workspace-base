import {
  ShellPresentationStoreContext,
  useWorkspaceVisible,
} from "./workspaceContext";
import { useContext, useEffect, useId } from "react";
import { useSetAtom, useStore } from "jotai";
import { shellOverlayOwnersAtom } from "../state/appModeAtoms";

/**
 * Register a shell overlay. When `isOpen` is true, panel WebContentsViews
 * are hidden so the shell dialog/overlay isn't obscured by Electron's
 * native-layer compositing.
 *
 * Usage: call in any component that renders a Radix Dialog, AlertDialog,
 * or other overlay that appears in the panel content area.
 *
 *   useShellOverlay(dialogIsOpen);
 */
export function useShellOverlay(isOpen: boolean): void {
  const ownerId = useId();
  const localStore = useStore();
  const presentationStore =
    useContext(ShellPresentationStoreContext) ?? localStore;
  const visible = useWorkspaceVisible();
  const setOwners = useSetAtom(shellOverlayOwnersAtom, {
    store: presentationStore,
  });

  useEffect(() => {
    if (!isOpen || !visible) return;
    setOwners((current) => {
      if (current.has(ownerId)) return current;
      const next = new Set(current);
      next.add(ownerId);
      return next;
    });
    return () => {
      setOwners((current) => {
        if (!current.has(ownerId)) return current;
        const next = new Set(current);
        next.delete(ownerId);
        return next;
      });
    };
  }, [isOpen, ownerId, setOwners, visible]);
}
