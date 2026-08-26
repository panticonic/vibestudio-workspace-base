/**
 * QuickfireOwner — the chrome side of the quickfire overlay (spec §2.3).
 *
 * It owns everything the surface must not: overlay open/close state, the mode,
 * the query, the ranked suggestions, the argument session, every RPC, and the
 * command execution. `QuickfireSurface` renders what this pushes and emits
 * opaque intents back. The split matters because the surface lives in a
 * separate `WebContentsView` with no RPC transport at all.
 *
 * It replaces `AppCommandPalette`, which was a DOM dialog behind
 * `useShellOverlay(true)` — i.e. it hid every panel view while open. This one
 * floats over the live panel, and it shares the overlay primitive with the
 * approval card rather than displacing it (host §2.3a made the overlay
 * multi-instance so both can be visible and operable at once).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  commandSpecFromWire,
  filledArgChips,
  parseInlineCommand,
  reduceArgSession,
  startArgSession,
  activeArgSpec,
  type ArgSession,
  type CommandSpec,
  type OpenPanelEntry,
  type SurfaceContext,
} from "@workspace/omnibox-core";
import {
  classifyQuickfireLink,
  suggestedOpeners,
} from "@workspace/quickfire-core";
import {
  QUICKFIRE_MODE_PLACEHOLDER,
  buildPaletteRows,
  parseGotoScope,
  buildRowTargets,
  completionForRow,
  emptyMessageFor,
  inputForMode,
  modeForInput,
  stripModePrefix,
} from "@workspace/quickfire-core";
import type {
  BrowserAddressSuggestion,
  PanelChromeState,
} from "@vibestudio/shared/panelChrome";
import {
  app,
  hostCommands,
  panel,
  quickfire,
  userNotifications,
  workspace,
} from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import {
  useShellContentOverlay,
  type ContentOverlayBounds,
} from "../shell/useShellContentOverlay";
import {
  effectiveThemeAtom,
  themeConfigAtom,
  setThemeModeAtom,
  setThemeConfigAtom,
} from "../state/themeAtoms";
import { workspaceChooserDialogOpenAtom } from "../state/appModeAtoms";
import {
  commandAgentRequestAtom,
  conversationSurfaceRequestAtom,
  type ConversationSurfaceRequest,
} from "../state/commandAgentAtoms";
import { useNavigationActions } from "./NavigationContext";
import {
  buildSlate,
  reportCommandFailure,
  runContributedCommand,
  type CommandOutcome,
  type SlateCommand,
  type SlateDeps,
} from "../commands/slate";
import {
  QUICKFIRE_MODE_CYCLE,
  QUICKFIRE_MODE_PREFIX,
  QUICKFIRE_SURFACE_KEY,
  type QuickfireIntent,
  type QuickfireMode,
  type QuickfireSurfaceProps,
} from "../overlay/quickfireSurfaceModel";
import type { QuickfireSessionSummary } from "@workspace/quickfire-core/service";
import type { OverlayThemeInfo } from "../overlay/types";
import {
  useQuickfireSession,
  type QuickfireSessionSource,
} from "./useQuickfireSession";
import { acquireFocusedPanelIdAfterRestore } from "./quickfirePanelFocus";

/**
 * Id of the panel-region div (rendered by `PanelApp`) whose rect anchors the
 * quickfire card. Separate from the approval card's host because the two
 * overlays are independent instances with different placement rules.
 */
export const QUICKFIRE_OVERLAY_HOST_ID = "app-quickfire-host";

/** Card width from §4; the native view adds the surface's shadow margin. */
const CARD_WIDTH = 640;
const SURFACE_MARGIN = 16;
/** Inset the native overlay applies inside the anchor rect it is given. */
const ANCHOR_MARGIN = 12;
/** Top-aligned at ~18% of the panel viewport (§2.3). */
const TOP_FRACTION = 0.18;
/** Transcript/list scrolls internally past this share of the viewport (§2.3). */
const MAX_HEIGHT_FRACTION = 0.62;
/** How long a non-navigating command's row stays flashed (§4.4). */
const SUCCESS_FLASH_MS = 900;
/** Upper bound on the walked panel forest, so a huge workspace cannot stall the open. */
const MAX_OPEN_PANELS = 300;
/** Same debounce the title bar's address field uses, so history feels identical. */
const HISTORY_DEBOUNCE_MS = 120;
/** Rows one durable panel-title search may contribute per keystroke. */
const PANEL_SEARCH_LIMIT = 20;

interface OverlayState {
  open: boolean;
  mode: QuickfireMode;
  query: string;
  /** Bumped whenever the chrome deliberately overwrites the surface's input. */
  inputEpoch: number;
  argSession: ArgSession | null;
  selectedId: string | null;
  /** True once the user has moved the selection off the top row. */
  selectionTouched: boolean;
  flashRowId: string | null;
  /**
   * Set when the overlay is a conversation surface (messaging plan §4.8): the
   * quickfire card bound to an EXISTING channel rather than the focused panel's
   * slot. Null for the Quickfire agent / palette.
   */
  conversation: Omit<ConversationSurfaceRequest, "sequence"> | null;
  /**
   * The user is choosing which panel this overlay acts on (§4.1). Activating a
   * panel row rebinds the conversation instead of navigating to it — the whole
   * point is to quickfire a panel you are *not* looking at.
   */
  retargeting: boolean;
}

const CLOSED: OverlayState = {
  open: false,
  mode: "all",
  query: "",
  inputEpoch: 0,
  argSession: null,
  selectedId: null,
  selectionTouched: false,
  flashRowId: null,
  conversation: null,
  retargeting: false,
};

