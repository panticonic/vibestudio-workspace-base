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
function wireMessageEvent(text: string, senderId = "user:me") {
  return {
    type: "agentic.trajectory.v1/event",
    pubsubId: 1,
    senderId,
    ts: 1_700_000_000_000,
    senderMetadata: { name: "you", type: "user" },
    payload: {
      kind: "message.completed",
      actor: { kind: "user", id: senderId, participantId: senderId },
      causality: { messageId: "msg-1" },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [{ blockId: "msg-1:block:0", type: "text", content: text }],
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
    senderMetadata: { name: "Command agent", type: "agent" },
    payload: {
      credKey: "cred-openai-codex",
      providerId: "openai-codex",
      connectSpec: { kind: "oauth" },
      reason: "Credential needs refresh",
    },
  };
}

function fakeChannelClient(events: unknown[] = []) {
  return {
    clientId: "user:me",
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
    callMethod: vi.fn(() => ({ result: Promise.resolve() })),
  };
}

function transportFor(
  session: QuickfireSessionFacts,
  overrides: Partial<QuickfireTransport> = {},
  events: unknown[] = []
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
    const { result } = renderHook(() => useQuickfireSessionCore(null, transport));
    expect(transport.sessionFor).not.toHaveBeenCalled();
    expect(result.current.view.hasConversation).toBe(false);
  });

  it("resolves and joins the conversation bound to a slot", async () => {
    const { transport, connectToChannel } = transportFor(fresh);
    const { result } = renderHook(() =>
      useQuickfireSessionCore("panel:tree/root/0", transport)
    );
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    expect(transport.sessionFor).toHaveBeenCalledWith("panel:tree/root/0", { fresh: false });
    // The bound slot is the participant this client claims, the way a panel
    // caller passes its slot id; replay streams so the reducer sees it.
    expect(connectToChannel).toHaveBeenCalledWith("channel-1", "ctx-1", {
      clientId: "panel:tree/root/0",
      replayMessageLimit: TRANSCRIPT_LIMIT,
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
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.resume).not.toBeNull());
    expect(result.current.view.resume).toEqual({
      messageCount: 3,
      lastActivityAt: 1_700_000_000_000,
    });
  });

  it("never joins the channel of a promoted conversation", async () => {
    const { transport, connectToChannel } = transportFor({ ...fresh, state: "promoted" });
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.promoted).toBe(true));
    expect(connectToChannel).not.toHaveBeenCalled();
    expect(result.current.view.connecting).toBe(false);
  });

  it("leaves the channel on unmount without ending the conversation", async () => {
    const { transport, client } = transportFor(fresh);
    const { result, unmount } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    unmount();
    await waitFor(() => expect(client.close).toHaveBeenCalled());
    expect(transport.clear).not.toHaveBeenCalled();
  });

  it("returns the promoted channel and context so the chat panel can attach to both", async () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    let promoted: { channelId: string; contextId: string } | null = null;
    await act(async () => {
      promoted = await result.current.promote();
    });
    expect(promoted).toMatchObject({ channelId: "channel-1", contextId: "ctx-1" });
    expect(result.current.view.promoted).toBe(true);
  });

  it("clearing detaches locally as well as server-side", async () => {
    const { transport, client } = transportFor(fresh);
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    await act(async () => {
      await result.current.clear();
    });
    expect(transport.clear).toHaveBeenCalledWith("slot");
    expect(client.close).toHaveBeenCalled();
    expect(result.current.view.hasConversation).toBe(false);
    expect(result.current.view.transcript).toEqual([]);
  });

  it("reports a failed bind instead of pretending to be connected", async () => {
    const { transport } = transportFor(fresh, {
      sessionFor: vi.fn(async () => {
        throw new Error("workspace is offline");
      }),
    });
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.error).toBe("workspace is offline"));
    expect(result.current.view.connecting).toBe(false);
  });
});

describe("useQuickfireSessionCore send queue", () => {
  it("delivers text typed before the binding resolved", async () => {
    // The palette's ask row sends and binds in one gesture: `send` is called
    // while the slot is still null, so the message exists before any channel
    // does. Dropping it loses exactly the sentence the user typed.
    const { transport, client } = transportFor(fresh);
    const { result, rerender } = renderHook(
      ({ slotId }: { slotId: string | null }) => useQuickfireSessionCore(slotId, transport),
      { initialProps: { slotId: null as string | null } }
    );

    await act(async () => {
      await result.current.send("why is this panel laid out this way?");
    });
    expect(client.send).not.toHaveBeenCalled();

    rerender({ slotId: "slot-a" });
    await waitFor(() => expect(client.send).toHaveBeenCalledTimes(1));
    expect(client.send).toHaveBeenCalledWith(
      "why is this panel laid out this way?",
      expect.objectContaining({ mentions: ["quickfire"] })
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
      ({ slotId }: { slotId: string | null }) => useQuickfireSessionCore(slotId, transport),
      { initialProps: { slotId: null as string | null } }
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
    const { result } = renderHook(() => useQuickfireSessionCore("slot-a", transport));

    await waitFor(() =>
      expect(result.current.view.transcript.map((message) => message.text)).toContain(
        "why is this panel laid out this way?"
      )
    );
  });

  it("surfaces credential waits instead of leaving an unexplained stop spinner", async () => {
    const { transport } = transportFor(fresh, {}, [wireCredentialEvent()]);
    const { result } = renderHook(() => useQuickfireSessionCore("slot-a", transport));

    await waitFor(() =>
      expect(result.current.view.credentialRequest).toEqual({
        providerId: "openai-codex",
        reason: "Credential needs refresh",
      })
    );
    expect(result.current.view.streaming).toBe(false);
  });
});
