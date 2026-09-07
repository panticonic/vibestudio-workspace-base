import { NativeModules, UIManager, requireNativeComponent } from "react-native";
import {
  clearWorkspaceCookies,
  workspaceBrowserProfile,
  workspaceWebViewConfig,
} from "./workspaceBrowserProfile";

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: {
    VibestudioMobileHost: {
      clearWorkspaceCookies: jest.fn(async () => undefined),
    },
  },
  UIManager: { getViewManagerConfig: jest.fn() },
  requireNativeComponent: jest.fn(() => "WorkspaceWebView"),
}));

describe("workspace browser profiles", () => {
  it("separates identical workspace names across accounts without ambiguous delimiters", () => {
    expect(workspaceBrowserProfile("server/account-a", "shared")).not.toBe(
      workspaceBrowserProfile("server/account-b", "shared"),
    );
    expect(workspaceBrowserProfile("a:b", "c")).not.toBe(
      workspaceBrowserProfile("a", "b:c"),
    );
    expect(() => workspaceBrowserProfile("account", "")).toThrow("identity");
  });

  it("refuses a shared browser fallback when native profiles are unavailable", () => {
    jest.mocked(UIManager.getViewManagerConfig).mockReturnValue(null as never);
    expect(() => workspaceWebViewConfig("account/workspace")).toThrow(
      "Update Android System WebView",
    );
    expect(requireNativeComponent).not.toHaveBeenCalled();
  });

  it("registers the native component once and captures a separate immutable scope for each view", () => {
    jest
      .mocked(UIManager.getViewManagerConfig)
      .mockReturnValue({ Constants: { profilesSupported: true } } as never);
    const first = workspaceWebViewConfig(
      workspaceBrowserProfile("account", "a"),
    );
    const second = workspaceWebViewConfig(
      workspaceBrowserProfile("account", "b"),
    );
    expect(first.component).toBe(second.component);
    expect(first.props).toEqual({ workspaceProfile: '["account","a"]' });
    expect(second.props).toEqual({ workspaceProfile: '["account","b"]' });
    expect(requireNativeComponent).toHaveBeenCalledTimes(1);
  });
});

it("clears only the captured profile and rejects missing scope before native access", async () => {
  const clear = jest.mocked(
    NativeModules["VibestudioMobileHost"].clearWorkspaceCookies,
  );
  await clearWorkspaceCookies("server-a:device-a", "project");
  expect(clear).toHaveBeenCalledWith('["server-a:device-a","project"]');
  await expect(clearWorkspaceCookies("", "project")).rejects.toThrow(
    "identity",
  );
  expect(clear).toHaveBeenCalledTimes(1);
});
