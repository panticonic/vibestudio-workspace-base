// @vitest-environment jsdom

/**
 * The quickfire session lifecycle moved into `@workspace/quickfire-core/session`
 * so the mobile sheet drives the same conversation (spec §7.2). These tests pin
 * the behavior that was previously only exercised by hand through the desktop
 * overlay: bind on gesture, do not join a promoted channel, tear down without
 * ending the conversation, and hand promotion's channel id back to the caller.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  REPLAY_LIMIT,
  TRANSCRIPT_LIMIT,
  useQuickfireSessionCore,
  type QuickfireSessionFacts,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";

/**
 * One agentic wire event, shaped the way a channel client yields them.
 *
 * The payload is a real `message.completed` trajectory event — the reducer
 * schema-parses its input and silently returns the previous state when the
 * shape is wrong, so an approximate fixture would pass for the wrong reason.
 */
function wireMessageEvent(text: string, senderId = "user:me", ordinal = 1) {
  return {
    type: "agentic.trajectory.v1/event",
    pubsubId: ordinal,
    senderId,
    ts: 1_700_000_000_000 + ordinal,
    senderMetadata: { name: "you", type: "user" },
    payload: {
      kind: "message.completed",
      actor: { kind: "user", id: senderId, participantId: senderId },
      causality: { messageId: `msg-${ordinal}` },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [
          { blockId: `msg-${ordinal}:block:0`, type: "text", content: text },
        ],
        outcome: "completed",
      },
      createdAt: "2026-08-14T12:00:00.000Z",
    },
  };
}

/** The out-of-band credential event published when a model cannot authenticate. */
function wireCredentialEvent() {
  return {
    type: "agentic.credential-connect.v1",
    pubsubId: 2,
    senderId: "do:agent",
    ts: 1_700_000_000_100,
    senderMetadata: { name: "Quickfire agent", type: "agent" },
    payload: {
      credKey: "cred-openai-codex",
      providerId: "openai-codex",
      connectSpec: { kind: "oauth" },
      reason: "Credential needs refresh",
    },
  };
}

function wireTurnEvent(
  kind: "turn.opened" | "turn.waiting",
  pubsubId: number,
  payload: Record<string, unknown> = {},
) {
  return {
    type: "agentic.trajectory.v1/event",
    pubsubId,
    senderId: "agent-1",
    ts: 1_700_000_000_000 + pubsubId,
    senderMetadata: { name: "Quickfire agent", type: "agent" },
    payload: {
      kind,
      actor: { kind: "agent", id: "agent-1", participantId: "agent-1" },
      turnId: "turn-1",
      payload: { protocol: "agentic.trajectory.v1", ...payload },
      createdAt: new Date(1_700_000_000_000 + pubsubId).toISOString(),
    },
  };
}

function fakeChannelClient(events: unknown[] = []) {
  return {
    channelId: "channel-1",
    clientId: "user:me",
    firstEnvelopeSeq: undefined as number | undefined,
    hasMoreBefore: false as boolean | undefined,
    getReplayBefore: vi.fn(async () => ({
      mode: "before" as const,
      logEvents: [] as Array<Record<string, unknown>>,
      snapshots: [],
      ready: { hasMoreBefore: false },
    })),
    events: () => ({
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: () =>
            index < events.length
              ? Promise.resolve({ value: events[index++], done: false })
              : // Then park: a live channel stays open rather than ending.
                new Promise<IteratorResult<unknown>>(() => {}),
        };
      },
    }),
    ready: () => Promise.resolve(),
    close: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve()),
    recordReadReceipt: vi.fn(() => Promise.resolve()),
    callMethod: vi.fn(() => ({ result: Promise.resolve() })),
  };
}

function channelClientEmittingOnSend(eventsOnSend: unknown[]) {
  const queued: unknown[] = [];
  let resolveNext: ((result: IteratorResult<unknown>) => void) | null = null;
  const emit = (event: unknown) => {
    const resolve = resolveNext;
    if (resolve) {
      resolveNext = null;
      resolve({ value: event, done: false });
    } else {
      queued.push(event);
    }
  };
  return {
    clientId: "user:me",
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = queued.shift();
          if (event !== undefined)
            return Promise.resolve({ value: event, done: false });
          return new Promise<IteratorResult<unknown>>((resolve) => {
            resolveNext = resolve;
          });
        },
      }),
    }),
    ready: () => Promise.resolve(),
    close: vi.fn(() => Promise.resolve()),
    send: vi.fn(async () => {
      eventsOnSend.forEach(emit);
    }),
    recordReadReceipt: vi.fn(() => Promise.resolve()),
    callMethod: vi.fn(() => ({ result: Promise.resolve() })),
  };
}

