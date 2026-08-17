/**
 * Pure projection from a reduced channel view to the bounded transcript tail the
 * quickfire surfaces render (quickfire-overlay-spec §2.4).
 *
 * Kept apart from the session hook so it can be tested without standing up any
 * RPC transport: this is where the transcript's shape, ordering, and truncation
 * rule are decided, and those are the parts worth pinning down. Both the desktop
 * overlay and the mobile sheet render this exact projection.
 *
 * What a message IS comes from `chatMessagesFromChannelView` — the same merge
 * the chat panel reads. This surface used to keep only `text` blocks off the raw
 * view, which meant an approval request, a rate-limit diagnostic, a lifecycle
 * notice, and a turn that ended without a reply all rendered as nothing at all.
 * The compact venue is entitled to draw those *briefly*; it is not entitled to
 * not know about them. Only presentation is decided here.
 */

import type { ChannelViewState } from "@workspace/agentic-protocol";
import { chatMessagesFromChannelView } from "@workspace/agentic-core/channel-chat-merge";
import type { ChatMessage } from "@workspace/agentic-core/channel-chat-merge";
import type {
  QuickfireSegment,
  QuickfireToolChip,
  QuickfireTranscriptEntry,
  QuickfireTranscriptMessage,
} from "./model";

/** Last N entries pushed to the surface (§2.4). */
export const TRANSCRIPT_LIMIT = 20;

/**
 * Which end of the conversation a surface reads from.
 *
 * The two clients genuinely differ, so this is a parameter rather than a
 * constant. The mobile sheet is a chat: compose at the bottom, oldest first,
 * newest above the keyboard. The desktop overlay puts the one input at the TOP,
 * where the palette's input already lives — so the newest message belongs
 * directly under it, and older ones recede downward. Truncation is unaffected:
 * both keep the same last N, and only the render order differs.
 */
export type TranscriptOrder = "oldest-first" | "newest-first";

export interface TranscriptProjectionOptions {
  limit?: number;
  order?: TranscriptOrder;
  /**
   * Text sent from this surface that the channel has not echoed back yet,
   * including sends still queued behind the binding handshake.
   */
  pendingTexts?: readonly string[];
}

export interface TranscriptProjection {
  entries: QuickfireTranscriptEntry[];
  /** Entries the bound dropped, so the surface can say so honestly. */
  olderCount: number;
}

/**
 * Content types the compact venue deliberately does not carry.
 *
 * Inline UI and custom messages are excluded from this venue by design (the
 * overlay agent is told it has no such surface), and the invocation/progress
 * cards are already represented — more compactly — as the per-turn tool chips.
 * Typing pills become an explicit activity row instead.
 */
const OMITTED_CONTENT_TYPES = new Set([
  "inline_ui",
  "custom",
  "invocation",
  "toolcall-progress",
  "credential-connect",
  "typing",
]);

/**
 * Project the reduced channel view into the bounded tail the surface renders.
 *
 * Exported for tests: this is the only place transcript shape is decided. The
 * truncation rule is always "last N"; `order` decides only which end the caller
 * reads from, and the surface's scroll behavior follows it.
 */
export function projectTranscript(
  state: ChannelViewState,
  selfParticipantKey: string | null,
  options: TranscriptProjectionOptions = {}
): TranscriptProjection {
  const { limit = TRANSCRIPT_LIMIT, order = "oldest-first", pendingTexts = [] } = options;
  const merged = chatMessagesFromChannelView(state);
  const toolChipsByTurn = toolChipsByTurnId(state);

  const projected: QuickfireTranscriptEntry[] = [];
  for (const message of merged) {
    if (message.retracted) continue;
    if (message.contentType && OMITTED_CONTENT_TYPES.has(message.contentType)) continue;
    const entry = projectChatMessage(message, selfParticipantKey, toolChipsByTurn);
    if (entry) projected.push(entry);
  }

  // A turn that is open but has produced nothing yet is the case the overlay
  // most needed and least had: the user pressed Enter and the card sat blank.
  const openTurn = openTurnActivity(state);
  if (openTurn && !projected.some((entry) => entry.kind === "message" && entry.streaming)) {
    projected.push(openTurn);
  }

  // Optimistic echoes go last: they are, by definition, the newest thing said.
  for (const [index, text] of pendingTexts.entries()) {
    projected.push({
      kind: "message",
      id: `pending:${index}:${text.slice(0, 32)}`,
      author: "you",
      authorLabel: "you",
      text,
      segments: splitSegments(text),
      pending: true,
    });
  }

  // Truncate before reordering: the bound is on WHICH entries are kept (the
  // newest N), never on which end they are read from.
  const olderCount = Math.max(0, projected.length - limit);
  const tail = projected.slice(-limit);
  return { entries: order === "newest-first" ? [...tail].reverse() : tail, olderCount };
}

