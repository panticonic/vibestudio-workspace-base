/**
 * The props/intent contract between `QuickfireOwner` (chrome, holds all state
 * and RPC) and `QuickfireSurface` (overlay document, pure view).
 *
 * Everything here is JSON — it crosses a process boundary as serialized
 * `props` in and opaque `intent` payloads out. The one deliberate exception to
 * the approval card's fully-controlled model is the text input: keystrokes
 * would otherwise round-trip surface → chrome → surface and visibly stutter, so
 * the surface owns the input's value locally and only *echoes* it to the
 * chrome. `inputValue`/`inputEpoch` exist for the cases where the chrome must
 * overwrite it anyway (mode chips, popping an argument, restoring a query).
 */

export const QUICKFIRE_SURFACE_KEY = "quickfire";

/**
 * The view model itself is shared with `apps/mobile` through
 * `@workspace/quickfire-core` (the parity rule in `../SKILL.md`: share
 * canonical presentation rules, not renderers). Only the overlay *bridge* —
 * props envelope and intent union — is desktop-local, because only desktop has
 * a process boundary to cross.
 */
import type {
  QuickfireArgSessionView,
  QuickfireComposeView,
  QuickfireContextStrip,
  QuickfireGroup,
  QuickfireMode,
} from "@workspace/quickfire-core";

export type {
  QuickfireArgChip,
  QuickfireArgSessionView,
  QuickfireComposeView,
  QuickfireContextStrip,
  QuickfireGroup,
  QuickfireMode,
  QuickfireResumeChip,
  QuickfireRow,
  QuickfireTranscriptMessage,
} from "@workspace/quickfire-core";
export {
  QUICKFIRE_MODE_CHIPS,
  QUICKFIRE_MODE_CYCLE,
  QUICKFIRE_MODE_PREFIX,
} from "@workspace/quickfire-core";

export interface QuickfireSurfaceProps {
  mode: QuickfireMode;
  /** Value the chrome wants in the input; adopted when `inputEpoch` changes. */
  inputValue: string;
  inputEpoch: number;
  placeholder: string;
  /** Ghost-text completion appended after the typed text, if any. */
  ghostSuffix: string | null;
  groups: QuickfireGroup[];
  selectedId: string | null;
  argSession: QuickfireArgSessionView | null;
  context: QuickfireContextStrip | null;
  /** Shown instead of rows when there is nothing to offer. */
  emptyMessage: string | null;
  /** Row that just ran, flashed for 900ms so chained commands read as landed. */
  flashRowId: string | null;
  compose: QuickfireComposeView | null;
}

export type QuickfireIntent =
  /** The surface echoing its locally-owned input. */
  | { type: "input"; value: string }
  /** Send and immediately promote to a full chat panel (Cmd+Enter, §1.3). */
  | { type: "send-and-promote"; text: string }
  /** Stop the turn in flight. */
  | { type: "stop" }
  /**
   * Widen the rendered window over the replay the session already holds. The
   * compact venue keeps a tail on purpose; "12 earlier entries" with no way to
   * see them was the surface withholding what it had.
   */
  | { type: "show-older" }
  /**
   * A link in agent prose was activated. The surface cannot open anything — it
   * has no RPC, and its `WebContentsView` has no window-open handler — so the
   * destination goes to the chrome, which resolves it through the same address
   * grammar the title bar uses.
   */
  | { type: "open-link"; href: string }
  /** Ask the chrome to carry one image's bytes across (see `QuickfireImage`). */
  | { type: "reveal-image"; imageId: string }
  /** Walk your own sent messages back into the input (↑ on an empty compose). */
  | { type: "recall"; delta: number }
  /** Re-aim the overlay at another open panel (spec §4.1 context strip). */
  | { type: "retarget" }
  /** Clear this slot's conversation and bind a fresh one. */
  | { type: "clear" }
  | { type: "promote" }
  /** Focus the chat panel that a promoted conversation continued into. */
  | { type: "focus-promoted" }
  /** Abandon a promoted mapping and start a fresh conversation on this slot. */
  | { type: "start-fresh" }
  | { type: "select"; rowId: string }
  | { type: "activate"; rowId: string }
  | { type: "move"; delta: number }
  | { type: "accept-completion" }
  | { type: "mode"; mode: QuickfireMode }
  | { type: "cycle-mode" }
  /** Backspace pressed with an empty input: pop an argument, or drop the mode. */
  | { type: "backspace-empty" }
  | { type: "escape" }
  /**
   * Escape pressed outside the overlay document — synthesized by the host while
   * an overlay is visible, because a focused panel eats the key before any
   * renderer sees it. Closes outright rather than walking the Esc chain: the
   * user was not in the overlay, so there is no scope to step back through.
   */
  | { type: "host-escape" }
  /**
   * Pointer press outside the overlay document — synthesized by the host
   * because the quickfire surface is a sibling native view and cannot receive
   * DOM bubbling from the panel/chrome view underneath it.
   */
  | { type: "host-pointer-down" }
  | { type: "dismiss" }
  | { type: "send"; text: string };

export function isQuickfireSurfaceProps(value: unknown): value is QuickfireSurfaceProps {
  const props = value as Partial<QuickfireSurfaceProps> | null;
  return (
    !!props &&
    typeof props === "object" &&
    typeof props.mode === "string" &&
    Array.isArray(props.groups) &&
    typeof props.inputEpoch === "number"
  );
}