export function QuickfireOwner() {
  const [state, setState] = useState<OverlayState>(CLOSED);
  const [chromeState, setChromeState] = useState<PanelChromeState | null>(null);
  const [pinnedPanelIds, setPinnedPanelIds] = useState<string[]>([]);
  const [openPanels, setOpenPanels] = useState<OpenPanelEntry[]>([]);
  /**
   * Durable title matches for the current query, merged over the walked index.
   *
   * The walk is bounded (`MAX_OPEN_PANELS`) and happens once per open, so on a
   * large workspace it cannot be the whole answer to "which panel is called
   * X". The workspace's own full-text panel search is; it runs debounced beside
   * the local filter, and rows appear the moment either source has them.
   */
  const [treeHits, setTreeHits] = useState<OpenPanelEntry[]>([]);
  const [history, setHistory] = useState<BrowserAddressSuggestion[]>([]);
  const [workspaceNames, setWorkspaceNames] = useState<string[]>([]);
  const [contributed, setContributed] = useState<CommandSpec[]>([]);
  const [anchorBounds, setAnchorBounds] = useState<ContentOverlayBounds | null>(
    null,
  );
  const [panelLost, setPanelLost] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  /** Rows for the `quickfire.list` picker; non-null only while it is showing. */
  const [quickfireConversations, setQuickfireConversations] = useState<
    QuickfireSessionSummary[] | null
  >(null);
  const flashTimerRef = useRef(0);
  /** How far back through your own sent messages ↑ has walked; -1 is "not walking". */
  const recallRef = useRef(-1);
  /** Panel focused when the overlay opened, restored on dismiss (§2.3). */
  const returnFocusPanelIdRef = useRef<string | null>(null);
  /**
   * A dismissal's in-flight focus restoration. Reopening must observe the
   * restored panel before acquiring its context; otherwise an immediate
   * Escape, Ctrl/Cmd+K chord can briefly see no focused panel.
   */
  const focusRestoreRef = useRef<Promise<void> | null>(null);
  /** Chat panels this shell opened for a promoted conversation, by channel id. */
  const promotedPanelIdsRef = useRef(new Map<string, string>());

  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const themeConfig = useAtomValue(themeConfigAtom);
  const setThemeMode = useSetAtom(setThemeModeAtom);
  const setThemeConfig = useSetAtom(setThemeConfigAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const { navigateToId, setAddressBarVisible } = useNavigationActions();

  const workspaceNamesRef = useRef(workspaceNames);
  workspaceNamesRef.current = workspaceNames;

  const deps = useMemo<SlateDeps>(
    () => ({
      setThemeMode,
      setThemeConfig,
      openWorkspaceChooser: () => setWorkspaceChooserOpen(true),
      navigateToId,
      setAddressBarVisible,
      workspaceNames: () => workspaceNamesRef.current,
      showQuickfireConversations: setQuickfireConversations,
    }),
    [
      navigateToId,
      setAddressBarVisible,
      setThemeConfig,
      setThemeMode,
      setWorkspaceChooserOpen,
    ],
  );

  const slate = useMemo(() => buildSlate(deps), [deps]);
  const slateById = useMemo(
    () =>
      new Map<string, SlateCommand>(
        slate.map((command) => [command.id, command]),
      ),
    [slate],
  );

  // --- Context assembled from the focused panel -----------------------------
  const ctx = useMemo<SurfaceContext>(
    () => ({
      platform: "desktop",
      openPanels: { entries: mergePanelEntries(openPanels, treeHits) },
      ...(chromeState
        ? {
            focusedPanel: {
              panelId: chromeState.panelId,
              title: chromeState.title,
              source: chromeState.source,
              kind:
                chromeState.kind === "browser"
                  ? ("browser" as const)
                  : ("workspace" as const),
              canGoBack: chromeState.canGoBack,
              canGoForward: chromeState.canGoForward,
              pinned: pinnedPanelIds.includes(chromeState.panelId),
              addressable: chromeState.kind !== "browser",
            },
          }
        : {}),
    }),
    [chromeState, openPanels, pinnedPanelIds, treeHits],
  );

  const commands = useMemo(
    () => [...slate, ...contributed],
    [contributed, slate],
  );

  // --- Opening --------------------------------------------------------------
  /**
   * Slots known to hold a live conversation, so the *next* open can decide the
   * scope without waiting for a round trip. Refreshed on every open.
   */
  const conversationSlotsRef = useRef<Set<string>>(new Set());
  /** Invalidates an in-flight list snapshot when a local clear changes truth. */
  const conversationIndexEpochRef = useRef(0);

  const refreshConversationSlots =
    useCallback(async (): Promise<Set<string> | null> => {
      const epoch = conversationIndexEpochRef.current;
      try {
        const rows = await quickfire.list();
        if (epoch !== conversationIndexEpochRef.current) return null;
        const slots = new Set(
          rows
            .filter((row) => row.promotedAt === null)
            .map((row) => row.slotId),
        );
        conversationSlotsRef.current = slots;
        return slots;
      } catch {
        return null;
      }
    }, []);

  // Warm the resume index before the first accelerator press. Opening the
  // palette must not be the operation that first discovers durable state.
  useEffect(() => {
    void refreshConversationSlots();
  }, [refreshConversationSlots]);

  /**
   * One key, resume-aware: opening over a panel that already has a conversation
   * lands *in* that conversation rather than in the ranked list. A promoted one
   * is excluded — the chat panel owns it, and there is nothing to continue here.
   *
   * The cache answers instantly when this shell has looked before; the refresh
   * behind it only switches scope while the input is still untouched, so it can
   * never rewrite something the user has started typing.
   */
  const resumeIntoConversation = useCallback(
    (slotId: string) => {
      const enter = () =>
        setState((current) =>
          current.open &&
          current.mode === "all" &&
          !current.argSession &&
          current.query === ""
            ? {
                ...current,
                mode: "quickfire",
                inputEpoch: current.inputEpoch + 1,
              }
            : current,
        );
      if (conversationSlotsRef.current.has(slotId)) enter();
      void refreshConversationSlots().then((slots) => {
        if (slots?.has(slotId)) enter();
      });
    },
    [refreshConversationSlots],
  );

  const open = useCallback(
    (
      mode: QuickfireMode,
      options?: {
        panelId?: string;
        conversation?: Omit<ConversationSurfaceRequest, "sequence">;
        /** Pre-filled compose text (without the mode prefix); the user sends. */
        prompt?: string;
      },
    ) => {
      setPanelLost(false);
      void (async () => {
        let focused: string | null = null;
        try {
          // Acquire panel context before mounting/focusing the overlay. Once
          // its WebContents takes focus, the panel registry intentionally has
          // no focused panel and can no longer answer this question.
          focused = await acquireFocusedPanelIdAfterRestore(
            focusRestoreRef,
            () => panel.getFocusedPanelId(),
          );
        } catch {
          // A palette that cannot describe the panel is still a working palette;
          // only the panel-scoped commands drop out.
        }

        returnFocusPanelIdRef.current = focused;
        setState((current) => ({
          ...CLOSED,
          open: true,
          mode,
          query: options?.prompt
            ? `${QUICKFIRE_MODE_PREFIX[mode]}${options.prompt}`
            : "",
          inputEpoch: current.inputEpoch + 1,
          conversation: options?.conversation ?? null,
        }));
        setFocusRequest((sequence) => sequence + 1);

        try {
          // Focus restore always names the panel the user was actually on, even
          // when the overlay was opened *about* a different one (a context menu
          // on a background tree node): dismissing must not move them.
          const target = options?.panelId ?? focused;
          if (mode === "all" && target) resumeIntoConversation(target);
          setChromeState(target ? await panel.getChromeState(target) : null);
        } catch {
          // A palette that cannot describe the panel is still a working palette;
          // only the panel-scoped commands drop out.
          setChromeState(null);
        }
        void panel
          .listPinnedPanelIds()
          .then(setPinnedPanelIds)
          .catch(() => setPinnedPanelIds([]));
        void hostCommands
          .list()
          .then((contributions) =>
            setContributed(
              contributions.flatMap((contribution) =>
                contribution.commands.map((command) =>
                  commandSpecFromWire(command, {
                    panelId: contribution.panelId,
                  }),
                ),
              ),
            ),
          )
          .catch(() => setContributed([]));
        void workspace
          .list()
          .then((entries) =>
            setWorkspaceNames(entries.map((entry) => entry.name)),
          )
          .catch(() => setWorkspaceNames([]));
      })();
    },
    [resumeIntoConversation],
  );

  useShellEvent(
    "open-command-palette",
    useCallback(() => open("all"), [open]),
  );
  // A panel or skill handing the user to the agent that sees a panel
  // (`app.openShellSurface({ kind: "command-agent", … })`). A prompt lands in
  // the compose box of the `/` surface; nothing is sent on the caller's behalf.
  useShellEvent(
    "open-command-agent",
    useCallback(
      (request) => {
        const mode = request?.mode ?? (request?.prompt ? "quickfire" : "all");
        const options = {
          ...(request?.panelId ? { panelId: request.panelId } : {}),
          ...(request?.prompt ? { prompt: request.prompt } : {}),
        };
        if (!request?.panelId) {
          open(mode, options);
          return;
        }
        // Coherence: the overlay is bound to the named panel, so that panel
        // must be the one the user is looking at — otherwise the conversation
        // would be "about" a panel they cannot see, and dismissal would return
        // them to the wrong place. Focus first, then open; a panel that cannot
        // be focused (gone, or not ours to focus) still gets the overlay bound
        // to it, which the header names explicitly.
        void panel
          .focus(request.panelId)
          .catch(() => {})
          .then(() => open(mode, options));
      },
      [open],
    ),
  );
  // Chrome-side requests (tree button, breadcrumb and tree context menus) come
  // through an atom because a renderer cannot emit shell events.
  const commandAgentRequest = useAtomValue(commandAgentRequestAtom);
  useEffect(() => {
    if (!commandAgentRequest) return;
    open(commandAgentRequest.mode, {
      ...(commandAgentRequest.panelId
        ? { panelId: commandAgentRequest.panelId }
        : {}),
    });
    // `sequence` is the identity of the request: repeating the same ask reopens.
  }, [commandAgentRequest, open]);
  // A notification asking to talk to the agent that sent it (plan §4.8): the
  // same overlay, in `/` mode, bound to that conversation instead of a slot.
  const conversationRequest = useAtomValue(conversationSurfaceRequestAtom);
  useEffect(() => {
    if (!conversationRequest) return;
    const { sequence: _sequence, ...conversation } = conversationRequest;
    open("quickfire", { conversation });
  }, [conversationRequest, open]);

  /**
   * Close the overlay. Focus returns to the panel the user was looking at only
   * on a plain dismissal (Esc, outside click) — a command that navigated or
   * created a panel just moved focus deliberately, and restoring the old panel
   * would race that navigation and bounce the user back (§1.3/§2.3).
   */
  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    setState(CLOSED);
    setQuickfireConversations(null);
    const returnTo = returnFocusPanelIdRef.current;
    returnFocusPanelIdRef.current = null;
    if (options?.restoreFocus !== false && returnTo) {
      focusRestoreRef.current = panel.focus(returnTo).then(
        () => undefined,
        () => undefined,
      );
    }
  }, []);

  // The bound slot can vanish under an open overlay (§4.4 `panel-lost`).
  useShellEvent(
    "panel-tree-invalidated",
    useCallback(() => {
      const panelId = chromeState?.panelId;
      if (!state.open || !panelId) return;
      void panel
        .getChromeState(panelId)
        .then((next) => setChromeState(next))
        .catch(() => setPanelLost(true));
    }, [chromeState?.panelId, state.open]),
  );

  /**
   * The slot the conversation is bound to. Non-null only while the user is
   * actually in quickfire mode over a live panel: entering `/` IS the gesture
   * that creates the conversation, so this must never be driven by focus alone.
   */
  const quickfireSlotId =
    state.open && state.mode === "quickfire" && !state.argSession && !panelLost
      ? (chromeState?.panelId ?? null)
      : null;
  const conversationBinding =
    state.open && state.mode === "quickfire" ? state.conversation : null;
  const quickfireSource = useMemo<QuickfireSessionSource | null>(() => {
    if (conversationBinding) {
      return {
        kind: "conversation",
        channelId: conversationBinding.channelId,
        contextId: conversationBinding.contextId,
        clientId: `conversation:${conversationBinding.channelId}`,
        ...(conversationBinding.focusMessageId
          ? { focusMessageId: conversationBinding.focusMessageId }
          : {}),
        ...(conversationBinding.replyTo
          ? {
              replyTo: {
                participantId: conversationBinding.replyTo.participantId,
              },
            }
          : {}),
      };
    }
    return quickfireSlotId ? { kind: "slot", slotId: quickfireSlotId } : null;
  }, [conversationBinding, quickfireSlotId]);
  const quickfireSession = useQuickfireSession(quickfireSource);

  // A send can create the first durable conversation after the open-time
  // snapshot. Remember it immediately so the next open resumes synchronously.
  useEffect(() => {
    if (!quickfireSlotId) return;
    if (
      quickfireSession.view.hasConversation &&
      !quickfireSession.view.promoted
    ) {
      conversationSlotsRef.current.add(quickfireSlotId);
    }
  }, [
    quickfireSession.view.hasConversation,
    quickfireSession.view.promoted,
    quickfireSlotId,
  ]);

  const searchQuery = state.argSession
    ? state.query
    : stripModePrefix(state.query, state.mode);

  // --- Open-panel index for the `@` scope and `panel` arguments -------------
  // Collected once per open and filtered locally: the durable tree search
  // requires a non-empty query, and the palette's idle state has none.
  useEffect(() => {
    if (!state.open) return;
    let live = true;
    void collectOpenPanels()
      .then((entries) => {
        if (live) setOpenPanels(entries);
      })
      .catch(() => {
        if (live) setOpenPanels([]);
      });
    return () => {
      live = false;
    };
  }, [state.open]);

  // --- Live durable panel-title search -------------------------------------
  // Non-blocking by construction: the locally filtered walk already renders,
  // and these hits merge in when they arrive. Never awaited, never cleared
  // before the replacement lands, so the list does not flicker while typing.
  const panelSearchQuery =
    !state.argSession && (state.mode === "all" || state.mode === "goto")
      ? (state.mode === "goto"
          ? parseGotoScope(searchQuery).query
          : searchQuery
        ).trim()
      : "";
  useEffect(() => {
    if (!state.open || !panelSearchQuery) {
      setTreeHits([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void panel
        .searchTree({ query: panelSearchQuery, limit: PANEL_SEARCH_LIMIT })
        .then((page) => {
          if (!live) return;
          setTreeHits(
            page.hits.map((hit) => {
              const parent = hit.ancestors.at(-1);
              return {
                id: hit.node.slotId,
                title: hit.node.title,
                source: hit.node.source ?? "",
                ...(hit.node.icon ? { icon: hit.node.icon } : {}),
                ...(parent ? { location: parent.title } : {}),
              };
            }),
          );
        })
        .catch(() => {
          // A palette that cannot reach the durable index still searches what
          // it walked; dropping the local rows too would be strictly worse.
          if (live) setTreeHits([]);
        });
    }, HISTORY_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [panelSearchQuery, state.open]);

  // --- Browser history for the `@` scope and mixed mode ---------------------
  // Same data path as the title bar's address autocomplete
  // (`panel.getBrowserAddressOptions` → the shell's browser-data client), so
  // the palette and the address bar never disagree about what "recent" means.
  // Search engines are dropped: they are an address-bar affordance, not a
  // destination. Favicons are deliberately not fetched — the address bar's
  // rows are glyph-only too, and one image RPC per row would cost more than it
  // tells the user.
  const historyQuery =
    state.mode === "goto" ? parseGotoScope(searchQuery).query : searchQuery;
  const wantsHistory =
    !state.argSession && (state.mode === "all" || state.mode === "goto");
  useEffect(() => {
    if (!state.open || !wantsHistory) {
      setHistory([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void panel
        .getBrowserAddressOptions(historyQuery)
        .then((options) => {
          if (live) {
            setHistory(
              options.suggestions.filter(
                (item) => item.source !== "search-engine",
              ),
            );
          }
        })
        .catch(() => {
          // A palette that cannot reach history is still a working palette.
          if (live) setHistory([]);
        });
    }, HISTORY_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [historyQuery, state.open, wantsHistory]);

  // --- Ranking --------------------------------------------------------------
  const rows = useMemo(() => {
    const base = buildPaletteRows({
      mode: state.mode,
      argSession: state.argSession,
      query: searchQuery,
      ctx,
      commands,
      history,
    });
    if (!quickfireConversations) return base;
    // The picker replaces the ranked list while it is up: it was opened by an
    // explicit command, and mixing it with unrelated suggestions would make
    // Enter ambiguous.
    return [
      {
        key: "quickfire-conversations",
        label: "Quickfire agent conversations",
        rows: quickfireConversations.map((row) => ({
          id: `quickfire-slot:${row.slotId}`,
          title:
            openPanels.find((entry) => entry.id === row.slotId)?.title ??
            row.slotId,
          meta:
            row.promotedAt === null
              ? "conversation"
              : "continued in a chat panel",
          icon: "✦",
        })),
      },
    ];
  }, [
    commands,
    ctx,
    history,
    openPanels,
    quickfireConversations,
    searchQuery,
    state,
  ]);

  const selectedId = useMemo(() => {
    const flat = rows.flatMap((group) => group.rows);
    if (
      state.selectionTouched &&
      flat.some((row) => row.id === state.selectedId)
    ) {
      return state.selectedId;
    }
    return flat.find((row) => !row.disabled)?.id ?? flat[0]?.id ?? null;
  }, [rows, state.selectedId, state.selectionTouched]);

  const ghostSuffix = useMemo(() => {
    if (state.argSession) return null;
    const selected = rows
      .flatMap((group) => group.rows)
      .find((row) => row.id === selectedId);
    if (!selected) return null;
    const completion = completionForRow(selected);
    if (!completion) return null;
    const typed = stripModePrefix(state.query, state.mode).trim();
    if (!typed || !completion.toLowerCase().startsWith(typed.toLowerCase()))
      return null;
    const suffix = completion.slice(typed.length);
    return suffix || null;
  }, [rows, selectedId, state.argSession, state.mode, state.query]);

  // --- Anchor measurement ---------------------------------------------------
  useEffect(() => {
    const measure = () => {
      const host = document.getElementById(QUICKFIRE_OVERLAY_HOST_ID);
      const rect = host?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        setAnchorBounds(null);
        return;
      }
      // The native overlay pins itself to the top-left of the anchor it is
      // handed, inset by its own margin. Handing it a rect positioned where the
      // card belongs is how a corner-anchored primitive renders a centered,
      // top-aligned card without a second placement mode in main.
      // Clamp to the panel viewport so a narrow window never clips the card
      // (§4: width 640, clamped to anchor rect − 48px).
      const viewWidth = Math.min(
        CARD_WIDTH + SURFACE_MARGIN * 2,
        rect.width - ANCHOR_MARGIN * 2,
      );
      const width = viewWidth + ANCHOR_MARGIN * 2;
      const centeredX = rect.left + rect.width / 2 - viewWidth / 2;
      const next = {
        x: Math.round(Math.max(rect.left, centeredX) - ANCHOR_MARGIN),
        y: Math.round(rect.top + rect.height * TOP_FRACTION - ANCHOR_MARGIN),
        width: Math.round(width),
        height: Math.round(
          rect.height * MAX_HEIGHT_FRACTION + ANCHOR_MARGIN * 2,
        ),
      };
      setAnchorBounds((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };
    measure();
    const host = document.getElementById(QUICKFIRE_OVERLAY_HOST_ID);
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(host as Element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // --- Execution ------------------------------------------------------------
  const flashRow = useCallback((rowId: string) => {
    window.clearTimeout(flashTimerRef.current);
    setState((current) => ({ ...current, flashRowId: rowId }));
    flashTimerRef.current = window.setTimeout(() => {
      setState((current) => ({ ...current, flashRowId: null }));
    }, SUCCESS_FLASH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);

  const applyOutcome = useCallback(
    (outcome: CommandOutcome, rowId: string) => {
      if (outcome.mode) {
        setState((current) => ({
          ...CLOSED,
          open: true,
          mode: outcome.mode!,
          query: `${QUICKFIRE_MODE_PREFIX[outcome.mode!]}${outcome.query ?? ""}`,
          inputEpoch: current.inputEpoch + 1,
        }));
        return;
      }
      if (outcome.close) {
        // Commands that close either navigated somewhere or dismissed a dialog
        // flow; either way the focus they left behind is the intended one.
        close({ restoreFocus: false });
        return;
      }
      // Non-navigating commands leave the palette open for chaining and say so
      // on the row itself rather than with a toast (§4.4).
      setState((current) => ({ ...current, argSession: null }));
      flashRow(rowId);
    },
    [close, flashRow],
  );

  const execute = useCallback(
    (command: CommandSpec, args: Record<string, string>, rowId: string) => {
      const runner = slateById.get(command.id);
      const operation = runner
        ? Promise.resolve(runner.run(args, deps))
        : command.panelId
          ? runContributedCommand(
              command.panelId,
              command.id.slice(command.panelId.length + 1),
            )
          : null;
      if (!operation) return;
      void operation
        .then((outcome) => applyOutcome(outcome ?? {}, rowId))
        .catch((error: unknown) => {
          reportCommandFailure(error);
          close();
        });
    },
    [applyOutcome, close, deps, slateById],
  );

  /** Enter a command: run it, or open its argument session. */
  const activateCommand = useCallback(
    (command: CommandSpec, rowId: string) => {
      const inline = parseInlineCommand(
        stripModePrefix(state.query, state.mode),
        [command],
        ctx,
      );
      const outcome = startArgSession(command, {
        ...(inline
          ? { prefilled: inline.filled, seedQuery: inline.residual }
          : {}),
        restoreQuery: state.query,
      });
      if (outcome.kind === "execute") {
        execute(command, outcome.args, rowId);
        return;
      }
      if (outcome.kind === "session") {
        setState((current) => ({
          ...current,
          argSession: outcome.session,
          query: outcome.session.query,
          inputEpoch: current.inputEpoch + 1,
          selectedId: null,
          selectionTouched: false,
        }));
      }
    },
    [ctx, execute, state.mode, state.query],
  );

  const rowTargets = useMemo(
    () => buildRowTargets(rows, commands, { argSession: state.argSession }),
    [commands, rows, state.argSession],
  );

  const applySessionOutcome = useCallback(
    (outcome: ReturnType<typeof reduceArgSession>, rowId: string) => {
      if (outcome.kind === "execute") {
        execute(outcome.command, outcome.args, rowId);
        return;
      }
      if (outcome.kind === "exit") {
        setState((current) => ({
          ...current,
          argSession: null,
          query: outcome.restoreQuery,
          inputEpoch: current.inputEpoch + 1,
          selectedId: null,
          selectionTouched: false,
        }));
        return;
      }
      setState((current) => ({
        ...current,
        argSession: outcome.session,
        query: outcome.session.query,
        inputEpoch: current.inputEpoch + 1,
        selectedId: null,
        selectionTouched: false,
      }));
    },
    [execute],
  );

  const activateRow = useCallback(
    (rowId: string) => {
      const flat = rows.flatMap((group) => group.rows);
      const row = flat.find((entry) => entry.id === rowId);
      if (!row || row.disabled) return;
      const target = rowTargets.get(rowId);
      if (!target) return;
      switch (target.kind) {
        case "command":
          activateCommand(target.command, rowId);
          return;
        case "option": {
          const session = state.argSession;
          if (!session) return;
          const outcome = reduceArgSession(session, {
            type: "enter",
            value: target.value,
          });
          applySessionOutcome(outcome, rowId);
          return;
        }
        case "panel":
          if (state.retargeting) {
            // Rebind, do not navigate: the overlay stays put and starts talking
            // about the panel you picked.
            setState((current) => ({
              ...current,
              retargeting: false,
              mode: "quickfire",
              query: "",
              inputEpoch: current.inputEpoch + 1,
              selectedId: null,
              selectionTouched: false,
            }));
            setPanelLost(false);
            void panel
              .getChromeState(target.panelId)
              .then(setChromeState)
              .catch(() => setPanelLost(true));
            return;
          }
          navigateToId(target.panelId);
          close({ restoreFocus: false });
          return;
        case "quickfire-slot":
          // Focus the slot, then reopen the overlay over it in quickfire mode
          // so the conversation binds to the panel the user just moved to.
          navigateToId(target.slotId);
          setQuickfireConversations(null);
          open("quickfire");
          return;
        case "url":
          void panel
            .createBrowser(target.url, { focus: true })
            .catch(reportCommandFailure);
          close({ restoreFocus: false });
          return;
        case "quickfire-ask":
          // Enter on typed prose is one gesture: switch into the conversation
          // over this panel and send what was typed. The compose box opens empty
          // because the message is already on its way — the core queues it until
          // the binding resolves.
          setQuickfireConversations(null);
          setState((current) => ({
            ...current,
            mode: "quickfire",
            argSession: null,
            query: "",
            inputEpoch: current.inputEpoch + 1,
            selectedId: null,
            selectionTouched: false,
          }));
          void quickfireSession.send(target.prompt).catch(reportCommandFailure);
          return;
        case "chat":
          void panel
            .createPanel("panels/chat", {
              focus: true,
              stateArgs: { initialPrompt: target.prompt },
            })
            .catch(reportCommandFailure);
          close({ restoreFocus: false });
          return;
      }
    },
    [
      activateCommand,
      applySessionOutcome,
      close,
      navigateToId,
      open,
      quickfireSession,
      rowTargets,
      rows,
      state.argSession,
    ],
  );

  // --- Intents --------------------------------------------------------------
  // --- Quickfire actions ----------------------------------------------------
  /**
   * Hand this exact conversation to a chat panel. Promotion is a view change,
   * not a copy: the panel attaches to the same channel, and the mapping is
   * marked promoted so closing the source slot no longer archives it (§1.4).
   */
  const promoteToChatPanel = useCallback(async () => {
    if (state.conversation) {
      // A conversation surface has nothing to promote: its chat panel is
      // found-or-opened (never duplicated), landing on the envelope it opened on.
      const { channelId, focusMessageId } = state.conversation;
      close({ restoreFocus: false });
      await userNotifications.openChannel(channelId, {
        ...(focusMessageId ? { focusMessageId } : {}),
      });
      return;
    }
    const parentSlot = chromeState?.panelId;
    // Capture the bound session and issue promotion before closing: closing
    // removes the overlay's source binding on the next render, but must not
    // leave its presentation onscreen while the durable RPC or panel build runs.
    const promotion = quickfireSession.promote();
    close({ restoreFocus: false });
    const promoted = await promotion;
    if (!promoted) return;
    const { channelId, contextId } = promoted;
    const opened = parentSlot
      ? await panel.createChild(parentSlot, "panels/chat", {
          stateArgs: { channelName: channelId },
          contextId,
          focus: true,
        })
      : await panel.createPanel("panels/chat", {
          focus: true,
          stateArgs: { channelName: channelId },
          contextId,
        });
    if (opened?.id) promotedPanelIdsRef.current.set(channelId, opened.id);
  }, [chromeState?.panelId, close, quickfireSession, state.conversation]);

  /**
   * Focus the chat panel a promoted conversation continued into.
   *
   * The panel this shell opened is remembered by channel; the open-panel index
   * carries no stateArgs, so guessing from it would be guessing. If the panel
   * was since closed, open a fresh view of the same durable channel — the
   * conversation outlived the view, which is the whole point of promotion.
   */
  const focusPromotedPanel = useCallback(async () => {
    const channelId = quickfireSession.view.channelId;
    const contextId = quickfireSession.view.contextId;
    if (!channelId || !contextId) return;
    const known = promotedPanelIdsRef.current.get(channelId);
    if (known) {
      navigateToId(known);
      close({ restoreFocus: false });
      return;
    }
    const opened = await panel.createPanel("panels/chat", {
      focus: true,
      stateArgs: { channelName: channelId },
      contextId,
    });
    if (opened?.id) promotedPanelIdsRef.current.set(channelId, opened.id);
    close({ restoreFocus: false });
  }, [
    close,
    navigateToId,
    quickfireSession.view.channelId,
    quickfireSession.view.contextId,
  ]);

  /**
   * Open a link the agent wrote.
   *
   * Deliberately never `panel.navigate`: the overlay floats over the panel the
   * user is looking at, and replacing that panel's content because they clicked
   * a reference in a reply would destroy the thing they were asking about. A
   * link opens beside it — as a child of the bound panel when there is one.
   */
  const openLink = useCallback(
    async (href: string) => {
      const target = classifyQuickfireLink(href);
      if (!target) return;
      const parentSlot = chromeState?.panelId ?? null;
      if (target.kind === "external") {
        await app.openExternal(target.url);
        return;
      }
      if (target.kind === "browser-url") {
        await panel.createBrowser(target.url, { focus: true });
      } else if (target.kind === "panel-source") {
        await (parentSlot
          ? panel.createChild(parentSlot, target.source, { focus: true })
          : panel.createPanel(target.source, { focus: true, isRoot: true }));
      } else {
        const { location } = target;
        const common = {
          ref: location.ref,
          contextId: location.contextId,
          stateArgs: location.stateArgs,
          placement: location.placement,
        };
        await (parentSlot
          ? panel.createChild(parentSlot, location.source, {
              ...common,
              title: location.title,
              slug: location.slug,
              focus: location.focus ?? true,
            })
          : panel.createPanel(location.source, {
              ...common,
              title: location.title,
              slug: location.slug,
              isRoot: true,
              focus: location.focus ?? true,
            }));
      }
      // Opening moved focus deliberately; restoring the old panel would race it.
      close({ restoreFocus: false });
    },
    [chromeState?.panelId, close],
  );

  const handleIntent = useCallback(
    (payload: unknown) => {
      const intent = payload as QuickfireIntent | null;
      if (
        !intent ||
        typeof intent !== "object" ||
        typeof intent.type !== "string"
      )
        return;
      switch (intent.type) {
        case "input":
          recallRef.current = -1;
          setQuickfireConversations(null);
          setState((current) => ({
            ...current,
            query: intent.value,
            // A conversation is a durable interaction mode, not a query
            // prefix. Once entered, ordinary prose (including prose beginning
            // with `@`, `>` or `/`) is a reply until Clear explicitly returns
            // to commands.
            mode:
              current.mode === "quickfire" || current.argSession
                ? current.mode
                : modeForInput(intent.value, current.mode),
            selectedId: null,
            selectionTouched: false,
            ...(current.argSession
              ? {
                  argSession: {
                    ...current.argSession,
                    query: intent.value,
                    error: null,
                  },
                }
              : {}),
          }));
          return;
        case "select":
          setState((current) => ({
            ...current,
            selectedId: intent.rowId,
            selectionTouched: true,
          }));
          return;
        case "activate":
          activateRow(intent.rowId);
          return;
        case "move": {
          const flat = rows.flatMap((group) => group.rows);
          if (!flat.length) return;
          const index = Math.max(
            0,
            flat.findIndex((row) => row.id === selectedId),
          );
          const next = (index + intent.delta + flat.length) % flat.length;
          setState((current) => ({
            ...current,
            selectedId: flat[next]!.id,
            selectionTouched: true,
          }));
          return;
        }
        case "accept-completion": {
          if (!ghostSuffix) return;
          setState((current) => ({
            ...current,
            query: `${current.query}${ghostSuffix}`,
            inputEpoch: current.inputEpoch + 1,
          }));
          return;
        }
        case "mode":
          setState((current) => setMode(current, intent.mode));
          return;
        case "cycle-mode":
          if (state.mode === "quickfire" && !state.argSession) return;
          setState((current) => {
            const next =
              QUICKFIRE_MODE_CYCLE[
                (QUICKFIRE_MODE_CYCLE.indexOf(current.mode) + 1) %
                  QUICKFIRE_MODE_CYCLE.length
              ]!;
            return setMode(current, next);
          });
          return;
        case "backspace-empty":
          if (state.argSession) {
            applySessionOutcome(
              reduceArgSession(state.argSession, { type: "backspace" }),
              selectedId ?? "",
            );
            return;
          }
          if (state.mode === "quickfire") return;
          // Dropping the prefix is the palette's other "one step back".
          setState((current) =>
            current.mode === "all" ? current : setMode(current, "all"),
          );
          return;
        case "escape":
          // Escape means "put this away". The spec's chain also stepped back
          // through the scope first, which read as Esc not working: now that one
          // key opens straight into a resumed conversation, the scope you are in
          // is rarely one you navigated to, and pressing Esc twice to close a
          // thing you opened once is not a mental model worth defending.
          // Backspace on an empty input still drops the scope prefix.
          if (state.argSession) {
            applySessionOutcome(
              reduceArgSession(state.argSession, { type: "escape" }),
              selectedId ?? "",
            );
            return;
          }
          close();
          return;
        case "dismiss":
          close();
          return;
        case "host-escape":
          // Only meaningful while we are the visible overlay; the approval card
          // receives the same forwarded intent and ignores it.
          close();
          return;
        case "host-pointer-down":
          // The underlying native view is handling this same press. Do not
          // restore the old panel and race the user's chosen focus target.
          close({ restoreFocus: false });
          return;
        case "send":
          recallRef.current = -1;
          void quickfireSession.send(intent.text);
          return;
        case "send-and-promote":
          void quickfireSession
            .send(intent.text)
            .then(() => promoteToChatPanel())
            .catch(reportCommandFailure);
          return;
        case "stop":
          void quickfireSession.stop().catch(reportCommandFailure);
          return;
        case "recall": {
          // Your own words, newest first. The overlay's transcript is already
          // newest-first, so this walks it in the order it is displayed.
          const mine = quickfireSession.view.transcript
            .filter(
              (entry): entry is Extract<typeof entry, { kind: "message" }> =>
                entry.kind === "message" && entry.author === "you",
            )
            .map((entry) => entry.text)
            .filter((text) => text.trim().length > 0);
          if (mine.length === 0) return;
          const next = Math.min(
            mine.length - 1,
            Math.max(-1, recallRef.current + (intent.delta < 0 ? 1 : -1)),
          );
          recallRef.current = next;
          setState((current) => ({
            ...current,
            query: next < 0 ? "" : (mine[next] ?? ""),
            inputEpoch: current.inputEpoch + 1,
          }));
          return;
        }
        case "retarget":
          setState((current) => ({
            ...current,
            retargeting: true,
            mode: "goto",
            query: QUICKFIRE_MODE_PREFIX.goto,
            inputEpoch: current.inputEpoch + 1,
            selectedId: null,
            selectionTouched: false,
          }));
          return;
        case "show-older":
          void quickfireSession.showOlder();
          return;
        case "open-link":
          void openLink(intent.href).catch(reportCommandFailure);
          return;
        case "reveal-image":
          quickfireSession.revealImage(intent.imageId);
          return;
        case "clear":
          // A notification-bound conversation cannot be destroyed from this
          // borrowed surface. Slot conversations clear and return to commands.
          if (state.conversation) return;
          void quickfireSession
            .clear()
            .then(() => {
              conversationIndexEpochRef.current += 1;
              if (quickfireSlotId)
                conversationSlotsRef.current.delete(quickfireSlotId);
              setQuickfireConversations(null);
              setState((current) => ({
                ...current,
                mode: "all",
                query: "",
                inputEpoch: current.inputEpoch + 1,
                argSession: null,
                selectedId: null,
                selectionTouched: false,
              }));
            })
            .catch(reportCommandFailure);
          return;
        case "promote":
          void promoteToChatPanel().catch(reportCommandFailure);
          return;
        case "focus-promoted":
          void focusPromotedPanel().catch(reportCommandFailure);
          return;
        case "start-fresh":
          if (state.conversation) return;
          void quickfireSession.startFresh().catch(reportCommandFailure);
          return;
      }
    },
    [
      activateRow,
      applySessionOutcome,
      state.conversation,
      close,
      focusPromotedPanel,
      ghostSuffix,
      openLink,
      promoteToChatPanel,
      quickfireSession,
      quickfireSlotId,
      rows,
      selectedId,
      state.argSession,
      state.mode,
      state.retargeting,
    ],
  );

  // --- Props ----------------------------------------------------------------
  const theme = useMemo<OverlayThemeInfo>(
    () => ({
      appearance: effectiveTheme,
      accentColor: themeConfig.accentColor,
      grayColor: themeConfig.grayColor,
      radius: themeConfig.radius,
      scaling: themeConfig.scaling,
      panelBackground: themeConfig.panelBackground,
    }),
    [
      effectiveTheme,
      themeConfig.accentColor,
      themeConfig.grayColor,
      themeConfig.panelBackground,
      themeConfig.radius,
      themeConfig.scaling,
    ],
  );

  const surfaceProps = useMemo<QuickfireSurfaceProps>(() => {
    const session = state.argSession;
    // Named apart from the imported `quickfire` service client.
    const conversation = quickfireSession;
    const arg = session ? activeArgSpec(session) : undefined;
    return {
      mode: state.mode,
      inputValue: state.query,
      inputEpoch: state.inputEpoch,
      placeholder: session
        ? (arg?.label ?? "")
        : QUICKFIRE_MODE_PLACEHOLDER[state.mode],
      ghostSuffix,
      groups: rows,
      selectedId,
      argSession:
        session && arg
          ? {
              commandTitle: session.spec.title,
              chips: filledArgChips(session).map(({ arg: chipArg, value }) => ({
                name: chipArg.name,
                label: chipArg.label,
                value,
              })),
              activeLabel: arg.label,
              error: session.error,
            }
          : null,
      context: chromeState
        ? {
            title: chromeState.title,
            ...(panelLost ? { lost: true } : {}),
          }
        : null,
      emptyMessage: rows.length
        ? null
        : emptyMessageFor({ argSession: state.argSession, query: searchQuery }),
      flashRowId: state.flashRowId,
      compose:
        state.mode === "quickfire" && !session
          ? {
              kind: state.conversation
                ? ("conversation" as const)
                : ("slot" as const),
              panelTitle: state.conversation
                ? (state.conversation.title ??
                  (state.conversation.replyTo?.handle
                    ? `@${state.conversation.replyTo.handle}`
                    : state.conversation.channelId))
                : (chromeState?.title ?? "this panel"),
              hint: state.conversation
                ? state.conversation.replyTo?.handle
                  ? `Reply to @${state.conversation.replyTo.handle}. Open the chat panel for the whole conversation.`
                  : "Reply here, or open the chat panel for the whole conversation."
                : "Ask about this panel. I can describe what it is and how it is running.",
              // The overlay's input is at the top, so the conversation reads
              // downward from it: newest first (see `useQuickfireSession`).
              transcriptOrder: "newest-first" as const,
              // Honest about why the box is dead, never silently inert.
              disabledReason: state.conversation
                ? conversation.view.error
                : panelLost
                  ? "That panel closed. Reopen the Quickfire agent over another panel to keep going."
                  : !chromeState
                    ? "No panel is focused, so there is nothing to ask about."
                    : conversation.view.error,
              transcript: conversation.view.transcript,
              olderCount: conversation.view.olderCount,
              expandable: conversation.view.expandable,
              loadingOlder: conversation.view.loadingOlder,
              credentialRequest: conversation.view.credentialRequest,
              resume: conversation.view.resume,
              // The envelope this surface was opened on, so the notification the
              // person tapped is the one they land on (messaging plan §4.8).
              focusMessageId: state.conversation?.focusMessageId ?? null,
              connecting: conversation.view.connecting,
              streaming: conversation.view.streaming,
              promoted: conversation.view.promoted,
              hasConversation: conversation.view.hasConversation,
              error: conversation.view.error,
              // Only for a slot conversation: a notification thread already has
              // a subject, and offering "what is this panel doing?" there is
              // answering a question nobody asked.
              ...(state.conversation
                ? {}
                : {
                    suggestions: suggestedOpeners({
                      title: chromeState?.title ?? null,
                      kind:
                        chromeState?.kind === "browser"
                          ? "browser"
                          : "workspace",
                    }),
                  }),
            }
          : null,
    };
  }, [
    chromeState,
    ghostSuffix,
    panelLost,
    quickfireSession,
    rows,
    searchQuery,
    selectedId,
    state,
  ]);

  useShellContentOverlay(
    state.open && anchorBounds
      ? {
          surface: QUICKFIRE_SURFACE_KEY,
          open: true,
          bounds: anchorBounds,
          // The palette always takes keyboard focus on open (§2.3).
          focusRequest: `quickfire:${focusRequest}`,
          theme,
          props: surfaceProps,
        }
      : null,
    handleIntent,
  );

  return null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Union of the walked index and the durable search hits, walk order first.
 *
 * The walk carries the tree order the sidebar shows, which is what the idle list
 * and tie-breaking rank by; search hits are appended for panels the bounded walk
 * never reached. Slot ids are the identity, so a panel found twice appears once.
 */
function mergePanelEntries(
  walked: OpenPanelEntry[],
  found: OpenPanelEntry[],
): OpenPanelEntry[] {
  if (found.length === 0) return walked;
  const seen = new Set(walked.map((entry) => entry.id));
  return [...walked, ...found.filter((entry) => !seen.has(entry.id))];
}

/** Bounded walk of the open panel forest — the "already open" index (§4.1). */
async function collectOpenPanels(): Promise<OpenPanelEntry[]> {
  const entries: OpenPanelEntry[] = [];
  const titles = new Map<string, string>();
  const pending: Array<
    | { kind: "roots"; ownerUserId: string | null }
    | { kind: "children"; parentSlotId: string }
  > = [];
  const groups = await panel.getRootGroups({ limit: 50 });
  for (const group of groups.groups)
    pending.push({ kind: "roots", ownerUserId: group.ownerUserId });
  while (pending.length && entries.length < MAX_OPEN_PANELS) {
    const group = pending.shift()!;
    let cursor: string | undefined;
    do {
      const page = await panel.getTreePage({
        group,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const node of page.nodes) {
        titles.set(node.slotId, node.title);
        const parentTitle = node.parentSlotId
          ? titles.get(node.parentSlotId)
          : undefined;
        entries.push({
          id: node.slotId,
          title: node.title,
          source: node.source ?? "",
          ...(node.icon ? { icon: node.icon } : {}),
          ...(parentTitle ? { location: parentTitle } : {}),
        });
        if (node.childCount > 0)
          pending.push({ kind: "children", parentSlotId: node.slotId });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && entries.length < MAX_OPEN_PANELS);
  }
  return entries;
}

/**
 * Switch mode while keeping the typed query, and force the surface's input to
 * adopt the rewritten value (the surface owns its input locally otherwise).
 */
function setMode(current: OverlayState, mode: QuickfireMode): OverlayState {
  return {
    ...current,
    mode,
    argSession: null,
    query: inputForMode(current.query, current.mode, mode),
    inputEpoch: current.inputEpoch + 1,
    selectedId: null,
    selectionTouched: false,
  };
}
