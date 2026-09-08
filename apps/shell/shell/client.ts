import {
  createRecoveryCoordinator,
  type RecoveryKind,
} from "@vibestudio/shell-core/recoveryCoordinator";
/** Stable startup client and exports used by shell entry points. */
import {
  createRpcClient,
  rpcDestinationMatchesCaller,
  type RpcDestination,
  bridgeStreamSurfaceOf,
  openBridgeStream,
  openBridgeUploadStream,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@vibestudio/rpc";
import { assertPresent } from "../utils/assertPresent";
import {
  createNativeConnectionState,
  type NativeWorkspaceConnectionBridge,
} from "./nativeConnectionState";
import { createNativePanelPresentation } from "./nativePanelPresentation";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import {
  createShellApprovalClient,
  createShellWorkspaceClient,
} from "./workspaceClient";
export * from "./workspaceClient";
const g = globalThis as unknown as {
  __vibestudioWorkspaceConnection?: NativeWorkspaceConnectionBridge;
  __vibestudioTransport?: {
    onRecovery?: (
      kind: RecoveryKind,
      handler: (workspaceId?: string) => void | Promise<void>,
    ) => () => void;
    identity: { workspaceId: string; runtimeId: string };
    send: (envelope: RpcEnvelope) => Promise<void>;
    onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
  };
};
if (!g.__vibestudioTransport) throw new Error("Shell transport not available");
const connection = createNativeConnectionState(
  assertPresent(g.__vibestudioWorkspaceConnection),
);
const transport: EnvelopeRpcTransport = {
  send: (envelope) => assertPresent(g.__vibestudioTransport).send(envelope),
  onMessage: (handler) =>
    assertPresent(g.__vibestudioTransport).onMessage(handler),
  status: connection.status,
  ready: connection.ready,
  onStatusChange: connection.onStatusChange,
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
const systemOwner = createOwnerRpc({
  kind: "workspace",
  workspaceId: g.__vibestudioTransport.identity.workspaceId,
});
const rpc: RpcClient = systemOwner.rpc;
const hubOwner = createOwnerRpc({ kind: "hub" });
export const hubRpc = hubOwner.rpc;
export const hubApprovalSource = {
  owner: { kind: "hub" as const },
  shellApproval: createShellApprovalClient(hubRpc),
  events: new EventsClient(hubRpc),
};
export const systemWorkspaceId = Promise.resolve(
  g.__vibestudioTransport.identity.workspaceId,
);
export const nativePanelPresentation = createNativePanelPresentation(rpc);
export const startupWorkspaceClient = createShellWorkspaceClient(rpc, {
  workspaceId: systemWorkspaceId,
  nativePresentation: nativePanelPresentation,
  hubRpc,
  recoveryCoordinator: systemOwner.recoveryCoordinator,
});
/** The startup workspace client; never rebound when focus changes. */
export const {
  unitIcons,
  websiteConnections,
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

/** One captured RPC owner; focus changes cannot retarget it. */
function createOwnerRpc(destination: RpcDestination) {
  let closed = false;
  const releases = new Set<() => void>();
  const recoveryCoordinator = createRecoveryCoordinator();
  for (const kind of ["resubscribe", "cold-recover"] as const) {
    const release = g.__vibestudioTransport?.onRecovery?.(
      kind,
      (workspaceId) => {
        if (
          !closed &&
          destination.kind === "workspace" &&
          destination.workspaceId === workspaceId
        )
          return recoveryCoordinator.run(kind);
        return undefined;
      },
    );
    if (release) releases.add(release);
  }
  const statuses = new Set<
    (status: import("@vibestudio/rpc").RpcConnectionStatus) => void
  >();
  const scopedRpc = createRpcClient({
    selfId: assertPresent(g.__vibestudioTransport).identity.runtimeId,
    callerKind: "app",
    workspaceId: assertPresent(g.__vibestudioTransport).identity.workspaceId,
    authorityAcquisition: "wait",
    transport: {
      ...(transport.stream
        ? {
            stream: ((envelope, signal, body) => {
              if (closed)
                return Promise.reject(new Error("Workspace UI is closed"));
              return transport.stream!(
                {
                  ...envelope,
                  destination,
                },
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
                {
                  ...envelope,
                  destination,
                },
                signal,
                body,
              );
            }) satisfies NonNullable<EnvelopeRpcTransport["streamBody"]>,
          }
        : {}),
      send: (envelope) => {
        if (closed) return Promise.reject(new Error("Workspace UI is closed"));
        return transport.send({
          ...envelope,
          destination,
        });
      },
      onMessage: (handler) => {
        const release = transport.onMessage((envelope) => {
          if (
            rpcDestinationMatchesCaller(destination, envelope.delivery.caller)
          )
            handler(envelope);
        });
        releases.add(release);
        return () => {
          releases.delete(release);
          release();
        };
      },
      status: () => (closed ? "disconnected" : connection.status()),
      ready: async () => {
        if (closed) throw new Error("Workspace UI is closed");
        await connection.ready();
      },
      onStatusChange: (handler) => {
        statuses.add(handler);
        const release = connection.onStatusChange((status) => {
          if (!closed) handler(status);
        });
        releases.add(release);
        return () => {
          statuses.delete(handler);
          releases.delete(release);
          release();
        };
      },
    },
  });
  return {
    rpc: scopedRpc,
    recoveryCoordinator,
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
/** A captured target client. Desktop UI admission is enforced at the native IPC boundary. */
export async function createWorkspaceShellClient(workspaceId: string) {
  const owner = createOwnerRpc({ kind: "workspace", workspaceId });
  const scopedRpc = owner.rpc;
  const scoped = createShellWorkspaceClient(scopedRpc, {
    workspaceId,
    nativePresentation: nativePanelPresentation,
    hubRpc,
    recoveryCoordinator: owner.recoveryCoordinator,
  });
  const client = {
    ...scoped,
    // Account/device management has one System presentation owner. Native
    // workspace navigation, panels and Quickfire keep their scoped clients.
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
      scoped.unitIcons.close();
      owner.close();
    },
  };
}
