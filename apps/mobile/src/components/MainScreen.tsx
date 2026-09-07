import type { MobileShellSurface } from "../services/mobileShellSurfaces";
import { asPanelEntityId } from "@vibestudio/shared/panel/ids";
import { parseShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import type { ShellClient } from "../services/shellClient";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
  useWorkspaceVisible,
  useWorkspaceDirectory,
} from "../state/workspaceScope";
import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  BackHandler,
  Platform,
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  useWindowDimensions,
} from "react-native";
import {
  useNavigation,
  DrawerActions,
  useDrawerStatus,
  type StackNavigationProp,
} from "@workspace/mobile-navigation";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ConnectionBar } from "./ConnectionBar";
import { AppBar } from "./AppBar";
import { workspaceBrowserProfile } from "../services/workspaceBrowserProfile";
import { LoadedPanelWebView } from "./LoadedPanelWebView";
import { syncManagedWebViewThemes } from "./webViewThemes";
import { CommandSheet } from "./CommandSheet";
import { QuickfireSheet } from "./QuickfireSheet";
import { Toast } from "./Toast";
import { VibestudioLogo } from "./VibestudioLogo";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import type { PanelWebViewHandle, PanelNavigationEvent } from "./PanelWebView";
import type { WebViewNavigation } from "react-native-webview/lib/WebViewTypes";
import type { PanelPageObservation } from "@vibestudio/shared/panel/observation";
import type { PanelEntityId } from "@vibestudio/shared/panel/ids";
import {
  panelTreeRevisionAtom,
  shellClientAtom,
} from "../state/shellClientAtom";
import {
  colorSchemeAtom,
  themeColorsAtom,
  type ThemePreference,
} from "../state/themeAtoms";
import { inboxDeepLinkAtom } from "../state/inboxDeepLinkAtom";
import { pushToastAtom } from "../state/toastAtoms";
import {
  activePanelIdAtom,
  activePanelTitleAtom,
  activePanelParentIdAtom,
  activePanelMetadataAtom,
  pinnedPanelIdsAtom,
  pinsHydratedAtom,
} from "../state/navigationAtoms";
import {
  addWebViewEntry,
  sweepIdleWebViews,
  webViewUnmountNeedsUnload,
  type WebViewEntry,
} from "./webViewStack";
import {
  loadPinnedPanelIds,
  savePinnedPanelIds,
} from "../shellCore/pinnedPanels";
import { resolveMobileBackAction } from "../shellCore/mobileBackNavigation";
import { mobileNavigationLayout } from "../shellCore/mobileLayout";
import {
  contributedHostCommandId,
  presentMobileHostCommands,
} from "../shellCore/mobilePanelCommands";
import { HOST_COMMAND_RUN_EVENT } from "@vibestudio/shared/hostCommands";
import { PANEL_UI_IDLE_SWEEP_MS } from "@vibestudio/shared/constants";
import { parseHostConfig } from "../services/panelUrls";
import {
  materializeLatestMobilePanel,
  mobilePanelMaterializationState,
  PanelMaterializationRetryQueue,
} from "../services/panelMaterializer";
import {
  copyToClipboard,
  openExternalUrl,
  shareText,
} from "../services/nativeCapabilities";
import { resetToNativeBootstrap } from "../services/auth";
import { clearShellCredential } from "../services/mobileCredentials";
import {
  buildPanelChromeState,
  isBrowserPanelSource,
  parseAddressInput,
  type AddressAction,
} from "@vibestudio/shared/panelChrome";
import {
  buildAddressAutocompleteItems,
  type AddressAutocompleteItem,
} from "@workspace/omnibox-core";
import {
  applySearchTemplate,
  canonicalizeBrowserHistoryUrl,
  getAvailablePanelCommands,
  getBrowserNavigationIntentForAddressAction,
  getBrowserNavigationIntentForCommand,
  type BrowserNavigationIntent,
  type AddressNavigationMode,
  type PanelCommandId,
} from "@vibestudio/shared/panelCommands";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";

import type { HostConfig } from "../services/panelUrls";

import {
  channelInviteFromNotification,
  type UserNotification,
} from "@vibestudio/shared/userNotifications";
import { showActionSheetAtom } from "../state/actionSheetAtoms";
import {
  openCommandSheetAtom,
  openQuickfireSheetAtom,
} from "../state/commandSheetAtoms";
import { collectMobileOpenPanels } from "../shellCore/openPanelIndex";
import type { PanelDescriptor } from "@workspace/omnibox-core";
import type { QuickfireTransport } from "@workspace/quickfire-core/session";
import type { MobileSlateDeps } from "../commands/slate";
import { spacing, type as typeScale } from "../design/tokens";
import {
  Archive as ArchiveIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  Bell as BellIcon,
  Command as HostCommandIcon,
  Copy as CopyIcon,
  CopyPlus as CopyPlusIcon,
  ExternalLink as ExternalLinkIcon,
  Link2 as Link2Icon,
  MessageCircle as MessageCircleIcon,
  Pin as PinIcon,
  PinOff as PinOffIcon,
  Power as PowerIcon,
  RefreshCw as RefreshCwIcon,
  Share2 as ShareIcon,
  Square as SquareIcon,
  type IconComponent,
} from "../design/icons";
import { Button, EmptyState } from "./ui/primitives";

/** Native icon choices for renderer-neutral shared panel commands. */
const PANEL_COMMAND_PRESENTATION: Partial<
  Record<PanelCommandId, { icon?: IconComponent }>
> = {
  back: { icon: ArrowLeftIcon },
  forward: { icon: ArrowRightIcon },
  "reload-panel": { icon: RefreshCwIcon },
  "reload-view": { icon: RefreshCwIcon },
  "force-reload-view": { icon: RefreshCwIcon },
  "rebuild-panel": { icon: RefreshCwIcon },
  stop: { icon: SquareIcon },
  "copy-address": { icon: CopyIcon },
  "share-address": { icon: ShareIcon },
  "open-external": { icon: ExternalLinkIcon },
  duplicate: { icon: CopyPlusIcon },
  "toggle-pin": { icon: PinIcon },
  unload: { icon: PowerIcon },
  archive: { icon: ArchiveIcon },
  "focus-address": { icon: Link2Icon },
};

const PANEL_MATERIALIZE_TIMEOUT_MS = 45_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  cancel: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      cancel();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function smokePhase(phase: string, extra?: Record<string, unknown>): void {
  console.log(`[VibestudioMobileSmoke] phase=${phase}`, extra ?? "");
}

const noDirectorySubscription = () => () => {};
const noDirectoryRevision = () => 0;

