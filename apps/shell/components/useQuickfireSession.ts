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
  type QuickfireSessionView,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";
import { connectToChannel, quickfire } from "../shell/client";
import { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT } from "./quickfireTranscript";

export { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT };
export type { QuickfireSessionView };

const transport: QuickfireTransport = {
  sessionFor: (slotId, options) => quickfire.sessionFor(slotId, options),
  clear: (slotId) => quickfire.clear(slotId),
  promote: (slotId) => quickfire.promote(slotId),
  connectToChannel,
};

/**
 * Resolve and drive the conversation bound to `slotId`.
 *
 * Passing `slotId: null` (overlay closed, or not in quickfire mode) tears the
 * connection down. The durable conversation is untouched by that — only clear,
 * slot close, and promotion end a conversation.
 */
export function useQuickfireSession(slotId: string | null): QuickfireSessionController {
  const bound = useMemo(() => transport, []);
  return useQuickfireSessionCore(slotId, bound);
}
