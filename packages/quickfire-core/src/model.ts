/**
 * The platform-neutral quickfire view model (quickfire-overlay-spec §4, §7).
 *
 * These types started life in `apps/shell/overlay/quickfireSurfaceModel.ts` as
 * the props contract between the chrome owner and the overlay surface. The
 * mobile sheets render the same information natively, and the parity rule in
 * `apps/shell/SKILL.md` is explicit that the two clients share canonical
 * presentation *rules*, not renderer components — so the rules live here and
 * each client keeps its own renderer.
 *
 * Everything in this module is JSON-shaped: on desktop it still crosses a
 * process boundary as serialized overlay props.
 */

/** The four scopes of §1.2, in chip order. */
export type QuickfireMode = "all" | "commands" | "goto" | "quickfire";

export const QUICKFIRE_MODE_PREFIX: Record<QuickfireMode, "" | ">" | "@" | "/"> = {
  all: "",
  commands: ">",
  goto: "@",
  quickfire: "/",
};

export const QUICKFIRE_MODE_CHIPS: Array<{ mode: QuickfireMode; label: string }> = [
  { mode: "all", label: "All" },
  { mode: "commands", label: "Commands" },
  { mode: "goto", label: "Go to" },
  { mode: "quickfire", label: "Command agent" },
];

/** Cycle order for repeating the palette accelerator while open (§1.3). */
export const QUICKFIRE_MODE_CYCLE: QuickfireMode[] = ["all", "commands", "goto", "quickfire"];

export interface QuickfireRow {
  id: string;
  title: string;
  /** Secondary line: where it leads, or what activating it will do. */
  meta?: string;
  /** Emoji or short glyph; neither client has an icon registry of its own. */
  icon?: string;
  /** Trailing chip, e.g. "Already open". */
  badge?: string;
  /** Trailing keyboard hint, display only. Desktop renders it; mobile does not. */
  accelerator?: string;
  danger?: boolean;
  /** Listed but not runnable in the current context. */
  disabled?: boolean;
}

export interface QuickfireToolChip {
  name: string;
  /** Running work, finished work, and work that ended badly must look different. */
  state: "running" | "done" | "failed";
}

export interface QuickfireGroup {
  key: string;
  label: string;
  rows: QuickfireRow[];
}

export interface QuickfireArgChip {
  name: string;
  label: string;
  value: string;
}

/** Breadcrumb state while a command's arguments are being collected (§4.2). */
export interface QuickfireArgSessionView {
  commandTitle: string;
  chips: QuickfireArgChip[];
  /** Placeholder for the argument being prompted. */
  activeLabel: string;
  error: string | null;
}

/** The persistent "which panel will this act on" line (§4.1). */
export interface QuickfireContextStrip {
  title: string;
  icon?: string;
  /** Set when the bound slot closed while the surface was open (§4.4). */
  lost?: boolean;
}

/** One rendered transcript line. Content is already flattened to text. */
export interface QuickfireTranscriptMessage {
  id: string;
  /** "you" for this device's own messages, otherwise the agent handle. */
  author: "you" | "agent" | "other";
  authorLabel: string;
  text: string;
  /** Still streaming: render the live delta treatment. */
  streaming?: boolean;
  /**
   * Compact tool pills, in call order.
   *
   * Carrying `state` is the difference between a transcript that shows work and
   * one that only shows names: a deduped list of names renders a running call,
   * a finished one, a failure and an interruption identically, which is what
   * made "is the agent doing anything?" unanswerable from the overlay.
   */
  toolChips?: QuickfireToolChip[];
  error?: boolean;
}

/**
 * Resume state for a conversation that already existed when the surface opened
 * (§1.4). `messageCount` is null when the channel log could not be read — the
 * chip says "resumed" without inventing a count.
 */
export interface QuickfireResumeChip {
  messageCount: number | null;
  /** Epoch ms of the last durable message; display only, never an expiry. */
  lastActivityAt: number | null;
}

/** The `/` mode conversation view. */
export interface QuickfireComposeView {
  panelTitle: string;
  hint: string;
  /**
   * Which end of the conversation the transcript is rendered from. Presentation
   * only — the projection has already ordered the messages; the renderer uses
   * this to place the compose hint next to the input rather than after the
   * oldest message.
   */
  transcriptOrder?: "oldest-first" | "newest-first";
  /** Why sending is unavailable right now; null when the user can type. */
  disabledReason: string | null;
  /** Bounded tail of the conversation: last N messages plus the live delta. */
  transcript: QuickfireTranscriptMessage[];
  /** Non-null only when this open resumed an existing conversation. */
  resume: QuickfireResumeChip | null;
  /** True while the conversation is still being resolved/created. */
  connecting: boolean;
  /** True while an agent turn is open; the compose row shows a stop affordance. */
  streaming: boolean;
  /**
   * The conversation was promoted to a chat panel, which now owns it (§1.4).
   * The client offers "continued in chat panel →" plus "start a new
   * conversation here" instead of a compose row.
   */
  promoted: boolean;
  /** Second press of the two-step clear affordance turns this true. */
  clearArmed: boolean;
  /** True once a conversation exists, enabling clear/promote in the header. */
  hasConversation: boolean;
  /** Set when resolving or sending failed; shown inline, never as a modal. */
  error: string | null;
}
