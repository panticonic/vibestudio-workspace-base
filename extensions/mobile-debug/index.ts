import type { ExtensionContext } from "@vibestudio/extension";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/mobile-debug": Api;
  }
}

/** Userland presentation for the installed host's native mobile executor. */
export async function activate(ctx: ExtensionContext) {
  const call = <T>(method: string, ...args: unknown[]) =>
    ctx.rpc.call<T>("main", `mobileNative.${method}`, ...args);
  const stream = (method: string, arg: unknown) =>
    ctx.rpc.stream("main", `mobileNative.${method}`, [arg]);
  ctx.health.healthy({
    summary: "Host mobile executor available through reviewed RPC",
  });

  return {
    doctor: () => call("doctor"),
    listDevices: () => call("listDevices"),
    listIosSimulators: () => call("listIosSimulators"),
    buildAndroid: (input?: { device?: string; architectures?: string[] }) =>
      call("buildAndroid", input),
    installAndroid: (input?: {
      device?: string;
      resetApp?: boolean;
      launch?: boolean;
    }) => call("installAndroid", input),
    installIos: (input?: {
      device?: string;
      simulator?: boolean;
      configuration?: "Debug" | "Release" | "Internal";
      launch?: boolean;
    }) => call("installIos", input),
    launchAndroid: (input?: { device?: string; packageName?: string }) =>
      call("launchAndroid", input),
    launchIos: (input?: { device?: string; bundleId?: string }) =>
      call("launchIos", input),
    clearAndroidApp: (input?: { device?: string; packageName?: string }) =>
      call("clearAndroidApp", input),
    adbReverse: (input: { device?: string; ports: Array<[number, number]> }) =>
      call("adbReverse", input),
    screenshot: (input?: { device?: string }) => call("screenshot", input),
    screenshotIos: (input?: { device?: string }) =>
      call("screenshotIos", input),
    verify: (input?: { device?: string; packageName?: string }) =>
      call("verify", input),
    verifyWorkspaceReady: (input?: {
      device?: string;
      packageName?: string;
      sinceMs?: number;
      timeoutMs?: number;
    }) => call("verifyWorkspaceReady", input),
    logcat: (input?: {
      device?: string;
      packageName?: string;
      filter?: string;
    }) => stream("logcat", input),
    logsIos: (input?: { device?: string; predicate?: string }) =>
      stream("logsIos", input),
    shell: (input: { device?: string; command: string; args?: string[] }) =>
      stream("shell", input),
  };
}
