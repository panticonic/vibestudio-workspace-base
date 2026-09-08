import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AppDialog } from "@workspace/ui/overlay";
import { isRpcConnectionLost } from "@vibestudio/rpc";

import {
  settingsDialogAtom,
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
  workspaceCreationSourceUrlAtom,
  shellOverlayActiveAtom,
} from "../state/appModeAtoms";

import { useShellEvent } from "../shell/useShellEvent";
import { useShellOverlay } from "../shell/useShellOverlay";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";
import {
  ApprovalPresentationContext,
  useApprovalPresentationController,
} from "./ApprovalPresentationContext";
import { WorkspaceDesktop } from "./WorkspaceDesktop";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceConnectionOverlay } from "./WorkspaceConnectionOverlay";

/**
 * Main mode: the normal desktop startup surface with the panel app and its
 * workspace dialogs. Optional feature toolchains below this boundary remain
 * lazy, but the panel chrome itself is required for first useful paint.
 */
export default function MainMode() {
  const client = useShellWorkspaceClient();
  const { view } = client;
  const approvalPresentation = useApprovalPresentationController(client);

  const workspaceChooserOpen = useAtomValue(workspaceChooserDialogOpenAtom);
  const setCreationTemplate = useSetAtom(workspaceChooserTemplateAtom);
  const setCreationSource = useSetAtom(workspaceCreationSourceUrlAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const settingsTarget = useAtomValue(settingsDialogAtom);
  const setSettingsTarget = useSetAtom(settingsDialogAtom);
  const shellOverlayActive = useAtomValue(shellOverlayActiveAtom);

  // Mounted here, not next to the badge that opens it: the badge lives in the
  // panel tree, which breadcrumb mode unmounts, but this event arrives in both.
  useShellEvent(
    "open-settings",
    useCallback((target) => setSettingsTarget(target), [setSettingsTarget]),
  );

  // Register shell overlays — hides panel views so dialogs aren't obscured
  useShellOverlay(workspaceChooserOpen);

  // Reassert the current desired state after reconnection, including a dialog
  // closed while its workspace connection was unavailable.
  const syncOverlay = useCallback(() => {
    void view.setShellOverlay(shellOverlayActive).catch((error: unknown) => {
      if (!isRpcConnectionLost(error)) {
        console.warn("[MainMode] Shell overlay sync failed:", error);
      }
    });
  }, [view, shellOverlayActive]);
  useEffect(syncOverlay, [syncOverlay]);
  useShellEvent(
    "server-connection-changed",
    useCallback(
      ({ status }) => {
        if (status === "connected") syncOverlay();
      },
      [syncOverlay],
    ),
  );

  useEffect(() => {
    const bridge = (
      globalThis as {
        __vibestudioApp?: {
          setChromeInteractiveFocus?: (active: boolean) => void;
        };
      }
    ).__vibestudioApp;
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(
        'input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="treeitem"], [role="dialog"], [tabindex]:not([tabindex="-1"])',
      ) !== null;
    const sync = (event: FocusEvent) =>
      bridge?.setChromeInteractiveFocus?.(isInteractive(event.target));
    const clear = () => bridge?.setChromeInteractiveFocus?.(false);
    document.addEventListener("focusin", sync, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("focusin", sync, true);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, []);

  return (
    <ApprovalPresentationContext.Provider value={approvalPresentation}>
      <WorkspaceDesktop>
        {/* Workspace creation */}
        <AppDialog
          open={workspaceChooserOpen}
          onOpenChange={(open) => {
            setWorkspaceChooserOpen(open);
            if (!open) { setCreationTemplate(null); setCreationSource(null); }
          }}
          maxWidth="920px"
          title="Add workspace"
          description="Start a separate space for your panels, files and conversations."
        >
          <WorkspaceChooser />
        </AppDialog>
      </WorkspaceDesktop>

      <WorkspaceConnectionOverlay
        onOpenSettings={() => setSettingsTarget({ section: "connection" })}
      />
      <ConnectionSettingsDialog
        section={settingsTarget?.section ?? null}
        workspaceId={settingsTarget?.workspaceId}
        onSectionChange={(section) =>
          setSettingsTarget(section ? { ...settingsTarget, section } : null)
        }
      />
    </ApprovalPresentationContext.Provider>
  );
}
