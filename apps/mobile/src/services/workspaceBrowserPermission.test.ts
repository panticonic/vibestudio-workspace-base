import {
  createBrowserPermissionHandler,
  type NativeBrowserPermissionRequest,
} from "./workspaceBrowserPermission";

const request: NativeBrowserPermissionRequest = {
  requestId: "native-request",
  target: 42,
  origin: "https://camera.example",
  topLevelUrl: "https://camera.example/page",
  capabilities: ["camera"],
};

test("forwards native origin to the captured panel and returns the existing queue decision", async () => {
  const approve = jest.fn(async () => ({ granted: true }));
  const respond = jest.fn();
  const handler = createBrowserPermissionHandler(
    "personal-panel",
    approve,
    respond,
  );
  await handler.onEvent({ nativeEvent: request });
  expect(approve).toHaveBeenCalledWith(
    "personal-panel",
    request,
    expect.any(AbortSignal),
  );
  expect(respond).toHaveBeenCalledWith(42, "native-request", true);
});

test("navigation cancels the RPC and ignores its late approval", async () => {
  let finish!: (decision: { granted: boolean }) => void;
  let signal!: AbortSignal;
  const approve = jest.fn((_panel, _request, capturedSignal: AbortSignal) => {
    signal = capturedSignal;
    return new Promise<{ granted: boolean }>((resolve) => {
      finish = resolve;
    });
  });
  const respond = jest.fn();
  const handler = createBrowserPermissionHandler("panel", approve, respond);
  const pending = handler.onEvent({ nativeEvent: request });
  await handler.onEvent({ nativeEvent: { ...request, cancelled: true } });
  expect(signal.aborted).toBe(true);
  finish({ granted: true });
  await pending;
  expect(respond).not.toHaveBeenCalled();
});

test("closing a panel denies outstanding native callbacks and aborts pending approval", async () => {
  let finish!: (decision: { granted: boolean }) => void;
  const approve = jest.fn(
    () =>
      new Promise<{ granted: boolean }>((resolve) => {
        finish = resolve;
      }),
  );
  const respond = jest.fn();
  const handler = createBrowserPermissionHandler("panel", approve, respond);
  const pending = handler.onEvent({ nativeEvent: request });
  handler.close();
  expect(respond).toHaveBeenCalledWith(42, "native-request", false);
  finish({ granted: true });
  await pending;
  expect(respond).toHaveBeenCalledTimes(1);
});

test("missing or failed workspace connection never grants native access", async () => {
  const respond = jest.fn();
  await createBrowserPermissionHandler("panel", undefined, respond).onEvent({
    nativeEvent: request,
  });
  await createBrowserPermissionHandler(
    "panel",
    async () => {
      throw new Error("offline");
    },
    respond,
  ).onEvent({ nativeEvent: request });
  expect(respond.mock.calls).toEqual([
    [42, "native-request", false],
    [42, "native-request", false],
  ]);
});
