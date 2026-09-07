import { UIManager } from "react-native";

export interface NativeBrowserPermissionRequest {
  requestId: string;
  target: number;
  origin: string;
  topLevelUrl: string;
  capabilities: ("camera" | "microphone" | "geolocation")[];
}
export type BrowserPermissionRequester = (
  panelId: string,
  request: NativeBrowserPermissionRequest,
  signal: AbortSignal,
) => Promise<{ granted: boolean }>;

/** Native events are never accepted from the page message bridge. */
export function createBrowserPermissionHandler(
  panelId: string,
  request: BrowserPermissionRequester | undefined,
  respond = (target: number, requestId: string, granted: boolean) =>
    UIManager.dispatchViewManagerCommand(target, "resolveWorkspacePermission", [
      requestId,
      granted,
    ]),
) {
  const pending = new Map<
    string,
    { controller: AbortController; target: number }
  >();
  let closed = false;
  return {
    async onEvent(event: {
      nativeEvent: NativeBrowserPermissionRequest & { cancelled?: boolean };
    }): Promise<void> {
      const data = event.nativeEvent;
      if (data.cancelled) {
        pending.get(data.requestId)?.controller.abort();
        pending.delete(data.requestId);
        return;
      }
      if (closed || !request) {
        respond(data.target, data.requestId, false);
        return;
      }
      if (pending.has(data.requestId)) return;
      const controller = new AbortController();
      pending.set(data.requestId, { controller, target: data.target });
      let granted = false;
      try {
        granted = (await request(panelId, data, controller.signal)).granted;
      } catch {
        // Failed, disconnected, and cancelled approvals never grant browser access.
      } finally {
        if (!controller.signal.aborted) {
          pending.delete(data.requestId);
          respond(data.target, data.requestId, granted);
        }
      }
    },
    close() {
      closed = true;
      for (const [id, entry] of pending) {
        entry.controller.abort();
        respond(entry.target, id, false);
      }
      pending.clear();
    },
  };
}
