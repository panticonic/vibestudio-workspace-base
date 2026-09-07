import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient, RpcEnvelope } from "@vibestudio/rpc";
const state = vi.hoisted(() => ({ clients: [] as RpcClient[] }));
vi.mock("./workspaceClient", () => ({
  createShellWorkspaceClient: (rpc: RpcClient) => {
    state.clients.push(rpc);
    return {
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
  const module = await import("./client");
  expect(await module.systemWorkspaceId).toBe("system");
  expect(send).not.toHaveBeenCalled();
  const project = await module.createWorkspaceShellClient("project");
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
      targetWorkspaceId: "system",
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
