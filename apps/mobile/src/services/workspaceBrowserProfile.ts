import {
  Platform,
  NativeModules,
  UIManager,
  requireNativeComponent,
} from "react-native";
import type { WebViewProps } from "react-native-webview";
import type { NativeProps } from "react-native-webview/lib/RNCWebViewNativeComponent";
import type { HostComponent } from "react-native";

import type { NativeBrowserPermissionRequest } from "./workspaceBrowserPermission";

const COMPONENT = "VibestudioWorkspaceWebView";
let nativeComponent: HostComponent<NativeProps> | null = null;

/** Account and workspace are captured before a native browser view is created. */
export function workspaceBrowserProfile(
  accountScope: string,
  workspaceId: string,
): string {
  if (!accountScope || !workspaceId)
    throw new Error("A workspace browser identity is required");
  return JSON.stringify([accountScope, workspaceId]);
}

/** No shared-profile fallback: profile support is a native hosting requirement. */
export function workspaceWebViewConfig(
  scope: string,
  onWorkspacePermission?: (event: {
    nativeEvent: NativeBrowserPermissionRequest & { cancelled?: boolean };
  }) => void,
): NonNullable<WebViewProps["nativeConfig"]> {
  const native = UIManager.getViewManagerConfig(COMPONENT) as {
    Constants?: { profilesSupported?: boolean };
  } | null;
  if (!native?.Constants?.["profilesSupported"]) {
    throw new Error(
      Platform.OS === "android"
        ? "Update Android System WebView and Vibestudio to open isolated workspace panels."
        : "This workspace needs Vibestudio for iOS 17 or later.",
    );
  }
  if (!scope) throw new Error("A workspace browser identity is required");
  return {
    component: (nativeComponent ??=
      requireNativeComponent<NativeProps>(COMPONENT)),
    props: {
      workspaceProfile: scope,
      ...(onWorkspacePermission ? { onWorkspacePermission } : {}),
    },
  };
}

/** This device's exact profile, independent of the server's browser vault. */
export async function clearWorkspaceCookies(
  accountScope: string,
  workspaceId: string,
): Promise<void> {
  const scope = workspaceBrowserProfile(accountScope, workspaceId);
  await NativeModules["VibestudioMobileHost"].clearWorkspaceCookies(scope);
}
