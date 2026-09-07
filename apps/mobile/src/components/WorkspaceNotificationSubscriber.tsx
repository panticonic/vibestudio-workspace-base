import { useEffect } from "react";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
import { presentWorkspaceNotification } from "../services/workspaceNotifications";
import type { ToastInput } from "../state/toastAtoms";

/** Connected workspace events remain visible even before its panels are opened. */
export function WorkspaceNotificationSubscriber({
  directory,
  session,
  notify,
}: {
  directory: MobileWorkspaceDirectory;
  session: MobileWorkspaceSession;
  notify: (toast: ToastInput) => void;
}) {
  useEffect(() => {
    const client = session.client;
    let active = true;
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
    const subscribe = async () => {
      try {
        await client.events.subscribe("notification:show");
        if (!active) await client.events.unsubscribe("notification:show");
      } catch (error) {
        if (active)
          console.warn("[WorkspaceNotifications] Subscription failed", error);
      }
    };
    const stopEvent = client.events.on("notification:show", present);
    const stopDirect = client.onDirectEvent("notification:show", present);
    const stopReconnect = client.transport.onReconnect(() => {
      void subscribe();
    });
    void subscribe();
    return () => {
      active = false;
      stopEvent();
      stopDirect();
      stopReconnect();
      void client.events
        .unsubscribe("notification:show")
        .catch((error: unknown) => {
          console.warn("[WorkspaceNotifications] Unsubscribe failed", error);
        });
    };
  }, [directory, session, notify]);
  return null;
}
