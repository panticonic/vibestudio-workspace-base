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
  /** First click arms the two-step clear; second click performs it. */
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
