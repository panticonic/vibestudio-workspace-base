import { atom } from "jotai";
import type { PushUserInboxDataPayload } from "@vibestudio/shared/userNotifications";

/**
 * A tapped inbox push (messaging plan §4.10.9), handed from the push runtime to
 * `MainScreen`, which opens the conversation sheet on the escalated envelope
 * and acknowledges the entry. `sequence` makes a repeated tap distinct.
 */
export const inboxDeepLinkAtom = atom<(PushUserInboxDataPayload & { sequence: number }) | null>(
  null
);
