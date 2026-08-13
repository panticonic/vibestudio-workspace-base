import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@vibestudio/extension";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/mobile-debug": Api;
  }
}

const defaultPackage = "app.vibestudio.mobile.internal";
const supportedAndroidAbis = new Set([
  "arm64-v8a",
  "armeabi-v7a",
  "x86_64",
  "x86",
]);

class MobileDebugError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MobileDebugError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function activate(ctx: ExtensionContext) {
  const workspace = await ctx.workspace.getInfo();
  if (!path.isAbsolute(workspace.path)) {
    throw new MobileDebugError(
      "EBUILD",
      "Workspace source root must be absolute",
    );
  }
  const sourceRoot = path.normalize(workspace.path);
  if (!isMobileSourceRoot(sourceRoot)) {
    ctx.health.degraded({
      summary: "Mobile debug activated without a Vibestudio repo root",
      reasons: [
        "Build and install helpers require a checkout containing apps/mobile/android.",
      ],
    });
  }
  return {
    async doctor() {
      const adb = await hasCommand(sourceRoot, "adb");
      const xcrun = await hasCommand(sourceRoot, "xcrun");
      const xcodebuild = await hasCommand(sourceRoot, "xcodebuild");
      const devices = adb ? await listAdbDevices(sourceRoot) : [];
      const simulators = xcrun
        ? await listIosSimulators(sourceRoot).catch(() => [])
        : [];
      const ready = devices.filter((device) => device.state === "device");
      const repoRoot = isMobileSourceRoot(sourceRoot) ? sourceRoot : null;
      const apkPath = repoRoot ? defaultApkPath(repoRoot) : null;
      const issues: string[] = [];
      if (!repoRoot)
        issues.push(
          "Could not locate Vibestudio repo root containing apps/mobile/android",
        );
      if (!adb) issues.push("adb is not on PATH");
      if (process.platform === "darwin") {
        if (!xcrun) issues.push("xcrun is not on PATH");
        if (!xcodebuild) issues.push("xcodebuild is not on PATH");
        if (
          simulators.filter((device) => device.state === "Booted").length === 0
        )
          issues.push("No booted iOS simulator");
      }
      if (devices.some((device) => device.state === "unauthorized"))
        issues.push("Accept the Android USB debugging prompt");
      if (ready.length === 0) issues.push("No ready Android device");
      if (ready.length > 1)
        issues.push("Multiple ready devices; pass a serial");
      if (apkPath && !fs.existsSync(apkPath))
        issues.push("Internal APK has not been built");
      let deviceAbi: string | null = null;
      if (ready[0]) {
        try {
          deviceAbi = await readAndroidDeviceAbi(sourceRoot, ready[0].serial);
        } catch (error) {
          issues.push(
            `Could not determine Android device ABI: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return {
        adb,
        xcrun,
        xcodebuild,
        device: ready[0],
        deviceAbi,
        iosSimulator: simulators.find((device) => device.state === "Booted"),
        apkSigned: !!apkPath && fs.existsSync(apkPath),
        apkBytes:
          apkPath && fs.existsSync(apkPath) ? fs.statSync(apkPath).size : null,
        issues,
      };
    },

    async listDevices() {
      return listAdbDevices(sourceRoot);
    },

    async listIosSimulators() {
      return listIosSimulators(sourceRoot);
    },

    async buildAndroid(raw?: {
      variant?: "internal" | "release";
      device?: string;
      architectures?: string[];
    }) {
      const repoRoot = requireMobileSourceRoot(sourceRoot);
      const started = Date.now();
      const variant = raw?.variant ?? "internal";
      const gradleTask =
        variant === "release" ? "assembleRelease" : "assembleInternal";
      let architectures = validateAndroidArchitectures(raw?.architectures);
      if (architectures.length === 0 && raw?.device) {
        architectures = [await readAndroidDeviceAbi(sourceRoot, raw.device)];
      }
      const apkPath =
        variant === "release"
          ? path.join(
              repoRoot,
              "apps",
              "mobile",
              "android",
              "app",
              "build",
              "outputs",
              "apk",
              "release",
              "app-release.apk",
            )
          : defaultApkPath(repoRoot);
      await run(
        path.join(repoRoot, "apps", "mobile", "android", "gradlew"),
        [
          gradleTask,
          "--no-daemon",
          "--max-workers=2",
          "-Pkotlin.compiler.execution.strategy=in-process",
          ...(architectures.length > 0
            ? [`-PreactNativeArchitectures=${architectures.join(",")}`]
            : []),
        ],
        {
          cwd: path.join(repoRoot, "apps", "mobile", "android"),
          errorCode: "EBUILD",
        },
      );
      return {
        apkPath,
        apkBytes: fs.statSync(apkPath).size,
        architectures,
        durationMs: Date.now() - started,
      };
    },

    async installAndroid(raw?: {
      device?: string;
      resetApp?: boolean;
      launch?: boolean;
    }) {
      const repoRoot = requireMobileSourceRoot(sourceRoot);
      const args = [
        "--from-source",
        "--package",
        defaultPackage,
        raw?.resetApp ? "--reset-app" : null,
        raw?.launch ? "--launch" : null,
        raw?.device ? "--device" : null,
        raw?.device ?? null,
      ].filter((value): value is string => !!value);
      const script = path.join(
        repoRoot,
        "scripts",
        "cli",
        "mobile-install.mjs",
      );
      await run(process.execPath, [script, ...args], { cwd: repoRoot });
      return { packageName: defaultPackage };
    },

    async installIos(raw?: {
      device?: string;
      simulator?: boolean;
      configuration?: "Debug" | "Release" | "Internal";
      launch?: boolean;
    }) {
      const repoRoot = requireMobileSourceRoot(sourceRoot);
      const script = path.join(
        repoRoot,
        "scripts",
        "cli",
        "mobile-install.mjs",
      );
      const args = [
        "--platform",
        "ios",
        raw?.simulator !== false ? "--simulator" : null,
        raw?.device ? "--device" : null,
        raw?.device ?? null,
        "--configuration",
        raw?.configuration ?? "Debug",
        raw?.launch ? "--launch" : null,
      ].filter((value): value is string => !!value);
      await run(process.execPath, [script, ...args], {
        cwd: repoRoot,
        errorCode: "EBUILD",
      });
      return {
        bundleId:
          process.env["VIBESTUDIO_IOS_BUNDLE_ID"] ?? "app.vibestudio.mobile",
      };
    },

    async launchAndroid(raw?: { device?: string; packageName?: string }) {
      await adb(sourceRoot, raw?.device, [
        "shell",
        "monkey",
        "-p",
        raw?.packageName ?? defaultPackage,
        "1",
      ]);
    },

    async launchIos(raw?: { device?: string; bundleId?: string }) {
      requireMac("launch iOS apps");
      const bundleId =
        raw?.bundleId ??
        process.env["VIBESTUDIO_IOS_BUNDLE_ID"] ??
        "app.vibestudio.mobile";
      if (raw?.device) {
        await run(
          "xcrun",
          [
            "devicectl",
            "device",
            "process",
            "launch",
            "--device",
            raw.device,
            bundleId,
          ],
          {
            cwd: sourceRoot,
            errorCode: "EIOS",
          },
        );
      } else {
        await run("xcrun", ["simctl", "launch", "booted", bundleId], {
          cwd: sourceRoot,
          errorCode: "EIOS",
        });
      }
    },

    async clearAndroidApp(raw?: { device?: string; packageName?: string }) {
      const packageName = raw?.packageName ?? defaultPackage;
      await adb(sourceRoot, raw?.device, ["shell", "pm", "clear", packageName]);
    },

    async adbReverse(raw: { device?: string; ports: Array<[number, number]> }) {
      for (const [devicePort, hostPort] of raw.ports) {
        await adb(sourceRoot, raw.device, [
          "reverse",
          `tcp:${devicePort}`,
          `tcp:${hostPort}`,
        ]);
      }
    },

    async screenshot(raw?: { device?: string }) {
      const result = await adbCapture(sourceRoot, raw?.device, [
        "exec-out",
        "screencap",
        "-p",
      ]);
      return {
        pngBase64: Buffer.from(result.stdout, "binary").toString("base64"),
      };
    },

    async screenshotIos(raw?: { device?: string }) {
      requireMac("capture iOS screenshots");
      const args = ["simctl", "io", raw?.device ?? "booted", "screenshot", "-"];
      const result = await runCapture("xcrun", args, {
        cwd: sourceRoot,
        encoding: "binary",
        errorCode: "EIOS",
      });
      if (result.exitCode !== 0)
        throw new MobileDebugError("EIOS", result.stderr || result.stdout);
      return {
        pngBase64: Buffer.from(result.stdout, "binary").toString("base64"),
      };
    },

    async verify(raw?: { device?: string; packageName?: string }) {
      const devices = await listAdbDevices(sourceRoot);
      const device = pickDevice(devices, raw?.device);
      const packageName = raw?.packageName ?? defaultPackage;
      const packageInstalled = await adbExitOk(sourceRoot, device.serial, [
        "shell",
        "pm",
        "path",
        packageName,
      ]);
      const issues: string[] = packageInstalled
        ? []
        : [`${packageName} is not installed`];
      const rendering = packageInstalled
        ? await adbExitOk(sourceRoot, device.serial, [
            "shell",
            "pidof",
            packageName,
          ])
        : false;
      let screenshot: Awaited<ReturnType<typeof adbCapture>> | null = null;
      if (rendering) {
        try {
          screenshot = await adbCapture(sourceRoot, device.serial, [
            "exec-out",
            "screencap",
            "-p",
          ]);
        } catch (error) {
          issues.push(
            `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return {
        installed: packageInstalled,
        bundleActive: rendering,
        rendering,
        screenshotCaptured: screenshot !== null,
        screenshotBytes: screenshot
          ? Buffer.byteLength(screenshot.stdout, "binary")
          : 0,
        issues,
      };
    },

    async verifyWorkspaceReady(raw?: {
      device?: string;
      packageName?: string;
      sinceMs?: number;
      timeoutMs?: number;
    }) {
      const devices = await listAdbDevices(sourceRoot);
      const device = pickDevice(devices, raw?.device);
      const packageName = raw?.packageName ?? defaultPackage;
      const sinceMs = raw?.sinceMs ?? Date.now() - 300_000;
      const timeoutMs = Math.min(
        Math.max(raw?.timeoutMs ?? 180_000, 1_000),
        300_000,
      );
      const deadline = Date.now() + timeoutMs;
      let last = workspaceReadinessFromLog("", sinceMs);
      let readySince: number | null = null;

      while (readySince !== null || Date.now() < deadline) {
        if (readySince !== null && Date.now() - readySince >= 20_000)
          return last;
        const pid = await adbCapture(sourceRoot, device.serial, [
          "shell",
          "pidof",
          packageName,
        ])
          .then((result) => result.stdout.trim().split(/\s+/u)[0])
          .catch(() => undefined);
        if (!pid) {
          last = {
            ...last,
            issues: [`${packageName} is not rendering`],
          };
        } else {
          const logs = await adbCapture(sourceRoot, device.serial, [
            "logcat",
            "-d",
            `--pid=${pid}`,
            "-v",
            "epoch",
            "ReactNativeJS:V",
            "chromium:V",
            "*:S",
          ]);
          last = workspaceReadinessFromLog(logs.stdout, sinceMs);
          if (last.issues.length > 0) return last;
          if (last.ready) {
            readySince ??= Date.now();
            // Readiness markers describe completed startup work, but an ICE
            // transition can still reject the just-finished RPC moments later.
            // Reaching ready within the caller's deadline earns one full
            // reconnect grace window. Do not charge that stability check to
            // the cold-start budget or return ready=true with a timeout issue.
          } else {
            readySince = null;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      return {
        ...last,
        issues:
          last.issues.length > 0
            ? last.issues
            : [
                "The mobile workspace did not become ready before the verification timeout",
              ],
      };
    },

    logcat(raw?: { device?: string; packageName?: string; filter?: string }) {
      const args = raw?.packageName
        ? ["shell", "pidof", raw.packageName]
        : null;
      const streamArgs = raw?.filter
        ? ["logcat", "-v", "time", raw.filter]
        : ["logcat", "-v", "time"];
      return streamAdb(sourceRoot, raw?.device, args, streamArgs);
    },

    logsIos(raw?: { device?: string; predicate?: string }) {
      requireMac("stream iOS simulator logs");
      return streamProcess(sourceRoot, "xcrun", [
        "simctl",
        "spawn",
        raw?.device ?? "booted",
        "log",
        "stream",
        "--style",
        "compact",
        "--predicate",
        raw?.predicate ?? 'process == "Vibestudio"',
      ]);
    },

    async shell(raw: { device?: string; command: string; args?: string[] }) {
      return streamProcess(
        sourceRoot,
        "adb",
        adbArgs(raw.device, ["shell", raw.command, ...(raw.args ?? [])]),
      );
    },
  };
}

export function workspaceReadinessFromLog(log: string, sinceMs = 0) {
  const relevant = log
    .split(/\r?\n/u)
    .filter((line) => {
      const timestamp = /^(\d+(?:\.\d+)?)\s/u.exec(line)?.[1];
      return !timestamp || Number(timestamp) * 1000 >= sinceMs;
    })
    .join("\n");
  const panelHostReady = relevant.includes(
    "phase=workspace-panels-initialized",
  );
  const workspaceConnected = relevant.includes("phase=workspace-connected");
  const panelWebViewLoaded = relevant.includes(
    "phase=workspace-panel-webview-loaded",
  );
  const failure = relevant.match(
    /invalid distance code|phase=workspace-(?:login-error|panel-webview-error|panel-webview-http-error|panel-activate-failed)[^\r\n]*/iu,
  )?.[0];
  return {
    ready: panelHostReady && workspaceConnected && !failure,
    workspaceConnected,
    panelHostReady,
    panelWebViewLoaded,
    issues: failure ? [failure] : [],
  };
}
async function listAdbDevices(
  sourceRoot: string,
): Promise<
  Array<{
    serial: string;
    state: "device" | "unauthorized" | "offline";
    model?: string;
  }>
> {
  const result = await adbCapture(sourceRoot, undefined, ["devices", "-l"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, stateRaw] = line.split(/\s+/, 2);
      const model = line.match(/\bmodel:([^\s]+)/)?.[1];
      const state =
        stateRaw === "device" || stateRaw === "unauthorized"
          ? stateRaw
          : "offline";
      return { serial: serial!, state, ...(model ? { model } : {}) };
    });
}

function pickDevice(
  devices: Array<{ serial: string; state: string }>,
  requested?: string,
) {
  if (requested) {
    const match = devices.find((device) => device.serial === requested);
    if (!match)
      throw new MobileDebugError("ENODEVICE", `adb does not see ${requested}`);
    if (match.state !== "device")
      throw new MobileDebugError(
        "EUNAUTHORIZED",
        `${requested} is ${match.state}`,
      );
    return match;
  }
  const ready = devices.filter((device) => device.state === "device");
  if (
    ready.length === 0 &&
    devices.some((device) => device.state === "unauthorized")
  ) {
    throw new MobileDebugError(
      "EUNAUTHORIZED",
      "Accept the Android USB debugging prompt",
    );
  }
  if (ready.length === 0)
    throw new MobileDebugError("ENODEVICE", "No ready Android device");
  if (ready.length > 1)
    throw new MobileDebugError(
      "ENODEVICE",
      "Multiple Android devices; pass a serial",
    );
  return ready[0]!;
}

export function validateAndroidArchitectures(
  value: string[] | undefined,
): string[] {
  if (!value) return [];
  const unique = [...new Set(value)];
  for (const abi of unique) {
    if (!supportedAndroidAbis.has(abi)) {
      throw new MobileDebugError(
        "EABI",
        `Unsupported Android ABI ${JSON.stringify(abi)}; expected ${[
          ...supportedAndroidAbis,
        ].join(", ")}`,
      );
    }
  }
  return unique;
}

async function readAndroidDeviceAbi(
  sourceRoot: string,
  device: string,
): Promise<string> {
  const result = await adbCapture(sourceRoot, device, [
    "shell",
    "getprop",
    "ro.product.cpu.abi",
  ]);
  const abi = result.stdout.trim();
  validateAndroidArchitectures([abi]);
  return abi;
}

function requireMac(action: string): void {
  if (process.platform !== "darwin") {
    throw new MobileDebugError(
      "EIOS_PLATFORM",
      `${action} requires macOS with Xcode`,
    );
  }
}

async function listIosSimulators(
  sourceRoot: string,
): Promise<
  Array<{ udid: string; name: string; state: string; runtime: string }>
> {
  requireMac("list iOS simulators");
  const result = await runCapture(
    "xcrun",
    ["simctl", "list", "devices", "--json"],
    {
      cwd: sourceRoot,
      errorCode: "EIOS",
    },
  );
  if (result.exitCode !== 0) {
    throw new MobileDebugError(
      "EIOS",
      result.stderr || result.stdout || "simctl list failed",
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    devices?: Record<
      string,
      Array<{ udid?: string; name?: string; state?: string }>
    >;
  };
  const out: Array<{
    udid: string;
    name: string;
    state: string;
    runtime: string;
  }> = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    for (const device of devices) {
      if (!device.udid || !device.name || !device.state) continue;
      out.push({
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtime,
      });
    }
  }
  return out;
}

function adbArgs(device: string | undefined, args: string[]): string[] {
  return device ? ["-s", device, ...args] : args;
}

async function adb(
  sourceRoot: string,
  device: string | undefined,
  args: string[],
) {
  await run("adb", adbArgs(device, args), { cwd: sourceRoot });
}

async function adbExitOk(
  sourceRoot: string,
  device: string | undefined,
  args: string[],
): Promise<boolean> {
  const result = await runCapture("adb", adbArgs(device, args), {
    cwd: sourceRoot,
    reject: false,
  });
  return result.exitCode === 0;
}

async function adbCapture(
  sourceRoot: string,
  device: string | undefined,
  args: string[],
) {
  const result = await runCapture("adb", adbArgs(device, args), {
    cwd: sourceRoot,
    encoding: "binary",
  });
  if (result.exitCode !== 0)
    throw new MobileDebugError(
      "EADB",
      result.stderr || result.stdout || "adb failed",
    );
  return result;
}

async function hasCommand(
  sourceRoot: string,
  command: string,
): Promise<boolean> {
  try {
    const result = await runCapture(command, ["version"], {
      cwd: sourceRoot,
      reject: false,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; errorCode?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: "ignore",
    });
    const errorCode = opts.errorCode ?? "EADB";
    child.on("error", (error) =>
      reject(new MobileDebugError(errorCode, error.message)),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new MobileDebugError(
              errorCode,
              `${command} ${args.join(" ")} exited ${code}`,
            ),
          ),
    );
  });
}

function runCapture(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    reject?: boolean;
    encoding?: BufferEncoding;
    errorCode?: string;
  },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errorCode = opts.errorCode ?? "EADB";
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) =>
      reject(new MobileDebugError(errorCode, error.message)),
    );
    child.on("exit", (code) => {
      const result = {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString(opts.encoding ?? "utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 || opts.reject === false) resolve(result);
      else
        reject(
          new MobileDebugError(
            errorCode,
            result.stderr || result.stdout || `${command} failed`,
          ),
        );
    });
  });
}

