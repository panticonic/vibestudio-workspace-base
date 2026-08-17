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
  QuickfireToolCall,
  QuickfireTranscriptEntry,
  QuickfireTranscriptMessage,
} from "./model";
import {
  parseQuickfireMarkdown,
  type QuickfireMarkdownBlock,
  type QuickfireMarkdownInline,
} from "./markdown";

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
  /** A local send was accepted but its durable agent turn has not arrived yet. */
  awaitingResponse?: boolean;
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
 * cards are already represented — more compactly — as per-turn tool records.
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
  options: TranscriptProjectionOptions = {},
): TranscriptProjection {
  const {
    limit = TRANSCRIPT_LIMIT,
    order = "oldest-first",
    pendingTexts = [],
    awaitingResponse = false,
  } = options;
  const merged = chatMessagesFromChannelView(state);
  const toolCallsByTurn = toolCallsByTurnId(state);

  const projected: QuickfireTranscriptEntry[] = [];
  for (const message of merged) {
    if (message.retracted) continue;
    if (message.contentType && OMITTED_CONTENT_TYPES.has(message.contentType))
      continue;
    const entry = projectChatMessage(
      message,
      selfParticipantKey,
      toolCallsByTurn,
    );
    if (entry) projected.push(entry);
  }

  // Optimistic echoes follow the durable transcript. Activity comes after
  // them: work starts because of the send, and both renderer orders therefore
  // place the live status between the input and the message that caused it.
  for (const [index, text] of pendingTexts.entries()) {
    projected.push({
      kind: "message",
      id: `pending:${index}:${text.slice(0, 32)}`,
      author: "you",
      authorLabel: "you",
      text,
      pending: true,
    });
  }

  // A turn that is open but has produced nothing yet is the case the overlay
  // most needed and least had: the user pressed Enter and the card sat blank.
  const activity = currentActivity(state, toolCallsByTurn, awaitingResponse);
  if (activity) projected.push(activity);

  // Truncate before reordering: the bound is on WHICH entries are kept (the
  // newest N), never on which end they are read from.
  const olderCount = Math.max(0, projected.length - limit);
  const tail = projected.slice(-limit);
  return {
    entries: order === "newest-first" ? [...tail].reverse() : tail,
    olderCount,
  };
}

