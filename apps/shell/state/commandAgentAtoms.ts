/**
 * In-renderer request channel for opening the command agent overlay.
 *
 * The accelerators arrive as shell events from the main process, but chrome UI
 * (the panel tree's button, the breadcrumb and tree context menus) lives in this
 * renderer and cannot emit those — shell events only travel main → renderer. So
 * chrome asks through this atom and `QuickfireOwner` answers.
 *
 * A request carries the panel it was made *about*: a context menu on a tree node
 * or breadcrumb names that panel, which is not necessarily the focused one, and
 * binding the conversation to the wrong panel would be a silent lie about what
 * the agent can see. `sequence` makes two identical requests distinct, so asking
 * twice reopens rather than being swallowed as an unchanged value.
 */
import { atom } from "jotai";
import type { QuickfireMode } from "../overlay/quickfireSurfaceModel";

export interface CommandAgentOpenRequest {
  mode: QuickfireMode;
  /** Panel the request was made about; falls back to the focused panel. */
  panelId?: string;
  sequence: number;
}

export const commandAgentRequestAtom = atom<CommandAgentOpenRequest | null>(null);

/**
 * Ask for the overlay. Defaults to the conversation scope, because every caller
 * of this atom is a "talk to the agent about this panel" affordance; the palette
 * scopes are reached by accelerator and by the mode chips.
 */
export const openCommandAgentAtom = atom(
  null,
  (get, set, request?: { mode?: QuickfireMode; panelId?: string }) => {
    const previous = get(commandAgentRequestAtom);
    set(commandAgentRequestAtom, {
      mode: request?.mode ?? "quickfire",
      ...(request?.panelId ? { panelId: request.panelId } : {}),
      sequence: (previous?.sequence ?? 0) + 1,
    });
  }
);
