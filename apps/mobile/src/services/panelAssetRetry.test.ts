import {
  awaitPipeReady,
  isTransientPipeError,
  withPanelAssetRetry,
  type PipeStatus,
  type RetryTransport,
} from "./panelAssetRetry";

function fakeTransport(initial: PipeStatus = "connected"): RetryTransport & {
  set(status: PipeStatus): void;
  listenerCount(): number;
} {
  let status = initial;
  const listeners = new Set<(status: PipeStatus) => void>();
  return {
    get status() {
      return status;
    },
    onStatusChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    set(next: PipeStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

const pipeDown = (): Error => Object.assign(new Error("Not connected to server"), {
  code: "PIPE_CLOSED",
});

describe("isTransientPipeError", () => {
  it("treats pipe-shaped failures as retryable", () => {
    for (const error of [
      pipeDown(),
      new Error("Streaming RPC HEAD not received within 20000ms"),
      new Error("pipe down: control channel closed"),
      new Error("bulk sequence gap: 3 message(s) lost"),
      new Error("pipe down: ICE failed"),
    ]) {
      expect(isTransientPipeError(error)).toBe(true);
    }
  });

  it("does not retry a real answer from the server", () => {
    // A 404 or a policy rejection is the resource's answer, not the link's —
    // retrying it just multiplies the failure.
    for (const error of [
      new Error("gateway.fetch rejected: path not allowed"),
      new Error("404 Not Found"),
      new Error("boom"),
    ]) {
      expect(isTransientPipeError(error)).toBe(false);
    }
  });
});

describe("withPanelAssetRetry", () => {
  it("returns the first success without touching the transport", async () => {
    const transport = fakeTransport();
    const result = await withPanelAssetRetry(transport, { canRetry: () => true }, async () => "ok");
    expect(result).toBe("ok");
    expect(transport.listenerCount()).toBe(0);
  });

  it("retries a transient failure and succeeds", async () => {
    const transport = fakeTransport();
    let calls = 0;
    const result = await withPanelAssetRetry(transport, { canRetry: () => true }, async () => {
      calls += 1;
      if (calls === 1) throw pipeDown();
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("waits for the pipe to come back rather than retrying into a dead link", async () => {
    const transport = fakeTransport("disconnected");
    let calls = 0;
    const flight = withPanelAssetRetry(transport, { canRetry: () => true }, async () => {
      calls += 1;
      if (calls === 1) throw pipeDown();
      return "recovered";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1); // parked until the transport reports connected

    transport.set("connected");
    await expect(flight).resolves.toBe("recovered");
    expect(calls).toBe(2);
    expect(transport.listenerCount()).toBe(0); // no listener leak
  });

  it("never retries once the response is committed", async () => {
    // Re-running the fetch after a status line went out would append a second
    // body to a half-written response.
    const transport = fakeTransport();
    let calls = 0;
    await expect(
      withPanelAssetRetry(transport, { canRetry: () => false }, async () => {
        calls += 1;
        throw pipeDown();
      })
    ).rejects.toThrow(/Not connected/);
    expect(calls).toBe(1);
  });

  it("does not retry a non-transient failure", async () => {
    const transport = fakeTransport();
    let calls = 0;
    await expect(
      withPanelAssetRetry(transport, { canRetry: () => true }, async () => {
        calls += 1;
        throw new Error("404 Not Found");
      })
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget and rethrows the last error", async () => {
    const transport = fakeTransport();
    let calls = 0;
    const seen: number[] = [];
    await expect(
      withPanelAssetRetry(
        transport,
        { attempts: 3, canRetry: () => true, onRetry: (n) => seen.push(n) },
        async () => {
          calls += 1;
          throw pipeDown();
        }
      )
    ).rejects.toThrow(/Not connected/);
    expect(calls).toBe(3);
    expect(seen).toEqual([1, 2]);
  });
});

describe("awaitPipeReady", () => {
  it("resolves immediately when already connected", async () => {
    await expect(awaitPipeReady(fakeTransport("connected"))).resolves.toBeUndefined();
  });

  it("ignores non-connected transitions", async () => {
    const transport = fakeTransport("disconnected");
    let settled = false;
    void awaitPipeReady(transport).then(() => {
      settled = true;
    });
    transport.set("connecting");
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.set("connected");
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});
