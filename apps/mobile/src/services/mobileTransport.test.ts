import type { PanelEntityId } from "@vibestudio/shared/panel/ids";
import type {
  RpcClient,
  RpcConnectionStatus,
  RpcEventContext,
} from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { IrohClientSession } from "@vibestudio/rpc/transports/irohClient";
import {
  loadShellCredential,
  MobileConnectionAggregateError,
  reconnectMobileSession,
  type StoredRoutedMobileConnection,
  type IrohConnection,
} from "@vibestudio/mobile-iroh";
import {
  isTransientMobileTransportFailure,
  MobileRpcClient,
  type ReconnectProgress,
} from "./mobileTransport";

jest.mock("@vibestudio/mobile-iroh", () => ({
  loadShellCredential: jest.fn(),
  MobileConnectionAggregateError: class MobileConnectionAggregateError extends Error {
    errors: readonly unknown[];
    constructor(errors: readonly unknown[], message: string) {
      super(message);
      this.errors = errors;
    }
  },
  reconnectMobileSession: jest.fn(),
}));

const mockLoadShellCredential = loadShellCredential as jest.MockedFunction<
  typeof loadShellCredential
>;
const mockReconnectMobileSession =
  reconnectMobileSession as jest.MockedFunction<typeof reconnectMobileSession>;
const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);

describe("isTransientMobileTransportFailure", () => {
  it("recognizes structured connection and Iroh response timeout failures", () => {
    expect(isTransientMobileTransportFailure({ code: "CONNECTION_LOST" })).toBe(
      true,
    );
    expect(
      isTransientMobileTransportFailure({
        cause: { code: "IROH_RESPONSE_HEAD_TIMEOUT" },
      }),
    ).toBe(true);
  });

  it("does not retry unrelated application failures", () => {
    expect(
      isTransientMobileTransportFailure({
        code: "CONNECTION_LOST",
        errorKind: "authorization",
      }),
    ).toBe(false);
    expect(
      isTransientMobileTransportFailure({
        errorKind: "access",
        cause: { code: "CONNECTION_LOST", errorKind: "transport" },
      }),
    ).toBe(false);
    expect(
      isTransientMobileTransportFailure({
        code: "IROH_RESPONSE_HEAD_TIMEOUT",
        errorKind: "application",
      }),
    ).toBe(false);
    expect(isTransientMobileTransportFailure(new Error("access denied"))).toBe(
      false,
    );
  });
});