function projectChatMessage(
  message: ChatMessage,
  selfParticipantKey: string | null,
  toolCallsByTurn: Map<string, QuickfireToolCall[]>,
): QuickfireTranscriptEntry | null {
  const { contentType } = message;

  if (contentType === "thinking") {
    const text = message.content ?? "";
    if (!text.trim()) return null;
    return {
      kind: "thinking",
      id: message.id,
      title: reasoningTitle(text),
      text,
      ...(message.complete === false ? { streaming: true } : {}),
    };
  }

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
      ...((message.diagnostic.detail ?? message.content)
        ? { detail: message.diagnostic.detail ?? message.content }
        : {}),
      // The panel offers "Resume at reset" / "Retry with local model" here.
      // This venue cannot run either, so it advertises the panel instead.
      ...(message.diagnostic.resetAt || severity === "error"
        ? { recoverable: true }
        : {}),
    };
  }

  if (contentType === "lifecycle" && message.lifecycle) {
    if (message.lifecycle.status === "waiting") {
      return {
        kind: "activity",
        id: message.id,
        state: "waiting",
        phase: "waiting",
        label: message.lifecycle.title,
      };
    }
    return {
      kind: "notice",
      id: message.id,
      severity: "info",
      title: message.lifecycle.title,
      ...((message.lifecycle.detail ?? message.content)
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
        contentType === "fork"
          ? "This conversation was forked"
          : "Sent in another conversation",
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
  const isSelf =
    selfParticipantKey !== null && message.senderId === selfParticipantKey;
  const toolCalls = message.turnId
    ? toolCallsByTurn.get(message.turnId)
    : undefined;
  const streaming = message.complete === false && !message.error;

  // A bodiless message with no tool records, errors, or attachments is noise.
  if (
    !hasBody &&
    !message.error &&
    !toolCalls?.length &&
    !message.attachments?.length
  )
    return null;

  const projectedMessage: QuickfireTranscriptMessage = {
    kind: "message",
    id: message.id,
    author: isSelf ? "you" : isAgent ? "agent" : "other",
    authorLabel: isSelf
      ? "you"
      : (message.senderMetadata?.name ?? (isAgent ? "agent" : "someone")),
    text,
    ...(streaming ? { streaming: true } : {}),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(message.error ? { error: true, errorText: message.error } : {}),
    ...(message.pending ? { pending: true } : {}),
    ...(message.model?.displayName || message.model?.ref
      ? {
          modelLabel: (message.model.displayName ||
            message.model.ref) as string,
        }
      : {}),
    ...(message.attachments?.length
      ? { attachmentCount: message.attachments.length }
      : {}),
  };
  return projectedMessage;
}

const REASONING_TITLE_LIMIT = 72;

/** Turn the first meaningful Markdown block into a useful collapsed label. */
export function reasoningTitle(source: string): string {
  const text = parseQuickfireMarkdown(source)
    .map(markdownBlockText)
    .find((candidate) => candidate.trim().length > 0) ?? source;
  const normalized = text.replace(/\s+/gu, " ").trim() || source.trim();
  const characters = [...normalized];
  return characters.length <= REASONING_TITLE_LIMIT
    ? normalized
    : `${characters.slice(0, REASONING_TITLE_LIMIT - 1).join("")}…`;
}

function markdownBlockText(block: QuickfireMarkdownBlock): string {
  switch (block.kind) {
    case "paragraph":
    case "heading":
    case "quote":
      return markdownInlineText(block.children);
    case "bullet-list":
    case "ordered-list":
      return markdownInlineText(block.items[0] ?? []);
    case "code-block":
      return block.text.split("\n", 1)[0] ?? "";
  }
}

function markdownInlineText(nodes: QuickfireMarkdownInline[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" || node.kind === "code"
        ? node.text
        : markdownInlineText(node.children),
    )
    .join("");
}

/**
 * Every call in a turn, in order, each carrying how it ended. Not deduped: five
 * console reads are five calls, and collapsing them hides both the work and its
 * failures.
 */
function toolCallsByTurnId(
  state: ChannelViewState,
): Map<string, QuickfireToolCall[]> {
  const byTurn = new Map<string, QuickfireToolCall[]>();
  for (const invocation of Object.values(state.invocations)) {
    if (!invocation.turnId) continue;
    if (typeof invocation.name !== "string" || invocation.name.length === 0)
      continue;
    const progress = invocation.progress
      .map(
        (item) =>
          item.message ??
          (item.data === undefined ? "" : formatDetail(item.data)),
      )
      .filter(Boolean)
      .slice(-20);
    const failure = invocation.failure ?? invocation.terminalReason;
    const call: QuickfireToolCall = {
      id: invocation.invocationId,
      name: invocation.name,
      state:
        invocation.status === "failed" ||
        invocation.status === "cancelled" ||
        invocation.status === "abandoned"
          ? "failed"
          : invocation.status === "completed"
            ? "done"
            : "running",
      ...(invocation.request === undefined
        ? {}
        : { input: formatDetail(invocation.request) }),
      ...(invocation.result === undefined && invocation.outputs.length === 0
        ? {}
        : {
            output: formatDetail(
              invocation.result === undefined
                ? invocation.outputs
                : invocation.result,
            ),
          }),
      ...(progress.length > 0 ? { progress } : {}),
      ...(failure ? { failure: formatDetail(failure) } : {}),
    };
    const calls = byTurn.get(invocation.turnId);
    if (calls) calls.push(call);
    else byTurn.set(invocation.turnId, [call]);
  }
  return byTurn;
}

function currentActivity(
  state: ChannelViewState,
  toolCallsByTurn: Map<string, QuickfireToolCall[]>,
  awaitingResponse: boolean,
): QuickfireTranscriptEntry | null {
  const turns = Object.values(state.turns).sort(
    (left, right) => activityOrder(right) - activityOrder(left),
  );
  const activeTurn = turns.find(
    (turn) => turn.status === "open" || turn.status === "waiting",
  );
  // Waiting turns are already projected by the canonical chat merge as a
  // lifecycle entry carrying the actual summary/reason. `projectChatMessage`
  // turns that one entry into the compact activity shape; adding another here
  // would render the same wait twice.
  if (activeTurn?.status === "waiting") return null;
  const orphanedRunningInvocation = Object.values(state.invocations).find(
    (invocation) =>
      invocation.status === "running" || invocation.status === "started",
  );
  const turnId = activeTurn?.turnId ?? orphanedRunningInvocation?.turnId;
  if (!turnId) {
    return awaitingResponse
      ? {
          kind: "activity",
          id: "activity:awaiting-response",
          state: "working",
          phase: "starting",
          label: "Starting…",
        }
      : null;
  }

  const toolCalls = toolCallsByTurn.get(turnId) ?? [];
  const hasRunningTool = toolCalls.some((call) => call.state === "running");
  const turnMessages = Object.values(state.messages).filter(
    (message) =>
      message.turnId === turnId &&
      message.status !== "completed" &&
      message.status !== "failed",
  );
  const hasResponse = turnMessages.some((message) =>
    (message.blocks ?? []).some(
      (block) =>
        block.type === "text" && "content" in block && Boolean(block.content),
    ),
  );
  const phase = hasRunningTool
    ? "using-tools"
    : hasResponse
      ? "responding"
      : "thinking";
  return {
    kind: "activity",
    id: `activity:${turnId}`,
    state: "working",
    phase,
    label:
      phase === "using-tools"
        ? "Using tools…"
        : phase === "responding"
          ? "Responding…"
          : "Thinking…",
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function activityOrder(turn: ChannelViewState["turns"][string]): number {
  if (turn.lastSeq !== undefined) return turn.lastSeq;
  const timestamp = Date.parse(turn.updatedAt ?? turn.openedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDetail(value: unknown): string {
  const seen = new WeakSet<object>();
  let rendered: string;
  try {
    rendered =
      typeof value === "string"
        ? value
        : (JSON.stringify(
            value,
            (key, nested) => {
              if (
                (key === "data" || key === "base64") &&
                typeof nested === "string"
              ) {
                return `[${nested.length} characters omitted]`;
              }
              if (typeof nested === "string" && nested.length > 2_000) {
                return `${nested.slice(0, 2_000)}…`;
              }
              if (nested && typeof nested === "object") {
                if (seen.has(nested)) return "[circular]";
                seen.add(nested);
              }
              return nested;
            },
            2,
          ) ?? String(value));
  } catch {
    rendered = String(value);
  }
  return rendered.length > 6_000
    ? `${rendered.slice(0, 6_000)}\n… detail truncated`
    : rendered;
}

/** A turn is in flight while any turn is open or waiting on the user. */
export function hasOpenTurn(state: ChannelViewState): boolean {
  return Object.values(state.turns).some(
    (turn) => turn.status === "open" || turn.status === "waiting",
  );
}
