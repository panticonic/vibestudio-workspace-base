/**
 * The transport-agnostic core of one quickfire conversation
 * (quickfire-overlay-spec §2.4).
 *
 * The desktop overlay and the mobile sheet resolve, join, reduce and drive the
 * same durable conversation; only the way they reach the workspace differs
 * (Electron's preload RPC bridge vs. the mobile WebRTC pipe). So the whole
 * lifecycle lives here and each client injects a `QuickfireTransport`.
 *
 * Three deliberate choices, unchanged from the desktop original:
 *
 *  - `sessionFor` runs on the user gesture that enters quickfire mode, never on
 *    hover or focus change. Binding a slot creates an agent; that must be
 *    something the user did.
 *  - Only the last `TRANSCRIPT_LIMIT` messages are ever projected. "Show all"
 *    promotes to a chat panel instead of rendering a full transcript.
 *  - Reduction is throttled to ~30 Hz. A streaming turn emits far more events
 *    than either client can usefully repaint.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  createInitialChannelViewState,
  pubsubChannelEventToEnvelope,
  pubsubAgenticEventToEnvelope,
  reduceChannelView,
  type ChannelViewState,
} from "@workspace/agentic-protocol";
import type { PubSubClient } from "@workspace/pubsub";
import type { QuickfireResumeChip, QuickfireTranscriptEntry } from "./model";
import {
  hasOpenTurn,
  projectTranscript,
  TRANSCRIPT_LIMIT,
  type TranscriptOrder,
} from "./transcript";

export { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT };
export type { TranscriptOrder };

/** Per-client presentation choices the shared lifecycle honors. */
export interface QuickfireSessionOptions {
  /**
   * Which end of the conversation this client reads from. Desktop puts its one
   * input at the top and therefore wants the newest message under it; mobile is
   * an ordinary chat and keeps the default.
   */
  transcriptOrder?: TranscriptOrder;
}

/** One channel-client event carrying a trajectory payload. */
interface PubSubAgenticWireEvent {
  type?: string;
  pubsubId?: number;
  senderId?: string;
  ts?: number;
  senderMetadata?: { name?: string; type?: string; handle?: string };
  payload?: unknown;
}

/** ~30 Hz. Streaming deltas arrive far faster than a surface can repaint. */
const PUSH_INTERVAL_MS = 33;

/**
 * The facts a client needs back from `quickfire.sessionFor`/`promote`.
 *
 * Structural on purpose: the canonical schema lives in the host repo
 * (`@vibestudio/service-schemas/quickfire`) and this package deliberately does
 * not depend on it, so both clients can pass their own typed client's result
 * straight through.
 */
export interface QuickfireSessionFacts {
  channelId: string;
  contextId: string;
  state: "fresh" | "resumed" | "promoted";
  messageCount: number | null;
  lastActivityAt: number | null;
}

/**
 * What a session is bound to (messaging plan §4.8). The core does not care
 * which: it resolves facts, joins the channel, reduces the log, and drives it.
 *
 *  - `slot` — the quickfire overlay: a per-slot agent minted on the user's
 *    gesture (`transport.sessionFor`), clearable and restartable.
 *  - `conversation` — an existing channel, e.g. the one an agent notified the
 *    user from. Nothing is minted: the person joins as their ordinary `user:`
 *    participant, and a reply is an ordinary message addressed back to the
 *    notifying participant (`replyTo` the envelope, so respond policies wake
 *    exactly the right agent). There is no "fresh" and no "clear" for a
 *    channel that already exists — those controller members throw in this mode
 *    and surfaces do not render them.
 */
export type QuickfireSessionSource =
  | { kind: "slot"; slotId: string }
  | {
      kind: "conversation";
      channelId: string;
      contextId: string;
      /** Stable client id for the observer connection (the channel maps a
       *  human caller to `user:<id>` regardless). */
      clientId: string;
      /** The envelope this surface opened on; replies thread under it. */
      focusMessageId?: string;
      /** The participant that notified — replies are addressed to it. */
      replyTo?: { participantId: string };
    };

/** Everything the core needs from its host client. */
export interface QuickfireTransport {
  sessionFor: (
    slotId: string,
    options?: { fresh?: boolean }
  ) => Promise<QuickfireSessionFacts>;
  clear: (slotId: string) => Promise<unknown>;
  promote: (slotId: string) => Promise<QuickfireSessionFacts | null>;
  /**
   * Join the conversation's channel for live delivery.
   *
   * `clientId` is the participant id this client claims — the bound slot, the
   * way a panel caller passes its slot id rather than the raw transport id. A
   * client that claims nothing claims its transport id, which is not an
   * identity the channel can admit.
   */
  connectToChannel: (
    channelId: string,
    contextId: string,
    options: { clientId?: string; replayMessageLimit?: number }
  ) => PubSubClient;
}

