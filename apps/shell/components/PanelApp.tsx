import { useShellWorkspaceClient, useWorkspaceVisible, useWorkspaceNavigationHost } from "../shell/workspaceContext";
import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, Flex } from "@radix-ui/themes";

import { effectiveThemeAtom, loadThemePreferenceAtom, themeConfigAtom } from "../state/themeAtoms";
import { NavigationProvider, useNavigationActions, useNavigationLayout } from "./NavigationContext";
import { PanelTreeProvider, PanelDndProvider, LayoutDragProvider } from "../shell/hooks/index.js";
import { useShellEvent } from "../shell/useShellEvent";

import { PanelStack } from "./PanelStack";
import type { ChromeCommand } from "./PanelStack";
import { TitleBar } from "./TitleBar";
import { NotificationBar } from "./NotificationBar";
import { UserNotificationBar } from "./UserNotificationBar";
import { ConsentApprovalBar, APPROVAL_OVERLAY_HOST_ID } from "./ConsentApprovalBar";
import { QuickfireOwner, QUICKFIRE_OVERLAY_HOST_ID } from "./QuickfireOwner";
import type { PanelChromeState } from "@vibestudio/shared/panelChrome";
import type { FocusedPaneChromeState, PaneChromeCommand } from "./paneChrome";
import { NextPanelBuildWarmup } from "./NextPanelBuildWarmup";

export function PanelApp() {
  return (
    <PanelTreeProvider>
      <LayoutDragProvider>
        <PanelDndProvider>
          <NavigationProvider>
            <PanelAppContent />
          </NavigationProvider>
        </PanelDndProvider>
      </LayoutDragProvider>
    </PanelTreeProvider>
  );
}