const storedCredential: StoredRoutedMobileConnection = {
  schemaVersion: 5,
  transport: "iroh",
  phase: "routed",
  endpointIdentityId: "identity-1",
  credential: { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
  controlPairing: {
    endpointId: "aa".repeat(32),
    relays: ["https://relay.example/"],
    v: 5,
  },
  workspacePairing: {
    endpointId: "bb".repeat(32),
    relays: ["https://relay.example/"],
    v: 5,
  },
  selectedWorkspaceId: "ws-a",
  pairedAt: 123,
};

// Overrides are test doubles, not RpcClients: `call` and `stream` are generic
// in their result, which no jest.fn can satisfy. Key names stay checked so a
// typo is still an error, and the result is cast once, below.
function makeRpc(
  overrides: Partial<Record<keyof RpcClient, unknown>> = {},
): RpcClient {
  return {
    selfId: `shell:${DEVICE_ID}`,
    expose: jest.fn(),
    call: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ...overrides,
  } as unknown as RpcClient;
}

function makeSession(
  overrides: Partial<IrohClientSession> = {},
): IrohClientSession {
  return {
    callerId: jest.fn(() => `shell:${DEVICE_ID}`),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send: jest.fn(),
    status: jest.fn(() => "connected" as RpcConnectionStatus),
    onStatusChange: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ready: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as IrohClientSession;
}

// Overrides are doubles, so they are accepted by key name and the assembled
// connection is cast once — the same contract as makeRpc above.
function makeConnection(
  overrides: Partial<Record<keyof IrohConnection, unknown>> = {},
): IrohConnection {
  const session = overrides.session ?? makeSession();
  return {
    callerId: `shell:${DEVICE_ID}`,
    deviceId: DEVICE_ID,
    rpc: overrides.rpc ?? makeRpc(),
    hubControlRpc: overrides.hubControlRpc ?? makeRpc(),
    session,
    transport:
      overrides.transport ??
      ({
        openSession: jest.fn(),
      } as unknown as IrohConnection["transport"]),
    close: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as IrohConnection;
}

describe("MobileRpcClient Iroh transport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadShellCredential.mockResolvedValue(storedCredential);
  });

  it("loads the stored Iroh credential, reconnects, and delegates RPC calls", async () => {
    const rpc = makeRpc({
      call: jest.fn(async () => ({ ok: true })),
    });
    const connection = makeConnection({ rpc });
    mockReconnectMobileSession.mockResolvedValue(connection);
    const client = new MobileRpcClient({});

    await client.connectAndWait();

    expect(mockLoadShellCredential).toHaveBeenCalledTimes(1);
    expect(mockReconnectMobileSession).toHaveBeenCalledWith(
      storedCredential,
      expect.stringMatching(/^(app-scheme|client-loopback)$/),
      expect.any(Function),
    );
    expect(client.selfId).toBe(`shell:${DEVICE_ID}`);
    expect(client.status).toBe("connected");
    await expect(client.call("main", "demo.hello", ["world"])).resolves.toEqual(
      { ok: true },
    );
    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "demo.hello",
      ["world"],
      undefined,
    );
  });

  it("exposes shell presentation handlers before connect and reattaches them after reconnect", async () => {
    const firstRpc = makeRpc();
    const secondRpc = makeRpc();
    const firstConnection = makeConnection({ rpc: firstRpc });
    const secondConnection = makeConnection({ rpc: secondRpc });
    mockReconnectMobileSession
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    const client = new MobileRpcClient({});
    const handler = jest.fn(async () => undefined);

    client.expose("mobileBrowserPrivacyPresentation.open", handler);
    expect(firstRpc.expose).not.toHaveBeenCalled();

    await client.connectAndWait();
    expect(firstRpc.expose).toHaveBeenCalledWith(
      "mobileBrowserPrivacyPresentation.open",
      handler,
    );

    await client.close();
    await client.connectAndWait();
    expect(secondRpc.expose).toHaveBeenCalledWith(
      "mobileBrowserPrivacyPresentation.open",
      handler,
    );
  });

  it("rejects duplicate exposed shell methods instead of replacing live authority", () => {
    const client = new MobileRpcClient({});
    client.expose(
      "mobileBrowserPrivacyPresentation.open",
      async () => undefined,
    );

    expect(() =>
      client.expose(
        "mobileBrowserPrivacyPresentation.open",
        async () => undefined,
      ),
    ).toThrow(
      'Mobile RPC method "mobileBrowserPrivacyPresentation.open" is already exposed',
    );
  });

  it("routes only typed hub destinations over the retained stable hub pipe", async () => {
    const workspaceCall = jest.fn(async () => ({ workspace: true }));
    const hubCall = jest.fn(async () => ({ hub: true }));
    mockReconnectMobileSession.mockResolvedValue(
      makeConnection({
        rpc: makeRpc({ call: workspaceCall }),
        hubControlRpc: makeRpc({ call: hubCall }),
      }),
    );
    const client = new MobileRpcClient({});

    await client.connectAndWait();

    await expect(client.call("main", "workspace.getInfo", [])).resolves.toEqual(
      {
        workspace: true,
      },
    );
    await expect(
      client.call("main", "shellApproval.listPending", [], {
        destination: { kind: "hub" },
      }),
    ).resolves.toEqual({
      hub: true,
    });
    await expect(
      client.call("main", "hubControl.lookalikeWorkspaceMethod", []),
    ).resolves.toEqual({ workspace: true });
    expect(workspaceCall).toHaveBeenCalledWith(
      "main",
      "workspace.getInfo",
      [],
      undefined,
    );
    expect(hubCall).toHaveBeenCalledWith(
      "main",
      "shellApproval.listPending",
      [],
      undefined,
    );
  });

  it("retries transient initial Iroh reconnect failures", async () => {
    const warnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const connection = makeConnection();
    mockReconnectMobileSession
      .mockRejectedValueOnce(new Error("relay warming up"))
      .mockResolvedValueOnce(connection);
    const client = new MobileRpcClient({
      initialConnectionRetry: { maxMs: 1_000, delayMs: 1, maxDelayMs: 1 },
    });

    try {
      await expect(client.connectAndWait()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockReconnectMobileSession).toHaveBeenCalledTimes(2);
    expect(client.status).toBe("connected");
  });

  it("forwards transport reconnect progress when that optional hook is available", async () => {
    let emitProgress: ((progress: ReconnectProgress) => void) | undefined;
    const transport = {
      openSession: jest.fn(),
      onReconnectProgress: jest.fn((listener) => {
        emitProgress = listener;
        return jest.fn();
      }),
    } as unknown as IrohConnection["transport"];
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ transport }));
    const client = new MobileRpcClient({});
    const listener = jest.fn();
    client.onReconnectProgress(listener);

    await client.connectAndWait();
    emitProgress?.({
      attempt: 3,
      phase: "scheduled",
      reason: "network unavailable",
    });

    expect(listener).toHaveBeenCalledWith({
      attempt: 3,
      phase: "scheduled",
      reason: "network unavailable",
    });
  });

  it("waits for an interrupted session to recover before startup resumes", async () => {
    let status: RpcConnectionStatus = "disconnected";
    let publishStatus: ((next: RpcConnectionStatus) => void) | undefined;
    const session = makeSession({
      status: jest.fn(() => status),
      onStatusChange: jest.fn((listener) => {
        publishStatus = listener;
        return jest.fn();
      }),
    });
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ session }));
    const client = new MobileRpcClient({});
    await client.connectAndWait();

    const recovered = client.waitUntilConnected(1_000);
    status = "connected";
    publishStatus?.("connected");

    await expect(recovered).resolves.toBeUndefined();
  });

  it("dispatches server events to subscribed local listeners and unsubscribes cleanly", async () => {
    const eventCallbacks = new Map<string, (event: RpcEventContext) => void>();
    const activeUnsub = jest.fn();
    const rpc = makeRpc({
      on: jest.fn(
        (event: string, callback: (event: RpcEventContext) => void) => {
          eventCallbacks.set(event, callback);
          return activeUnsub;
        },
      ),
    });
    mockReconnectMobileSession.mockResolvedValue(makeConnection({ rpc }));
    const client = new MobileRpcClient({});
    const listener = jest.fn();

    const unsubscribe = client.on("shell-approval:pending-changed", listener);
    await client.connectAndWait();
    eventCallbacks.get("shell-approval:pending-changed")!({
      payload: { pending: ["approval-1"] },
    } as RpcEventContext);

    expect(listener).toHaveBeenCalledWith({
      payload: { pending: ["approval-1"] },
    });
    unsubscribe();
    expect(activeUnsub).toHaveBeenCalledTimes(1);
  });

  it("opens panel sessions over the existing pipe with fresh grant tokens", async () => {
    let openedOptions:
      | Parameters<IrohConnection["transport"]["openSession"]>[0]
      | null = null;
    let tokenSeenByReady = "";
    const rpc = makeRpc({
      call: jest.fn(async () => ({ token: "panel-grant-123" })),
    });
    const panelSession = makeSession({
      ready: jest.fn(async () => {
        tokenSeenByReady = await openedOptions!.getToken();
      }),
    });
    const transport = {
      openSession: jest.fn((options) => {
        openedOptions = options;
        return panelSession;
      }),
    } as unknown as IrohConnection["transport"];
    mockReconnectMobileSession.mockResolvedValue(
      makeConnection({ rpc, transport }),
    );
    const client = new MobileRpcClient({});

    await expect(
      client.openPanelSession(
        "panel:runtime-1" as PanelEntityId,
        "panel-conn-1",
      ),
    ).resolves.toBe(panelSession);

    expect(transport.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "panel-conn-1",
        clientPlatform: "mobile",
      }),
    );
    expect(rpc.call).toHaveBeenCalledWith("main", "auth.grantConnection", [
      "panel:runtime-1",
    ]);
    expect(tokenSeenByReady).toBe("panel-grant-123");
  });

  it("closes the pipe (no leak) when disconnect() races an in-flight connect", async () => {
    // Handshake that only resolves when we let it — models a disconnect landing
    // mid-connect (background / dispose-during-connect).
    let resolveConnect!: (connection: IrohConnection) => void;
    const connection = makeConnection();
    mockReconnectMobileSession.mockImplementation(
      () =>
        new Promise<IrohConnection>((resolve) => (resolveConnect = resolve)),
    );
    const client = new MobileRpcClient({});

    client.connect(); // fire-and-forget; handshake now pending
    // Let establishConnection() await loadShellCredential and reach the
    // (still-pending) reconnectMobileSession handshake.
    await new Promise((r) => setTimeout(r, 0));
    client.disconnect(); // teardown lands before the handshake resolves
    resolveConnect(connection);
    await new Promise((r) => setTimeout(r, 0)); // let the pending handshake settle

    // The produced pipe is closed (keepalive gone), not adopted as "connected".
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(client.status).not.toBe("connected");
  });

  it("surfaces composed teardown failures through reconnect progress", async () => {
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const connection = makeConnection({
      close: jest.fn(async () => {
        throw new MobileConnectionAggregateError(
          [new Error("workspace close"), new Error("hub close")],
          "connections failed to close",
        );
      }),
    });
    mockReconnectMobileSession.mockResolvedValue(connection);
    const client = new MobileRpcClient({});
    const progress = jest.fn();
    client.onReconnectProgress(progress);

    try {
      await client.connectAndWait();
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      errorSpy.mockRestore();
    }

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 0,
        phase: "failed",
        reason: expect.stringContaining("Disconnect teardown failed"),
      }),
    );
    expect(client.status).toBe("disconnected");
  });

  it("forwards Iroh recovery notifications to registered listeners", async () => {
    let emitRecovery:
      | ((kind: RecoveryKind) => void | Promise<void>)
      | undefined;
    mockReconnectMobileSession.mockImplementation(
      async (_stored, _callbackMode, onRecovery) => {
        emitRecovery = onRecovery;
        return makeConnection();
      },
    );
    const client = new MobileRpcClient({});
    const coldRecover = jest.fn();
    const resubscribe = jest.fn();
    client.onRecovery("cold-recover", coldRecover);
    client.onRecovery("resubscribe", resubscribe);

    await client.connectAndWait();
    await emitRecovery?.("cold-recover");
    await emitRecovery?.("resubscribe");

    expect(coldRecover).toHaveBeenCalledTimes(1);
    expect(resubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("MobileRpcClient session ownership", () => {
  it("retires status, progress, events and recovery before close; old callbacks cannot affect a replacement", async () => {
    const recoveries: Array<(kind: RecoveryKind) => void | Promise<void>> = [];
    const statuses: Array<(status: RpcConnectionStatus) => void> = [];
    const progresses: Array<(progress: ReconnectProgress) => void> = [];
    const events: Array<(event: RpcEventContext) => void> = [];
    const stops = [jest.fn(), jest.fn(), jest.fn()];
    const connections = [0, 1].map((index) =>
      makeConnection({
        session: makeSession({
          onStatusChange: (listener) => {
            statuses[index] = listener;
            return stops[0]!;
          },
        }),
        transport: {
          openSession: jest.fn(),
          onReconnectProgress: (
            listener: (progress: ReconnectProgress) => void,
          ) => {
            progresses[index] = listener;
            return stops[1]!;
          },
        } as unknown as IrohConnection["transport"],
        rpc: makeRpc({
          on: (_name: string, listener: (event: RpcEventContext) => void) => {
            events[index] = listener;
            return stops[2]!;
          },
        }),
      }),
    );
    let finishClose!: () => void;
    connections[0]!.close = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const factory = jest.fn(
      async (recover: (kind: RecoveryKind) => void | Promise<void>) => {
        const index = recoveries.length;
        recoveries.push(recover);
        return connections[index]!;
      },
    );
    const client = new MobileRpcClient({ connectWorkspace: factory });
    const status = jest.fn();
    const progress = jest.fn();
    const event = jest.fn();
    const recovery = jest.fn();
    client.onStatusChange(status);
    client.onReconnectProgress(progress);
    client.on("owned-event", event);
    client.onRecovery("resubscribe", recovery);
    await client.connectAndWait();
    statuses[0]!("connecting");
    expect(status).toHaveBeenLastCalledWith("connecting");
    const closing = client.close();
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    const replacement = client.connectAndWait();
    expect(factory).toHaveBeenCalledTimes(1);
    finishClose();
    await Promise.all([closing, replacement]);
    status.mockClear();
    progress.mockClear();
    event.mockClear();
    recovery.mockClear();
    statuses[0]!("disconnected");
    progresses[0]!({ attempt: 1, phase: "failed", reason: "retired" });
    events[0]!({ payload: "retired" } as RpcEventContext);
    await recoveries[0]!("resubscribe");
    expect(status).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    statuses[1]!("connecting");
    await recoveries[1]!("resubscribe");
    events[1]!({ payload: "current" } as RpcEventContext);
    expect(status).toHaveBeenCalledWith("connecting");
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("does not clear a newer in-flight connection when a retired handshake completes", async () => {
    const pending: Array<(connection: IrohConnection) => void> = [];
    const factory = jest.fn(
      () =>
        new Promise<IrohConnection>((resolve) => {
          pending.push(resolve);
        }),
    );
    const client = new MobileRpcClient({ connectWorkspace: factory });
    const first = client.call("main", "read", []);
    const retired = expect(first).rejects.toThrow("superseded");
    await Promise.resolve();
    await client.close();
    const second = client.call("main", "read", []);
    await Promise.resolve();
    const abandoned = makeConnection();
    pending[0]!(abandoned);
    await retired;
    expect(abandoned.close).toHaveBeenCalledTimes(1);
    const third = client.call("main", "read", []);
    expect(factory).toHaveBeenCalledTimes(2);
    pending[1]!(
      makeConnection({
        rpc: makeRpc({ call: jest.fn(async () => "current") }),
      }),
    );
    await expect(second).resolves.toBe("current");
    await expect(third).resolves.toBe("current");
    await client.close();
  });
});

describe("MobileRpcClient connect lifetime boundaries", () => {
  it("ignores a retired handshake rejection after its replacement connects", async () => {
    let rejectFirst!: (error: Error) => void;
    const factory = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<IrohConnection>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(makeConnection());
    const client = new MobileRpcClient({ connectWorkspace: factory });
    const first = client.connectAndWait();
    const retired = expect(first).rejects.toThrow("superseded");
    await Promise.resolve();
    await client.close();
    await client.connectAndWait();
    const status = jest.fn();
    client.onStatusChange(status);
    rejectFirst(new Error("old network failure"));
    await retired;
    expect(status).not.toHaveBeenCalled();
    expect(client.status).toBe("connected");
    expect(factory).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("does not retry after disconnect during initial connection backoff", async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const factory = jest.fn(async () => {
      throw new Error("temporarily offline");
    });
    const client = new MobileRpcClient({
      connectWorkspace: factory,
      initialConnectionRetry: { delayMs: 500, maxMs: 2000 },
    });
    let scheduled!: () => void;
    const retryScheduled = new Promise<void>((resolve) => {
      scheduled = resolve;
    });
    client.onReconnectProgress((progress) => {
      if (progress.phase === "scheduled") scheduled();
    });
    try {
      const connecting = client.connectAndWait();
      const retired = expect(connecting).rejects.toThrow("superseded");
      await retryScheduled;
      client.disconnect();
      await jest.advanceTimersByTimeAsync(500);
      await retired;
      expect(factory).toHaveBeenCalledTimes(1);
      expect(client.status).toBe("disconnected");
    } finally {
      await client.close();
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it("does not reconnect after its requested lifetime is canceled while old close is pending", async () => {
    let finish!: () => void;
    const old = makeConnection({
      close: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const factory = jest.fn(async () => old);
    const client = new MobileRpcClient({ connectWorkspace: factory });
    await client.connectAndWait();
    client.reconnect();
    const canceled = client.close();
    finish();
    await canceled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.status).toBe("disconnected");
  });

  it("closes every subscription and native connection even when unsubscribe throws", async () => {
    const stopStatus = jest.fn(() => {
      throw new Error("status cleanup failed");
    });
    const stopProgress = jest.fn();
    const stopEvent = jest.fn();
    const connection = makeConnection({
      session: makeSession({ onStatusChange: () => stopStatus }),
      transport: {
        openSession: jest.fn(),
        onReconnectProgress: () => stopProgress,
      } as unknown as IrohConnection["transport"],
      rpc: makeRpc({ on: () => stopEvent }),
    });
    const client = new MobileRpcClient({
      connectWorkspace: async () => connection,
    });
    client.on("owned", () => undefined);
    await client.connectAndWait();
    await expect(client.close()).rejects.toThrow(
      "resources could not all be closed",
    );
    expect(stopStatus).toHaveBeenCalledTimes(1);
    expect(stopProgress).toHaveBeenCalledTimes(1);
    expect(stopEvent).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(client.status).toBe("disconnected");
  });
});

describe("MobileRpcClient shared initial connection job", () => {
  it("shares one complete retry job and executes a waiting user mutation only once", async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const mutation = jest.fn(async () => "saved");
    const ready = makeConnection({ rpc: makeRpc({ call: mutation }) });
    const factory = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ready);
    const client = new MobileRpcClient({
      connectWorkspace: factory,
      initialConnectionRetry: { delayMs: 500, maxMs: 2000 },
    });
    let scheduled!: () => void;
    const backoff = new Promise<void>((resolve) => {
      scheduled = resolve;
    });
    client.onReconnectProgress((progress) => {
      if (progress.phase === "scheduled") scheduled();
    });
    try {
      const first = client.connectAndWait();
      await backoff;
      const second = client.connectAndWait(1);
      const write = client.call("main", "write", ["value"]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(mutation).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.all([first, second]);
      await expect(write).resolves.toBe("saved");
      expect(factory).toHaveBeenCalledTimes(2);
      expect(mutation).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(["missing-control", "expose", "listener"] as const)(
    "never publishes an invalid %s connection and waits for exact cleanup before retry",
    async (phase) => {
      const warn = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      let finishClose!: () => void;
      let closing!: () => void;
      const closeStarted = new Promise<void>((resolve) => {
        closing = resolve;
      });
      const invalidRpc = makeRpc({
        call: jest.fn(),
        ...(phase === "expose"
          ? {
              expose: () => {
                throw new Error("expose failed");
              },
            }
          : {}),
        ...(phase === "listener"
          ? {
              on: () => {
                throw new Error("listener failed");
              },
            }
          : {}),
      });
      const stopStatus = jest.fn();
      const invalid = makeConnection({
        rpc: invalidRpc,
        ...(phase === "missing-control" ? { hubControlRpc: undefined } : {}),
        session: makeSession({ onStatusChange: () => stopStatus }),
        close: jest.fn(() => {
          closing();
          return new Promise<void>((resolve) => {
            finishClose = resolve;
          });
        }),
      });
      const mutation = jest.fn(async () => "current");
      const factory = jest
        .fn()
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce(
          makeConnection({ rpc: makeRpc({ call: mutation }) }),
        );
      const client = new MobileRpcClient({
        connectWorkspace: factory,
        initialConnectionRetry: { delayMs: 0, maxMs: 2000 },
      });
      client.expose("owned-handler", async () => undefined);
      client.on("owned-event", () => undefined);
      try {
        const request = client.call("main", "write", []);
        await closeStarted;
        const connected = client.connectAndWait();
        expect(factory).toHaveBeenCalledTimes(1);
        expect(invalidRpc.call).not.toHaveBeenCalled();
        expect(client.status).toBe("connecting");
        finishClose();
        await connected;
        await expect(request).resolves.toBe("current");
        expect(invalid.close).toHaveBeenCalledTimes(1);
        if (phase === "listener") expect(stopStatus).toHaveBeenCalledTimes(1);
        expect(mutation).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        warn.mockRestore();
      }
    },
  );
});

it("ignores recovery before adoption and from a failed initial attempt during the same retry lifetime", async () => {
  const callbacks: Array<(kind: RecoveryKind) => void | Promise<void>> = [];
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const factory = jest.fn(
    async (recover: (kind: RecoveryKind) => void | Promise<void>) => {
      callbacks.push(recover);
      await recover("resubscribe");
      if (callbacks.length === 1) throw new Error("first handshake failed");
      return makeConnection();
    },
  );
  const client = new MobileRpcClient({
    connectWorkspace: factory,
    initialConnectionRetry: { delayMs: 0, maxMs: 2000 },
  });
  const recovered = jest.fn();
  client.onRecovery("resubscribe", recovered);
  try {
    await client.connectAndWait();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(recovered).not.toHaveBeenCalled();
    await callbacks[0]!("resubscribe");
    expect(recovered).not.toHaveBeenCalled();
    await callbacks[1]!("resubscribe");
    expect(recovered).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    warn.mockRestore();
  }
});

it("makes every reconnect caller await retirement and preserves failed cleanup for later close", async () => {
  const logged = jest
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const warned = jest
    .spyOn(console, "warn")
    .mockImplementation(() => undefined);
  let failClose!: (error: Error) => void;
  const connection = makeConnection({
    close: jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failClose = reject;
        }),
    ),
  });
  const factory = jest.fn(async () => connection);
  const client = new MobileRpcClient({ connectWorkspace: factory });
  try {
    await client.connectAndWait();
    client.reconnect();
    const request = client.call("main", "write", []);
    const rejected = expect(request).rejects.toThrow(
      "resources could not all be closed",
    );
    const connected = client.connectAndWait();
    const connectionRejected = expect(connected).rejects.toThrow(
      "resources could not all be closed",
    );
    expect(factory).toHaveBeenCalledTimes(1);
    failClose(new Error("native cleanup failed"));
    await Promise.all([rejected, connectionRejected]);
    await expect(client.call("main", "write", [])).rejects.toThrow(
      "resources could not all be closed",
    );
    await expect(client.close()).rejects.toThrow(
      "resources could not all be closed",
    );
    client.reconnect();
    await expect(client.connectAndWait()).rejects.toThrow(
      "resources could not all be closed",
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(client.status).toBe("disconnected");
  } finally {
    logged.mockRestore();
    warned.mockRestore();
  }
});
