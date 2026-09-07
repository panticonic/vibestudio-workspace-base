// @vitest-environment jsdom

import { RpcBoundaryError } from "@vibestudio/rpc";
import { render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (payload: unknown) => void>();
const subscribe = vi.fn();
const unsubscribe = vi.fn();
const onEvent = vi.fn();

vi.mock("./client.js", () => ({
  events: {
    subscribe: (...args: unknown[]) => subscribe(...args),
    unsubscribe: (...args: unknown[]) => unsubscribe(...args),
    on: (...args: unknown[]) => onEvent(...args)
  }
}));

import { useShellEvent } from "./useShellEvent";

function Probe({ onUpdate }: { onUpdate: (payload: unknown) => void }) {
  useShellEvent("panel-tree-invalidated", onUpdate as never);
  return null;
}

function CommitProbe({
  onUpdate,
  payload
}: {
  onUpdate: (payload: unknown) => void;
  payload?: unknown;
}) {
  useShellEvent("panel-tree-invalidated", onUpdate as never);
  useLayoutEffect(() => {
    if (payload !== undefined) {
      listeners.get("panel-tree-invalidated")?.(payload);
    }
  }, [payload]);
  return null;
}

describe("useShellEvent", () => {
  it("installs the listener before subscribing so immediate snapshots are delivered", async () => {
    const snapshot = { revision: 1, forest: [] };
    const received = vi.fn();
    const order: string[] = [];

    listeners.clear();
    subscribe.mockReset();
    unsubscribe.mockReset();
    unsubscribe.mockResolvedValue(undefined);
    onEvent.mockReset();
    onEvent.mockImplementation((event: string, listener: (payload: unknown) => void) => {
      order.push("listen");
      listeners.set(event, listener);
      return () => listeners.delete(event);
    });
    subscribe.mockImplementation(async (event: string) => {
      order.push("subscribe");
      listeners.get(event)?.(snapshot);
    });

    render(<Probe onUpdate={received} />);

    await waitFor(() => expect(received).toHaveBeenCalledWith(snapshot));
    expect(order).toEqual(["listen", "subscribe"]);
  });

  it("uses the current callback for an event delivered during an update commit", () => {
    const first = vi.fn();
    const second = vi.fn();

    listeners.clear();
    subscribe.mockReset();
    subscribe.mockResolvedValue(undefined);
    unsubscribe.mockReset();
    unsubscribe.mockResolvedValue(undefined);
    onEvent.mockReset();
    onEvent.mockImplementation((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    });

    const rendered = render(<CommitProbe onUpdate={first} />);
    rendered.rerender(<CommitProbe onUpdate={second} payload={{ revision: 2 }} />);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ revision: 2 });
  });
});

it.each(["transport", "access", "internal"] as const)(
  "keeps the watch desired during loss and preserves %s diagnostics",
  async (kind) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failure = new RpcBoundaryError("unavailable", kind, "CONNECTION_LOST");
      subscribe.mockReset().mockRejectedValue(failure);
      unsubscribe.mockReset().mockRejectedValue(failure);
      onEvent
        .mockReset()
        .mockImplementation((event: string, listener: (payload: unknown) => void) => {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        });
      const received = vi.fn();
      const mounted = render(<Probe onUpdate={received} />);
      await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
      // A failed opening attempt must not discard the desired local listener;
      // the canonical EventsClient can deliver its recovered snapshot to it.
      listeners.get("panel-tree-invalidated")?.({ revision: 9 });
      expect(received).toHaveBeenCalledWith({ revision: 9 });
      mounted.unmount();
      await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(kind === "transport" ? 0 : 2);
    } finally {
      warn.mockRestore();
    }
  }
);
