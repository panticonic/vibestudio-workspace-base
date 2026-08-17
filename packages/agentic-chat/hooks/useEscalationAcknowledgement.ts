/**
 * Acknowledge-on-read (messaging plan §4.5.4, §4.10.6, D16).
 *
 * When this human's surface renders a message that was escalated to them, two
 * things happen from one observation: the ordinary read receipt goes out (so
 * the sending agent sees "read" through the mechanism it already has), and the
 * durable inbox entry — whose id is derived from the same message id — is
 * acknowledged. There is no second "seen" concept and no presence guess: the
 * entry retires because the message was actually rendered while the surface
 * was visible.
 */
import { useEffect, useRef, useState } from "react";
import { agentMessageNotificationId } from "@vibestudio/shared/userNotifications";
import type { PubSubClient } from "@workspace/pubsub";
import type { ChatMessage, ChatParticipantMetadata } from "../types";

export interface EscalationAcknowledgementOptions {
  messages: readonly ChatMessage[];
  /** This client's participant id — `user:<id>` for a person; anything else disables the hook. */
  selfId: string | null;
  client: PubSubClient<ChatParticipantMetadata> | null;
  /** Host-provided inbox acknowledgement (Gad `acknowledgeUserNotification`). */
  acknowledge: ((notificationId: string) => Promise<unknown> | unknown) | null | undefined;
  /** False until replay settled and the surface is actually showing the transcript. */
  enabled: boolean;
}

/** Messages escalated to `selfId` that this surface has not yet acknowledged. */
export function pendingEscalationsFor(
  messages: readonly ChatMessage[],
  selfId: string
): ChatMessage[] {
  return messages.filter(
    (message) =>
      message.escalation !== undefined &&
      message.escalation.alert !== "none" &&
      message.escalation.users.includes(selfId) &&
      message.receipts?.byParticipant[selfId] !== "read"
  );
}

export function useEscalationAcknowledgement(options: EscalationAcknowledgementOptions): void {
  const { messages, selfId, client, acknowledge, enabled } = options;
  const handled = useRef(new Set<string>());
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden"
  );

  // A hidden surface that becomes visible again acknowledges what it now
  // shows — the same observation, just made later.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled || !visible || !selfId || !selfId.startsWith("user:") || !client) return;
    const userId = selfId.slice("user:".length);
    for (const message of pendingEscalationsFor(messages, selfId)) {
      if (handled.current.has(message.id)) continue;
      handled.current.add(message.id);
      void client.recordReadReceipt(message.id).catch(() => {
        // Retry on a later pass; the receipt is what tells the sender "read".
        handled.current.delete(message.id);
      });
      void Promise.resolve(acknowledge?.(agentMessageNotificationId(message.id, userId))).catch(
        () => undefined
      );
    }
  }, [messages, selfId, client, acknowledge, enabled, visible]);
}