function streamAdb(
  sourceRoot: string,
  device: string | undefined,
  pidProbeArgs: string[] | null,
  streamArgs: string[],
): Response {
  if (!pidProbeArgs)
    return streamProcess(sourceRoot, "adb", adbArgs(device, streamArgs));
  return streamAdbAfterPidProbe(sourceRoot, device, pidProbeArgs, streamArgs);
}

function streamAdbAfterPidProbe(
  sourceRoot: string,
  device: string | undefined,
  pidProbeArgs: string[],
  streamArgs: string[],
): Response {
  const encoder = new TextEncoder();
  let child: ReturnType<typeof spawn> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const probe = spawn("adb", adbArgs(device, pidProbeArgs), {
        cwd: sourceRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = probe;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      probe.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      probe.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      probe.on("error", (err) => controller.error(err));
      probe.on("exit", (code) => {
        if (cancelled) return;
        const pid = firstPid(Buffer.concat(stdout).toString("utf8"));
        if (code !== 0 || !pid) {
          const message =
            Buffer.concat(stderr).toString("utf8").trim() ||
            "package process is not running";
          controller.enqueue(encoder.encode(`${message}\n`));
          controller.close();
          return;
        }
        const scopedArgs = pidScopedLogcatArgs(streamArgs, pid);
        const streamChild = spawn("adb", adbArgs(device, scopedArgs), {
          cwd: sourceRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = streamChild;
        streamChild.stdout?.on("data", (chunk) =>
          controller.enqueue(Buffer.from(chunk)),
        );
        streamChild.stderr?.on("data", (chunk) =>
          controller.enqueue(encoder.encode(String(chunk))),
        );
        streamChild.on("error", (err) => controller.error(err));
        streamChild.on("exit", () => controller.close());
      });
    },
    cancel() {
      cancelled = true;
      child?.kill("SIGTERM");
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/octet-stream" },
  });
}

export function pidScopedLogcatArgs(
  streamArgs: string[],
  pid: string,
): string[] {
  if (streamArgs[0] !== "logcat") return streamArgs;
  return ["logcat", `--pid=${pid}`, ...streamArgs.slice(1)];
}

function firstPid(raw: string): string | null {
  return raw.split(/\s+/).find((part) => /^\d+$/.test(part)) ?? null;
}

function streamProcess(
  sourceRoot: string,
  command: string,
  args: string[],
): Response {
  const encoder = new TextEncoder();
  const child = spawn(command, args, {
    cwd: sourceRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout?.on("data", (chunk) =>
        controller.enqueue(Buffer.from(chunk)),
      );
      child.stderr?.on("data", (chunk) =>
        controller.enqueue(encoder.encode(String(chunk))),
      );
      child.on("error", (err) => controller.error(err));
      child.on("exit", () => controller.close());
    },
    cancel() {
      child.kill("SIGTERM");
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/octet-stream" },
  });
}

function requireMobileSourceRoot(sourceRoot: string): string {
  if (!isMobileSourceRoot(sourceRoot)) {
    throw new MobileDebugError(
      "EBUILD",
      `Workspace source root does not contain apps/mobile/android: ${sourceRoot}`,
    );
  }
  return sourceRoot;
}

function isMobileSourceRoot(sourceRoot: string): boolean {
  return fs.existsSync(path.join(sourceRoot, "apps", "mobile", "android"));
}

function defaultApkPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    "apps",
    "mobile",
    "android",
    "app",
    "build",
    "outputs",
    "apk",
    "internal",
    "app-internal.apk",
  );
}
