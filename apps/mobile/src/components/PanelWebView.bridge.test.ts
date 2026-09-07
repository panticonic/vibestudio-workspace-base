jest.mock("react-native-webview", () => ({ WebView: () => null }));

import { buildBridgeBootstrapScript } from "./PanelWebView";

type BridgeTestRoot = {
  console: Console;
  addEventListener?: (...args: unknown[]) => void;
  window?: unknown;
  document?: unknown;
  ReactNativeWebView?: { postMessage: (message: string) => void };
  __vibestudioShell?: {
    onRecovery: (kind: string, handler: () => void | Promise<void>) => () => void;
  };
  __vibestudioMobileHost?: { deliverRecovery: (kind: string) => void };
};

it("invokes, observes failures, and unsubscribes mobile recovery handlers", async () => {
  const root = globalThis as unknown as BridgeTestRoot;
  const addEventListener = root.addEventListener;
  const priorWindow = root.window;
  const priorDocument = root.document;
  const priorConsole = root.console;
  const error = jest.spyOn(priorConsole, "error").mockImplementation(() => {});
  const postMessage = jest.fn();
  Object.assign(root, {
    addEventListener: jest.fn(),
    window: root,
    document: {
      title: "",
      readyState: "loading",
      querySelector: jest.fn(() => null),
      createElement: jest.fn(() => ({ setAttribute: jest.fn() })),
      head: { appendChild: jest.fn() },
      documentElement: {},
      addEventListener: jest.fn(),
    },
    ReactNativeWebView: { postMessage },
  });
  try {
    (0, eval)(buildBridgeBootstrapScript(null, true));
    const recovered = jest.fn(async () => {
      throw new Error("restore failed");
    });
    const stop = root.__vibestudioShell!.onRecovery("resubscribe", recovered);

    root.__vibestudioMobileHost!.deliverRecovery("resubscribe");
    await Promise.resolve();
    await Promise.resolve();
    stop();
    root.__vibestudioMobileHost!.deliverRecovery("resubscribe");

    expect(recovered).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[VibestudioBridge] Panel recovery failed",
      "resubscribe",
      expect.objectContaining({ message: "restore failed" }),
    );
    expect(
      postMessage.mock.calls.some(([raw]) =>
        String(raw).includes("Panel recovery failed"),
      ),
    ).toBe(true);
  } finally {
    root.console = priorConsole;
    error.mockRestore();
    if (addEventListener) root.addEventListener = addEventListener;
    else delete root.addEventListener;
    delete root.__vibestudioShell;
    delete root.__vibestudioMobileHost;
    if (priorWindow === undefined) delete root.window;
    else root.window = priorWindow;
    if (priorDocument === undefined) delete root.document;
    else root.document = priorDocument;
    delete root.ReactNativeWebView;
  }
});
