/**
 * Open/close state for the two quickfire surfaces (quickfire-overlay-spec §7).
 *
 * Atoms rather than props because both sheets are opened from several places —
 * the AppBar ✦ button, a long-press on the active panel pill, and commands that
 * hand off to each other — and none of those should have to thread a callback
 * through `MainScreen`.
 */
import { atom } from "jotai";
import type { QuickfireMode } from "@workspace/quickfire-core";

export interface CommandSheetRequest {
  /** Scope the sheet opens in. Long-press on the active panel opens "goto". */
  mode: QuickfireMode;
  /** Seed query, already stripped of its mode prefix. */
  query?: string;
}

export const commandSheetAtom = atom<CommandSheetRequest | null>(null);

export const openCommandSheetAtom = atom(
  null,
  (_get, set, request?: Partial<CommandSheetRequest>) => {
    set(commandSheetAtom, {
      mode: request?.mode ?? "all",
      ...(request?.query ? { query: request.query } : {}),
    });
  }
);

export const dismissCommandSheetAtom = atom(null, (_get, set) => {
  set(commandSheetAtom, null);
});

export interface QuickfireSheetRequest {
  /** The panel slot the conversation binds to (§1.4). */
  slotId: string;
  /** Text to prefill the compose box with, e.g. from `>ask …`. */
  draft?: string;
}

export const quickfireSheetAtom = atom<QuickfireSheetRequest | null>(null);

/**
 * Opening the sheet over a slot IS the gesture that binds a conversation to it
 * (§6.2), so this must only ever be set from an explicit user action — never
 * from focus changes or navigation.
 */
export const openQuickfireSheetAtom = atom(
  null,
  (_get, set, request: QuickfireSheetRequest) => {
    set(quickfireSheetAtom, request);
  }
);

export const dismissQuickfireSheetAtom = atom(null, (_get, set) => {
  set(quickfireSheetAtom, null);
});
