import {
  createWebsiteNotificationHandler,
  WorkspaceWebsiteNotificationCoordinator,
  type WebsiteNotificationHost,
} from "./workspaceWebsiteNotifications";
import type { ToastInput } from "../state/toastAtoms";

describe("mobile website notifications", () => {
  test("routes only bounded native-attested operations and cancels pending work", async () => {
    let release!: (value: "granted") => void;
    const host: WebsiteNotificationHost = {
      permission: jest.fn(() => "granted"),
      requestPermission: jest.fn(
        () => new Promise<"granted">((resolve) => (release = resolve)),
      ),
      show: jest.fn(async () => "notification-1"),
      close: jest.fn(async () => {}),
    };
    const reply = jest.fn();
    const handler = createWebsiteNotificationHandler("panel-1", host, reply);
    const pending = handler.onEvent({
      nativeEvent: {
        requestId: "request-1",
        target: 7,
        origin: "https://example.com",
        topLevelUrl: "https://example.com/page",
        method: "requestPermission",
        argsJson: "null",
      },
    });
    await handler.onEvent({
      nativeEvent: {
        requestId: "request-1",
        target: 7,
        origin: "",
        topLevelUrl: "",
        method: "show",
        argsJson: "null",
        cancelled: true,
      },
    });
    release("granted");
    await pending;
    expect(host.requestPermission).toHaveBeenCalledWith(
      "panel-1",
      "https://example.com",
      "https://example.com/page",
      expect.any(AbortSignal),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  test("closes a show accepted after its document was destroyed", async () => {
    let accept!: (value: string) => void;
    const host: WebsiteNotificationHost = {
      permission: jest.fn(() => "granted"),
      requestPermission: jest.fn(async () => "granted"),
      show: jest.fn(() => new Promise<string>((resolve) => (accept = resolve))),
      close: jest.fn(async () => {}),
    };
    const reply = jest.fn();
    const handler = createWebsiteNotificationHandler("panel-1", host, reply);
    const pending = handler.onEvent({
      nativeEvent: {
        requestId: "request-1",
        target: 7,
        origin: "https://example.com",
        topLevelUrl: "https://example.com/page",
        method: "show",
        argsJson: JSON.stringify({ title: "Done", options: {} }),
      },
    });
    handler.close();
    accept("notification-1");
    await pending;
    expect(host.close).toHaveBeenCalledWith("notification-1");
    expect(reply).not.toHaveBeenCalled();
  });

  test("replaces tags within an origin and workspace and preserves other owners", async () => {
    const shown: Array<{ workspaceId: string; toast: ToastInput }> = [];
    const dismissed: string[] = [];
    const lifecycle: Array<[number, string, "click" | "close"]> = [];
    const coordinator = new WorkspaceWebsiteNotificationCoordinator(
      (workspaceId, toast) => shown.push({ workspaceId, toast }),
      (id) => dismissed.push(id),
      (target, id, type) => lifecycle.push([target, id, type]),
    );
    const first = await coordinator.show(
      "workspace-a",
      "https://example.com",
      1,
      "First",
      {
        tag: "build",
      },
    );
    const other = await coordinator.show(
      "workspace-b",
      "https://example.com",
      2,
      "Other",
      {
        tag: "build",
      },
    );
    const replacement = await coordinator.show(
      "workspace-a",
      "https://example.com",
      3,
      "Latest",
      {
        tag: "build",
      },
    );
    expect(replacement).not.toBe(first);
    expect(lifecycle).toContainEqual([1, first, "close"]);
    expect(lifecycle).not.toContainEqual([2, other, "close"]);
    shown.at(-1)?.toast.onAction?.();
    expect(lifecycle).toContainEqual([3, replacement, "click"]);
  });
});
