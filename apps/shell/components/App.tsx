import { useEffect, useCallback } from "react";
import { useSetAtom } from "jotai";
import { Theme } from "@radix-ui/themes";

import {
  workspaceChooserDialogOpenAtom,
  activeWorkspaceNameAtom,
} from "../state/appModeAtoms";
import {
  effectiveThemeAtom,
  loadThemePreferenceAtom,
  themeModeAtom,
  themeConfigAtom,
  loadThemeConfigAtom,
} from "../state/themeAtoms";
import { useAtomValue } from "jotai";
import { useShellEvent } from "../shell/useShellEvent";
import {
  app,
  hostCommands,
  incomingShellSurface,
  notification,
  panel,
  workspace,
  shellNetwork,
  connectNativePanelAdapter,
} from "../shell/client";
import { ChunkErrorBoundary } from "./ChunkErrorBoundary";
import MainMode from "./MainMode";

/**
 * Root App component that renders the main panel app.
 */
export function App() {
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeMode = useAtomValue(themeModeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const loadThemeConfig = useSetAtom(loadThemeConfigAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);
  // Hand the window to the hosted shell immediately. MainMode belongs to the
  // normal startup surface and is bundled with it; optional heavyweight
  // features inside that surface retain their own lazy boundaries.
  useEffect(() => {
    void connectNativePanelAdapter().catch((error: unknown) =>
      console.warn("[App] Panel host connection failed:", error),
    );
  }, []);

  // Load theme preference on mount
  useEffect(() => {
    loadThemePreference();
    loadThemeConfig();
  }, [loadThemePreference, loadThemeConfig]);

  // Keep Electron and its embedded panel web contents on the same appearance
  // as the shell. Server-owned pages use prefers-color-scheme because they do
  // not have access to the panel runtime while a build is still pending.
  useEffect(() => {
    void app.setThemeMode(themeMode).catch((error) => {
      console.error("Failed to synchronize native appearance", error);
    });
  }, [themeMode]);

  // When the OS reports the network came back, tell main to nudge the server
  // pipe awake (a stale WebRTC "connected" can linger ~45s after a flap). Pure
  // signal — main only probes, never tears down a healthy pipe.
  useEffect(() => {
    const handleOnline = () => shellNetwork.notifyOnline();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  // Broadcast the theme identity to every panel whenever it changes, so a
  // user-picked accent/radius propagates live over the runtime bridge.
  useEffect(() => {
    void panel.updateThemeConfig(themeConfig).catch((error) => {
      console.error("Failed to broadcast theme identity", error);
    });
  }, [themeConfig]);

  // Eagerly load active workspace name on mount (independent of chooser dialog)
  useEffect(() => {
    workspace
      .getActive()
      .then((name) => {
        setActiveWorkspaceName(name);
      })
      .catch((err) =>
        console.error("[App] Failed to get active workspace:", err),
      );
  }, [setActiveWorkspaceName]);

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Listen for workspace switcher menu event via shell event
  const handleOpenWorkspaceSwitcher = useCallback(() => {
    setWorkspaceChooserOpen(true);
  }, [setWorkspaceChooserOpen]);
  useShellEvent("open-workspace-switcher", handleOpenWorkspaceSwitcher);

  // Listen for navigate-about menu event via shell event
  const handleNavigateAbout = useCallback(async (payload: { page: string }) => {
    try {
      await panel.createAboutPanel(payload.page);
    } catch (error) {
      console.error(
        `[App] Failed to create shell panel for ${payload.page}:`,
        error,
      );
      void notification.show({
        type: "error",
        title: "Couldn't open page",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);
  useShellEvent("navigate-about", handleNavigateAbout);

  // A panel's contributed host command, invoked from outside the palette
  // (`app.openShellSurface({ kind: "panel-command" })` or its deep link). Same
  // routing as a palette selection; the panel decides what the id means.
  const handleRunPanelCommand = useCallback(
    (payload: { panelId: string; commandId: string }) => {
      void hostCommands.run(payload.panelId, payload.commandId);
    },
    [],
  );
  useShellEvent("run-panel-command", handleRunPanelCommand);

  // A surface deep link that reached the host before this shell was listening:
  // drain it once and send it back through the host's dispatcher.
  useEffect(() => {
    void incomingShellSurface.getPending().then((target) => {
      if (!target) return;
      app.openShellSurface(target).catch((error: unknown) => {
        void notification.show({
          type: "error",
          title: "Couldn't open that link",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }, []);

  return (
    <Theme
      appearance={effectiveTheme}
      {...themeConfig}
      className="app-shell-theme"
    >
      <ChunkErrorBoundary>
        <MainMode />
      </ChunkErrorBoundary>
    </Theme>
  );
}