export interface QuickfireSessionView {
  /** What this session is bound to; `null` while unbound. */
  source: QuickfireSessionSource | null;
  slotId: string | null;
  channelId: string | null;
  contextId: string | null;
  connecting: boolean;
  /** True once a durable mapping exists for the slot (always true for a conversation). */
  hasConversation: boolean;
  promoted: boolean;
  resume: QuickfireResumeChip | null;
  transcript: QuickfireTranscriptEntry[];
  olderCount: number;
  /** Unresolved model credential request carried by the conversation channel. */
  credentialRequest: {
    providerId: string;
    reason: string | null;
  } | null;
  streaming: boolean;
  error: string | null;
}

export interface QuickfireSessionController {
  view: QuickfireSessionView;
  /** `slot` sessions can be cleared and restarted; `conversation` sessions cannot. */
  mode: "slot" | "conversation" | null;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Slot mode only; throws for a conversation. */
  clear: () => Promise<void>;
  /** Slot mode only (promotion mints the chat panel); a conversation resolves to its own facts. */
  promote: () => Promise<QuickfireSessionFacts | null>;
  /** Slot mode only; throws for a conversation. */
  startFresh: () => Promise<void>;
}

const IDLE: QuickfireSessionView = {
  source: null,
  slotId: null,
  channelId: null,
  contextId: null,
  connecting: false,
  hasConversation: false,
  promoted: false,
  resume: null,
  transcript: [],
  olderCount: 0,
  credentialRequest: null,
  streaming: false,
  error: null,
};

/** Accept the historical `slotId` string form as well as a source object. */
function normalizeSource(
  input: string | QuickfireSessionSource | null | undefined
): QuickfireSessionSource | null {
  if (!input) return null;
  return typeof input === "string" ? { kind: "slot", slotId: input } : input;
}

function sourceKey(source: QuickfireSessionSource | null): string {
  if (!source) return "";
  return source.kind === "slot"
    ? `slot:${source.slotId}`
    : `conversation:${source.channelId}:${source.contextId}:${source.clientId}`;
}

/**
 * Resolve and drive the conversation bound to `source`.
 *
 * Passing `null` (surface closed, or not in quickfire mode) tears the connection
 * down. The durable conversation is untouched by that — only clear, slot close,
 * and promotion end a slot conversation; a `conversation` source is never ended
 * from here.
 *
 * `transport` is read through a ref, so a caller that rebuilds the object every
 * render does not churn the connection.
 */
