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
import type { QuickfireToolChip, QuickfireTranscriptMessage } from "./model";

/** Last N messages pushed to the surface (§2.4). */
export const TRANSCRIPT_LIMIT = 20;

/**
 * Which end of the conversation a surface reads from.
 *
 * The two clients genuinely differ, so this is a parameter rather than a
 * constant. The mobile sheet is a chat: compose at the bottom, oldest first,
 * newest above the keyboard. The desktop overlay puts the one input at the TOP,
 * where the palette's input already lives — so the newest message belongs
 * directly under it, and older ones recede downward. Truncation is unaffected:
 * both keep the same last N by seq, and only the render order differs.
 */
export type TranscriptOrder = "oldest-first" | "newest-first";

export interface TranscriptProjectionOptions {
  limit?: number;
  order?: TranscriptOrder;
}

/**
 * Project the reduced channel view into the bounded tail the surface renders.
 *
 * Exported for tests: this is the only place transcript shape is decided. The
 * truncation rule is always "last N by seq"; `order` decides only which end the
 * caller reads from, and the surface's scroll behavior follows it.
 */
export function projectTranscript(
  state: ChannelViewState,
  selfParticipantKey: string | null,
  options: TranscriptProjectionOptions = {}
): QuickfireTranscriptMessage[] {
  const { limit = TRANSCRIPT_LIMIT, order = "oldest-first" } = options;
  const ordered = Object.values(state.messages)
    .filter((message) => !message.retracted)
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  // Truncate before reordering: the bound is on WHICH messages are kept (the
  // newest N), never on which end they are read from.
  const tail = ordered.slice(-limit);
  const rendered = order === "newest-first" ? [...tail].reverse() : tail;
  return rendered.map((message): QuickfireTranscriptMessage => {
    const actorId = message.actor.participantId ?? message.actor.id;
    const isSelf = selfParticipantKey !== null && actorId === selfParticipantKey;
    const isAgent = message.actor.kind === "agent" || message.role === "assistant";
    // Every call in this turn, in order, each carrying how it ended. Not
    // deduped: five console reads are five calls, and collapsing them hides
    // both the work and its failures.
    const toolChips = Object.values(state.invocations)
      .filter(
        (invocation) =>
          invocation.turnId &&
          invocation.turnId === message.turnId &&
          typeof invocation.name === "string" &&
          invocation.name.length > 0
      )
      .map((invocation): QuickfireToolChip => ({
        name: invocation.name as string,
        state:
          invocation.status === "failed" ||
          invocation.status === "cancelled" ||
          invocation.status === "abandoned"
            ? "failed"
            : invocation.status === "completed"
              ? "done"
              : "running",
      }));
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
      ...(toolChips.length > 0 ? { toolChips } : {}),
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