function projectChatMessage(
  message: ChatMessage,
  selfParticipantKey: string | null,
  toolChipsByTurn: Map<string, QuickfireToolChip[]>
): QuickfireTranscriptEntry | null {
  const { contentType } = message;

  if (contentType === "approval" && message.approval) {
    return {
      kind: "approval",
      id: message.id,
      status:
        message.approval.status === "granted"
          ? "granted"
          : message.approval.status === "denied"
            ? "denied"
            : "pending",
      question: message.approval.question ?? message.content,
      ...(message.approval.reason ? { reason: message.approval.reason } : {}),
    };
  }

  if (contentType === "diagnostic" && message.diagnostic) {
    const severity =
      message.diagnostic.severity === "error"
        ? "error"
        : message.diagnostic.severity === "warning"
          ? "warning"
          : "info";
    return {
      kind: "notice",
      id: message.id,
      severity,
      title: message.diagnostic.title,
      ...(message.diagnostic.detail ?? message.content
        ? { detail: message.diagnostic.detail ?? message.content }
        : {}),
      // The panel offers "Resume at reset" / "Retry with local model" here.
      // This venue cannot run either, so it advertises the panel instead.
      ...(message.diagnostic.resetAt || severity === "error" ? { recoverable: true } : {}),
    };
  }

  if (contentType === "lifecycle" && message.lifecycle) {
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.lifecycle.title,
      ...(message.lifecycle.detail ?? message.content
        ? { detail: message.lifecycle.detail ?? message.content }
        : {}),
    };
  }

  if (contentType === "task" && message.task) {
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.content || "Background task",
    };
  }

  if (contentType === "fork" || contentType === "cross-channel-sent") {
    // Marginalia: it happened, it is not a turn here, and this venue offers no
    // way to switch conversations — so it is stated and not made actionable.
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title:
        contentType === "fork" ? "This conversation was forked" : "Sent in another conversation",
      ...(message.content ? { detail: message.content } : {}),
    };
  }

  if (contentType === "automation") {
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.content || "Automation ran",
    };
  }

  const text = message.content ?? "";
  const hasBody = text.trim().length > 0;
  const senderType = message.senderMetadata?.type;
  const isAgent = senderType === "agent";
  const isSelf = selfParticipantKey !== null && message.senderId === selfParticipantKey;
  const toolChips = message.turnId ? toolChipsByTurn.get(message.turnId) : undefined;
  const streaming = message.complete === false && !message.error;

  // A bodiless, chipless, errorless row is noise in a card this small.
  if (!hasBody && !message.error && !toolChips?.length && !message.attachments?.length) return null;

  const projectedMessage: QuickfireTranscriptMessage = {
    kind: "message",
    id: message.id,
    author: isSelf ? "you" : isAgent ? "agent" : "other",
    authorLabel: isSelf
      ? "you"
      : (message.senderMetadata?.name ?? (isAgent ? "agent" : "someone")),
    text,
    ...(hasBody ? { segments: splitSegments(text) } : {}),
    ...(streaming ? { streaming: true } : {}),
    ...(toolChips?.length ? { toolChips } : {}),
    ...(message.error ? { error: true, errorText: message.error } : {}),
    ...(message.pending ? { pending: true } : {}),
    ...(message.model?.displayName || message.model?.ref
      ? { modelLabel: (message.model.displayName || message.model.ref) as string }
      : {}),
    ...(message.attachments?.length ? { attachmentCount: message.attachments.length } : {}),
  };
  return projectedMessage;
}

/**
 * Every call in a turn, in order, each carrying how it ended. Not deduped: five
 * console reads are five calls, and collapsing them hides both the work and its
 * failures.
 */
function toolChipsByTurnId(state: ChannelViewState): Map<string, QuickfireToolChip[]> {
  const byTurn = new Map<string, QuickfireToolChip[]>();
  for (const invocation of Object.values(state.invocations)) {
    if (!invocation.turnId) continue;
    if (typeof invocation.name !== "string" || invocation.name.length === 0) continue;
    const chip: QuickfireToolChip = {
      name: invocation.name,
      state:
        invocation.status === "failed" ||
        invocation.status === "cancelled" ||
        invocation.status === "abandoned"
          ? "failed"
          : invocation.status === "completed"
            ? "done"
            : "running",
    };
    const chips = byTurn.get(invocation.turnId);
    if (chips) chips.push(chip);
    else byTurn.set(invocation.turnId, [chip]);
  }
  return byTurn;
}

function openTurnActivity(state: ChannelViewState): QuickfireTranscriptEntry | null {
  const waiting = Object.values(state.turns).find((turn) => turn.status === "waiting");
  if (waiting) {
    return {
      kind: "activity",
      id: `activity:${waiting.turnId}`,
      state: "waiting",
      label: "waiting for you",
    };
  }
  const open = Object.values(state.turns).find((turn) => turn.status === "open");
  if (!open) return null;
  return { kind: "activity", id: `activity:${open.turnId}`, state: "working", label: "working" };
}

/**
 * Split content into prose and fenced-code runs.
 *
 * Deliberately only fences: this venue renders a card a few lines tall, and a
 * full markdown pipeline there buys headings and tables nobody can read at that
 * size. Code is the one run whose formatting is load-bearing — losing the line
 * breaks in a snippet makes the answer useless rather than merely plain.
 */
export function splitSegments(content: string): QuickfireSegment[] {
  const segments: QuickfireSegment[] = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    const prose = content.slice(cursor, match.index);
    if (prose.trim()) segments.push({ type: "text", text: prose.trim() });
    const code = match[2] ?? "";
    if (code.trim()) {
      segments.push({
        type: "code",
        text: code.replace(/\n$/, ""),
        ...(match[1] ? { language: match[1] } : {}),
      });
    }
    cursor = fence.lastIndex;
  }
  const rest = content.slice(cursor);
  if (rest.trim()) segments.push({ type: "text", text: rest.trim() });
  return segments.length > 0 ? segments : [{ type: "text", text: content }];
}

/** A turn is in flight while any turn is open or waiting on the user. */
export function hasOpenTurn(state: ChannelViewState): boolean {
  return Object.values(state.turns).some(
    (turn) => turn.status === "open" || turn.status === "waiting"
  );
}