function transportFor(
  session: QuickfireSessionFacts,
  overrides: Partial<QuickfireTransport> = {},
  events: unknown[] = [],
) {
  const client = fakeChannelClient(events);
  const connectToChannel = vi.fn(() => client as never);
  const transport: QuickfireTransport = {
    sessionFor: vi.fn(async () => session),
    clear: vi.fn(async () => ({ cleared: true, archived: 1 })),
    promote: vi.fn(async () => ({ ...session, state: "promoted" as const })),
    connectToChannel,
    ...overrides,
  };
  return { transport, client, connectToChannel };
}

const fresh: QuickfireSessionFacts = {
  channelId: "channel-1",
  contextId: "ctx-1",
  state: "fresh",
  messageCount: null,
  lastActivityAt: null,
};

describe("useQuickfireSessionCore", () => {
  it("does nothing at all until a slot is bound", () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore(null, transport),
    );
    expect(transport.sessionFor).not.toHaveBeenCalled();
    expect(result.current.view.hasConversation).toBe(false);
  });

  it("resolves and joins the conversation bound to a slot", async () => {
    const { transport, connectToChannel } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("panel:tree/root/0", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    expect(transport.sessionFor).toHaveBeenCalledWith("panel:tree/root/0", {
      fresh: false,
    });
    // The bound slot is the participant this client claims, the way a panel
    // caller passes its slot id; replay streams so the reducer sees it.
    expect(connectToChannel).toHaveBeenCalledWith("channel-1", "ctx-1", {
      clientId: "panel:tree/root/0",
      // Replay is deliberately wider than the rendered tail: "12 earlier
      // entries" is only an offer the surface can keep if the client already
      // holds them.
      replayMessageLimit: REPLAY_LIMIT,
    });
    expect(result.current.view.channelId).toBe("channel-1");
    expect(result.current.view.hasConversation).toBe(true);
  });

  it("surfaces the resume chip for an existing conversation", async () => {
    const { transport } = transportFor({
      ...fresh,
      state: "resumed",
      messageCount: 3,
      lastActivityAt: 1_700_000_000_000,
    });
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.resume).not.toBeNull());
    expect(result.current.view.resume).toEqual({
      messageCount: 3,
      lastActivityAt: 1_700_000_000_000,
    });
  });

  it("pages durable history after the buffered replay has been revealed", async () => {
    const recent = Array.from({ length: TRANSCRIPT_LIMIT }, (_, index) =>
      wireMessageEvent(`recent ${index + 1}`, "user:me", 101 + index),
    );
    const { transport, client } = transportFor(fresh, {}, recent);
    client.firstEnvelopeSeq = 101;
    client.hasMoreBefore = true;
    client.getReplayBefore.mockResolvedValueOnce({
      mode: "before",
      logEvents: Array.from({ length: 40 }, (_, index) => {
        const wire = wireMessageEvent(
          `older ${index + 1}`,
          "user:me",
          61 + index,
        );
        const { pubsubId, ...rest } = wire;
        return { ...rest, id: pubsubId };
      }),
      snapshots: [],
      ready: { hasMoreBefore: false },
    });

    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => {
      expect(result.current.view.connecting).toBe(false);
      expect(result.current.view.transcript).toHaveLength(TRANSCRIPT_LIMIT);
      expect(result.current.view.expandable).toBe(true);
    });

    await act(async () => {
      await result.current.showOlder();
    });

    expect(client.getReplayBefore).toHaveBeenCalledWith(101, 500);
    await waitFor(() => {
      expect(result.current.view.transcript).toHaveLength(
        TRANSCRIPT_LIMIT + 40,
      );
      expect(result.current.view.olderCount).toBe(0);
      expect(result.current.view.expandable).toBe(false);
      expect(result.current.view.loadingOlder).toBe(false);
    });
    expect(
      result.current.view.transcript.some(
        (entry) => entry.kind === "message" && entry.text === "older 1",
      ),
    ).toBe(true);
  });

  it("never joins the channel of a promoted conversation", async () => {
    const { transport, connectToChannel } = transportFor({
      ...fresh,
      state: "promoted",
    });
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.promoted).toBe(true));
    expect(connectToChannel).not.toHaveBeenCalled();
    expect(result.current.view.connecting).toBe(false);
  });

  it("leaves the channel on unmount without ending the conversation", async () => {
    const { transport, client } = transportFor(fresh);
    const { result, unmount } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    unmount();
    await waitFor(() => expect(client.close).toHaveBeenCalled());
    expect(transport.clear).not.toHaveBeenCalled();
  });

  it("returns the promoted channel and context so the chat panel can attach to both", async () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    let promoted: { channelId: string; contextId: string } | null = null;
    await act(async () => {
      promoted = await result.current.promote();
    });
    expect(promoted).toMatchObject({
      channelId: "channel-1",
      contextId: "ctx-1",
    });
    expect(result.current.view.promoted).toBe(true);
  });

  it("clearing archives and disconnects without creating another conversation", async () => {
    const { transport, client } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    await act(async () => {
      await result.current.clear();
    });
    expect(transport.clear).toHaveBeenCalledWith("slot");
    expect(client.close).toHaveBeenCalled();
    expect(transport.sessionFor).toHaveBeenCalledTimes(1);
    expect(result.current.view.hasConversation).toBe(false);
    expect(result.current.view.connecting).toBe(false);
    expect(result.current.view.transcript).toEqual([]);
  });

  it("reports a failed bind instead of pretending to be connected", async () => {
    const { transport } = transportFor(fresh, {
      sessionFor: vi.fn(async () => {
        throw new Error("workspace is offline");
      }),
    });
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() =>
      expect(result.current.view.error).toBe("workspace is offline"),
    );
    expect(result.current.view.connecting).toBe(false);
  });
});

