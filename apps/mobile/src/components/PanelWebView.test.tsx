import { render } from "@testing-library/react-native";
import { PanelWebView } from "./PanelWebView";

jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    WebView: React.forwardRef((props: Record<string, unknown>, _ref) => (
      <View {...props} testID="native-webview" />
    )),
  };
});

jest.mock("../services/nativeCapabilities", () => ({
  openExternalUrl: jest.fn(async () => undefined),
}));

describe("PanelWebView lifecycle", () => {
  it("does not report an unmount when the callback identity changes", () => {
    const first = jest.fn();
    const latest = jest.fn();
    const view = render(
      <PanelWebView
        panelId="panel:tree/panels~chat/one"
        url="about:blank"
        visible
        managed={false}
        onUnmount={first}
      />
    );

    view.rerender(
      <PanelWebView
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
});