export function MainScreen({
  setThemePreference,
}: {
  setThemePreference: (preference: ThemePreference) => void;
}) {
  const workspaceVisible = useWorkspaceVisible();
  const workspaceDirectory = useWorkspaceDirectory();
  useSyncExternalStore(
    workspaceDirectory?.subscribe ?? noDirectorySubscription,
    workspaceDirectory?.getSnapshot ?? noDirectoryRevision,
  );
  const navigation = useNavigation();
  const drawerStatus = useDrawerStatus();
  const { width: viewportWidth, height: viewportHeight } =
    useWindowDimensions();
  const persistentNavigation =
    mobileNavigationLayout(viewportWidth, viewportHeight).kind === "tablet";
  useEffect(() => {
    if (!workspaceVisible) return;
    navigation.dispatch(
      persistentNavigation
        ? DrawerActions.openDrawer()
        : DrawerActions.closeDrawer(),
    );
  }, [navigation, persistentNavigation, workspaceVisible]);
  const shellClient = useAtomValue(shellClientAtom);
  const panelTreeRevision = useAtomValue(panelTreeRevisionAtom);
  const setPanelTreeRevision = useSetAtom(panelTreeRevisionAtom);
  const setActivePanelMetadata = useSetAtom(activePanelMetadataAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const colorScheme = useAtomValue(colorSchemeAtom);
  const currentThemeModeRef = useRef<"light" | "dark">(
    colorScheme === "light" ? "light" : "dark",
  );
  currentThemeModeRef.current = colorScheme === "light" ? "light" : "dark";
  const activePanelId = useAtomValue(activePanelIdAtom);
  const activePanelTitle = useAtomValue(activePanelTitleAtom);
  const activePanelParentId = useAtomValue(activePanelParentIdAtom);
  const colors = useAtomValue(themeColorsAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const pinnedPanelIds = useAtomValue(pinnedPanelIdsAtom);
  const setPinnedPanelIds = useSetAtom(pinnedPanelIdsAtom);
  const pinsHydrated = useAtomValue(pinsHydratedAtom);
  const setPinsHydrated = useSetAtom(pinsHydratedAtom);
  useEffect(() => {
    let cancelled = false;
    if (!shellClient || !activePanelId) {
      setActivePanelMetadata(null);
      return;
    }
    void Promise.all([
      shellClient.panels.observe(activePanelId),
      shellClient.panels.getTreePath(activePanelId),
    ])
      .then(([observation, path]) => {
        if (cancelled) return;
        const target = path?.nodes[path.nodes.length - 1];
        setActivePanelMetadata({
          panelId: activePanelId,
          title: target?.title ?? observation.title,
          parentId: target?.parentSlotId ?? observation.parentId,
        });
      })
      .catch(() => {
        if (!cancelled) setActivePanelMetadata(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activePanelId, panelTreeRevision, setActivePanelMetadata, shellClient]);
  // Refs mirror the latest values so interval/callback closures read fresh
  // state without re-subscribing.
  const pinnedPanelIdsRef = useRef<Set<string>>(pinnedPanelIds);
  const isForegroundRef = useRef(true);
  const activePanelIdRef = useRef<string | null>(activePanelId);
  useEffect(() => {
    pinnedPanelIdsRef.current = pinnedPanelIds;
  }, [pinnedPanelIds]);
  useEffect(() => {
    activePanelIdRef.current = activePanelId;
  }, [activePanelId]);
  useAppLifecycle(shellClient);
  const [webViewStack, setWebViewStack] = useState<WebViewEntry[]>([]);
  const webViewStackRef = useRef<WebViewEntry[]>([]);
  const retentionLifetime = useRef(new AbortController());
  const updateWebViewStack = useCallback(
    (update: (current: WebViewEntry[]) => WebViewEntry[]) => {
      if (retentionLifetime.current.signal.aborted) return;
      const next = update(webViewStackRef.current);
      webViewStackRef.current = next;
      setWebViewStack(next);
    },
    [],
  );
  const [loadingPanelId, setLoadingPanelId] = useState<string | null>(null);
  const [panelLoadErrors, setPanelLoadErrors] = useState<
    Record<string, string>
  >({});
  const [userNotifications, setUserNotifications] = useState<
    UserNotification[]
  >([]);
  const userNotificationRefreshSeq = useRef(0);

  const [addressBarVisible, setAddressBarVisible] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<
    AddressAutocompleteItem[]
  >([]);
  const [webViewNavigation, setWebViewNavigation] = useState<
    Record<string, WebViewNavigation>
  >({});
  const webViewNavigationRef = useRef<Record<string, WebViewNavigation>>({});
  const browserProfile = shellClient?.workspaceId
    ? workspaceBrowserProfile(
        shellClient.localStorageScope,
        shellClient.workspaceId,
      )
    : null;
  const webViewRefsMap = useRef<Map<string, PanelWebViewHandle | null>>(
    new Map(),
  );
  const webViewThemeSignaturesRef = useRef<Map<string, string>>(new Map());
  const pendingPanelLoads = useRef<Set<string>>(new Set());
  const [panelMaterializationRetryEpoch, setPanelMaterializationRetryEpoch] =
    useState(0);
  const panelMaterializationRetryQueueRef =
    useRef<PanelMaterializationRetryQueue | null>(null);
  if (!panelMaterializationRetryQueueRef.current) {
    panelMaterializationRetryQueueRef.current =
      new PanelMaterializationRetryQueue(() =>
        setPanelMaterializationRetryEpoch((epoch) => epoch + 1),
      );
  }
  const panelMaterializationRetryQueue =
    panelMaterializationRetryQueueRef.current;
  const pendingHistoryIntentByUrl = useRef<
    Map<string, BrowserNavigationIntent>
  >(new Map());
  const pendingHistoryIntentByPanel = useRef<
    Map<string, BrowserNavigationIntent>
  >(new Map());
  const recentHistoryRecords = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    webViewNavigationRef.current = webViewNavigation;
  }, [webViewNavigation]);
  useEffect(
    () => () => panelMaterializationRetryQueue.stop(),
    [panelMaterializationRetryQueue],
  );
  useEffect(() => {
    userNotificationRefreshSeq.current += 1;
    if (!shellClient) {
      setUserNotifications([]);
      return;
    }
    let disposed = false;
    const refresh = async () => {
      const refreshSequence = ++userNotificationRefreshSeq.current;
      const next = await shellClient.userNotifications.list();
      if (!disposed && userNotificationRefreshSeq.current === refreshSequence) {
        setUserNotifications(next);
      }
    };
    void refresh().catch((error: unknown) => {
      if (!disposed)
        console.warn("[MainScreen] Failed to load user notifications:", error);
    });
    const unsubscribeEvent = shellClient.onDirectEvent(
      "user-notifications-changed",
      () =>
        void refresh().catch((error: unknown) =>
          console.warn(
            "[MainScreen] Failed to refresh user notifications:",
            error,
          ),
        ),
    );
    const unsubscribeResubscribe =
      shellClient.recovery.registerResubscribeHandler(
        "mobile-user-notifications",
        refresh,
      );
    const unsubscribeColdRecover =
      shellClient.recovery.registerColdRecoverHandler(
        "mobile-user-notifications",
        refresh,
      );
    return () => {
      disposed = true;
      userNotificationRefreshSeq.current += 1;
      unsubscribeEvent();
      unsubscribeResubscribe();
      unsubscribeColdRecover();
    };
  }, [shellClient]);
  // Route host→panel RPC envelopes (relay replies + events) into the target
  // panel's webview. The shell-client relay holds this sink; we supply it here
  // because the webview handles live in the UI layer.
  useEffect(() => {
    if (!shellClient) return;
    shellClient.panels.setDeliverToPanel((panelId, envelope) => {
      const webView = webViewRefsMap.current.get(panelId);
      if (!webView) return false;
      webView.deliverEnvelope(envelope);
      return true;
    });
  }, [shellClient]);
  useEffect(() => {
    if (!shellClient) return;
    return shellClient.onRecoveryComplete((kind) => {
      if (kind !== "cold-recover") return;
      // A cold recovery replaced the server process and therefore every
      // panel-side bridge session. Reload only retained WebViews whose runtime
      // identity is still authoritative; changed identities are rematerialized
      // by the convergence effect below instead of loading stale URLs.
      for (const entry of webViewStackRef.current) {
        if (!entry.managed) continue;
        const panel = shellClient.panels.registry.getPanel(entry.panelId);
        if (
          panel &&
          mobilePanelMaterializationState(panel, entry) === "current"
        ) {
          shellClient.panels.resetBridgeSessionForReload(entry.panelId);
          webViewRefsMap.current.get(entry.panelId)?.reload();
        }
      }
    });
  }, [shellClient]);
  const handleWebViewUnmount = useCallback(
    (panelId: string) => {
      webViewRefsMap.current.delete(panelId);
      webViewThemeSignaturesRef.current.delete(panelId);
      shellClient?.hostCommands.clear(panelId);
      if (
        shellClient &&
        webViewUnmountNeedsUnload(webViewStackRef.current, panelId)
      ) {
        void shellClient.panels.unload(panelId).catch((error: unknown) =>
          pushToast({
            title: "Could not unload panel",
            message: error instanceof Error ? error.message : "Try again.",
            tone: "danger",
          }),
        );
      }
    },
    [pushToast, shellClient],
  );
  const handleWebViewRef = useCallback(
    (panelId: string, handle: PanelWebViewHandle | null) => {
      if (!handle) {
        webViewRefsMap.current.delete(panelId);
        webViewThemeSignaturesRef.current.delete(panelId);
        return;
      }
      webViewRefsMap.current.set(panelId, handle);
      shellClient?.panels.flushPanelDeliveries(panelId);
      const existingEntry = webViewStackRef.current.find(
        (entry) => entry.panelId === panelId,
      );
      if (existingEntry) {
        syncManagedWebViewThemes(
          [existingEntry],
          webViewRefsMap.current,
          webViewThemeSignaturesRef.current,
          currentThemeModeRef.current,
        );
      }
    },
    [shellClient],
  );
  const hostConfig: HostConfig | null = useMemo(() => {
    if (!shellClient) return null;
    try {
      return parseHostConfig(shellClient.serverUrl);
    } catch {
      return null;
    }
  }, [shellClient]);
  const activePanel = useMemo(() => {
    if (!activePanelId || !shellClient) return null;
    return shellClient.panels.registry.getPanel(activePanelId) ?? null;
  }, [activePanelId, panelTreeRevision, shellClient]);
  const activeRuntimeLease = useMemo(() => {
    if (!activePanelId || !shellClient) return null;
    return shellClient.panels.registry.getRuntimeLease(activePanelId);
  }, [activePanelId, panelTreeRevision, shellClient]);
  const activePanelLoadError = activePanelId
    ? panelLoadErrors[activePanelId]
    : null;
  const activePanelLeasedElsewhere = Boolean(
    activeRuntimeLease &&
    activeRuntimeLease.clientSessionId !== shellClient?.credentials.deviceId,
  );
  const activeChromeState = useMemo(() => {
    if (!activePanel) return null;
    const nav = activePanelId ? webViewNavigation[activePanelId] : undefined;
    return buildPanelChromeState({
      panel: {
        ...activePanel,
        navigation: nav
          ? {
              url: nav.url,
              pageTitle: nav.title,
              isLoading: nav.loading,
              canGoBack: nav.canGoBack,
              canGoForward: nav.canGoForward,
            }
          : activePanel.navigation,
      },
    });
  }, [activePanel, activePanelId, webViewNavigation]);
  useEffect(() => {
    if (!addressBarVisible || !activeChromeState || !shellClient) {
      setAddressSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const query = addressQuery.trim() || activeChromeState.editableAddress;
      const request =
        activeChromeState.kind === "browser"
          ? shellClient.panels.getBrowserAddressOptions(query).then((options) =>
              buildAddressAutocompleteItems({
                kind: "browser",
                input: query,
                browserSuggestions: options.suggestions,
                limit: 8,
              }),
            )
          : shellClient.panels.getAddressOptions(query).then((options) => {
              return buildAddressAutocompleteItems({
                kind: "panel",
                input: query,
                panelSuggestions: options.suggestions,
                limit: 8,
              });
            });
      void request
        .then((items) => {
          if (!cancelled) setAddressSuggestions(items);
        })
        .catch(() => {
          if (!cancelled) setAddressSuggestions([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeChromeState, addressBarVisible, addressQuery, shellClient]);
  // Persist the pin set to AsyncStorage (workspace-scoped). Best-effort.
  const persistPins = useCallback(
    (ids: Set<string>) => {
      const workspaceId = shellClient?.workspaceId;
      if (!workspaceId) return;
      void savePinnedPanelIds(shellClient.localStorageScope, workspaceId, [
        ...ids,
      ]);
    },
    [shellClient],
  );
  // Predicates shared by the cap insert and the idle sweep. Reads the pin ref
  // (latest value inside interval/callback closures) and the live lease.
  const buildStackPredicates = useCallback(
    () => ({
      isPinned: (id: string) => pinnedPanelIdsRef.current.has(id),
      isKeepLoaded: (id: string) =>
        !!shellClient?.panels.registry.getRuntimeLease(id)?.keepLoaded,
    }),
    [shellClient],
  );
  const togglePanelPin = useCallback(
    (panelId: string) => {
      setPinnedPanelIds((prev) => {
        const next = new Set(prev);
        if (next.has(panelId)) next.delete(panelId);
        else next.add(panelId);
        persistPins(next);
        return next;
      });
    },
    [persistPins, setPinnedPanelIds],
  );
  const refreshTree = useCallback(() => {
    if (!shellClient) return;
    setPanelTreeRevision(shellClient.panels.treeCache.getRevision());
    updateWebViewStack((prev) =>
      prev.filter(
        (entry) =>
          shellClient.panels.registry.getPanel(entry.panelId) !== undefined,
      ),
    );
    // Prune pins for panels no longer in the tree; persist if anything dropped.
    setPinnedPanelIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (shellClient.panels.registry.getPanel(id) !== undefined)
          next.add(id);
        else changed = true;
      }
      if (!changed) return prev;
      persistPins(next);
      return next;
    });
  }, [shellClient, setPanelTreeRevision, setPinnedPanelIds, persistPins]);
  const retainPanelPresentation = useCallback(
    (panelId: string) => {
      if (!shellClient || retentionLifetime.current.signal.aborted) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      if (
        !panel ||
        webViewStackRef.current.some((entry) => entry.panelId === panelId)
      )
        return;
      // Activation creates only the presentation slot. One shared convergence
      // path below owns every asynchronous runtime read, lease, and URL update,
      // so initial activation cannot race navigation differently from a
      // retained background WebView.
      const snapshot = getCurrentSnapshot(panel);
      smokePhase("workspace-panel-activate-start", { panelId });
      setLoadingPanelId(panelId);
      setPanelLoadErrors((prev) => {
        if (!prev[panelId]) return prev;
        const { [panelId]: _removed, ...rest } = prev;
        return rest;
      });
      panelMaterializationRetryQueue.cancel(panelId, { resetAttempts: true });
      updateWebViewStack((prev) =>
        addWebViewEntry(
          prev,
          {
            panelId,
            runtimeEntityId: null,
            url: "about:blank",
            managed: !isBrowserPanelSource(snapshot.source),
            panelInit: null,
            lastActive: Date.now(),
          },
          {
            activePanelId: activePanelIdRef.current,
            isPinned: (id) => pinnedPanelIdsRef.current.has(id),
            isKeepLoaded: (id) =>
              !!shellClient.panels.registry.getRuntimeLease(id)?.keepLoaded,
          },
        ),
      );
    },
    [shellClient, panelMaterializationRetryQueue, updateWebViewStack],
  );
  const activatePanel = useCallback(
    (panelId: string) => {
      if (!shellClient || !hostConfig) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      if (!panel) return;
      setActivePanelId(panelId);
      updateWebViewStack((prev) =>
        prev.map((entry) =>
          entry.panelId === panelId
            ? { ...entry, lastActive: Date.now() }
            : entry,
        ),
      );
      if (webViewStackRef.current.some((entry) => entry.panelId === panelId))
        return;
      const lease = shellClient.panels.registry.getRuntimeLease(panelId);
      if (lease && lease.clientSessionId !== shellClient.credentials.deviceId) {
        smokePhase("workspace-panel-leased-elsewhere", { panelId });
        return;
      }

      retainPanelPresentation(panelId);
    },
    [
      hostConfig,
      panelMaterializationRetryQueue,
      shellClient,
      setActivePanelId,
      updateWebViewStack,
      retainPanelPresentation,
    ],
  );
  const syncRetainedRuntimeOwners = useCallback(() => {
    if (!shellClient || retentionLifetime.current.signal.aborted) return;
    shellClient.panels.syncRetainedRuntimeOwners(
      webViewStackRef.current.flatMap((entry) => {
        const panel = shellClient.panels.registry.getPanel(entry.panelId);
        return panel?.runtimeEntityId
          ? [
              {
                panelId: entry.panelId,
                runtimeEntityId: asPanelEntityId(panel.runtimeEntityId),
              },
            ]
          : [];
      }),
    );
  }, [shellClient]);
  useEffect(() => {
    retentionLifetime.current = new AbortController();
    return () => {
      retentionLifetime.current.abort();
      webViewStackRef.current = [];
      shellClient?.panels.syncRetainedRuntimeOwners([]);
    };
  }, [shellClient]);
  const getRetainedPanel = useCallback(
    (panelId: string) => {
      syncRetainedRuntimeOwners();
      return webViewStackRef.current.some((entry) => entry.panelId === panelId)
        ? (shellClient?.panels.registry.getPanel(panelId) ?? null)
        : null;
    },
    [shellClient, syncRetainedRuntimeOwners],
  );
  // WebViews are retained presentation slots, not runtime identities. Converge
  // every retained slot when its immutable runtime entity changes—whether the
  // change came from build completion or navigation, and whether it is visible.
  useEffect(() => {
    if (!hostConfig || !shellClient) return;
    const retainedPanelIds = new Set(
      webViewStack.map((entry) => entry.panelId),
    );
    panelMaterializationRetryQueue.retainOnly(retainedPanelIds);
    syncRetainedRuntimeOwners();
    for (const entry of webViewStack) {
      const panel = shellClient.panels.registry.getPanel(entry.panelId);
      if (!panel) {
        panelMaterializationRetryQueue.cancel(entry.panelId, {
          resetAttempts: true,
        });
        setLoadingPanelId((current) =>
          current === entry.panelId ? null : current,
        );
        continue;
      }
      const materializationState = mobilePanelMaterializationState(
        panel,
        entry,
      );
      if (materializationState === "current") {
        panelMaterializationRetryQueue.cancel(entry.panelId, {
          resetAttempts: true,
        });
        setLoadingPanelId((current) =>
          current === entry.panelId ? null : current,
        );
        continue;
      }
      if (materializationState === "pending") {
        // Runtime identity/build completion is published asynchronously through
        // the shared tree. Keep polling as a bounded fallback in case that
        // publication does not produce a local registry revision.
        panelMaterializationRetryQueue.schedule(entry.panelId);
        continue;
      }
      if (pendingPanelLoads.current.has(entry.panelId)) {
        continue;
      }
      // A real tree/stack change supersedes the delayed fallback poll. Preserve
      // its attempt count so a persistent failure still backs off.
      panelMaterializationRetryQueue.cancel(entry.panelId, {
        resetAttempts: false,
      });
      pendingPanelLoads.current.add(entry.panelId);
      const cancellation = new AbortController();
      void withTimeout(
        materializeLatestMobilePanel({
          panelId: entry.panelId,
          signal: cancellation.signal,
          hostConfig,
          getPanel: () => getRetainedPanel(entry.panelId),
          getPanelInit: (id) => shellClient.panels.getPanelInit(id),
          acquireLease: (id, entityId) =>
            shellClient.panels.acquireLease(id, entityId),
          takeOverLease: (id, entityId) =>
            shellClient.panels.takeOverLease(id, entityId),
          leaseMode: "acquire",
        }),
        PANEL_MATERIALIZE_TIMEOUT_MS,
        `Timed out preparing panel ${entry.panelId} for mobile.`,
        () => cancellation.abort(),
      )
        .then((materialized) => {
          syncRetainedRuntimeOwners();
          const currentEntry = webViewStackRef.current.find(
            (candidate) => candidate.panelId === entry.panelId,
          );
          const currentPanel = shellClient.panels.registry.getPanel(
            entry.panelId,
          );
          if (!currentEntry || !currentPanel) return;
          if (
            materialized.runtimeEntityId !== currentPanel.runtimeEntityId ||
            !shellClient.panels.isCurrentRuntimeLease(
              entry.panelId,
              materialized.runtimeEntityId,
              materialized.connectionId,
            )
          ) {
            throw new Error("Panel runtime changed before presentation");
          }
          if (hostConfig.protocol === "http") {
            console.log(`[MainScreen] Materialized panel ${entry.panelId}`, {
              url: materialized.url,
              managed: materialized.managed,
            });
          }
          smokePhase("workspace-panel-materialized", {
            panelId: entry.panelId,
            managed: materialized.managed,
          });
          // Fill the asset store only once materialization's own round trips are
          // done, and at the same moment the WebView is given its URL.
          //
          // Starting it any earlier would compete with the lease and panel-init
          // calls that make a usable WebView possible. Once the URL is ready,
          // independent per-asset Iroh streams can interleave; a WebView demand
          // joins the exact same store claim instead of downloading twice.
          shellClient.prefetchPanelBuild(currentPanel.buildKey);
          updateWebViewStack((current) =>
            current.map((currentEntry) =>
              currentEntry.panelId === entry.panelId
                ? {
                    ...currentEntry,
                    runtimeEntityId: materialized.runtimeEntityId,
                    url: materialized.url,
                    managed: materialized.managed,
                    panelInit: materialized.panelInit,
                  }
                : currentEntry,
            ),
          );
          panelMaterializationRetryQueue.cancel(entry.panelId, {
            resetAttempts: true,
          });
          setPanelLoadErrors((current) => {
            if (!current[entry.panelId]) return current;
            const { [entry.panelId]: _removed, ...rest } = current;
            return rest;
          });
          setLoadingPanelId((current) =>
            current === entry.panelId ? null : current,
          );
        })
        .catch((error: unknown) => {
          const retained = webViewStackRef.current.find(
            (candidate) => candidate.panelId === entry.panelId,
          );
          const currentPanel = getRetainedPanel(entry.panelId);
          if (
            !retained ||
            !currentPanel ||
            mobilePanelMaterializationState(currentPanel, retained) ===
              "current"
          )
            return;
          const message =
            error instanceof Error
              ? error.message
              : "Could not load this panel.";
          setPanelLoadErrors((current) => ({
            ...current,
            [entry.panelId]: message,
          }));
          setLoadingPanelId((current) =>
            current === entry.panelId ? null : current,
          );
          panelMaterializationRetryQueue.schedule(entry.panelId);
          smokePhase("workspace-panel-activate-failed", {
            panelId: entry.panelId,
            message,
          });
        })
        .finally(() => {
          pendingPanelLoads.current.delete(entry.panelId);
        });
    }
  }, [
    hostConfig,
    panelTreeRevision,
    panelMaterializationRetryEpoch,
    panelMaterializationRetryQueue,
    shellClient,
    updateWebViewStack,
    webViewStack,
    getRetainedPanel,
    syncRetainedRuntimeOwners,
  ]);
  const takeOverActivePanel = useCallback(() => {
    if (!activePanelId || !activePanel || !hostConfig || !shellClient) return;
    retainPanelPresentation(activePanelId);
    pendingPanelLoads.current.add(activePanelId);
    setLoadingPanelId(activePanelId);
    void materializeLatestMobilePanel({
      panelId: activePanelId,
      hostConfig,
      getPanel: () => getRetainedPanel(activePanelId),
      getPanelInit: (id) => shellClient.panels.getPanelInit(id),
      acquireLease: (id, entityId) =>
        shellClient.panels.acquireLease(id, entityId),
      takeOverLease: (id, entityId) =>
        shellClient.panels.takeOverLease(id, entityId),
      leaseMode: "takeOver",
    })
      .then((materialized) => {
        syncRetainedRuntimeOwners();
        if (
          !shellClient.panels.isCurrentRuntimeLease(
            activePanelId,
            materialized.runtimeEntityId,
            materialized.connectionId,
          )
        )
          return;
        updateWebViewStack((prev) =>
          addWebViewEntry(
            prev,
            {
              panelId: materialized.panelId,
              runtimeEntityId: materialized.runtimeEntityId,
              url: materialized.url,
              managed: materialized.managed,
              panelInit: materialized.panelInit,
              lastActive: Date.now(),
            },
            {
              activePanelId: activePanelIdRef.current,
              isPinned: (id) => pinnedPanelIdsRef.current.has(id),
              isKeepLoaded: (id) =>
                !!shellClient.panels.registry.getRuntimeLease(id)?.keepLoaded,
            },
          ),
        );
      })
      .catch((error: unknown) => {
        pushToast({
          title: "Take over failed",
          message:
            error instanceof Error
              ? error.message
              : "Could not take over panel.",
          tone: "danger",
        });
      })
      .finally(() => {
        pendingPanelLoads.current.delete(activePanelId);
        setLoadingPanelId((current) =>
          current === activePanelId ? null : current,
        );
      });
  }, [
    activePanel,
    activePanelId,
    hostConfig,
    pushToast,
    shellClient,
    getRetainedPanel,
    syncRetainedRuntimeOwners,
    retainPanelPresentation,
  ]);
  useEffect(() => {
    if (!shellClient) return;
    refreshTree();
    const eventNames = ["workspace:revision-bumped"] as const;
    const subscribeAll = async () => {
      await Promise.all(
        eventNames.map(async (name) => {
          try {
            await shellClient.events.subscribe(name);
          } catch (error) {
            console.warn(`[MainScreen] Failed to subscribe to ${name}:`, error);
          }
        }),
      );
    };
    void subscribeAll().catch((error: unknown) =>
      console.warn("[MainScreen] Event subscription failed", error),
    );
    const unsubNavigate = shellClient.onNavigateToPanel((panelId) => {
      refreshTree();
      activatePanel(panelId);
    });
    const unsubCreated = shellClient.onDirectEvent(
      "panel-created",
      ({ panelId, focus }) => {
        refreshTree();
        if (focus) activatePanel(panelId);
      },
    );
    const unsubNav = shellClient.onDirectEvent(
      "navigate-to-panel",
      ({ panelId }) => {
        if (panelId) activatePanel(panelId);
      },
    );
    const unsubWorkspaceRevision = shellClient.events.on(
      "workspace:revision-bumped",
      () => {
        void shellClient.panels
          .refresh()
          .then(refreshTree)
          .catch((error: unknown) => {
            console.warn(
              "[MainScreen] Panel refresh after workspace revision failed:",
              error,
            );
            return refreshTree();
          })
          .catch((error: unknown) =>
            console.warn(
              "[MainScreen] Panel tree fallback refresh failed:",
              error,
            ),
          );
      },
    );
    return () => {
      unsubNavigate();
      unsubCreated();
      unsubNav();
      unsubWorkspaceRevision();
      for (const name of eventNames) {
        void shellClient.events.unsubscribe(name).catch(() => {});
      }
    };
  }, [activatePanel, refreshTree, shellClient]);
  useEffect(() => {
    if (!activePanelId || !shellClient) return;
    void shellClient.panels.notifyFocused(activePanelId);
    webViewRefsMap.current
      .get(activePanelId)
      ?.dispatchHostEvent("runtime:focus", null);
  }, [activePanelId, shellClient]);
  // Activity on blur: when the active panel changes, bump the OUTGOING panel's
  // lastActive so "idle" means "since you last viewed it". The incoming panel
  // is already stamped on activation.
  const blurStampRef = useRef<string | null>(activePanelId);
  useEffect(() => {
    const previous = blurStampRef.current;
    blurStampRef.current = activePanelId;
    if (previous && previous !== activePanelId) {
      updateWebViewStack((stack) =>
        stack.map((entry) =>
          entry.panelId === previous
            ? { ...entry, lastActive: Date.now() }
            : entry,
        ),
      );
    }
  }, [activePanelId]);
  // Hydrate persisted pins once the workspace id is known. Gate the sweep on
  // `pinsHydrated` so a freshly reloaded app doesn't GC a just-restored pin in
  // the first tick.
  useEffect(() => {
    const workspaceId = shellClient?.workspaceId;
    if (!workspaceId) return;
    let cancelled = false;
    void loadPinnedPanelIds(shellClient.localStorageScope, workspaceId)
      .then((ids) => {
        if (cancelled) return;
        setPinnedPanelIds(new Set(ids));
        setPinsHydrated(true);
      })
      .catch((error: unknown) => {
        console.warn("[MainScreen] Failed to restore pinned panels:", error);
        if (cancelled) return;
        setPinnedPanelIds(new Set());
        setPinsHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [shellClient, setPinnedPanelIds, setPinsHydrated]);
  // Track foreground state for the idle sweep (a backgrounded app never GCs).
  useEffect(() => {
    isForegroundRef.current = AppState.currentState === "active";
    const sub = AppState.addEventListener("change", (state) => {
      isForegroundRef.current = state === "active";
    });
    return () => sub.remove();
  }, []);
  // Idle GC sweep: unload panels inactive for PANEL_UI_IDLE_UNLOAD_MS, pin- and
  // keepLoaded-aware, foreground-gated. Mirrors the desktop sweep.
  useEffect(() => {
    if (!shellClient || !pinsHydrated) return;
    const predicates = buildStackPredicates();
    const sweepTimer = setInterval(() => {
      updateWebViewStack((prev) =>
        sweepIdleWebViews(prev, {
          now: Date.now(),
          // Read activePanelId via ref so the interval isn't recreated on every
          // panel switch — that would reset the sweep countdown and, for an
          // actively-used app, mean it rarely (or never) reaches a tick.
          activePanelId: activePanelIdRef.current,
          foreground: isForegroundRef.current,
          unload: (id) => {
            void shellClient.panels.unload(id).catch((error: unknown) =>
              pushToast({
                title: "Could not unload panel",
                message: error instanceof Error ? error.message : "Try again.",
                tone: "danger",
              }),
            );
          },
          ...predicates,
        }),
      );
    }, PANEL_UI_IDLE_SWEEP_MS);
    return () => clearInterval(sweepTimer);
  }, [buildStackPredicates, pinsHydrated, pushToast, shellClient]);
  useEffect(() => {
    const mode = colorScheme === "light" ? "light" : "dark";
    syncManagedWebViewThemes(
      webViewStack,
      webViewRefsMap.current,
      webViewThemeSignaturesRef.current,
      mode,
    );
  }, [colorScheme, webViewStack]);
  useEffect(() => {
    if (!activePanelId) return;
    if (activePanelLeasedElsewhere) return;
    if (
      !webViewStack.some((entry) => entry.panelId === activePanelId) &&
      !pendingPanelLoads.current.has(activePanelId)
    ) {
      activatePanel(activePanelId);
    }
  }, [activePanelId, activePanelLeasedElsewhere, activatePanel, webViewStack]);
  useEffect(() => {
    if (!shellClient) return;
    updateWebViewStack((prev) =>
      prev.filter((entry) => {
        const lease = shellClient.panels.registry.getRuntimeLease(
          entry.panelId,
        );
        return (
          !lease || lease.clientSessionId === shellClient.credentials.deviceId
        );
      }),
    );
  }, [panelTreeRevision, shellClient]);
  useEffect(() => {
    if (!shellClient) return;
    if (activePanelId && shellClient.panels.registry.getPanel(activePanelId))
      return;
    const firstRootId = shellClient.panels.getPreferredRootId();
    setActivePanelId(firstRootId);
  }, [activePanelId, panelTreeRevision, setActivePanelId, shellClient]);
  const handleMenuPress = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
  const handlePanelCreated = useCallback(
    (panelId: string) => {
      activatePanel(panelId);
    },
    [activatePanel],
  );
  const handleActiveBack = useCallback(() => {
    if (!activePanelId) return;
    pendingHistoryIntentByPanel.current.set(
      activePanelId,
      requireBrowserNavigationIntent("back"),
    );
    webViewRefsMap.current.get(activePanelId)?.goBack();
  }, [activePanelId]);
  const handleActiveForward = useCallback(() => {
    if (!activePanelId) return;
    pendingHistoryIntentByPanel.current.set(
      activePanelId,
      requireBrowserNavigationIntent("forward"),
    );
    webViewRefsMap.current.get(activePanelId)?.goForward();
  }, [activePanelId]);
  const handleActiveReload = useCallback(() => {
    if (!activePanelId) return;
    const currentUrl = webViewNavigation[activePanelId]?.url;
    if (currentUrl)
      pendingHistoryIntentByUrl.current.set(
        canonicalHistoryKey(currentUrl),
        requireBrowserNavigationIntent("reload-panel"),
      );
    webViewRefsMap.current.get(activePanelId)?.reload();
  }, [activePanelId, webViewNavigation]);
  const handleActiveStop = useCallback(() => {
    if (!activePanelId) return;
    webViewRefsMap.current.get(activePanelId)?.stop();
  }, [activePanelId]);
  const performPanelCommand = useCallback(
    (command: PanelCommandId, panelId = activePanelId) => {
      if (!shellClient || !panelId) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      switch (command) {
        case "back":
          pendingHistoryIntentByPanel.current.set(
            panelId,
            requireBrowserNavigationIntent("back"),
          );
          webViewRefsMap.current.get(panelId)?.goBack();
          return;
        case "forward":
          pendingHistoryIntentByPanel.current.set(
            panelId,
            requireBrowserNavigationIntent("forward"),
          );
          webViewRefsMap.current.get(panelId)?.goForward();
          return;
        case "reload-panel":
        case "reload-view":
        case "force-reload-view":
        case "rebuild-panel":
          {
            const currentUrl = webViewNavigation[panelId]?.url;
            if (currentUrl)
              pendingHistoryIntentByUrl.current.set(
                canonicalHistoryKey(currentUrl),
                requireBrowserNavigationIntent("reload-panel"),
              );
          }
          webViewRefsMap.current.get(panelId)?.reload();
          return;
        case "stop":
          webViewRefsMap.current.get(panelId)?.stop();
          return;
        case "copy-address": {
          const address =
            panelId === activePanelId
              ? activeChromeState?.editableAddress
              : panel
                ? getCurrentSnapshot(panel).source
                : undefined;
          if (address) {
            copyToClipboard(address);
            pushToast({
              title: "Address copied",
              message: address,
              tone: "success",
            });
          }
          return;
        }
        case "share-address": {
          const address =
            panelId === activePanelId
              ? activeChromeState?.editableAddress
              : panel
                ? getCurrentSnapshot(panel).source
                : undefined;
          if (address) {
            void shareText(
              address,
              panel?.title ?? activePanelTitle ?? "Panel",
            ).catch((error: unknown) =>
              pushToast({
                title: "Could not share panel",
                message: error instanceof Error ? error.message : "Try again.",
                tone: "danger",
              }),
            );
          }
          return;
        }
        case "open-external": {
          const url =
            panelId === activePanelId
              ? activeChromeState?.resolvedUrl
              : panel
                ? getCurrentSnapshot(panel).resolvedUrl
                : undefined;
          if (url && /^https?:\/\//i.test(url)) void openExternalUrl(url);
          return;
        }
        case "duplicate": {
          if (!panel) return;
          const snapshot = getCurrentSnapshot(panel);
          if (isBrowserPanelSource(snapshot.source)) {
            const url =
              panelId === activePanelId
                ? activeChromeState?.resolvedUrl
                : snapshot.source.slice("browser:".length);
            if (url)
              void shellClient.panels
                .createBrowserUrlPanel(null, url, { focus: true })
                .then((result) => activatePanel(result.id));
          } else {
            void shellClient.panels
              .createRootPanel(snapshot.source)
              .then((result) => activatePanel(result.id));
          }
          return;
        }
        case "toggle-pin":
          togglePanelPin(panelId);
          return;
        case "unload":
          void shellClient.panels.unload(panelId).catch((error: unknown) =>
            pushToast({
              title: "Could not unload panel",
              message: error instanceof Error ? error.message : "Try again.",
              tone: "danger",
            }),
          );
          updateWebViewStack((prev) =>
            prev.filter((entry) => entry.panelId !== panelId),
          );
          return;
        case "archive":
          void shellClient.panels.archive(panelId).then(refreshTree);
          return;
        case "focus-address":
          setAddressBarVisible(true);
          return;
      }
    },
    [
      activatePanel,
      activeChromeState,
      activePanelId,
      activePanelTitle,
      pushToast,
      refreshTree,
      shellClient,
      togglePanelPin,
      webViewNavigation,
    ],
  );
  const showPanelActions = useCallback(
    (panelId = activePanelId) => {
      if (!shellClient || !panelId) return;
      const panel = shellClient.panels.registry.getPanel(panelId);
      const chrome =
        panelId === activePanelId
          ? activeChromeState
          : panel
            ? buildPanelChromeState({ panel })
            : null;
      const commands = getAvailablePanelCommands(
        { chrome, addressBarVisible, isPinned: pinnedPanelIds.has(panelId) },
        [
          "back",
          "forward",
          "reload-panel",
          "reload-view",
          "force-reload-view",
          "rebuild-panel",
          "stop",
          "copy-address",
          "share-address",
          "open-external",
          "duplicate",
          "toggle-pin",
          "unload",
          "archive",
        ],
      );
      const contributedCommands = presentMobileHostCommands(
        shellClient.hostCommands.get(panelId),
      );
      const isPinned = pinnedPanelIds.has(panelId);
      showActionSheet({
        title: panel?.title ?? "Panel",
        subtitle: chrome?.editableAddress,
        items: [
          ...contributedCommands.map((command) => ({
            ...command,
            icon: HostCommandIcon,
          })),
          ...commands.map((command) => {
            const presentation = PANEL_COMMAND_PRESENTATION[command.id];
            return {
              id: command.id,
              label: command.label,
              description: command.description,
              icon:
                command.id === "toggle-pin" && isPinned
                  ? PinOffIcon
                  : presentation?.icon,
              tone:
                command.id === "archive"
                  ? ("danger" as const)
                  : ("default" as const),
            };
          }),
        ],
        onSelect: (id) => {
          const commandId = contributedHostCommandId(id);
          if (!commandId) {
            performPanelCommand(id as PanelCommandId, panelId);
            return;
          }
          const webView = webViewRefsMap.current.get(panelId);
          if (!webView) {
            pushToast({
              title: "Panel command is not ready",
              message: "Wait for the panel to finish loading, then try again.",
              tone: "warning",
            });
            return;
          }
          webView.dispatchHostEvent(HOST_COMMAND_RUN_EVENT, { commandId });
        },
      });
    },
    [
      activeChromeState,
      activePanelId,
      addressBarVisible,
      performPanelCommand,
      pinnedPanelIds,
      pushToast,
      shellClient,
      showActionSheet,
    ],
  );
  // ---- Command sheet + quickfire sheet (quickfire-overlay-spec §7) ---------
  const openCommandSheet = useSetAtom(openCommandSheetAtom);
  const openQuickfireSheet = useSetAtom(openQuickfireSheetAtom);

  /**
   * The "already open" index, read from the cache the drawer already renders so
   * the sheet issues no tree RPCs of its own and cannot disagree with it.
   */
  const openPanelEntries = useMemo(() => {
    if (!shellClient) return [];
    return collectMobileOpenPanels(shellClient.panels.treeCache);
  }, [panelTreeRevision, shellClient]);

  /** What the slate's availability predicates read about the acted-on panel. */
  const focusedPanelDescriptor = useMemo<PanelDescriptor | undefined>(() => {
    if (!shellClient || !activePanelId) return undefined;
    const panel = shellClient.panels.registry.getPanel(activePanelId);
    const source = panel ? getCurrentSnapshot(panel).source : undefined;
    const isBrowser = source ? isBrowserPanelSource(source) : false;
    return {
      panelId: activePanelId,
      title: panel?.title ?? activePanelTitle,
      ...(source ? { source } : {}),
      kind: isBrowser ? ("browser" as const) : ("workspace" as const),
      canGoBack: activeChromeState?.canGoBack === true,
      canGoForward: activeChromeState?.canGoForward === true,
      pinned: pinnedPanelIds.has(activePanelId),
      // A browser panel's address belongs to the address bar, not a share link.
      addressable: !isBrowser,
    };
  }, [
    activeChromeState,
    activePanelId,
    activePanelTitle,
    panelTreeRevision,
    pinnedPanelIds,
    shellClient,
  ]);

  const contributedCommandContributions = useMemo(() => {
    if (!shellClient || !activePanelId) return [];
    const commands = shellClient.hostCommands.get(activePanelId);
    return commands.length ? [{ panelId: activePanelId, commands }] : [];
  }, [activePanelId, panelTreeRevision, shellClient]);

  const dispatchContributedCommand = useCallback(
    (panelId: string, commandId: string) => {
      const webView = webViewRefsMap.current.get(panelId);
      if (!webView) return false;
      webView.dispatchHostEvent(HOST_COMMAND_RUN_EVENT, { commandId });
      return true;
    },
    [],
  );

  /**
   * A tapped inbox push (messaging plan §4.10.9): open the conversation sheet on
   * the escalated envelope — same quickfire core, bound to that channel — and
   * acknowledge the entry, which is exactly what opening it on the desktop does.
   */
  const [inboxDeepLink, setInboxDeepLink] = useAtom(inboxDeepLinkAtom);
  useEffect(() => {
    if (!inboxDeepLink || !shellClient) return;
    const link = inboxDeepLink;
    setInboxDeepLink(null);
    void (async () => {
      try {
        if (link.channelId) {
          const conversation =
            await shellClient.userNotifications.describeConversation(
              link.channelId,
            );
          openQuickfireSheet({
            conversation: {
              channelId: link.channelId,
              contextId: conversation.contextId,
              ...(link.messageId ? { focusMessageId: link.messageId } : {}),
              ...(link.senderParticipantId
                ? {
                    replyTo: {
                      participantId: link.senderParticipantId,
                      ...(link.senderHandle
                        ? { handle: link.senderHandle }
                        : {}),
                    },
                  }
                : {}),
              ...(conversation.title ? { title: conversation.title } : {}),
            },
          });
        }
        await shellClient.userNotifications.acknowledge(link.notificationId);
      } catch (error) {
        pushToast({
          title: "Could not open the message",
          message: error instanceof Error ? error.message : String(error),
          tone: "warning",
        });
      }
    })();
  }, [
    inboxDeepLink,
    openQuickfireSheet,
    pushToast,
    setInboxDeepLink,
    shellClient,
  ]);

  const showQuickfireConversations = useCallback(
    (rows: Parameters<MobileSlateDeps["showQuickfireConversations"]>[0]) => {
      showActionSheet({
        title: "Quickfire agent conversations",
        items: rows.map((row) => ({
          id: row.slotId,
          label:
            shellClient?.panels.registry.getPanel(row.slotId)?.title ??
            row.slotId,
          description:
            row.promotedAt === null
              ? "conversation"
              : "continued in a chat panel",
        })),
        onSelect: (slotId) => {
          activatePanel(slotId);
          openQuickfireSheet({ slotId });
        },
      });
    },
    [activatePanel, openQuickfireSheet, shellClient, showActionSheet],
  );

  /**
   * Show a promoted conversation as a chat panel. `openChannel` finds the panel
   * this device already opened for the channel before creating another, which
   * is what keeps promotion a view change rather than a duplicate. Declared
   * before `slateDeps` because the slate's `quickfire.promote` routes through
   * the same path as the sheet's ⧉ — one promotion behavior, not two.
   */
  const openChatPanelForChannel = useCallback(
    async (channelId: string) => {
      if (!shellClient) return;
      const opened = await shellClient.userNotifications.openChannel(channelId);
      activatePanel(opened.id);
      refreshTree();
    },
    [activatePanel, refreshTree, shellClient],
  );

  const slateDeps = useMemo<MobileSlateDeps | null>(() => {
    if (!shellClient) return null;
    return {
      activePanelId,
      panels: shellClient.panels,
      quickfire: shellClient.quickfire,
      performPanelCommand,
      navigateToPanel: activatePanel,
      setThemePreference,
      copyText: copyToClipboard,
      openWorkspaceSettings: () =>
        navigation
          .getParent<StackNavigationProp<RootStackParamList>>()
          ?.navigate("Settings", {
            workspaceId: shellClient.workspaceId ?? undefined,
          }),
      showQuickfireConversations,
      openChatPanelForChannel,
    };
  }, [
    openChatPanelForChannel,
    activatePanel,
    activePanelId,
    navigation,
    performPanelCommand,
    setThemePreference,
    shellClient,
    showQuickfireConversations,
  ]);

  /**
   * The quickfire service plus a channel join. Stable across renders so the
   * session core never re-resolves a conversation because a callback changed.
   */
  const quickfireTransport = useMemo<QuickfireTransport | null>(() => {
    if (!shellClient) return null;
    return {
      sessionFor: (slotId, options) =>
        shellClient.quickfire.sessionFor(slotId, options),
      clear: (slotId) => shellClient.quickfire.clear(slotId),
      promote: (slotId) => shellClient.quickfire.promote(slotId),
      connectToChannel: (channelId, contextId, options) =>
        shellClient.connectToChannel(channelId, contextId, options),
    };
  }, [shellClient]);

  const openWorkspacePanelLink = useCallback(
    (
      workspaceId: string,
      source: string,
      options: Parameters<ShellClient["panels"]["createRootPanel"]>[1],
    ) => {
      if (!workspaceDirectory) return;
      void workspaceDirectory
        .openPanelSource(workspaceId, source, options)
        .catch((error: unknown) => {
          pushToast({
            title: "Could not open panel link",
            message:
              error instanceof Error
                ? error.message
                : "The workspace is unavailable.",
            tone: "danger",
          });
        });
    },
    [workspaceDirectory, pushToast],
  );

  const executeAddressAction = useCallback(
    (action: AddressAction, mode: AddressNavigationMode = "current") => {
      if (!shellClient) return;
      const targetMode = mode;
      if (action.type === "panel-location") {
        const location = action.location;
        const locationMode =
          mode === "current" ? (location.disposition ?? mode) : mode;
        if (locationMode === "external") {
          if (action.raw) void openExternalUrl(action.raw);
          return;
        }
        if (
          location.workspace &&
          location.workspace !== shellClient.workspaceId
        ) {
          openWorkspacePanelLink(location.workspace, location.source, {
            ref: location.ref,
            contextId: location.contextId,
            stateArgs: location.stateArgs,
            title: location.title,
            slug: location.slug,
            focus: true,
          });
          return;
        }
        const common = {
          ref: location.ref,
          contextId: location.contextId,
          stateArgs: location.stateArgs,
        };
        const operation =
          locationMode === "current" && activePanelId
            ? shellClient.panels.navigatePanel(
                activePanelId,
                location.source,
                common,
              )
            : locationMode === "child" && activePanelId
              ? shellClient.panels.createChildPanel(
                  activePanelId,
                  location.source,
                  {
                    ...common,
                    title: location.title,
                    slug: location.slug,
                    focus: location.focus ?? true,
                  },
                )
              : shellClient.panels.createRootPanel(location.source, {
                  ...common,
                  title: location.title,
                  slug: location.slug,
                  focus: location.focus ?? true,
                });
        void operation
          .then((result) => {
            refreshTree();
            if (location.focus !== false) activatePanel(result.id);
          })
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Could not open panel link.",
              tone: "danger",
            }),
          );
        return;
      }
      if (action.type === "navigate-url") {
        const intent = getBrowserNavigationIntentForAddressAction(action);
        if (intent)
          pendingHistoryIntentByUrl.current.set(
            canonicalHistoryKey(action.url),
            intent,
          );
        if (targetMode === "external") {
          void openExternalUrl(action.url);
        } else if (targetMode === "child" && activePanelId) {
          void shellClient.panels
            .createBrowserUrlPanel(activePanelId, action.url, { focus: true })
            .catch((error: unknown) =>
              pushToast({
                title: "Navigation failed",
                message:
                  error instanceof Error
                    ? error.message
                    : "Could not open browser panel.",
                tone: "danger",
              }),
            );
        } else if (targetMode === "root") {
          void shellClient.panels
            .createBrowserUrlPanel(null, action.url, { focus: true })
            .then((result) => activatePanel(result.id))
            .catch((error: unknown) =>
              pushToast({
                title: "Navigation failed",
                message:
                  error instanceof Error
                    ? error.message
                    : "Could not open browser panel.",
                tone: "danger",
              }),
            );
        } else {
          if (!activePanelId) return;
          const active = shellClient.panels.registry.getPanel(activePanelId);
          if (
            active &&
            isBrowserPanelSource(getCurrentSnapshot(active).source)
          ) {
            updateWebViewStack((prev) =>
              prev.map((entry) =>
                entry.panelId === activePanelId
                  ? { ...entry, url: action.url }
                  : entry,
              ),
            );
            setWebViewNavigation((prev) => ({
              ...prev,
              [activePanelId]: {
                ...(prev[activePanelId] as WebViewNavigation | undefined),
                url: action.url,
              } as WebViewNavigation,
            }));
          } else {
            void shellClient.panels
              .createBrowserUrlPanel(activePanelId, action.url, { focus: true })
              .catch((error: unknown) =>
                pushToast({
                  title: "Navigation failed",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Could not open browser panel.",
                  tone: "danger",
                }),
              );
          }
        }
        return;
      }
      if (action.type === "search" || action.type === "keyword-search") {
        const url = applySearchTemplate(action.query, action.template);
        const intent = getBrowserNavigationIntentForAddressAction(action);
        if (intent)
          pendingHistoryIntentByUrl.current.set(
            canonicalHistoryKey(url),
            intent,
          );
        if (targetMode === "external") {
          void openExternalUrl(url);
          return;
        }
        if (targetMode === "current" && activePanelId) {
          const active = shellClient.panels.registry.getPanel(activePanelId);
          if (
            active &&
            isBrowserPanelSource(getCurrentSnapshot(active).source)
          ) {
            updateWebViewStack((prev) =>
              prev.map((entry) =>
                entry.panelId === activePanelId ? { ...entry, url } : entry,
              ),
            );
            setWebViewNavigation((prev) => ({
              ...prev,
              [activePanelId]: {
                ...(prev[activePanelId] as WebViewNavigation | undefined),
                url,
              } as WebViewNavigation,
            }));
            return;
          }
        }
        void shellClient.panels
          .createBrowserUrlPanel(
            targetMode === "child" ? activePanelId : null,
            url,
            {
              focus: true,
            },
          )
          .then((result) => activatePanel(result.id))
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message:
                error instanceof Error ? error.message : "Could not search.",
              tone: "danger",
            }),
          );
        return;
      }
      if (action.type === "panel-source") {
        const ref = action.ref ?? undefined;
        const created =
          targetMode === "current" && activePanelId
            ? shellClient.panels.navigatePanel(activePanelId, action.source, {
                ref,
              })
            : targetMode === "child" && activePanelId
              ? shellClient.panels.createChildPanel(
                  activePanelId,
                  action.source,
                  {
                    focus: true,
                    ref,
                  },
                )
              : shellClient.panels.createRootPanel(action.source, { ref });
        void created
          .then((result) => activatePanel(result.id))
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Could not open panel.",
              tone: "danger",
            }),
          );
      }
    },
    [
      activatePanel,
      activePanelId,
      openWorkspacePanelLink,
      pushToast,
      refreshTree,
      shellClient,
      webViewNavigation,
    ],
  );
  const openShellSurface = useCallback(
    (target: MobileShellSurface) => {
      if (!shellClient || !workspaceDirectory)
        throw new Error("The workspace is unavailable");
      if (target.kind === "workspace-chooser") {
        if (target.template)
          workspaceDirectory.requestWorkspaceCreation(target.template);
        else navigation.dispatch(DrawerActions.openDrawer());
        return;
      }
      const workspaceId = target.workspaceId ?? shellClient.workspaceId;
      if (
        !workspaceId ||
        !workspaceDirectory.entries.some(
          (entry) => entry.workspaceId === workspaceId,
        )
      ) {
        throw new Error("You no longer have access to the selected workspace");
      }
      const parent =
        navigation.getParent<StackNavigationProp<RootStackParamList>>();
      if (!parent) throw new Error("Mobile settings navigation is unavailable");
      parent.push("Settings", { workspaceId, section: target.section });
    },
    [navigation, shellClient, workspaceDirectory],
  );
  useEffect(
    () => shellClient?.onOpenShellSurface(openShellSurface),
    [shellClient, openShellSurface],
  );

  const handleShellSurfaceLink = useCallback(
    (url: string): boolean => {
      const parsed = parseShellSurfaceLink(url);
      if (parsed.kind === "unrelated") return false;
      try {
        if (parsed.kind === "error") throw new Error(parsed.reason);
        if (!shellClient) throw new Error("The workspace is unavailable");
        shellClient.openShellSurface(parsed.target);
      } catch (error) {
        pushToast({
          title: "Could not open link",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      }
      return true;
    },
    [pushToast, shellClient],
  );
  const handleNavigateAddress = useCallback(
    (value: string, mode: AddressNavigationMode = "current") => {
      if (!shellClient) return;
      if (mode !== "external" && handleShellSurfaceLink(value)) return;
      const parsed = parseAddressInput(value);
      if (!parsed) return;
      if (parsed.type === "panel-location") {
        const location = parsed.location;
        const targetMode =
          mode === "current" ? (location.disposition ?? mode) : mode;
        if (targetMode === "external") {
          void openExternalUrl(value);
          return;
        }
        if (
          location.workspace &&
          location.workspace !== shellClient.workspaceId
        ) {
          openWorkspacePanelLink(location.workspace, location.source, {
            ref: location.ref,
            contextId: location.contextId,
            stateArgs: location.stateArgs,
            title: location.title,
            slug: location.slug,
            focus: true,
          });
          return;
        }
        const common = {
          ref: location.ref,
          contextId: location.contextId,
          stateArgs: location.stateArgs,
        };
        const created =
          targetMode === "current" && activePanelId
            ? shellClient.panels.navigatePanel(
                activePanelId,
                location.source,
                common,
              )
            : targetMode === "child" && activePanelId
              ? shellClient.panels.createChildPanel(
                  activePanelId,
                  location.source,
                  {
                    ...common,
                    title: location.title,
                    slug: location.slug,
                    focus: location.focus ?? true,
                  },
                )
              : shellClient.panels.createRootPanel(location.source, {
                  ...common,
                  title: location.title,
                  slug: location.slug,
                  focus: location.focus ?? true,
                });
        void created
          .then((result) => {
            refreshTree();
            if (location.focus !== false) activatePanel(result.id);
          })
          .catch((error: unknown) =>
            pushToast({
              title: "Navigation failed",
              message:
                error instanceof Error
                  ? error.message
                  : "Could not open panel link.",
              tone: "danger",
            }),
          );
        return;
      }
      if (parsed.type === "browser-url") {
        executeAddressAction(
          { type: "navigate-url", url: parsed.url, recordAsTyped: true },
          mode,
        );
        return;
      }
      if (parsed.type === "panel-source") {
        executeAddressAction(
          { type: "panel-source", source: parsed.source },
          mode,
        );
        return;
      }
      if (parsed.type === "search") {
        executeAddressAction(
          {
            type: "search",
            query: parsed.query,
            template: "https://www.google.com/search?q=%s",
            recordAsTyped: true,
          },
          mode,
        );
      }
    },
    [
      activePanelId,
      executeAddressAction,
      handleShellSurfaceLink,
      openWorkspacePanelLink,
      shellClient,
    ],
  );
  const handlePanelNavigate = useCallback(
    (event: PanelNavigationEvent) => {
      if (!shellClient) return;
      if (event.workspace && event.workspace !== shellClient.workspaceId) {
        openWorkspacePanelLink(event.workspace, event.source, {
          ref: event.ref ?? event.options.ref,
          contextId: event.contextId ?? event.options.contextId,
          stateArgs: event.stateArgs,
          title: event.options.title,
          slug: event.options.slug,
          name: event.options.name,
          focus: true,
        });
        return;
      }
      const common = {
        ref: event.ref ?? event.options.ref,
        contextId: event.contextId ?? event.options.contextId,
        stateArgs: event.stateArgs,
      };
      const operation =
        event.disposition === "child"
          ? shellClient.panels.createChildPanel(event.panelId, event.source, {
              ...common,
              title: event.options.title,
              slug: event.options.slug,
              name: event.options.name,
              focus: event.options.focus ?? true,
            })
          : event.disposition === "root"
            ? shellClient.panels.createRootPanel(event.source, {
                ...common,
                title: event.options.title,
                slug: event.options.slug,
                name: event.options.name,
                focus: event.options.focus ?? true,
              })
            : shellClient.panels.navigatePanel(
                event.panelId,
                event.source,
                common,
              );
      void operation
        .then((result) => {
          refreshTree();
          if (event.options.focus !== false) {
            activatePanel(result.id);
          }
        })
        .catch((error: unknown) => {
          pushToast({
            title: "Panel navigation failed",
            message:
              error instanceof Error ? error.message : "Could not open panel.",
            tone: "danger",
          });
        });
    },
    [
      activatePanel,
      openWorkspacePanelLink,
      pushToast,
      refreshTree,
      shellClient,
    ],
  );
  const handlePanelTitleChange = useCallback(
    (panelId: string, title: string) => {
      if (!shellClient) return;
      const navUrl = webViewNavigationRef.current[panelId]?.url;
      const panel = shellClient.panels.registry.getPanel(panelId);
      if (
        navUrl &&
        panel &&
        isBrowserPanelSource(getCurrentSnapshot(panel).source)
      ) {
        void shellClient.panels
          .updateHistoryTitle({ url: navUrl, title })
          .catch((error: unknown) =>
            console.warn(
              `[MainScreen] Failed to update history title for ${panelId}:`,
              error,
            ),
          );
      }
      void shellClient.panels
        .updateTitle(panelId, title)
        .then(refreshTree)
        .catch((error: unknown) => {
          console.warn(
            `[MainScreen] Failed to update title for panel ${panelId}:`,
            error,
          );
        });
    },
    [refreshTree, shellClient],
  );
  const handlePanelBootObservation = useCallback(
    (
      panelId: string,
      runtimeEntityId: PanelEntityId,
      connectionId: string,
      observation: PanelPageObservation,
    ) => {
      if (!shellClient) return;
      const phase =
        observation.boot.kind === "observed"
          ? observation.boot.observation.phase
          : "probe-unavailable";
      // Local boot observation is the smoke's presentation evidence. Do not
      // couple it to reportView's state mutation: after an app restart the
      // same authoritative runtime attempt may already be terminal-ready, so
      // replaying loading/booting/ready is correctly rejected as non-monotonic.
      if (phase === "ready") {
        console.log("[VibestudioMobileSmoke] phase=workspace-panel-ready");
      }
      void shellClient.panels
        .reportView(runtimeEntityId, connectionId, observation)
        .then((result) => {
          if (result === "reported" && hostConfig?.protocol === "http") {
            console.log(`[MainScreen] Reported panel boot for ${panelId}`, {
              phase,
              runtimeEntityId,
              connectionId,
            });
          }
        })
        .catch((error: unknown) => {
          console.warn(
            `[MainScreen] Failed to report panel boot for ${panelId}:`,
            error,
          );
        });
    },
    [hostConfig?.protocol, shellClient],
  );
  const recordMobileBrowserNavigation = useCallback(
    (panelId: string, navState: WebViewNavigation) => {
      if (!shellClient || !/^https?:\/\//i.test(navState.url)) return;
      const key = canonicalHistoryKey(navState.url);
      const intent = pendingHistoryIntentByUrl.current.get(key) ??
        pendingHistoryIntentByPanel.current.get(panelId) ?? {
          transition: "link",
          typed: false,
        };
      pendingHistoryIntentByUrl.current.delete(key);
      pendingHistoryIntentByPanel.current.delete(panelId);
      const duplicateKey = `${panelId}:${key}:${intent.transition ?? "link"}`;
      const now = Date.now();
      const previous = recentHistoryRecords.current.get(duplicateKey);
      if (previous && now - previous < 1000) return;
      recentHistoryRecords.current.set(duplicateKey, now);
      void shellClient.panels
        .recordHistoryVisit({
          url: navState.url,
          title: navState.title,
          transition: intent.transition,
          typed: intent.typed,
          visitTime: now,
        })
        .catch((error: unknown) =>
          console.warn("[MainScreen] Failed to record browser history:", error),
        );
    },
    [shellClient],
  );
  const handleWebViewNavigationStateChange = useCallback(
    (panelId: string, managed: boolean, navState: WebViewNavigation) => {
      setWebViewNavigation((prev) => ({
        ...prev,
        [panelId]: navState,
      }));
      if (!managed && /^https?:\/\//i.test(navState.url)) {
        void shellClient?.panels
          .updateBrowserUrl(panelId, navState.url)
          .catch((error: unknown) =>
            console.warn("[MainScreen] Failed to update browser URL:", error),
          );
        recordMobileBrowserNavigation(panelId, navState);
      }
    },
    [recordMobileBrowserNavigation, shellClient],
  );
  const handleBridgeCall = useCallback(
    async (panelId: string, method: string, args: unknown[]) => {
      if (!shellClient) throw new Error("Shell client not available");
      const result = await shellClient.handlePanelBridgeCall(
        panelId,
        method,
        args,
      );
      refreshTree();
      return result;
    },
    [refreshTree, shellClient],
  );
  useEffect(() => {
    if (Platform.OS !== "android" || !workspaceVisible) return;
    const onBackPress = () => {
      const action = resolveMobileBackAction({
        drawerOpen: !persistentNavigation && drawerStatus === "open",
        addressBarVisible,
        browserCanGoBack: Boolean(
          activePanelId && webViewNavigation[activePanelId]?.canGoBack,
        ),
        parentPanelId: activePanelParentId,
      });
      switch (action) {
        case "close-address":
          setAddressBarVisible(false);
          return true;
        case "browser-back":
          if (!activePanelId) return false;
          pendingHistoryIntentByPanel.current.set(
            activePanelId,
            requireBrowserNavigationIntent("back"),
          );
          webViewRefsMap.current.get(activePanelId)?.goBack();
          return true;
        case "parent-panel":
          if (!activePanelParentId) return false;
          activatePanel(activePanelParentId);
          return true;
        case "system":
          return false;
      }
    };
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      onBackPress,
    );
    return () => subscription.remove();
  }, [
    workspaceVisible,
    activePanelId,
    activePanelParentId,
    activatePanel,
    addressBarVisible,
    drawerStatus,
    persistentNavigation,
    webViewNavigation,
  ]);
  const handleRepair = useCallback(() => {
    Alert.alert(
      "Re-pair this device?",
      "This removes the saved connection. Try Reconnect first if the server is temporarily unavailable.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Re-pair",
          style: "destructive",
          onPress: () =>
            void clearShellCredential()
              .then(() => resetToNativeBootstrap())
              .catch((error) =>
                Alert.alert(
                  "Re-pair failed",
                  error instanceof Error
                    ? error.message
                    : "Could not return to the pairing screen.",
                ),
              ),
        },
      ],
    );
  }, []);
  const currentUserNotification = userNotifications[0] ?? null;
  const currentChannelInvite = currentUserNotification
    ? channelInviteFromNotification(currentUserNotification)
    : null;
  const dismissUserNotification = useCallback(async () => {
    if (!shellClient || !currentUserNotification) return;
    try {
      await shellClient.userNotifications.acknowledge(
        currentUserNotification.id,
      );
      setUserNotifications((current) =>
        current.filter(
          (notification) => notification.id !== currentUserNotification.id,
        ),
      );
    } catch (error) {
      pushToast({
        title: "Could not dismiss notification",
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    }
  }, [currentUserNotification, pushToast, shellClient]);
  const joinInvitedChannel = useCallback(async () => {
    if (!shellClient || !currentUserNotification || !currentChannelInvite)
      return;
    try {
      await shellClient.userNotifications.openChannel(
        currentChannelInvite.channelId,
      );
      await shellClient.userNotifications.acknowledge(
        currentUserNotification.id,
      );
      setUserNotifications((current) =>
        current.filter(
          (notification) => notification.id !== currentUserNotification.id,
        ),
      );
    } catch (error) {
      pushToast({
        title: "Could not open conversation",
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    }
  }, [currentChannelInvite, currentUserNotification, pushToast, shellClient]);
  // Inbox: the banner shows only the newest notification; this sheet lists all
  // of them. Selecting a channel invite joins it, anything else acknowledges.
  const openNotificationInbox = useCallback(() => {
    if (!shellClient || userNotifications.length === 0) return;
    showActionSheet({
      title: "Notifications",
      subtitle: `${userNotifications.length} waiting`,
      items: [
        ...userNotifications.map((notification) => {
          const invite = channelInviteFromNotification(notification);
          return {
            id: notification.id,
            label: notification.title,
            description:
              (notification.message ?? notification.kind) +
              (invite ? " — tap to join" : " — tap to dismiss"),
            icon: invite ? MessageCircleIcon : BellIcon,
          };
        }),
        {
          id: "__dismiss_all__",
          label: "Dismiss all",
          description: "Acknowledge every notification",
          tone: "danger" as const,
        },
      ],
      onSelect: (id) => {
        void (async () => {
          try {
            if (id === "__dismiss_all__") {
              for (const notification of userNotifications) {
                await shellClient.userNotifications.acknowledge(
                  notification.id,
                );
              }
              setUserNotifications([]);
              return;
            }
            const notification = userNotifications.find(
              (entry) => entry.id === id,
            );
            if (!notification) return;
            const invite = channelInviteFromNotification(notification);
            if (invite)
              await shellClient.userNotifications.openChannel(invite.channelId);
            await shellClient.userNotifications.acknowledge(notification.id);
            setUserNotifications((current) =>
              current.filter((entry) => entry.id !== id),
            );
          } catch (error) {
            pushToast({
              title: "Notification action failed",
              message: error instanceof Error ? error.message : String(error),
              tone: "danger",
            });
          }
        })();
      },
    });
  }, [pushToast, shellClient, showActionSheet, userNotifications]);
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar onRepair={handleRepair} />
      <AppBar
        title={activePanelTitle}
        approvalCount={workspaceDirectory?.approvalCount ?? 0}
        onApprovalsPress={() => workspaceDirectory?.openApprovals()}
        onMenuPress={handleMenuPress}
        showMenuButton={!persistentNavigation}
        onPanelCreated={handlePanelCreated}
        addressBarVisible={addressBarVisible}
        address={activeChromeState?.editableAddress ?? ""}
        isLoading={activeChromeState?.isLoading}
        canGoBack={activeChromeState?.canGoBack}
        canGoForward={activeChromeState?.canGoForward}
        onToggleAddressBar={() => setAddressBarVisible((visible) => !visible)}
        onBack={handleActiveBack}
        onForward={handleActiveForward}
        onReload={handleActiveReload}
        onStop={handleActiveStop}
        onNavigateAddress={handleNavigateAddress}
        addressSuggestions={addressSuggestions}
        onAddressQueryChange={setAddressQuery}
        onSelectAddressSuggestion={(item) => executeAddressAction(item.action)}
        onShowActions={() => showPanelActions()}
        onOpenCommands={() => openCommandSheet()}
        onOpenGoTo={() => openCommandSheet({ mode: "goto" })}
      />

      {currentUserNotification ? (
        <Pressable
          accessibilityLiveRegion="polite"
          accessibilityRole="button"
          accessibilityLabel={`Notification: ${currentUserNotification.title}. Tap to view all notifications.`}
          onPress={openNotificationInbox}
          style={({ pressed }) => [
            styles.userNotification,
            {
              backgroundColor: pressed ? colors.surfaceSunken : colors.surface,
              borderBottomColor: colors.borderSubtle,
            },
          ]}
        >
          <BellIcon size={17} color={colors.primary} />
          <View style={styles.userNotificationCopy}>
            <Text
              style={[styles.userNotificationTitle, { color: colors.text }]}
              numberOfLines={1}
            >
              {currentUserNotification.title}
            </Text>
            <Text
              style={[
                styles.userNotificationMessage,
                { color: colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {currentUserNotification.message ?? currentUserNotification.kind}
            </Text>
          </View>
          {userNotifications.length > 1 ? (
            <View
              style={[
                styles.userNotificationCountPill,
                { backgroundColor: colors.accentSoft },
              ]}
            >
              <Text style={[typeScale.micro, { color: colors.primary }]}>
                +{userNotifications.length - 1}
              </Text>
            </View>
          ) : null}
          {currentChannelInvite ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void joinInvitedChannel()}
              style={[
                styles.userNotificationButton,
                { borderColor: colors.primary },
              ]}
            >
              <Text
                style={[
                  styles.userNotificationButtonText,
                  { color: colors.primary },
                ]}
              >
                Join
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Dismiss ${currentUserNotification.title}`}
            onPress={() => void dismissUserNotification()}
            style={[
              styles.userNotificationButton,
              { borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.userNotificationButtonText,
                { color: colors.textSecondary },
              ]}
            >
              Dismiss
            </Text>
          </Pressable>
        </Pressable>
      ) : null}

      <View style={styles.contentArea}>
        {!activePanelId && (
          <EmptyState
            art={<VibestudioLogo size={76} variant="symbol" />}
            title="No panel selected"
            message="Swipe from the left edge or tap the menu button to pick a panel."
          />
        )}

        {loadingPanelId &&
          loadingPanelId === activePanelId &&
          !activePanelLoadError &&
          !webViewStack.some((entry) => entry.panelId === loadingPanelId) && (
            <View style={styles.loadingContainer}>
              <VibestudioLogo
                size={64}
                variant="symbol"
                style={styles.placeholderLogo}
              />
              <ActivityIndicator size="large" color={colors.primary} />
              <Text
                style={[styles.loadingText, { color: colors.textSecondary }]}
              >
                Loading panel…
              </Text>
            </View>
          )}

        {activePanelId &&
          activePanelLoadError &&
          !activePanelLeasedElsewhere &&
          !webViewStack.some((entry) => entry.panelId === activePanelId) && (
            <EmptyState
              art={<VibestudioLogo size={72} variant="symbol" />}
              title="Panel failed to load"
              message={activePanelLoadError}
              action={
                <Button
                  label="Retry"
                  variant="filled"
                  icon={RefreshCwIcon}
                  onPress={() => activatePanel(activePanelId)}
                />
              }
            />
          )}

        {activePanelId && activePanelLeasedElsewhere && (
          <EmptyState
            art={<VibestudioLogo size={72} variant="symbol" />}
            title={`Running on ${activeRuntimeLease?.holderLabel ?? "another client"}`}
            message="This panel is live on another device. Taking over moves it here."
            action={
              <Button
                label="Take over"
                variant="filled"
                onPress={takeOverActivePanel}
              />
            }
          />
        )}

        {!activePanelLeasedElsewhere &&
          browserProfile &&
          webViewStack.map((entry) => (
            <LoadedPanelWebView
              key={entry.panelId}
              entry={entry}
              browserProfile={browserProfile}
              onBrowserPermission={shellClient?.requestBrowserPermission}
              visible={entry.panelId === activePanelId}
              colors={colors}
              managedBasePath={hostConfig?.basePath ?? ""}
              diagnosticsEnabled={
                entry.managed && hostConfig?.protocol === "http"
              }
              onHandleChange={handleWebViewRef}
              onPanelNavigate={handlePanelNavigate}
              onShellSurfaceLink={handleShellSurfaceLink}
              onNavigationStateChange={handleWebViewNavigationStateChange}
              onTitleChange={handlePanelTitleChange}
              onBootObservation={handlePanelBootObservation}
              onBridgeCall={handleBridgeCall}
              onUnmount={handleWebViewUnmount}
            />
          ))}
      </View>
      {slateDeps ? (
        <CommandSheet
          slateDeps={slateDeps}
          {...(focusedPanelDescriptor
            ? { focusedPanel: focusedPanelDescriptor }
            : {})}
          openPanels={openPanelEntries}
          contributedCommands={contributedCommandContributions}
          runContributedCommand={dispatchContributedCommand}
        />
      ) : null}
      {quickfireTransport ? (
        <QuickfireSheet
          transport={quickfireTransport}
          panelTitle={activePanelTitle}
          openChatPanel={openChatPanelForChannel}
          // A link in agent prose opens beside the panel it is about, through
          // the same address grammar the address field uses — never by
          // replacing the panel the conversation is bound to, and never by
          // handing the person to the system browser for a workspace link.
          openLink={(href) => handleNavigateAddress(href, "child")}
        />
      ) : null}
      <Toast />
    </View>
  );
}
function canonicalHistoryKey(url: string): string {
  return canonicalizeBrowserHistoryUrl(url) ?? url;
}

function requireBrowserNavigationIntent(
  command: PanelCommandId,
): BrowserNavigationIntent {
  const intent = getBrowserNavigationIntentForCommand(command);
  if (!intent) {
    throw new Error(
      `Panel command ${command} does not have a browser navigation intent`,
    );
  }
  return intent;
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentArea: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
  userNotification: {
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  userNotificationCopy: {
    flex: 1,
    minWidth: 0,
  },
  userNotificationTitle: {
    fontSize: 14,
    fontWeight: "600",
  },
  userNotificationMessage: {
    fontSize: 12,
    marginTop: 2,
  },
  userNotificationCountPill: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  userNotificationButton: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  userNotificationButtonText: {
    fontSize: 13,
    fontWeight: "600",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  loadingText: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
  },
  placeholderLogo: {
    marginBottom: 18,
  },
});
