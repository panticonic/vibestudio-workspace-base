import { atom } from "jotai";
import type { SettingsSection } from "@vibestudio/shared/shellSurface";

// =============================================================================
// Panel Pin State (client-local)
// =============================================================================

/**
 * Slot ids of client-local pinned panels, mirrored from the main process pin
 * store. Read by the 📌 indicators (header + tree row); replaced wholesale on
 * startup and on every tree-snapshot update (named-panel slot ids are reused
 * after remove+recreate, so a stale pin must be reconciled, not just seeded).
 */
export const pinnedPanelIdsAtom = atom<Set<string>>(new Set<string>());

/**
 * Monotonic counter bumped on every local pin mutation (toggle). The tree-driven
 * reconcile captures it before fetching `listPinnedPanelIds()` and discards a
 * resolved response if a toggle happened meanwhile — so a stale in-flight
 * reconcile can't clobber a just-toggled optimistic update.
 */
export const pinMutationSeqAtom = atom<number>(0);

// =============================================================================
// Workspace Chooser State (for switch workspace dialog)
// =============================================================================

/**
 * Whether workspace chooser dialog is open
 */
export const workspaceChooserDialogOpenAtom = atom(false);
/** A source hint opens review only; creation still requires the user's action. */
export const workspaceChooserTemplateAtom = atom<
  import("@vibestudio/workspace-contracts/types").WorkspaceTemplatePin | null
>(null);

// =============================================================================
// Connection Settings State
// =============================================================================

/**
 * The open settings section, or null while the dialog is closed. Held here rather than
 * in the control that opens it: the connection badge lives in the panel tree,
 * which is unmounted in breadcrumb navigation, but the dialog is also opened
 * from the `open-settings` shell event (app.openShellSurface) and
 * the hamburger menu, which must work in either navigation mode.
 */
export const settingsDialogAtom = atom<{
  section: SettingsSection;
  workspaceId?: string;
} | null>(null);

// =============================================================================
// Shell Overlay State
// =============================================================================

/**
 * Idempotent overlay-owner registry. Each shell dialog registers its stable
 * hook instance while open and removes only that owner on close. A Set avoids
 * leaked counts when React replays effects during strict-mode/remount flows.
 */
export const shellOverlayOwnersAtom = atom<ReadonlySet<string>>(
  new Set<string>(),
);
export const shellOverlayActiveAtom = atom(
  (get) => get(shellOverlayOwnersAtom).size > 0,
);