describe("useQuickfireSessionCore conversation source (messaging plan §4.8)", () => {
  const conversation = {
    kind: "conversation" as const,
    channelId: "channel-notify",
    contextId: "ctx-notify",
    clientId: "conversation:channel-notify",
    focusMessageId: "say:call-1",
    replyTo: { participantId: "do:news-agent" },
  };

  it("joins an existing channel without minting a session", async () => {
    const { transport, connectToChannel, client } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore(conversation, transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    expect(transport.sessionFor).not.toHaveBeenCalled();
    expect(connectToChannel).toHaveBeenCalledWith(
      "channel-notify",
      "ctx-notify",
      {
        clientId: "conversation:channel-notify",
        replayMessageLimit: REPLAY_LIMIT,
      },
    );
    expect(result.current.mode).toBe("conversation");
    expect(result.current.view.hasConversation).toBe(true);
    // Opening on the escalated envelope is reading it (D16).
    expect(client.recordReadReceipt).toHaveBeenCalledWith("say:call-1");
    // No resume chip: this is not "your earlier quickfire session", it is a conversation.
    expect(result.current.view.resume).toBeNull();
  });

  it("replies threaded under the opened envelope, addressed to the notifier", async () => {
    const { transport, client } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore(conversation, transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    await act(async () => {
      await result.current.send("on it");
    });
    expect(client.send).toHaveBeenCalledWith("on it", {
      replyTo: "say:call-1",
      mentions: ["do:news-agent"],
      to: [{ kind: "participant", participantId: "do:news-agent" }],
    });
  });

  it("has no clear or fresh, and promotes to its own facts", async () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore(conversation, transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    await expect(result.current.clear()).rejects.toThrow(/cannot be cleared/u);
    await expect(result.current.startFresh()).rejects.toThrow(
      /cannot be restarted/u,
    );
    expect(transport.clear).not.toHaveBeenCalled();
    const promoted = await result.current.promote();
    expect(transport.promote).not.toHaveBeenCalled();
    expect(promoted).toMatchObject({
      channelId: "channel-notify",
      contextId: "ctx-notify",
    });
  });
});

describe("useQuickfireSessionCore startFresh", () => {
  it("rebinds through the same path, so the fresh session streams events", async () => {
    const { transport, connectToChannel } = transportFor(fresh, {}, [
      wireMessageEvent("hello"),
    ]);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    await act(async () => {
      await result.current.startFresh();
    });
    expect(transport.sessionFor).toHaveBeenLastCalledWith("slot", {
      fresh: true,
    });
    expect(connectToChannel).toHaveBeenCalledTimes(2);
    // The event loop is attached on the rebind too: the transcript renders.
    await waitFor(() =>
      expect(result.current.view.transcript.length).toBeGreaterThan(0),
    );
  });
});

describe("useQuickfireSessionCore send queue", () => {
  it("shows work immediately after send, before the channel opens a turn", async () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));

    await act(async () => {
      await result.current.send("what is the channel id?");
    });

    expect(result.current.view.streaming).toBe(true);
    expect(result.current.view.transcript).toContainEqual(
      expect.objectContaining({
        kind: "activity",
        phase: "starting",
        label: "starting",
      }),
    );
  });

  it("hands optimistic activity to the durable turn and does not call a wait streaming", async () => {
    const client = channelClientEmittingOnSend([
      wireTurnEvent("turn.opened", 1),
      wireTurnEvent("turn.waiting", 2, {
        reason: "input_required",
        summary: "Waiting for your choice",
      }),
    ]);
    const { transport } = transportFor(fresh, {
      connectToChannel: vi.fn(() => client as never),
    });
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));

    await act(async () => {
      await result.current.send("show me the choices");
    });

    await waitFor(() =>
      expect(result.current.view.transcript).toContainEqual(
        expect.objectContaining({
          kind: "activity",
          state: "waiting",
          label: "Waiting for your choice",
        }),
      ),
    );
    expect(result.current.view.streaming).toBe(false);
  });

  it("delivers text typed before the binding resolved", async () => {
    // The palette's ask row sends and binds in one gesture: `send` is called
    // while the slot is still null, so the message exists before any channel
    // does. Dropping it loses exactly the sentence the user typed.
    const { transport, client } = transportFor(fresh);
    const { result, rerender } = renderHook(
      ({ slotId }: { slotId: string | null }) =>
        useQuickfireSessionCore(slotId, transport),
      { initialProps: { slotId: null as string | null } },
    );

    await act(async () => {
      await result.current.send("why is this panel laid out this way?");
    });
    expect(client.send).not.toHaveBeenCalled();

    rerender({ slotId: "slot-a" });
    await waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    expect(client.send).toHaveBeenCalledWith(
      "why is this panel laid out this way?",
      expect.objectContaining({ mentions: ["quickfire"] }),
    );
  });

  it("forgets queued text when the overlay closes before the binding lands", async () => {
    // Esc between "Enter on the ask row" and the binding resolving. The message
    // was typed for a conversation that never opened; inheriting it would post
    // it into whichever conversation is bound next.
    let releaseBinding: (() => void) | null = null;
    const { transport, client } = transportFor(fresh, {
      sessionFor: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseBinding = resolve;
        });
        return fresh;
      }),
    });
    const { result, rerender } = renderHook(
      ({ slotId }: { slotId: string | null }) =>
        useQuickfireSessionCore(slotId, transport),
      { initialProps: { slotId: null as string | null } },
    );

    await act(async () => {
      await result.current.send("stale");
    });
    rerender({ slotId: "slot-a" });
    await waitFor(() => expect(transport.sessionFor).toHaveBeenCalled());

    // Close the overlay while the bind is still in flight, then open it again.
    rerender({ slotId: null });
    await act(async () => {
      releaseBinding?.();
    });
    rerender({ slotId: "slot-b" });
    await waitFor(() => expect(transport.sessionFor).toHaveBeenCalledTimes(2));
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("useQuickfireSessionCore reduction", () => {
  it("renders a channel event as a transcript message", async () => {
    // The reducer consumes a ChannelEnvelope, while the client yields a WIRE
    // event. Feeding the wire event straight in — which a cast made compile —
    // misses every branch of the reducer and returns the state untouched, so
    // the transcript stays empty while the subscription looks perfectly
    // healthy. That shipped, and only a full app run could see it. This test
    // sees it in milliseconds.
    const { transport } = transportFor(fresh, {}, [
      wireMessageEvent("why is this panel laid out this way?"),
    ]);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot-a", transport),
    );

    await waitFor(() =>
      expect(
        result.current.view.transcript
          .filter((message) => message.kind === "message")
          .map((message) => message.text),
      ).toContain("why is this panel laid out this way?"),
    );
  });

  it("shows the trimmed tail, then reveals it in place on request", async () => {
    // One more than the tail so the surface has something to offer, and the
    // offer is only honest because the join asked for `REPLAY_LIMIT`.
    const total = TRANSCRIPT_LIMIT + 5;
    const events = Array.from({ length: total }, (_value, index) =>
      wireMessageEvent(`message ${index + 1}`, "user:me", index + 1),
    );
    const { transport } = transportFor(fresh, {}, events);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot", transport),
    );

    await waitFor(() =>
      expect(result.current.view.transcript.length).toBe(TRANSCRIPT_LIMIT),
    );
    expect(result.current.view.olderCount).toBe(5);
    expect(result.current.view.expandable).toBe(true);

    await act(async () => {
      await result.current.showOlder();
    });

    await waitFor(() =>
      expect(result.current.view.transcript.length).toBe(total),
    );
    expect(result.current.view.olderCount).toBe(0);
    expect(result.current.view.expandable).toBe(false);
  });

  it("surfaces credential waits instead of leaving an unexplained stop spinner", async () => {
    const { transport } = transportFor(fresh, {}, [wireCredentialEvent()]);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("slot-a", transport),
    );

    await waitFor(() =>
      expect(result.current.view.credentialRequest).toEqual({
        providerId: "openai-codex",
        reason: "Credential needs refresh",
      }),
    );
    expect(result.current.view.streaming).toBe(false);
  });
});
