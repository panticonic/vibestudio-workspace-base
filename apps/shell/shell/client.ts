/** Stable startup client and exports used by shell entry points. */
import {
  createRpcClient,
  bridgeStreamSurfaceOf,
  openBridgeStream,
  openBridgeUploadStream,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { assertPresent } from "../utils/assertPresent";
import { createNativePanelPresentation } from "./nativePanelPresentation";
import { createShellWorkspaceClient } from "./workspaceClient";
export * from "./workspaceClient";
const g = globalThis as unknown as {
  __vibestudioTransport?: {
    identity: { workspaceId: string; runtimeId: string };
    send: (envelope: RpcEnvelope) => Promise<void>;
    onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
  };
};
if (!g.__vibestudioTransport) throw new Error("Shell transport not available");
const transport: EnvelopeRpcTransport = {
  send: (envelope) => assertPresent(g.__vibestudioTransport).send(envelope),
  onMessage: (handler) =>
    assertPresent(g.__vibestudioTransport).onMessage(handler),
  status: () => "connected",
  ready: () => Promise.resolve(),
  onStatusChange: () => () => {},
};
const streamSurface = bridgeStreamSurfaceOf(g.__vibestudioTransport);
if (streamSurface) {
  transport.stream = (envelope, signal, body) =>
    openBridgeStream(streamSurface, envelope, signal ?? null, body ?? null);
  transport.streamBody = (envelope, signal, body) => {
    if (!body) return Promise.reject(new Error("An upload requires a body"));
    return openBridgeUploadStream(
      streamSurface,
      envelope,
      signal ?? null,
      body,
    );
  };
}
const rpc: RpcClient = createRpcClient({
  selfId: g.__vibestudioTransport.identity.runtimeId,
  callerKind: "app",
  workspaceId: g.__vibestudioTransport.identity.workspaceId,
  transport: {
    ...transport,
    onMessage: (handler) =>
      transport.onMessage((envelope) => {
        const source = envelope.delivery.caller.workspaceId;
        if (!source || source === g.__vibestudioTransport?.identity.workspaceId)
          handler(envelope);
      }),
  },
});
export const systemWorkspaceId = Promise.resolve(
  g.__vibestudioTransport.identity.workspaceId,
);
export const nativePanelPresentation = createNativePanelPresentation(rpc);
export const startupWorkspaceClient = createShellWorkspaceClient(rpc, {
  workspaceId: systemWorkspaceId,
  nativePresentation: nativePanelPresentation,
});
/** The startup workspace client; never rebound when focus changes. */
export const {
  hostLaunch,
  app,
  panel,
  hostCommands,
  connectNativePanelAdapter,
  view,
  nativeShellOverlay,
  contentOverlay,
  shellNetwork,
  incomingPairLink,
  incomingShellSurface,
  incomingPanelLocation,
  menu,
  workspace,
  templates,
  credentials,
  sourceFiles,
  vcs,
  remoteCred,
  hubControl,
  autofill,
  blobstore,
  workspacePresence,
  ACCOUNT_PROFILE_CHANGED_EVENT,
  account,
  userNotifications,
  events,
  directEvents,
  notification,
  extensions,
  browserData,
  browserEnvironment,
  supervisedUnits,
  buildUnits,
  shellApproval,
  shellPresence,
  quickfire,
  connectToChannel,
} = startupWorkspaceClient;

/** A captured target client. Desktop UI admission is enforced at the native IPC boundary. */
export async function createWorkspaceShellClient(workspaceId: string) {
  const sourceWorkspaceId = await systemWorkspaceId;
  let closed = false;
  const releases = new Set<() => void>();
  const statuses = new Set<(status: "connected" | "disconnected") => void>();
  const scopedRpc = createRpcClient({
    selfId: assertPresent(g.__vibestudioTransport).identity.runtimeId,
    callerKind: "app",
    workspaceId: sourceWorkspaceId,
    transport: {
      ...(transport.stream
        ? {
            stream: ((envelope, signal, body) => {
              if (closed)
                return Promise.reject(new Error("Workspace UI is closed"));
              return transport.stream!(
                { ...envelope, targetWorkspaceId: workspaceId },
                signal,
                body,
              );
            }) satisfies NonNullable<EnvelopeRpcTransport["stream"]>,
          }
        : {}),
      ...(transport.streamBody
        ? {
            streamBody: ((envelope, signal, body) => {
              if (closed)
                return Promise.reject(new Error("Workspace UI is closed"));
              return transport.streamBody!(
                { ...envelope, targetWorkspaceId: workspaceId },
                signal,
                body,
              );
            }) satisfies NonNullable<EnvelopeRpcTransport["streamBody"]>,
          }
        : {}),
      send: (envelope) => {
        if (closed) return Promise.reject(new Error("Workspace UI is closed"));
        return transport.send({ ...envelope, targetWorkspaceId: workspaceId });
      },
      onMessage: (handler) => {
        const release = transport.onMessage((envelope) => {
          if (envelope.delivery.caller.workspaceId === workspaceId)
            handler(envelope);
        });
        releases.add(release);
        return () => {
          releases.delete(release);
          release();
        };
      },
      status: () => (closed ? "disconnected" : "connected"),
      ready: async () => {
        if (closed) throw new Error("Workspace UI is closed");
      },
      onStatusChange: (handler) => {
        statuses.add(handler);
        return () => {
          statuses.delete(handler);
        };
      },
    },
  });
  const scoped = createShellWorkspaceClient(scopedRpc, {
    workspaceId,
    nativePresentation: nativePanelPresentation,
  });
  const client = {
    ...scoped,
    // Account/device UI has one System presentation owner. Workspace code and
    // panel/Quickfire services above keep their captured target connection.
    app,
    hostLaunch,
    hubControl,
    account,
    remoteCred,
    incomingPairLink,
    incomingShellSurface,
    incomingPanelLocation,
    shellNetwork,
    nativeShellOverlay,
    contentOverlay,
    workspace: {
      ...workspace,
      getActive: scoped.workspace.getActive,
      getConfig: scoped.workspace.getConfig,
    },
  };
  return {
    client,
    close() {
      if (closed) return;
      closed = true;
      for (const listener of statuses) listener("disconnected");
      statuses.clear();
      for (const release of releases) release();
      releases.clear();
    },
  };
}
