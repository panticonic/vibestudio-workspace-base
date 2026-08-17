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
 * Ask for the overlay in the same state the accelerator produces: the palette,
 * which resumes straight into the panel's conversation when it already has one.
 * Callers name the panel, never the scope.
 */
export const openCommandAgentAtom = atom(
  null,
  (get, set, request?: { mode?: QuickfireMode; panelId?: string }) => {
    const previous = get(commandAgentRequestAtom);
    set(commandAgentRequestAtom, {
      mode: request?.mode ?? "all",
      ...(request?.panelId ? { panelId: request.panelId } : {}),
      sequence: (previous?.sequence ?? 0) + 1,
    });
  }
);

/**
 * Open the overlay as a lightweight conversation with the agent that notified
 * the user (messaging plan §4.8): the same quickfire surface, bound to an
 * EXISTING channel rather than a per-panel slot. Reply inline; pop out to the
 * chat panel on demand. Set by the notification surfaces.
 */
export interface ConversationSurfaceRequest {
  channelId: string;
  contextId: string;
  /** The envelope to land on; replies thread under it. */
  focusMessageId?: string;
  /** The participant that notified — replies are addressed to it. */
  replyTo?: { participantId: string; handle?: string };
  /** Header title (channel or sender), when the caller knows it. */
  title?: string;
  sequence: number;
}

export const conversationSurfaceRequestAtom = atom<ConversationSurfaceRequest | null>(null);

export const openConversationSurfaceAtom = atom(
  null,
  (get, set, request: Omit<ConversationSurfaceRequest, "sequence">) => {
    const previous = get(conversationSurfaceRequestAtom);
    set(conversationSurfaceRequestAtom, {
      ...request,
      sequence: (previous?.sequence ?? 0) + 1,
    });
  }
);
