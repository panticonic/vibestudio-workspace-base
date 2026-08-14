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
  useQuickfireSessionCore,
  type QuickfireSessionFacts,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";

function fakeChannelClient() {
  return {
    clientId: "user:me",
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        // Never yields: these tests care about lifecycle, not reduction (the
        // projection has its own tests in quickfireTranscript.test.ts).
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
      }),
    }),
    ready: () => Promise.resolve(),
    close: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve()),
    callMethod: vi.fn(() => ({ result: Promise.resolve() })),
  };
}

function transportFor(
  session: QuickfireSessionFacts,
  overrides: Partial<QuickfireTransport> = {}
) {
  const client = fakeChannelClient();
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
    expect(connectToChannel).toHaveBeenCalledWith("channel-1", "ctx-1");
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

  it("returns the promoted channel id so the caller can open a chat panel", async () => {
    const { transport } = transportFor(fresh);
    const { result } = renderHook(() => useQuickfireSessionCore("slot", transport));
    await waitFor(() => expect(result.current.view.connecting).toBe(false));
    let channelId: string | null = null;
    await act(async () => {
      channelId = await result.current.promote();
    });
    expect(channelId).toBe("channel-1");
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
