import { WorkspaceIconsContext } from "../shell/workspaceIconsContext";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { useEffect, useCallback } from "react";
import { useSetAtom } from "jotai";
import { Theme } from "@radix-ui/themes";

import {
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
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

import { ChunkErrorBoundary } from "./ChunkErrorBoundary";
import MainMode from "./MainMode";

/**
 * Root App component that renders the main panel app.
 */
export function App() {
  const {
    unitIcons,
    app,
    incomingShellSurface,
    notification,
    shellNetwork,
    connectNativePanelAdapter,
  } = useShellWorkspaceClient();

  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeMode = useAtomValue(themeModeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const loadThemeConfig = useSetAtom(loadThemeConfigAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const setWorkspaceChooserTemplate = useSetAtom(workspaceChooserTemplateAtom);
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
  // connection awake and detects a stalled transport. Pure
  // signal — main only probes, never tears down a healthy pipe.
  useEffect(() => {
    const handleOnline = () => shellNetwork.notifyOnline();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Listen for workspace switcher menu event via shell event
  const handleOpenWorkspaceSwitcher = useCallback((input: import("@vibestudio/shared/events").EventPayloads["open-workspace-switcher"]) => {
    setWorkspaceChooserTemplate(input?.template ?? null);
    setWorkspaceChooserOpen(true);
  }, [setWorkspaceChooserOpen, setWorkspaceChooserTemplate]);
  useShellEvent("open-workspace-switcher", handleOpenWorkspaceSwitcher);

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
      <WorkspaceIconsContext.Provider value={unitIcons}>
        <ChunkErrorBoundary>
          <MainMode />
        </ChunkErrorBoundary>
      </WorkspaceIconsContext.Provider>
    </Theme>
  );
}
