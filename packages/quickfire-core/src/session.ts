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
  createInitialChannelViewState,
  reduceChannelView,
  type ChannelViewState,
} from "@workspace/agentic-protocol";
import type { PubSubClient } from "@workspace/pubsub";
import type { QuickfireResumeChip, QuickfireTranscriptMessage } from "./model";
import { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT } from "./transcript";

export { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT };

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

/** Everything the core needs from its host client. */
export interface QuickfireTransport {
  sessionFor: (
    slotId: string,
    options?: { fresh?: boolean }
  ) => Promise<QuickfireSessionFacts>;
  clear: (slotId: string) => Promise<unknown>;
  promote: (slotId: string) => Promise<QuickfireSessionFacts | null>;
  /** Join the conversation's channel for live delivery. */
  connectToChannel: (channelId: string, contextId: string) => PubSubClient;
}

export interface QuickfireSessionView {
  slotId: string | null;
  channelId: string | null;
  connecting: boolean;
  /** True once a durable mapping exists for the slot. */
  hasConversation: boolean;
  promoted: boolean;
  resume: QuickfireResumeChip | null;
  transcript: QuickfireTranscriptMessage[];
  streaming: boolean;
  error: string | null;
}

export interface QuickfireSessionController {
  view: QuickfireSessionView;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  promote: () => Promise<string | null>;
  startFresh: () => Promise<void>;
}

const IDLE: QuickfireSessionView = {
  slotId: null,
  channelId: null,
  connecting: false,
  hasConversation: false,
  promoted: false,
  resume: null,
  transcript: [],
  streaming: false,
  error: null,
};

/**
 * Resolve and drive the conversation bound to `slotId`.
 *
 * Passing `slotId: null` (surface closed, or not in quickfire mode) tears the
 * connection down. The durable conversation is untouched by that — only clear,
 * slot close, and promotion end a conversation.
 *
 * `transport` is read through a ref, so a caller that rebuilds the object every
 * render does not churn the connection.
 */
export function useQuickfireSessionCore(
  slotId: string | null,
  transport: QuickfireTransport
): QuickfireSessionController {
  const [view, setView] = useState<QuickfireSessionView>(IDLE);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const clientRef = useRef<PubSubClient | null>(null);
  const stateRef = useRef<ChannelViewState>(createInitialChannelViewState());
  const selfKeyRef = useRef<string | null>(null);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const freshRef = useRef(false);
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
    setView((current) => ({
      ...current,
      transcript: projectTranscript(state, selfKeyRef.current),
      streaming: hasOpenTurn(state),
    }));
  }, []);

  const schedulePush = useCallback(() => {
    if (pushTimerRef.current !== null) return;
    pushTimerRef.current = setTimeout(flush, PUSH_INTERVAL_MS);
  }, [flush]);

  /** Put one message on the wire, surfacing a failure inline rather than throwing. */
  const deliver = useCallback(async (client: PubSubClient, text: string) => {
    try {
      await client.send(text, { mentions: ["quickfire"] });
    } catch (error) {
      setView((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  useEffect(() => {
    const generation = (generationRef.current += 1);
    const wantsFresh = freshRef.current;
    freshRef.current = false;
    if (!slotId) {
      // Settling into an unbound state is where queued text dies: the binding it
      // was typed for no longer exists, and nothing later should inherit it.
      queuedRef.current = [];
      setView(IDLE);
      return;
    }
    setView({ ...IDLE, slotId, connecting: true });
    stateRef.current = createInitialChannelViewState();
    let disposed = false;

    void (async () => {
      try {
        const session = await transportRef.current.sessionFor(slotId, { fresh: wantsFresh });
        if (disposed || generationRef.current !== generation) return;
        setView((current) => ({
          ...current,
          slotId,
          channelId: session.channelId,
          hasConversation: true,
          promoted: session.state === "promoted",
          resume:
            session.state === "resumed"
              ? {
                  messageCount: session.messageCount,
                  lastActivityAt: session.lastActivityAt,
                }
              : null,
          connecting: session.state === "promoted" ? false : true,
        }));
        // A promoted conversation is read from its chat panel, not here.
        if (session.state === "promoted") return;

        const client = transportRef.current.connectToChannel(
          session.channelId,
          session.contextId
        );
        clientRef.current = client;
        selfKeyRef.current = client.clientId ?? null;
        void (async () => {
          try {
            for await (const event of client.events({ includeReplay: true })) {
              if (disposed || generationRef.current !== generation) return;
              stateRef.current = reduceChannelView(stateRef.current, event as never);
              schedulePush();
            }
          } catch (error) {
            if (disposed || generationRef.current !== generation) return;
            setView((current) => ({
              ...current,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        })();
        await client.ready();
        if (disposed || generationRef.current !== generation) return;
        selfKeyRef.current = client.clientId ?? selfKeyRef.current;
        setView((current) => ({ ...current, connecting: false }));
        flush();
        const queued = queuedRef.current;
        queuedRef.current = [];
        for (const text of queued) {
          await deliver(client, text);
          if (disposed || generationRef.current !== generation) return;
        }
      } catch (error) {
        if (disposed || generationRef.current !== generation) return;
        setView((current) => ({
          ...current,
          connecting: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();

    return () => {
      disposed = true;
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
    };
  }, [deliver, flush, schedulePush, slotId]);

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
    if (!slotId) return;
    await transportRef.current.clear(slotId);
    stateRef.current = createInitialChannelViewState();
    const client = clientRef.current;
    clientRef.current = null;
    void client?.close().catch(() => undefined);
    setView({ ...IDLE, slotId });
  }, [slotId]);

  const promote = useCallback(async () => {
    if (!slotId) return null;
    const promoted = await transportRef.current.promote(slotId);
    if (!promoted) return null;
    setView((current) => ({ ...current, promoted: true }));
    return promoted.channelId;
  }, [slotId]);

  const startFresh = useCallback(async () => {
    freshRef.current = true;
    // Re-run the resolve effect against the same slot.
    generationRef.current += 1;
    setView({ ...IDLE, slotId, connecting: true });
    if (!slotId) return;
    try {
      const session = await transportRef.current.sessionFor(slotId, { fresh: true });
      freshRef.current = false;
      setView({
        ...IDLE,
        slotId,
        channelId: session.channelId,
        hasConversation: true,
        connecting: true,
      });
      const client = transportRef.current.connectToChannel(
        session.channelId,
        session.contextId
      );
      clientRef.current = client;
      stateRef.current = createInitialChannelViewState();
      await client.ready();
      selfKeyRef.current = client.clientId ?? null;
      setView((current) => ({ ...current, connecting: false }));
    } catch (error) {
      setView((current) => ({
        ...current,
        connecting: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [slotId]);

  return useMemo(
    () => ({ view, send, stop, clear, promote, startFresh }),
    [clear, promote, send, startFresh, stop, view]
  );
}
