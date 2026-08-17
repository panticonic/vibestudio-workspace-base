/**
 * Chrome-side binding of one quickfire conversation (quickfire-overlay-spec
 * §2.4).
 *
 * The lifecycle — resolve the slot's conversation, join its channel, reduce its
 * durable event log, throttle, send/stop/clear/promote — lives in
 * `@workspace/quickfire-core/session`, because the mobile quickfire sheet drives
 * exactly the same conversation over a different pipe. All that is desktop-local
 * is which client the core calls, so that is all this module supplies.
 */

import { useMemo } from "react";
import {
  useQuickfireSessionCore,
  type QuickfireSessionController,
  type QuickfireSessionSource,
  type QuickfireSessionView,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";
import { connectToChannel, quickfire } from "../shell/client";
import { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT } from "./quickfireTranscript";

export { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT };
export type { QuickfireSessionSource, QuickfireSessionView };

const transport: QuickfireTransport = {
  sessionFor: (slotId, options) => quickfire.sessionFor(slotId, options),
  clear: (slotId) => quickfire.clear(slotId),
  promote: (slotId) => quickfire.promote(slotId),
  connectToChannel,
};

/**
 * Resolve and drive the conversation bound to `source` — a panel slot (the
 * command agent) or an existing channel (a conversation opened from a
 * notification, messaging plan §4.8).
 *
 * Passing `null` (overlay closed, or not in quickfire mode) tears the connection
 * down. The durable conversation is untouched by that — only clear, slot close,
 * and promotion end a slot conversation.
 */
export function useQuickfireSession(
  source: QuickfireSessionSource | null
): QuickfireSessionController {
  const bound = useMemo(() => transport, []);
  // The overlay's only input sits at the TOP of the card — it is the palette's
  // input, reused. So the newest message belongs directly beneath it and older
  // ones recede downward; a bottom-anchored chat would put the reply furthest
  // from the caret the user is still typing in.
  return useQuickfireSessionCore(source, bound, { transcriptOrder: "newest-first" });
}
