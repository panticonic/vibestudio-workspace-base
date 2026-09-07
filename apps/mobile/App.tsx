// Must be the first import: react-native-gesture-handler requires its native
// side to be initialized before anything renders. The drawer navigator and the
// panel-tree swipe gestures depend on it.
import "react-native-gesture-handler";
import "./src/setupGlobals";
import { workspaceDirectoryAtom } from "./src/state/workspaceDirectoryAtom";
import { useEffect, useRef, useState } from "react";
import { AppRegistry, Appearance, Linking, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@workspace/mobile-navigation";
import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai";
import { APP_CAPABILITIES_BY_NATIVE_HOST } from "@vibestudio/shared/unitManifest";
import { BrowserPrivacyManager } from "./src/components/BrowserPrivacyManager";
import type { MobileBrowserPrivacySection } from "./src/services/shellClient";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { Toast } from "./src/components/Toast";
import { setApprovedAppCapabilities } from "./src/services/appCapabilities";
import { registerBackgroundHandlers } from "./src/services/backgroundHandlers";
import { setupOAuthHandler } from "./src/services/oauthHandler";
import { setupNotificationCategories } from "./src/services/notificationCategories";
import { registerForPushNotifications } from "./src/services/pushNotifications";
import {
  colorSchemeAtom,
  hydrateThemePreferenceAtom,
  isDarkModeAtom,
  systemColorSchemeAtom,
  themeColorsAtom,
} from "./src/state/themeAtoms";
import { ActionSheetHost } from "./src/components/ui/ActionSheetHost";
import { shellClientAtom } from "./src/state/shellClientAtom";
import { inboxDeepLinkAtom } from "./src/state/inboxDeepLinkAtom";
import { pushToastAtom } from "./src/state/toastAtoms";
import {
  parsePanelLocationLink,
  type PanelLocation,
} from "@vibestudio/shared/panelLocation";

setApprovedAppCapabilities(APP_CAPABILITIES_BY_NATIVE_HOST["react-native"]);
registerBackgroundHandlers();

function AppContent() {
  const shellClient = useAtomValue(shellClientAtom);
  const directory = useAtomValue(workspaceDirectoryAtom);
  const [privacySection, setPrivacySection] =
    useState<MobileBrowserPrivacySection | null>(null);
  useEffect(() => {
    setPrivacySection(null);
    return shellClient?.onOpenBrowserPrivacy(setPrivacySection);
  }, [shellClient]);
  const isDark = useAtomValue(isDarkModeAtom);
  const colors = useAtomValue(themeColorsAtom);
  const effectiveScheme = useAtomValue(colorSchemeAtom);
  const setSystemColorScheme = useSetAtom(systemColorSchemeAtom);
  const hydrateThemePreference = useSetAtom(hydrateThemePreferenceAtom);
  const inboxDeepLinkSequence = useRef(0);
  const pushToast = useSetAtom(pushToastAtom);
  const consumedPanelLinks = useRef(new Set<string>());

  useEffect(() => {
    void hydrateThemePreference();
  }, [hydrateThemePreference]);

  // Track the system color scheme at the app root so the theme follows the OS
  // on every screen (login, settings, panels) — not only while MainScreen is
  // mounted.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(
      ({ colorScheme: nextScheme }) => {
        setSystemColorScheme(nextScheme);
      },
    );
    return () => subscription.remove();
  }, [setSystemColorScheme]);

  // Mirror the effective theme (system scheme + user override) into managed
  // panels whenever it changes.
  useEffect(() => {
    if (!shellClient) return;
    void shellClient.panels
      .updateTheme(effectiveScheme === "light" ? "light" : "dark")
      .catch((error) =>
        console.warn("[mobile] Failed to sync panel theme:", error),
      );
  }, [effectiveScheme, shellClient]);

  // Set up OAuth deep link handler when the shell client is available
  useEffect(() => {
    if (!shellClient) return;
    const cleanup = setupOAuthHandler(shellClient);
    return cleanup;
  }, [shellClient]);

  useEffect(() => {
    if (!shellClient) return;
    const openLocation = async (location: PanelLocation) => {
      if (!directory)
        throw new Error("Your workspace directory is not connected");
      const workspaceId = location.workspace ?? directory.activeWorkspaceId;
      if (!workspaceId) throw new Error("Choose a workspace for this panel");
      const session = await directory.open(workspaceId);
      await directory.activate(workspaceId);
      const shellClient = session.client;
      const focusedPanelId = shellClient.panels.registry.getFocusedPanelId();
      const common = {
        ref: location.ref,
        contextId: location.contextId,
        stateArgs: location.stateArgs,
      };
      const disposition = location.disposition ?? "root";
      if (disposition === "current" && focusedPanelId) {
        await shellClient.panels.navigatePanel(
          focusedPanelId,
          location.source,
          common,
        );
      } else if (disposition === "child" && focusedPanelId) {
        await shellClient.panels.createChildPanel(
          focusedPanelId,
          location.source,
          {
            ...common,
            title: location.title,
            slug: location.slug,
            focus: location.focus ?? true,
          },
        );
      } else {
        await shellClient.panels.createRootPanel(location.source, {
          ...common,
          title: location.title,
          slug: location.slug,
          focus: location.focus ?? true,
        });
      }
    };
    const handleUrl = (raw: string) => {
      const parsed = parsePanelLocationLink(raw);
      if (parsed.kind !== "ok" || consumedPanelLinks.current.has(raw)) return;
      consumedPanelLinks.current.add(raw);
      void openLocation(parsed.location).catch((error: unknown) => {
        pushToast({
          title: "Panel link could not be opened",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      });
    };
    void Linking.getInitialURL().then((url) => {
      if (url) handleUrl(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) =>
      handleUrl(url),
    );
    return () => subscription.remove();
  }, [pushToast, shellClient, directory]);

  useEffect(() => {
    if (!shellClient) return;
    let cleanup: (() => void) | null = null;
    let disposed = false;

    void setupNotificationCategories()
      .then(() =>
        registerForPushNotifications(shellClient, {
          resolveWorkspace: async (scope) => {
            if (!directory) throw new Error("Your account is not connected");
            return (await directory.resolveNotificationWorkspace(scope)).client;
          },
          onApprovalDeepLink: (target) => {
            void directory
              ?.openApproval(target)
              .catch((error: unknown) =>
                pushToast({
                  title: "Could not open approval",
                  message: String(error),
                  tone: "danger",
                }),
              );
          },
          onInboxDeepLink: (payload) => {
            if (!directory) return;
            void directory
              .resolveNotificationWorkspace(payload)
              .then(async (session) => {
                await directory.activate(payload.workspaceId);
                session.store.set(inboxDeepLinkAtom, {
                  ...payload,
                  sequence: (inboxDeepLinkSequence.current += 1),
                });
              })
              .catch((error: unknown) =>
                pushToast({
                  title: "Could not open message",
                  message: String(error),
                  tone: "danger",
                }),
              );
          },
          onToast: (toast) => pushToast(toast),
        }),
      )
      .then((nextCleanup) => {
        if (disposed) {
          nextCleanup();
          return;
        }
        cleanup = nextCleanup;
      })
      .catch((error) => {
        console.warn("[App] Failed to initialize push notifications:", error);
        pushToast({
          durationMs: 7000,
          message: error instanceof Error ? error.message : String(error),
          title: "Push notifications unavailable",
          tone: "warning",
        });
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [pushToast, directory, shellClient]);

  return (
    <>
      <StatusBar
        barStyle={isDark ? "light-content" : "dark-content"}
        translucent
        backgroundColor="transparent"
      />
      <ErrorBoundary label="App" colors={colors}>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
        {shellClient && privacySection && (
          <BrowserPrivacyManager
            initialSection={privacySection}
            client={shellClient.browserPrivacy}
            onClose={() => setPrivacySection(null)}
          />
        )}
        <Toast />
        <ActionSheetHost />
      </ErrorBoundary>
    </>
  );
}

function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <JotaiProvider>
          <AppContent />
        </JotaiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

AppRegistry.registerComponent("Vibestudio", () => App);

export default App;