export function useQuickfireSessionCore(
  input: string | QuickfireSessionSource | null,
  transport: QuickfireTransport,
  options: QuickfireSessionOptions = {}
): QuickfireSessionController {
  const transcriptOrder = options.transcriptOrder ?? "oldest-first";
  const source = useMemo(() => normalizeSource(input), [input]);
  const key = sourceKey(source);
  const [view, setView] = useState<QuickfireSessionView>(IDLE);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const clientRef = useRef<PubSubClient | null>(null);
  const stateRef = useRef<ChannelViewState>(createInitialChannelViewState());
  const selfKeyRef = useRef<string | null>(null);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  /**
   * Text sent before the channel finished connecting.
   *
   * Entering quickfire from the palette's ask row (§4.1) sends and binds in the
   * same gesture, and binding is a round trip: dropping the message because the
   * client is a few hundred milliseconds behind would lose the thing the user
   * actually typed. Queued text is flushed once the channel is ready, and
   * discarded when the binding it was typed for goes away.
   */
  const queuedRef = useRef<string[]>([]);

  const flush = useCallback(() => {
    pushTimerRef.current = null;
    const state = stateRef.current;
    const projection = projectTranscript(state, selfKeyRef.current, {
      order: transcriptOrder,
    });
    const credentialRequest = Object.values(state.credentialRequests)
      .sort((left, right) => left.seq - right.seq)
      .slice(-1)[0];
    setView((current) => ({
      ...current,
      transcript: projection.entries,
      olderCount: projection.olderCount,
      // A waiting turn needs an interaction, not a stop spinner. Only an
      // actively executing turn is presented as streaming.
      streaming: Object.values(state.turns).some((turn) => turn.status === "open"),
      credentialRequest: credentialRequest
        ? {
            providerId: credentialRequest.providerId,
            reason: credentialRequest.reason ?? null,
          }
        : null,
    }));
  }, [transcriptOrder]);

  const schedulePush = useCallback(() => {
    if (pushTimerRef.current !== null) return;
    pushTimerRef.current = setTimeout(flush, PUSH_INTERVAL_MS);
  }, [flush]);

  /** Put one message on the wire, surfacing a failure inline rather than throwing. */
  const deliver = useCallback(async (client: PubSubClient, text: string) => {
    const bound = sourceRef.current;
    try {
      if (bound?.kind === "conversation") {
        // A reply into an existing conversation: threaded under the envelope
        // this surface opened on and addressed to whoever sent it, so a
        // directed channel wakes exactly that agent and nobody else.
        await client.send(text, {
          ...(bound.focusMessageId ? { replyTo: bound.focusMessageId } : {}),
          ...(bound.replyTo
            ? {
                mentions: [bound.replyTo.participantId],
                to: [{ kind: "participant" as const, participantId: bound.replyTo.participantId }],
              }
            : {}),
        });
      } else {
        await client.send(text, { mentions: ["quickfire"] });
      }
    } catch (error) {
      setView((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const closeClient = useCallback(() => {
    if (pushTimerRef.current !== null) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
    const client = clientRef.current;
    clientRef.current = null;
    selfKeyRef.current = null;
    // Leaving the channel is a view change only; the durable conversation
    // survives until an explicit lifecycle event ends it.
    void client?.close().catch(() => undefined);
  }, []);

  /**
   * The one binding path: resolve the source to session facts, join the
   * channel, and reduce its event stream. Both the resolve effect and
   * `startFresh` go through here, so a fresh slot session gets the same live
   * transcript as any other (the earlier duplicate connect path never
   * subscribed to events at all).
   */
  const bind = useCallback(
    async (bound: QuickfireSessionSource, generation: number, fresh: boolean) => {
      const live = () => generationRef.current === generation;
      try {
        const session: QuickfireSessionFacts =
          bound.kind === "slot"
            ? await transportRef.current.sessionFor(bound.slotId, { fresh })
            : {
                channelId: bound.channelId,
                contextId: bound.contextId,
                state: "resumed",
                messageCount: null,
                lastActivityAt: null,
              };
        if (!live()) return;
        setView((current) => ({
          ...current,
          source: bound,
          slotId: bound.kind === "slot" ? bound.slotId : null,
          channelId: session.channelId,
          contextId: session.contextId,
          hasConversation: true,
          promoted: session.state === "promoted",
          resume:
            bound.kind === "slot" && session.state === "resumed"
              ? {
                  messageCount: session.messageCount,
                  lastActivityAt: session.lastActivityAt,
                }
              : null,
          connecting: session.state !== "promoted",
        }));
        // A promoted slot conversation is read from its chat panel, not here.
        if (session.state === "promoted") return;

        const client = transportRef.current.connectToChannel(
          session.channelId,
          session.contextId,
          {
            clientId: bound.kind === "slot" ? bound.slotId : bound.clientId,
            replayMessageLimit: TRANSCRIPT_LIMIT,
          }
        );
        clientRef.current = client;
        selfKeyRef.current = client.clientId ?? null;
        void (async () => {
          try {
            for await (const event of client.events({ includeReplay: true })) {
              if (!live()) return;
              // A wire event is NOT the envelope the reducer consumes. Feeding
              // one straight in (behind a cast) misses every branch and returns
              // the state untouched, which renders as an empty transcript with a
              // healthy subscription and no error anywhere — the exact failure
              // this conversion existed to prevent in the chat client.
              const wire = event as PubSubAgenticWireEvent;
              if (wire.type === CREDENTIAL_CONNECT_PAYLOAD_KIND && wire.payload) {
                stateRef.current = reduceChannelView(
                  stateRef.current,
                  pubsubChannelEventToEnvelope(
                    session.channelId,
                    CREDENTIAL_CONNECT_PAYLOAD_KIND,
                    { ...wire, payload: wire.payload }
                  )
                );
                schedulePush();
                continue;
              }
              if (wire.type !== AGENTIC_EVENT_PAYLOAD_KIND || !wire.payload) continue;
              stateRef.current = reduceChannelView(
                stateRef.current,
                pubsubAgenticEventToEnvelope(session.channelId, {
                  ...(wire.pubsubId === undefined ? {} : { pubsubId: wire.pubsubId }),
                  ...(wire.senderId === undefined ? {} : { senderId: wire.senderId }),
                  ...(wire.ts === undefined ? {} : { ts: wire.ts }),
                  ...(wire.senderMetadata === undefined
                    ? {}
                    : { senderMetadata: wire.senderMetadata }),
                  payload: wire.payload as { actor: { id: string } },
                }) as never
              );
              schedulePush();
            }
          } catch (error) {
            if (!live()) return;
            setView((current) => ({
              ...current,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        })();
        await client.ready();
        if (!live()) return;
        selfKeyRef.current = client.clientId ?? selfKeyRef.current;
        setView((current) => ({ ...current, connecting: false }));
        flush();
        // Opening a conversation on an escalated envelope IS reading it
        // (messaging plan §4.5.4/§4.10.6): the ordinary read receipt goes out,
        // so the notifying agent sees "read" through the mechanism it has.
        if (bound.kind === "conversation" && bound.focusMessageId) {
          void client.recordReadReceipt(bound.focusMessageId).catch(() => undefined);
        }
        const queued = queuedRef.current;
        queuedRef.current = [];
        for (const text of queued) {
          await deliver(client, text);
          if (!live()) return;
        }
      } catch (error) {
        if (!live()) return;
        setView((current) => ({
          ...current,
          connecting: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [deliver, flush, schedulePush]
  );

  useEffect(() => {
    const generation = (generationRef.current += 1);
    const bound = source;
    if (!bound) {
      // Settling into an unbound state is where queued text dies: the binding it
      // was typed for no longer exists, and nothing later should inherit it.
      queuedRef.current = [];
      setView(IDLE);
      return;
    }
    setView({
      ...IDLE,
      source: bound,
      slotId: bound.kind === "slot" ? bound.slotId : null,
      connecting: true,
    });
    stateRef.current = createInitialChannelViewState();
    void bind(bound, generation, false);
    return () => {
      generationRef.current += 1;
      closeClient();
    };
    // `key` is the identity of the binding; `source` is its (memoized) value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bind, closeClient, key]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const client = clientRef.current;
      // Not connected yet: the resolve effect delivers this once the channel is
      // ready (see `queuedRef`). Sending and binding are one gesture from the
      // palette's ask row, so the message waits for the binding rather than
      // being dropped on the floor.
      if (!client) {
        queuedRef.current.push(trimmed);
        return;
      }
      await deliver(client, trimmed);
    },
    [deliver]
  );

  const stop = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const agents = Object.values(stateRef.current.roster).filter(
      (entry) => entry.leftAt === undefined && entry.participant.kind === "agent"
    );
    for (const agent of agents) {
      const participantId = agent.participant.participantId ?? agent.participant.id;
      try {
        await client.callMethod(participantId, "pause", {
          reason: "User interrupted quickfire",
        }).result;
      } catch {
        // Pausing is advisory: a vessel that is already idle rejects, and that
        // is not a failure the user needs to see.
      }
    }
  }, []);

  const clear = useCallback(async () => {
    const bound = sourceRef.current;
    if (!bound) return;
    if (bound.kind !== "slot") {
      throw new Error("A conversation opened from a notification cannot be cleared here");
    }
    await transportRef.current.clear(bound.slotId);
    generationRef.current += 1;
    closeClient();
    stateRef.current = createInitialChannelViewState();
    setView({ ...IDLE, source: bound, slotId: bound.slotId });
  }, [closeClient]);

  const promote = useCallback(async (): Promise<QuickfireSessionFacts | null> => {
    const bound = sourceRef.current;
    if (!bound) return null;
    if (bound.kind === "conversation") {
      // Nothing to mint: the conversation already has a home. The caller opens
      // its chat panel from these facts (find-or-open, messaging plan §4.8).
      return {
        channelId: bound.channelId,
        contextId: bound.contextId,
        state: "promoted",
        messageCount: null,
        lastActivityAt: null,
      };
    }
    const promoted = await transportRef.current.promote(bound.slotId);
    if (!promoted) return null;
    setView((current) => ({ ...current, promoted: true }));
    return promoted;
  }, []);

  const startFresh = useCallback(async () => {
    const bound = sourceRef.current;
    if (!bound) return;
    if (bound.kind !== "slot") {
      throw new Error("A conversation opened from a notification cannot be restarted here");
    }
    // Rebind against the same slot through the ONE binding path, so the fresh
    // session gets its live event stream like any other.
    const generation = (generationRef.current += 1);
    closeClient();
    queuedRef.current = [];
    stateRef.current = createInitialChannelViewState();
    setView({ ...IDLE, source: bound, slotId: bound.slotId, connecting: true });
    await bind(bound, generation, true);
  }, [bind, closeClient]);

  return useMemo(
    () => ({
      view,
      mode: source ? source.kind : null,
      send,
      stop,
      clear,
      promote,
      startFresh,
    }),
    [clear, promote, send, source, startFresh, stop, view]
  );
}
