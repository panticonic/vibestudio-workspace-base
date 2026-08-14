/**
 * Pure projection from a reduced channel view to the bounded transcript tail the
 * quickfire surfaces render (quickfire-overlay-spec §2.4).
 *
 * Kept apart from the session hook so it can be tested without standing up any
 * RPC transport: this is where the transcript's shape, ordering, and truncation
 * rule are decided, and those are the parts worth pinning down. Both the desktop
 * overlay and the mobile sheet render this exact projection.
 */

import type { ChannelViewState } from "@workspace/agentic-protocol";
import { messageDisplayText } from "@workspace/agentic-protocol";
import type { QuickfireTranscriptMessage } from "./model";

/** Last N messages pushed to the surface (§2.4). */
export const TRANSCRIPT_LIMIT = 20;

/**
 * Project the reduced channel view into the bounded tail the surface renders.
 *
 * Exported for tests: this is the only place transcript shape is decided, and
 * the truncation rule ("last N by seq, oldest first") is the contract the
 * surface's scroll behavior depends on.
 */
export function projectTranscript(
  state: ChannelViewState,
  selfParticipantKey: string | null,
  limit = TRANSCRIPT_LIMIT
): QuickfireTranscriptMessage[] {
  const ordered = Object.values(state.messages)
    .filter((message) => !message.retracted)
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  const tail = ordered.slice(-limit);
  return tail.map((message): QuickfireTranscriptMessage => {
    const actorId = message.actor.participantId ?? message.actor.id;
    const isSelf = selfParticipantKey !== null && actorId === selfParticipantKey;
    const isAgent = message.actor.kind === "agent" || message.role === "assistant";
    const toolChips = Object.values(state.invocations)
      .filter((invocation) => invocation.turnId && invocation.turnId === message.turnId)
      .map((invocation) => invocation.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    return {
      id: message.messageId,
      author: isSelf ? "you" : isAgent ? "agent" : "other",
      authorLabel: isSelf
        ? "you"
        : (message.actor.displayName ?? (isAgent ? "agent" : "someone")),
      text: messageDisplayText(message.blocks ?? []),
      ...(message.status === "streaming" || message.status === "started"
        ? { streaming: true }
        : {}),
      ...(toolChips.length > 0 ? { toolChips: [...new Set(toolChips)] } : {}),
      ...(message.status === "failed" || message.failedAt ? { error: true } : {}),
    };
  });
}

/** A turn is in flight while any turn is open or waiting on the user. */
export function hasOpenTurn(state: ChannelViewState): boolean {
  return Object.values(state.turns).some(
    (turn) => turn.status === "open" || turn.status === "waiting"
  );
}
