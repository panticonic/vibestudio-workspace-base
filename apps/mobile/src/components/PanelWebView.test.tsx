import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { PanelWebView, type PanelWebViewHandle } from "./PanelWebView";

const mockNativeWebViewMounted = jest.fn();
const mockNativeWebViewUnmounted = jest.fn();
const mockInjectJavaScript = jest.fn();
const mockNativeWebViewProps: Array<Record<string, unknown>> = [];

jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    WebView: React.forwardRef((props: Record<string, unknown>, ref) => {
      mockNativeWebViewProps.push(props);
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: mockInjectJavaScript,
      }));
      React.useEffect(() => {
        mockNativeWebViewMounted();
        return () => mockNativeWebViewUnmounted();
      }, []);
      return <View {...props} testID="native-webview" />;
    }),
  };
});

jest.mock("../services/workspaceBrowserProfile", () => ({ workspaceWebViewConfig: (scope: string) => ({ props: { workspaceProfile: scope } }) }));

jest.mock("../services/nativeCapabilities", () => ({
  openExternalUrl: jest.fn(async () => undefined),
}));

describe("PanelWebView lifecycle", () => {
  beforeEach(() => {
    mockNativeWebViewMounted.mockClear();
    mockNativeWebViewUnmounted.mockClear();
    mockInjectJavaScript.mockClear();
    mockNativeWebViewProps.length = 0;
  });

  it("does not report an unmount when the callback identity changes", () => {
    const first = jest.fn();
    const latest = jest.fn();
    const view = render(
      <PanelWebView
        browserProfile="test-account/workspace"
        panelId="panel:tree/panels~chat/one"
        url="about:blank"
        visible
        managed={false}
        onUnmount={first}
      />
    );

    view.rerender(
      <PanelWebView
        browserProfile="test-account/workspace"
        panelId="panel:tree/panels~chat/one"
        url="about:blank"
        visible
        managed={false}
        onUnmount={latest}
      />
    );

    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    view.unmount();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("panel:tree/panels~chat/one");
  });

  it("recreates the native document only when its managed connection changes", () => {
    const onUnmount = jest.fn();
    const common = {
      browserProfile: "test-account/workspace",
      panelId: "panel:tree/panels~chat/one",
      url: "https://panel.test/entry.js",
      visible: true,
      managed: true,
      onUnmount,
    } as const;
    const view = render(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-a" }}
      />,
    );

    view.rerender(
      <PanelWebView
        {...common}
        panelInit={{
          entityId: "panel:nav-one",
          connectionId: "conn-a",
          refreshed: true,
        }}
      />,
    );
    expect(mockNativeWebViewMounted).toHaveBeenCalledTimes(1);
    expect(mockNativeWebViewUnmounted).not.toHaveBeenCalled();

    view.rerender(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-b" }}
      />,
    );
    expect(mockNativeWebViewMounted).toHaveBeenCalledTimes(2);
    expect(mockNativeWebViewUnmounted).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it("recovers an errored same-url document and queues the new incarnation until ready", () => {
    const handle = React.createRef<PanelWebViewHandle>();
    const common = {
      ref: handle,
      browserProfile: "test-account/workspace",
      panelId: "panel:tree/panels~chat/one",
      url: "https://panel.test/entry.js",
      visible: true,
      managed: true,
    } as const;
    const view = render(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-a" }}
      />,
    );
    fireEvent(view.getByTestId("native-webview"), "loadEnd");
    fireEvent(view.getByTestId("native-webview"), "error", {
      nativeEvent: { description: "old connection failed" },
    });
    expect(view.queryByTestId("native-webview")).toBeNull();

    view.rerender(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-b" }}
      />,
    );
    const retiredProps = mockNativeWebViewProps[0]!;
    (retiredProps["onLoadEnd"] as () => void)();
    (
      retiredProps["onError"] as (event: {
        nativeEvent: { description: string };
      }) => void
    )({ nativeEvent: { description: "late retired error" } });
    expect(view.getByTestId("native-webview")).toBeTruthy();
    mockInjectJavaScript.mockClear();
    handle.current?.deliverEnvelope({ id: "new-incarnation" });
    expect(mockInjectJavaScript).not.toHaveBeenCalled();

    fireEvent(view.getByTestId("native-webview"), "loadEnd");
    const envelopeInjections = mockInjectJavaScript.mock.calls.filter(
      ([script]) => String(script).includes("deliverEnvelope"),
    );
    expect(envelopeInjections).toHaveLength(1);
    expect(envelopeInjections[0]?.[0]).toContain("new-incarnation");
  });

  it("retains queued envelopes across a URL change within one incarnation", () => {
    const handle = React.createRef<PanelWebViewHandle>();
    const panelInit = {
      entityId: "panel:nav-one",
      connectionId: "conn-a",
    };
    const view = render(
      <PanelWebView
        ref={handle}
        browserProfile="test-account/workspace"
        panelId="panel:tree/panels~chat/one"
        url="https://panel.test/one"
        visible
        managed
        panelInit={panelInit}
      />,
    );
    handle.current?.deliverEnvelope({ id: "survives-navigation" });
    view.rerender(
      <PanelWebView
        ref={handle}
        browserProfile="test-account/workspace"
        panelId="panel:tree/panels~chat/one"
        url="https://panel.test/two"
        visible
        managed
        panelInit={panelInit}
      />,
    );
    fireEvent(view.getByTestId("native-webview"), "loadEnd");
    expect(
      mockInjectJavaScript.mock.calls.some(([script]) =>
        String(script).includes("survives-navigation"),
      ),
    ).toBe(true);
  });

  it("does not deliver a retired document's delayed bridge result", async () => {
    const bridgeResolvers: Array<(value: unknown) => void> = [];
    const onBridgeCall = jest.fn(
      () => new Promise((resolve) => bridgeResolvers.push(resolve)),
    );
    const common = {
      browserProfile: "test-account/workspace",
      panelId: "panel:tree/panels~chat/one",
      url: "https://panel.test/entry.js",
      visible: true,
      managed: true,
      onBridgeCall,
    } as const;
    const view = render(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-a" }}
      />,
    );
    const retiredProps = mockNativeWebViewProps[0]!;
    await (
      retiredProps["onMessage"] as (event: {
        nativeEvent: { data: string; url: string };
      }) => void
    )({
      nativeEvent: {
        url: common.url,
        data: JSON.stringify({
          __vibestudioBridge: true,
          id: "old-call",
          method: "snapshot",
        }),
      },
    });
    view.rerender(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-b" }}
      />,
    );
    view.rerender(
      <PanelWebView
        {...common}
        panelInit={{ entityId: "panel:nav-one", connectionId: "conn-a" }}
      />,
    );
    bridgeResolvers[0]?.({ stale: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      mockInjectJavaScript.mock.calls.some(([script]) =>
        String(script).includes("old-call"),
      ),
    ).toBe(false);

    const currentProps = mockNativeWebViewProps.at(-1)!;
    (
      currentProps["onMessage"] as (event: {
        nativeEvent: { data: string; url: string };
      }) => void
    )({
      nativeEvent: {
        url: common.url,
        data: JSON.stringify({
          __vibestudioBridge: true,
          id: "unmounted-call",
          method: "snapshot",
        }),
      },
    });
    view.unmount();
    bridgeResolvers[1]?.({ stale: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      mockInjectJavaScript.mock.calls.some(([script]) =>
        String(script).includes("unmounted-call"),
      ),
    ).toBe(false);
  });
});
