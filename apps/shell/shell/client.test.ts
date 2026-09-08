import { afterEach, expect, it, vi } from "vitest";
import {
  envelopeFromMessage,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
const state = vi.hoisted(() => ({
  clients: [] as RpcClient[],
  recoveries:
    [] as import("@vibestudio/shell-core/recoveryCoordinator").RecoveryCoordinator[],
}));
vi.mock("./workspaceClient", () => ({
  createShellApprovalClient: () => ({}),
  createShellWorkspaceClient: (
    rpc: RpcClient,
    ownership: {
      recoveryCoordinator: import("@vibestudio/shell-core/recoveryCoordinator").RecoveryCoordinator;
    },
  ) => {
    state.recoveries.push(ownership.recoveryCoordinator);
    state.clients.push(rpc);
    return {
      unitIcons: { close: vi.fn() },
      app: { openShellSurface: vi.fn() },
      workspace: {
        getActive: async () => "workspace",
        getConfig: async () => ({}),
      },
    };
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  state.clients.length = 0;
  state.recoveries.length = 0;
});
it("binds System RPC identity before its first request and isolates destination events", async () => {
  const handlers = new Set<(envelope: RpcEnvelope) => void>();
  const send = vi.fn(async () => {});
  vi.stubGlobal("__vibestudioTransport", {
    identity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
    send,
    onMessage: (handler: (envelope: RpcEnvelope) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
  vi.stubGlobal("__vibestudioWorkspaceConnection", {
    getCurrent: async () => ({
      version: 1,
      phase: "online",
      mode: "remote",
      since: 1,
    }),
    onChange: () => () => {},
  });
  const module = await import("./client");
  expect(await module.systemWorkspaceId).toBe("system");
  expect(send).not.toHaveBeenCalled();
  const project = await module.createWorkspaceShellClient("project");
  expect(project.client.app).toBeDefined();
  expect(project.client.app).not.toBe(module.app);
  const systemEvent = vi.fn();
  const projectEvent = vi.fn();
  state.clients[0]!.on("changed", systemEvent);
  state.clients[1]!.on("changed", projectEvent);
  const deliver = (workspaceId: string) => {
    const caller = {
      callerId: "main",
      callerKind: "server" as const,
      workspaceId,
    };
    const envelope: RpcEnvelope = {
      from: "main",
      target: "@workspace-apps/shell",
      destination: { kind: "workspace", workspaceId: "system" },
      delivery: { caller },
      provenance: [caller],
      message: {
        type: "event",
        fromId: "main",
        event: "changed",
        payload: workspaceId,
      },
    };
    handlers.forEach((handler) => handler(envelope));
  };
  deliver("project");
  expect(systemEvent).not.toHaveBeenCalled();
  expect(projectEvent).toHaveBeenCalledOnce();
  deliver("system");
  expect(systemEvent).toHaveBeenCalledOnce();
  expect(projectEvent).toHaveBeenCalledOnce();
  project.close();
  deliver("project");
  expect(projectEvent).toHaveBeenCalledOnce();
});

it("holds a nested workspace acquisition for its owning shell and retries after approval", async () => {
  const handlers = new Set<(envelope: RpcEnvelope) => void>();
  const methods: string[] = [];
  const send = vi.fn(async (envelope: RpcEnvelope) => {
    if (envelope.message.type !== "request") return;
    methods.push(envelope.message.method);
    const protectedAttempts = methods.filter(
      (method) => method === "extensions.invokeProvider",
    ).length;
    const message =
      envelope.message.method === "authority.awaitDecision"
        ? {
            type: "response" as const,
            requestId: envelope.message.requestId,
            result: { state: "decided" },
          }
        : protectedAttempts === 1
          ? {
              type: "response" as const,
              requestId: envelope.message.requestId,
              error: "upsertImportJob: authority acquisition required",
              errorKind: "access" as const,
              errorCode: "EACQUIRE",
              errorData: {
                acquisition: {
                  acquisitionId: "acq:browser-import",
                  ownerRuntimeId: "@workspace-apps/shell",
                },
              },
            }
          : {
              type: "response" as const,
              requestId: envelope.message.requestId,
              result: { jobId: "import-1", phase: "queued" },
            };
    const caller = {
      callerId: "main",
      callerKind: "server" as const,
      workspaceId: "project",
    };
    queueMicrotask(() =>
      handlers.forEach((handler) =>
        handler(
          envelopeFromMessage({
            selfId: "main",
            from: "main",
            target: envelope.from,
            destination: { kind: "workspace", workspaceId: "system" },
            caller,
            message,
          }),
        ),
      ),
    );
  });
  vi.stubGlobal("__vibestudioTransport", {
    identity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
    send,
    onMessage: (handler: (envelope: RpcEnvelope) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
  vi.stubGlobal("__vibestudioWorkspaceConnection", {
    getCurrent: async () => ({
      version: 1,
      phase: "online",
      mode: "remote",
      since: 1,
    }),
    onChange: () => () => {},
  });

  const module = await import("./client");
  const project = await module.createWorkspaceShellClient("project");
  await expect(
    state.clients[1]!.call("main", "extensions.invokeProvider", [
      "browserData",
      "startImport",
      [],
    ]),
  ).resolves.toEqual({ jobId: "import-1", phase: "queued" });

  expect(methods).toEqual([
    "extensions.invokeProvider",
    "authority.awaitDecision",
    "extensions.invokeProvider",
  ]);
  const waitEnvelope = send.mock.calls
    .map(([envelope]) => envelope)
    .find(
      (envelope) =>
        envelope.message.type === "request" &&
        envelope.message.method === "authority.awaitDecision",
    );
  expect(waitEnvelope?.message).toMatchObject({
    args: [{ acquisitionId: "acq:browser-import" }],
  });
  project.close();
});

it("routes server calls and replies independently of a workspace named hub", async () => {
  const handlers = new Set<(envelope: RpcEnvelope) => void>();
  const sent: RpcEnvelope[] = [];
  vi.stubGlobal("__vibestudioTransport", {
    identity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
    send: async (envelope: RpcEnvelope) => {
      sent.push(envelope);
      if (envelope.message.type !== "request") return;
      const requestId = envelope.message.requestId;
      const isHub = envelope.destination?.kind === "hub";
      const workspaceId =
        envelope.destination?.kind === "workspace"
          ? envelope.destination.workspaceId
          : undefined;
      const caller = {
        callerId: isHub ? "hub" : "main",
        callerKind: "server" as const,
        ...(workspaceId ? { workspaceId } : {}),
      };
      queueMicrotask(() =>
        handlers.forEach((handler) =>
          handler(
            envelopeFromMessage({
              selfId: caller.callerId,
              from: caller.callerId,
              target: envelope.from,
              destination: { kind: "workspace", workspaceId: "system" },
              caller,
              message: {
                type: "response",
                requestId,
                result: isHub ? "server" : "workspace",
              },
            }),
          ),
        ),
      );
    },
    onMessage: (handler: (envelope: RpcEnvelope) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  });
  vi.stubGlobal("__vibestudioWorkspaceConnection", {
    getCurrent: async () => ({
      version: 1,
      phase: "online",
      mode: "remote",
      since: 1,
    }),
    onChange: () => () => {},
  });
  const module = await import("./client");
  const workspace = await module.createWorkspaceShellClient("hub");
  await expect(
    module.hubRpc.call("main", "shellApproval.listPending", []),
  ).resolves.toBe("server");
  await expect(
    state.clients[1]!.call("main", "shellApproval.listPending", []),
  ).resolves.toBe("workspace");
  expect(sent.map((envelope) => envelope.destination)).toEqual([
    { kind: "hub" },
    { kind: "workspace", workspaceId: "hub" },
  ]);
  workspace.close();
});

it("recovers only the addressed workspace and retires its recovery listeners on close", async () => {
  const handlers = new Map<
    string,
    Set<(workspaceId?: string) => void | Promise<void>>
  >();
  vi.stubGlobal("__vibestudioTransport", {
    identity: { workspaceId: "system", runtimeId: "@workspace-apps/shell" },
    send: vi.fn(async () => {}),
    onMessage: () => () => {},
    onRecovery: (
      kind: string,
      handler: (workspaceId?: string) => void | Promise<void>,
    ) => {
      const listeners = handlers.get(kind) ?? new Set();
      handlers.set(kind, listeners);
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  });
  vi.stubGlobal("__vibestudioWorkspaceConnection", {
    getCurrent: async () => ({
      version: 1,
      phase: "online",
      mode: "local",
      since: 1,
    }),
    onChange: () => () => {},
  });
  const module = await import("./client");
  const project = await module.createWorkspaceShellClient("project");
  const systemReplay = vi.fn(),
    projectReplay = vi.fn();
  state.recoveries[0]!.registerResubscribeHandler("test", systemReplay);
  state.recoveries[1]!.registerResubscribeHandler("test", projectReplay);
  await Promise.all(
    [...handlers.get("resubscribe")!].map((handler) => handler("project")),
  );
  expect(projectReplay).toHaveBeenCalledOnce();
  expect(systemReplay).not.toHaveBeenCalled();
  project.close();
  await Promise.all(
    [...handlers.get("resubscribe")!].map((handler) => handler("project")),
  );
  expect(projectReplay).toHaveBeenCalledOnce();
});
