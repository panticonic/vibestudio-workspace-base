import { useEffect, useRef } from "react";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
import { presentWorkspaceNotification } from "../services/workspaceNotifications";
import {
  handleExternalOpen,
  type ExternalOpenPayload,
} from "../services/oauthLoopback";
import {
  handleMobileAppLifecycleEvent,
  type AppLifecyclePayload,
} from "../services/appUpdatePrompt";
import type { ToastInput } from "../state/toastAtoms";

/** Connected workspace events remain visible even before its panels are opened. */
export function WorkspaceSessionEffects({
  directory,
  session,
  notify,
  theme,
}: {
  directory: MobileWorkspaceDirectory;
  session: MobileWorkspaceSession;
  notify: (toast: ToastInput) => void;
  theme: "light" | "dark";
}) {
  const promptedAppUpdates = useRef(new Set<string>());
  useEffect(() => {
    void session.client.panels.updateTheme(theme).catch((error) => {
      console.warn("[WorkspaceSession] Failed to sync panel theme", error);
    });
  }, [session, theme]);

  useEffect(() => {
    const client = session.client;
    let active = true;
    const isAppSource = session.workspaceId === directory.systemWorkspaceId;
    const candidate = isAppSource
      ? client.hostLaunch.configuredCandidate("react-native")
      : Promise.resolve(null);
    void candidate.catch(() => undefined);
    const current = () =>
      active && directory.sessions.get(session.workspaceId) === session;
    const stopAppLifecycle = isAppSource
      ? client.events.on("apps:lifecycle", (payload) => {
          void candidate
            .then((selected) => {
              if (!current() || !selected) return;
              handleMobileAppLifecycleEvent(payload as AppLifecyclePayload, {
                shellClient: client,
                pushToast: (toast) => {
                  if (current()) notify(toast);
                },
                prompted: promptedAppUpdates.current,
                selectedSource: selected.source,
                selectedAppId: selected.name,
              });
            })
            .catch((error: unknown) => {
              if (current())
                console.warn(
                  "[WorkspaceSession] App lifecycle unavailable",
                  error,
                );
            });
        })
      : undefined;
    const present = (payload: unknown) => {
      if (!active || directory.sessions.get(session.workspaceId) !== session)
        return;
      const notification = payload as {
        id?: string;
        title?: string;
        message?: string;
        type?: string;
        consent?: {
          provider?: string;
          scopes?: string[];
          callerTitle?: string;
        };
      };
      const consent = notification.type === "consent" && notification.id;
      presentWorkspaceNotification(directory, notify, session.workspaceId, {
        id: notification.id,
        title:
          notification.title ??
          (consent ? "OAuth access requested" : "Vibestudio"),
        message: consent
          ? `${notification.consent?.callerTitle ?? "A panel"} wants to connect to ${notification.consent?.provider ?? "service"} (${notification.consent?.scopes?.join(", ") ?? "access"}).`
          : (notification.message ?? ""),
        tone: "info",
      });
    };
    const topics = [
      "notification:show",
      "external-open:open",
      ...(isAppSource ? ["apps:lifecycle" as const] : []),
    ] as const;
    const subscribe = async () => {
      try {
        await client.events.subscribeAll(topics);
        if (!active) await client.events.unsubscribeMany(topics);
      } catch (error) {
        if (active)
          console.warn("[WorkspaceNotifications] Subscription failed", error);
      }
    };
    const openExternal = (payload: ExternalOpenPayload) => {
      if (!active || directory.sessions.get(session.workspaceId) !== session)
        return;
      void handleExternalOpen(client, payload).catch((error: unknown) => {
        if (!active || directory.sessions.get(session.workspaceId) !== session)
          return;
        presentWorkspaceNotification(directory, notify, session.workspaceId, {
          title: "Could not open external link",
          message: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      });
    };
    const stopExternal = client.events.on("external-open:open", openExternal);
    const stopExternalDirect = client.onDirectEvent(
      "external-open:open",
      openExternal,
    );
    const stopEvent = client.events.on("notification:show", present);
    const stopDirect = client.onDirectEvent("notification:show", present);
    void subscribe();
    return () => {
      active = false;
      stopAppLifecycle?.();
      stopExternal();
      stopExternalDirect();
      stopEvent();
      stopDirect();
      void client.events.unsubscribeMany(topics).catch((error: unknown) => {
        console.warn("[WorkspaceNotifications] Unsubscribe failed", error);
      });
    };
  }, [directory, session, notify]);
  return null;
}
