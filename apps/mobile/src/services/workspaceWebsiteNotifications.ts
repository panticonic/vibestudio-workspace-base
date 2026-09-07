import { UIManager } from "react-native";
import type { ToastInput } from "../state/toastAtoms";
import { WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT } from "@vibestudio/shared/websiteNotificationCompatibility";
import type { WebsiteNotificationPermission } from "@vibestudio/shared/websiteNotificationCompatibility";

export function buildWorkspaceWebsiteNotificationScript(
  expectedOrigin: string,
  initialPermission: WebsiteNotificationPermission,
): string {
  return `
(() => {
  const native = globalThis.__vibestudioWebsiteNotificationsNative;
  if (!native) return;
  let permission = location.origin === ${JSON.stringify(expectedOrigin)}
    ? ${JSON.stringify(initialPermission)}
    : "default";
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  native.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.permission) { permission = message.permission; return; }
    if (message.event) {
      for (const listener of listeners) listener(message.event);
      return;
    }
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (!message.ok) entry.reject(new Error(String(message.value)));
    else {
      if (entry.method === "permissionState" || entry.method === "requestPermission") permission = message.value;
      entry.resolve(message.value);
    }
  };
  function call(method, args) {
    const requestId = String(++sequence);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, method });
      native.postMessage(JSON.stringify({ requestId, method, args }));
    });
  }
  globalThis.__vibestudioWebsiteNotifications = {
    permission: () => permission,
    requestPermission: () => call("requestPermission", null),
    show: (title, options) => call("show", { title, options }),
    close: (id) => call("close", id),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  void call("permissionState", null).catch(() => {});
})();
${WEBSITE_NOTIFICATION_COMPATIBILITY_SCRIPT}
true;
`;
}

export type WebsiteNotificationMethod =
  | "permissionState"
  | "requestPermission"
  | "show"
  | "close";

export interface NativeWebsiteNotificationRequest {
  requestId: string;
  target: number;
  origin: string;
  topLevelUrl: string;
  method: WebsiteNotificationMethod;
  argsJson: string;
  cancelled?: boolean;
}

export interface WebsiteNotificationHost {
  permission(panelId: string, origin: string): WebsiteNotificationPermission;
  requestPermission(
    panelId: string,
    origin: string,
    topLevelUrl: string,
    signal: AbortSignal,
  ): Promise<WebsiteNotificationPermission>;
  show(
    panelId: string,
    origin: string,
    target: number,
    input: { title: string; options: unknown },
  ): Promise<string>;
  close(id: string): Promise<void>;
}

function respond(
  target: number,
  requestId: string,
  ok: boolean,
  value: unknown,
) {
  UIManager.dispatchViewManagerCommand(target, "resolveWebsiteNotification", [
    requestId,
    ok,
    JSON.stringify(value),
  ]);
}

/** Routes native-attested document requests; native retains document ownership of accepted IDs. */
export function createWebsiteNotificationHandler(
  panelId: string,
  host: WebsiteNotificationHost | undefined,
  reply = respond,
) {
  const pending = new Map<string, AbortController>();
  let closed = false;
  return {
    async onEvent(event: { nativeEvent: NativeWebsiteNotificationRequest }) {
      const request = event.nativeEvent;
      if (request.cancelled) {
        pending.get(request.requestId)?.abort();
        pending.delete(request.requestId);
        return;
      }
      if (closed || !host || pending.has(request.requestId)) {
        reply(
          request.target,
          request.requestId,
          false,
          "Notification bridge unavailable",
        );
        return;
      }
      const controller = new AbortController();
      pending.set(request.requestId, controller);
      try {
        const args = JSON.parse(request.argsJson) as unknown;
        let value: unknown;
        switch (request.method) {
          case "permissionState":
            value = await host.permission(panelId, request.origin);
            break;
          case "requestPermission":
            value = await host.requestPermission(
              panelId,
              request.origin,
              request.topLevelUrl,
              controller.signal,
            );
            break;
          case "show": {
            if (!args || typeof args !== "object")
              throw new Error("Invalid notification");
            const input = args as Record<string, unknown>;
            if (typeof input["title"] !== "string")
              throw new Error("Invalid notification title");
            value = await host.show(panelId, request.origin, request.target, {
              title: input["title"],
              options: input["options"],
            });
            break;
          }
          case "close":
            if (typeof args !== "string")
              throw new Error("Invalid notification id");
            await host.close(args);
            value = null;
            break;
        }
        if (
          controller.signal.aborted &&
          request.method === "show" &&
          typeof value === "string"
        ) {
          await host.close(value);
        } else if (!controller.signal.aborted)
          reply(request.target, request.requestId, true, value);
      } catch (error) {
        if (!controller.signal.aborted) {
          reply(
            request.target,
            request.requestId,
            false,
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        pending.delete(request.requestId);
      }
    },
    close() {
      closed = true;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
  };
}

export class WorkspaceWebsiteNotificationCoordinator {
  private readonly live = new Map<
    string,
    { workspaceId: string; origin: string; tag: string; target: number }
  >();

  constructor(
    private readonly notify: (workspaceId: string, toast: ToastInput) => void,
    private readonly dismiss: (id: string) => void,
    private readonly lifecycle = (
      target: number,
      id: string,
      type: "click" | "close",
    ) =>
      UIManager.dispatchViewManagerCommand(
        target,
        "emitWebsiteNotificationEvent",
        [id, type],
      ),
  ) {}

  async show(
    workspaceId: string,
    origin: string,
    target: number,
    title: string,
    options: unknown,
  ): Promise<string> {
    const record =
      options && typeof options === "object"
        ? (options as Record<string, unknown>)
        : {};
    const tag = typeof record["tag"] === "string" ? record["tag"] : "";
    if (tag) {
      const replaced = [...this.live.entries()].find(
        ([, item]) =>
          item.workspaceId === workspaceId &&
          item.origin === origin &&
          item.tag === tag,
      );
      if (replaced) this.finish(replaced[0], "close");
    }
    const id = crypto.randomUUID();
    this.live.set(id, { workspaceId, origin, tag, target });
    this.notify(workspaceId, {
      id: `website:${id}`,
      title,
      message: typeof record["body"] === "string" ? record["body"] : origin,
      durationMs: 0,
      actionLabel: "Open",
      onAction: () => this.finish(id, "click"),
      onClose: () => this.finish(id, "close", false),
    });
    return id;
  }

  async close(id: string): Promise<void> {
    this.finish(id, "close");
  }

  private finish(
    id: string,
    type: "click" | "close",
    removeToast = true,
  ): void {
    const item = this.live.get(id);
    if (!item) return;
    if (type === "close") this.live.delete(id);
    if (removeToast)
      this.dismiss(JSON.stringify([item.workspaceId, `website:${id}`]));
    this.lifecycle(item.target, id, type);
  }
}
