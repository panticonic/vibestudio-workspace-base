import { RpcBoundaryError, type RpcConnectionStatus } from "@vibestudio/rpc";
import { SESSION_CONNECTION_LOST_CODE } from "@vibestudio/rpc/protocol/remoteSession";
import type { WorkspaceConnectionState } from "@vibestudio/shared/workspaceConnection";

export interface NativeWorkspaceConnectionBridge {
  getCurrent(): Promise<WorkspaceConnectionState>;
  onChange(handler: (state: WorkspaceConnectionState) => void): () => void;
}

/** The same host-owned availability fact used by the single connection overlay. */
export function createNativeConnectionState(
  bridge: NativeWorkspaceConnectionBridge,
) {
  let status: RpcConnectionStatus = "connecting";
  let closed = false;
  let changed = false;
  const listeners = new Set<(status: RpcConnectionStatus) => void>();
  const publish = (next: RpcConnectionStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of listeners) listener(status);
  };
  const apply = (state: WorkspaceConnectionState) => {
    if (closed) return;
    publish(
      state.phase === "online"
        ? "connected"
        : state.phase === "ended"
          ? "disconnected"
          : "connecting",
    );
  };
  const stop = bridge.onChange((state) => {
    changed = true;
    apply(state);
  });
  const initialized = bridge.getCurrent().then((state) => {
    if (!changed) apply(state);
  });
  void initialized.catch((error) => {
    if (!closed)
      console.error("Native connection state is unavailable:", error);
  });
  return {
    status: () => status,
    ready: async () => {
      // Wait only for the first authoritative availability fact, never for a
      // later reconnection that could silently replay a user mutation.
      if (!changed && !closed) await initialized;
      if (status !== "connected")
        throw new RpcBoundaryError(
          "Workspace connection is unavailable",
          "transport",
          SESSION_CONNECTION_LOST_CODE,
        );
    },
    onStatusChange(handler: (status: RpcConnectionStatus) => void) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      publish("disconnected");
      listeners.clear();
    },
  };
}