function PanelAppContent() {
  const { notification, panel, hostCommands } = useShellWorkspaceClient();
  const visible = useWorkspaceVisible();
  const navigationHost = useWorkspaceNavigationHost();
  const workspaceId = navigationHost?.workspaceId ?? "system";

  const effectiveTheme = useThemeSynchronizer();
  const themeConfig = useAtomValue(themeConfigAtom);
  // Broadcast the theme identity to every panel whenever it changes, so a
  // user-picked accent/radius propagates live over the runtime bridge.
  useEffect(() => {
    void panel.updateThemeConfig(themeConfig).catch((error) => {
      console.error("Failed to broadcast theme identity", error);
    });
  }, [themeConfig]);


  const [currentTitle, setCurrentTitle] = useState("Vibestudio");
  const [chromeState, setChromeState] = useState<PanelChromeState | null>(null);
  const [paneChromeState, setPaneChromeState] = useState<FocusedPaneChromeState | null>(null);

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


  // Convert panel initialization errors into notifications
  useShellEvent(
    "panel-initialization-error",
    useCallback((payload: { path: string; error: string }) => {
      notification
        .show({
          type: "error",
          title: "Failed to initialize panels",
          message: payload.error,
        })
        .catch((err: unknown) =>
          console.error("Failed to show panel-initialization-error notification", err)
        );
    }, [])
  );

  // Use refs for callback handlers to avoid complex state patterns
  const openPanelDevToolsRef = useRef<() => void>(() => {});
  const showPanelContextMenuRef = useRef<
    (panelId: string, position: { x: number; y: number }) => Promise<void>
  >(async () => {});
  const handleChromeCommandRef = useRef<(command: ChromeCommand) => void>(() => {});
  const handlePaneChromeCommandRef = useRef<(command: PaneChromeCommand) => void>(() => {});

  const { addressBarVisible } = useNavigationLayout();
  const { navigateToId, registerNavigateToId, setAddressBarVisible } = useNavigationActions();

  // Stable callbacks that delegate to refs
  const openPanelDevTools = useCallback(() => openPanelDevToolsRef.current(), []);
  const showPanelContextMenu = useCallback(
    (panelId: string, position: { x: number; y: number }) =>
      showPanelContextMenuRef.current(panelId, position),
    []
  );
  const handleChromeCommand = useCallback(
    (command: ChromeCommand) => handleChromeCommandRef.current(command),
    []
  );
  const handlePaneChromeCommand = useCallback(
    (command: PaneChromeCommand) => handlePaneChromeCommandRef.current(command),
    []
  );
  const navigateToFocusedPane = useCallback(
    (panelId: string) => navigateToId(panelId, { target: "focused-pane" }),
    [navigateToId]
  );
  const registerPanelDevTools = useCallback((handler: () => void) => {
    openPanelDevToolsRef.current = handler;
  }, []);
  const registerPanelContextMenu = useCallback(
    (handler: (panelId: string, position: { x: number; y: number }) => Promise<void>) => {
      showPanelContextMenuRef.current = handler;
    },
    []
  );
  const registerChromeCommand = useCallback((handler: (command: ChromeCommand) => void) => {
    handleChromeCommandRef.current = handler;
  }, []);
  const registerPaneChromeCommand = useCallback((handler: (command: PaneChromeCommand) => void) => {
    handlePaneChromeCommandRef.current = handler;
  }, []);

  // Keyboard shortcut for the focused workspace only.
  useEffect(() => {
    if (!visible) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openPanelDevTools();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setAddressBarVisible(true);
        window.requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent("shell-focus-address"))
        );
      }
      if (event.key === "Escape") {
        const target = event.target instanceof Element ? event.target : null;
        if (
          event.defaultPrevented ||
          target?.closest(
            'input, textarea, select, [contenteditable="true"], [role="dialog"], [data-shell-overlay]'
          )
        ) {
          return;
        }
        handleChromeCommand({ type: "stop" });
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleChromeCommand, openPanelDevTools, setAddressBarVisible, visible]);

  useShellEvent(
    "toggle-address-bar",
    useCallback(() => {
      setAddressBarVisible(!addressBarVisible);
    }, [addressBarVisible, setAddressBarVisible])
  );

  useShellEvent(
    "focus-address-bar",
    useCallback(() => {
      setAddressBarVisible(true);
      window.requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("shell-focus-address"))
      );
    }, [setAddressBarVisible])
  );

  useShellEvent(
    "panel-chrome-command",
    useCallback(
      ({ command }) => {
        handleChromeCommand({ type: command });
      },
      [handleChromeCommand]
    )
  );

  // Listen for panel devtools toggle from native menu via shell event
  const handleTogglePanelDevTools = useCallback(() => {
    openPanelDevTools();
  }, [openPanelDevTools]);
  useShellEvent("toggle-panel-devtools", handleTogglePanelDevTools);



  return (
    <Flex direction="column" height="100%" style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <NextPanelBuildWarmup />
      {visible && navigationHost?.titleBarHost && createPortal(
        <TitleBar
          title={currentTitle}
          chromeState={chromeState}
          onChromeCommand={handleChromeCommand}
          onNavigateToId={navigateToFocusedPane}
          onPanelContextMenu={showPanelContextMenu}
          paneChromeState={paneChromeState}
          onPaneChromeCommand={handlePaneChromeCommand}
        />,
        navigationHost.titleBarHost,
      )}
      <div
        className="workspace-desktop-notifications"
        ref={visible ? navigationHost?.setNotificationHost : undefined}
      />
      <NotificationBar />
      <UserNotificationBar />
      <ConsentApprovalBar />
      <QuickfireOwner />
      {/* Panel region — also the positioning host the approval card portals
          into, so it floats over the panels rather than the chrome. */}
      <Box
        id={`${APPROVAL_OVERLAY_HOST_ID}:${workspaceId}`}
        style={{
          position: "relative",
          flex: "1 1 0",
          minHeight: 0,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Quickfire's own anchor: it spans the panel viewport but is never a
            hit target, so the owner can measure the region without changing
            how the approval card's host box lays out. */}
        <div
          id={`${QUICKFIRE_OVERLAY_HOST_ID}:${workspaceId}`}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        />
        <PanelStack
          onTitleChange={setCurrentTitle}
          onChromeStateChange={setChromeState}
          hostTheme={effectiveTheme}
          onRegisterDevToolsHandler={registerPanelDevTools}
          onRegisterNavigateToId={registerNavigateToId}
          onRegisterPanelContextMenu={registerPanelContextMenu}
          onRegisterChromeCommand={registerChromeCommand}
          onPaneChromeStateChange={setPaneChromeState}
          onRegisterPaneChromeCommand={registerPaneChromeCommand}
        />
      </Box>
    </Flex>
  );
}

/**
 * Hook that synchronizes the theme with system preferences.
 * - Loads saved theme preference from localStorage on mount
 * - Applies the effective theme to the document
 * - Listens for system theme changes
 * - Syncs with Electron's nativeTheme
 *
 * Returns the effective theme for use with Radix UI Theme component.
 * Exported for testing purposes.
 */
export function useThemeSynchronizer(): "light" | "dark" {
  const { app } = useShellWorkspaceClient();

  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);

  // Load saved theme preference on mount
  useEffect(() => {
    loadThemePreference();
  }, [loadThemePreference]);

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    // Force re-evaluation of system theme
    // The effectiveThemeAtom will automatically pick up the new system preference
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Sync initial theme with Electron on mount
  useEffect(() => {
    void (async () => {
      try {
        await app.getSystemTheme();
        // Only set if we're in system mode
        const savedMode = localStorage.getItem("theme-mode");
        if (!savedMode || savedMode === "system") {
          await app.setThemeMode("system");
        }
      } catch (error) {
        console.error("Failed to sync theme with Electron:", error);
      }
    })();
  }, []);

  return effectiveTheme;
}
