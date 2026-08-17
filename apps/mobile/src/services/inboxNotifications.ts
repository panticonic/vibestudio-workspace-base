/**
 * Pushed inbox entries on the phone (messaging plan §4.5 step 5, §4.10.9).
 *
 * Shared by the foreground push runtime and the headless background handler,
 * so it stays free of React Native runtime imports beyond the notification
 * types.
 */
import type { PushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";
import { INBOX_NOTIFICATION_CHANNEL_ID } from "./notificationCategories";

interface InboxNotifee {
  displayNotification: (notification: Record<string, unknown>) => Promise<unknown>;
}

interface InboxRemoteMessage {
  notification?: { title?: string; body?: string };
}

/**
 * Display a pushed inbox entry (messaging plan §4.10.9). Its id is the durable
 * entry's id, so a redriven push replaces rather than stacks, and a tap carries
 * the deep-link facts straight to the conversation sheet.
 */
export async function displayInboxNotification(
  data: PushUserInboxDataPayload,
  message: InboxRemoteMessage,
  notifee: InboxNotifee
): Promise<void> {
  await notifee.displayNotification({
    id: data.notificationId,
    title: data.title || message.notification?.title || "New message",
    body: data.body ?? message.notification?.body ?? "",
    data: { ...data },
    android: {
      channelId: INBOX_NOTIFICATION_CHANNEL_ID,
      pressAction: { id: "open", launchActivity: "default" },
      ...(data.priority === "high" ? { importance: 4 } : {}),
    },
    ios: {},
  });
}

