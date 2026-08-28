/**
 * local-models extension — installs and supervises llama.cpp, serves local
 * GGUF models to the agent harness as the `local` provider, and guarantees
 * the LFM2.5 fallback floor (design: docs/local-models-extension-design.md).
 *
 * Extension-owned engine pattern (git-bridge precedent): all operational
 * logic lives here; the host only forwards events and the model-settings
 * worker only projects `listModels()` into the catalog.
 *
 * Modules: hardware.ts (probe) · engine.ts (llama.cpp install) · library.ts
 * (GGUF library/downloads) · supervisor.ts (servers + single-owner lock).
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CuratedModel,
  DownloadJob,
  EnginePin,
  EngineState,
  HardwareProfile,
  LocalModelEntry,
  LocalModelsCapabilities,
  LocalModelsEvent,
  LocalModelsStatus,
  ModelRecord,
  ModelRuntimeConfig,
  ServerKind,
  ServerState,
} from "@workspace/model-catalog/localModels";
import { createHardwareProfiler } from "./hardware.js";
import { createEngineInstaller } from "./engine.js";
import { createModelLibrary, estimateFit, isCurrentFallbackRecord } from "./library.js";
import { createServerSupervisor } from "./supervisor.js";
import { runtimeContextLengthFor } from "./runtime-profiles.js";
import { runModelBenchmark } from "./benchmark.js";
import { DEFAULT_MODEL, FALLBACK_MODEL, ROOT_LAYOUT } from "./constants.js";

/**
 * Pinned llama.cpp build (design §4.2, risk #3): bumped with extension
 * updates, validated by the e2e suite on every bump. Every installable release
 * asset must have a pinned checksum; missing checksums fail closed before
 * extraction/execution.
 */
const ENGINE_PIN: EnginePin = {
  buildTag: "b10621", // llama.cpp v0.3.0, published 2026-08-25
  checksums: {
    "cudart-llama-bin-win-cuda-12.4-x64.zip":
      "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    "cudart-llama-bin-win-cuda-13.3-x64.zip":
      "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
    "llama-b10621-bin-macos-arm64.tar.gz":
      "429c8270608600188035e5e92f7d78dffb7900904fe7dd7e6a84f48068cd13cf",
    "llama-b10621-bin-macos-x64.tar.gz":
      "33c44e036e0e223f71a29fc74a0ab3e130ca9eadeb032ecc1c7af25985b8b91b",
    "llama-b10621-bin-ubuntu-arm64.tar.gz":
      "95940151be63492f70f659da420b268244cc83a6ee70e310d2600ccdb7ea4deb",
    "llama-b10621-bin-ubuntu-rocm-7.14-x64.tar.gz":
      "aa0b3b566f8e61d3a0c00b41ad6ca5aac4fb0e31d23bc4dc249f7040901d3794",
    "llama-b10621-bin-ubuntu-vulkan-arm64.tar.gz":
      "1267a0e918c37be5ef568b37f9a5de377e47cbe1ea77d4d42e38a20dfff1b358",
    "llama-b10621-bin-ubuntu-vulkan-x64.tar.gz":
      "3db8e4411033ef4531072be43377e859bcdbf9640c7bb36f9656e538eabd0978",
    "llama-b10621-bin-ubuntu-x64.tar.gz":
      "91d7b03ddae498a39f28fdb85d84d2b4a0fd3838d10b4f897e0ef8975bb9b583",
    "llama-b10621-bin-win-cpu-arm64.zip":
      "c072e8bb057751587243c1e0ed28d82e23c7e0544a426e0d476f1e77792bf3ce",
    "llama-b10621-bin-win-cpu-x64.zip":
      "0e8b65e650e369f70f8307d890508886f171ef4fb00facccddd4a1b7ffdaca51",
    "llama-b10621-bin-win-cuda-12.4-x64.zip":
      "81c2ff62e14b549cd5c766ccdd5c61f09e821a171655c3047bdccfddc2d1a1e2",
    "llama-b10621-bin-win-cuda-13.3-x64.zip":
      "23549ccc00b6a18d74348e95d4789f7e96c9efb11cf6e3f1b185baef34d7449f",
    "llama-b10621-bin-win-opencl-adreno-arm64.zip":
      "46e551fc6a4b1074cda5e0fcff20712e83ece24194d431d677bf99db20e487e0",
    "llama-b10621-bin-win-rocm-7.14-x64.zip":
      "4d9549449ae0d1c3d81446e440623b8fcaf117cff4f0a8ade991f428d9b086e9",
    "llama-b10621-bin-win-vulkan-x64.zip":
      "2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163",
  },
};

const BENCHMARK_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Curated, hardware-tier-filtered starter catalog (design §4.3). Hashes are
 *  trust-on-first-download until pinned here. */
const CURATED_CATALOG: CuratedModel[] = [
  {
    slug: FALLBACK_MODEL.slug,
    displayName: FALLBACK_MODEL.displayName,
    hfRepo: FALLBACK_MODEL.hfRepo,
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q5_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
      "cpu-min": "Q4_K_M",
    },
    sha256ByQuant: {
      Q4_K_M: "79fdf00351b46cf26f020aead28d01889886be87c55fa0eb907e6f9b00bfee14",
      Q5_K_M: "babb80c3249e1578e47d481bf494844a83b4cbfead6fc614a6450908b0f60c65",
      Q8_0: "36587fdf27bdfc69caf2637273679a0870ec155162161bde6fd16e8c70bdb757",
    },
    toolsCapable: true,
    blurb: "The local agent fallback: compact, tool-capable, and tuned for multi-step work.",
  },
  {
    slug: DEFAULT_MODEL.slug,
    displayName: DEFAULT_MODEL.displayName,
    hfRepo: DEFAULT_MODEL.hfRepo,
    quantByTier: { "gpu-large": DEFAULT_MODEL.quant },
    sha256ByQuant: { [DEFAULT_MODEL.quant]: DEFAULT_MODEL.sha256 },
    toolsCapable: true,
    blurb: "The preferred local agent model for long-horizon coding and tool use.",
  },
  {
    slug: "qwen3.5-4b",
    displayName: "Qwen3.5 4B",
    hfRepo: "unsloth/Qwen3.5-4B-GGUF",
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q5_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
    },
    sha256ByQuant: {
      Q4_K_M: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
      Q5_K_M: "8814232b85594dcd46c50e5b8b29324a7efe9e746edbe8a3d1df3d3fce7aad39",
      Q8_0: "10cc391b403021dd11c614679d2fd92f611c3681d29e29651b717316965d61e1",
    },
    toolsCapable: true,
    blurb: "Compact Qwen agent model for modest GPUs and strong CPUs.",
  },
  {
    slug: "qwen3.5-9b",
    displayName: "Qwen3.5 9B",
    hfRepo: "unsloth/Qwen3.5-9B-GGUF",
    quantByTier: { "gpu-large": "Q8_0", "gpu-mid": "Q4_K_M" },
    sha256ByQuant: {
      Q4_K_M: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
      Q8_0: "809626574d0cb43d4becfa56169980da2bb448f2299270f7be443cb89d0a6ae4",
    },
    toolsCapable: true,
    blurb: "Mid-size Qwen model for GPU-backed agent work.",
  },
  {
    slug: "gpt-oss-20b",
    displayName: "GPT-OSS 20B",
    hfRepo: "ggml-org/gpt-oss-20b-GGUF",
    quantByTier: { "gpu-large": "Q8_0", "gpu-mid": "Q4_K_M" },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "Larger reasoning-capable model; partial offload on mid GPUs.",
  },
];

type BootstrapStage = "idle" | "probing" | "engines" | "ready" | "error";

interface DownloadModelRequest {
  hfRepo: string;
  file: string;
  expectedSha256?: string;
  displayName?: string;
  slug?: string;
}

interface ExtensionInvocationLike {
  caller?: { kind?: string; id?: string };
  userlandCaller?: { kind?: string; id?: string };
}

/** Structural slice of ExtensionContext we use (git-bridge precedent: keep
 *  the extension decoupled from host packages via structural typing). */
interface Ctx {
  log: { info(msg: string, data?: unknown): void; warn?(msg: string, data?: unknown): void };
  emit(event: string, payload: unknown): void;
  health?: {
    healthy(detail?: unknown): void;
    degraded(detail: unknown): void;
    unhealthy(detail: unknown): void;
  };
  invocation?: {
    current(): ExtensionInvocationLike | null;
    signal?(): AbortSignal | null;
  };
  workspace?: { getInfo(): Promise<{ id: string }> };
  subscriptions?: { push(disposable: { dispose(): void }): void };
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/local-models": Api;
  }
}

function defaultRootDir(): string {
  const override = process.env["VIBESTUDIO_LOCAL_MODELS_DIR"];
  if (override && override.trim()) return override.trim();
  // Machine-global by design (§4.3): models/engines are hardware assets, not
  // workspace state. Location is configurable via the panel/env override.
  return path.join(os.homedir(), ".vibestudio", "local-models");
}

const ENV_BLOCKLIST = [/^LD_PRELOAD$/u, /^NODE_OPTIONS$/u, /^DYLD_/u];

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_BLOCKLIST.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  return env;
}

function execAdapter(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> }
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts?.timeoutMs ?? 30_000,
        env: opts?.env ?? cleanEnv(),
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code?: number }).code ?? null)
            : error
              ? null
              : 0;
        resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), code });
      }
    );
  });
}

function spawnAdapter(
  bin: string,
  args: string[],
  opts: {
    env: Record<string, string>;
    onExit(code: number | null): void;
    onStdout(line: string): void;
    onStderr(line: string): void;
  }
): { pid: number; kill(signal?: string): void } {
  const child = nodeSpawn(bin, args, {
    env: { ...cleanEnv(), ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  createInterface({ input: child.stdout }).on("line", opts.onStdout);
  createInterface({ input: child.stderr }).on("line", opts.onStderr);
  child.on("exit", (code) => opts.onExit(code));
  child.on("error", () => opts.onExit(null));
  return {
    pid: child.pid ?? -1,
    kill: (signal?: string) => {
      try {
        child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}

function jsonLineStream<T>(
  subscribe: (push: (value: T) => void, end: (error?: string) => void) => () => void
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = subscribe(
        (value) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)),
        (error) => {
          if (error) controller.enqueue(encoder.encode(`${JSON.stringify({ error })}\n`));
          controller.close();
          cleanup?.();
        }
      );
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

export async function activate(ctx: Ctx) {
  const rootDir = defaultRootDir();
  await fs.mkdir(rootDir, { recursive: true });
  const log = (msg: string, data?: unknown) => ctx.log.info(`local-models: ${msg}`, data);
  const emit = (event: LocalModelsEvent) => {
    try {
      ctx.emit(event.kind, event);
    } catch {
      // host not listening — events are best-effort
    }
  };

  let workspaceId = "unknown";
  try {
    workspaceId = (await ctx.workspace?.getInfo())?.id ?? "unknown";
  } catch {
    // headless/test hosts may not expose workspace info
  }

  // ── module wiring ─────────────────────────────────────────────────────
  let profile: HardwareProfile | null = null;
  let engineState: EngineState | null = null;
  let bootstrapStage: BootstrapStage = "idle";
  let bootstrapError: string | null = null;
  let bootstrapRun: Promise<void> | null = null;

  const profiler = createHardwareProfiler({
    exec: (cmd, args, timeoutMs) => execAdapter(cmd, args, { timeoutMs }),
    readFile: (file) => fs.readFile(file, "utf8"),
    platform: process.platform,
    arch: process.arch,
    totalMemBytes: os.totalmem(),
    cpuCount: os.cpus().length,
    log,
  });

  const engines = createEngineInstaller({
    rootDir,
    fetch: globalThis.fetch,
    exec: execAdapter,
    log,
  });

  const library = createModelLibrary({
    rootDir,
    fetch: globalThis.fetch,
    fallbackSha256: FALLBACK_MODEL.sha256,
    log,
    emit,
    now: () => Date.now(),
  });

  const supervisor = createServerSupervisor({
    rootDir,
    workspaceId,
    spawn: spawnAdapter,
    fetch: globalThis.fetch,
    log,
    emit: (event) => {
      emit(event);
      if (event.kind === "server.state") reportHealth();
    },
    engines: () => engineState,
    fallbackModel: () => library.get(FALLBACK_MODEL.slug),
    libraryModel: (slug) => library.get(slug),
    libraryModels: () => library.list(),
    now: () => Date.now(),
    killPid: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    },
  });

  /** Health reflects the readiness to *serve* a local model on demand, not a
   *  warm fallback: the fallback is loaded lazily (design §5), so a stopped
   *  utility server is normal, not degraded. Healthy = engines installed and
   *  the owner lock resolved; degraded during install; unhealthy only if the
   *  engine install failed or a demanded server hit its terminal error. */
  function reportHealth(): void {
    if (!ctx.health) return;
    if (bootstrapStage === "error") {
      ctx.health.unhealthy({ reason: bootstrapError, stage: "bootstrap" });
      return;
    }
    if (bootstrapStage !== "ready") {
      ctx.health.degraded({ stage: bootstrapStage });
      return;
    }
    // A server only reaches "error" after a caller demanded it and it failed
    // its retry budget — surface that as degraded (the floor is best-effort,
    // cloud providers may still be serving), never as a hard unhealthy.
    const utility = supervisor.status().utility;
    if (utility.state === "error") {
      ctx.health.degraded({ reason: utility.message, server: "utility" });
      return;
    }
    ctx.health.healthy({ fallback: FALLBACK_MODEL.ref, warm: false });
  }

  async function loadCachedProfile(): Promise<HardwareProfile | null> {
    try {
      const raw = await fs.readFile(path.join(rootDir, "hardware.json"), "utf8");
      return JSON.parse(raw) as HardwareProfile;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async function probeHardware(refresh: boolean): Promise<HardwareProfile> {
    if (!refresh) {
      const cached = profile ?? (await loadCachedProfile());
      if (cached) {
        profile = cached;
        return cached;
      }
    }
    const probed = await profiler.probe();
    profile = probed;
    try {
      await fs.writeFile(path.join(rootDir, "hardware.json"), JSON.stringify(probed, null, 2));
    } catch (error) {
      log("hardware profile cache write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return probed;
  }

  /** Bootstrap (design §5): probe → engines → resolve the owner lock. It does
   *  NOT download or warm the fallback: the fallback floor is loaded lazily on
   *  the first ensureLoaded() (no warm-fallback guarantee), so bootstrap only
   *  gets the machine to a state where any local model *can* be served on
   *  demand. Idempotent and restartable; failures land in bootstrapError. */
  async function bootstrap(): Promise<void> {
    try {
      bootstrapStage = "probing";
      const hw = await probeHardware(false);
      bootstrapStage = "engines";
      engineState = await engines.ensureInstalled(hw, ENGINE_PIN);
      // Resolve the single-owner lock so ports/api-key exist and this process
      // knows its role — but leave both servers cold. The utility server
      // starts on the first fallback ensureLoaded; the main server on the
      // first non-fallback ensureLoaded.
      await supervisor.activate();
      bootstrapStage = "ready";
      bootstrapError = null;
      emit({ kind: "models.changed" });
    } catch (err) {
      bootstrapStage = "error";
      bootstrapError = err instanceof Error ? err.message : String(err);
      log("bootstrap failed", { error: bootstrapError });
      throw err instanceof Error ? err : new Error(bootstrapError);
    } finally {
      reportHealth();
    }
  }

  function ensureBootstrap(): Promise<void> {
    if (bootstrapStage === "ready") return Promise.resolve();
    if (bootstrapRun && bootstrapStage !== "error") return bootstrapRun;
    bootstrapRun = bootstrap();
    return bootstrapRun;
  }

  /** Normalize a "local:slug" or bare "slug" ref to its bare slug. */
  function bareSlug(modelId: string): string {
    return modelId.startsWith("local:") ? modelId.slice("local:".length) : modelId;
  }

  /** Release this caller's wait when its RPC is cancelled. Model bootstrap is
   * supervisor-owned and may still satisfy another caller; cancellation does
   * not tear down that shared machine resource. */
  async function awaitInvocation<T>(work: Promise<T>): Promise<T> {
    const signal = ctx.invocation?.signal?.() ?? null;
    if (!signal) return work;
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new Error("local-model invocation aborted");
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      void work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  // Fire-and-forget: activation must not block on engine install/probing. The
  // build-time activation smoke verifies the exported API against a synthetic
  // context; it must not install native engines or leave background processes.
  if (process.env["VIBESTUDIO_EXTENSION_SMOKE"] !== "1") {
    void ensureBootstrap().catch(() => {});
  }
  const benchmarkRuns = new Map<string, Promise<{ tokensPerSec: number } | null>>();
  const addValidationRuns = new Map<string, Promise<void>>();

  function hasRecentBenchmark(record: ModelRecord | null): boolean {
    const benchmark = record?.benchmark ?? null;
    return (
      benchmark !== null &&
      Number.isFinite(benchmark.tokensPerSec) &&
      benchmark.tokensPerSec > 0 &&
      Date.now() - benchmark.measuredAt < BENCHMARK_RECENT_MS
    );
  }

  async function ensureLoadedInternal(
    modelId: string,
    options: { scheduleFallbackBenchmark?: boolean } = {}
  ): Promise<{ baseUrl: string }> {
    await awaitInvocation(ensureBootstrap());
    const slug = bareSlug(modelId);
    if (slug === FALLBACK_MODEL.slug) {
      const fallback = await awaitInvocation(library.ensureFallback());
      if (fallback.runtimeValidation?.status === "pending") {
        await awaitInvocation(validateAddedModel(slug));
      } else if (fallback.runtimeValidation?.status === "error") {
        throw new Error(
          fallback.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
        );
      }
      if (options.scheduleFallbackBenchmark) {
        scheduleBenchmark(slug);
      }
    } else {
      const record = await library.get(slug);
      if (record?.runtimeValidation?.status === "pending") {
        throw new Error(`Local model ${slug} is still being installed`);
      }
      if (record?.runtimeValidation?.status === "error") {
        throw new Error(
          record.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
        );
      }
    }
    return awaitInvocation(supervisor.ensureLoaded(slug));
  }

  async function validateAddedModel(slug: string): Promise<void> {
    const active = addValidationRuns.get(slug);
    if (active) return active;
    const record = await library.get(slug);
    // Records created before add-time validation are preconfigured models:
    // they remain trusted and are never probed during startup or invocation.
    if (!record?.runtimeValidation || record.runtimeValidation.status === "ready") return;
    if (record.runtimeValidation.status === "error") {
      throw new Error(
        record.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
      );
    }

    const run = (async () => {
      try {
        // Downloads and imports may finish while activation's native-engine
        // bootstrap is still in flight. Validation owns an isolated llama.cpp
        // process, so it must join that bootstrap before attempting to spawn.
        await ensureBootstrap();
        await supervisor.validateModel(slug);
        await library.setRuntimeValidation(slug, {
          status: "ready",
          error: null,
          validatedAt: Date.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await library.setRuntimeValidation(slug, {
          status: "error",
          error: message,
          validatedAt: null,
        });
        throw error;
      }
    })();
    addValidationRuns.set(slug, run);
    try {
      await run;
    } finally {
      if (addValidationRuns.get(slug) === run) addValidationRuns.delete(slug);
    }
  }

  async function benchmarkModelInternal(
    modelId: string,
    opts: { force?: boolean } = {}
  ): Promise<{ tokensPerSec: number } | null> {
    const slug = bareSlug(modelId);
    const existingRun = benchmarkRuns.get(slug);
    if (existingRun) {
      return existingRun;
    }

    const run = (async () => {
      const record = await library.get(slug);
      const recentBenchmark = record?.benchmark ?? null;
      if (opts.force !== true && hasRecentBenchmark(record) && recentBenchmark) {
        return { tokensPerSec: recentBenchmark.tokensPerSec };
      }

      return runModelBenchmark(slug, {
        fetch: globalThis.fetch,
        ensureLoaded: (candidate) => ensureLoadedInternal(candidate),
        apiKey: () => supervisor.apiKey(),
        setBenchmark: (candidate, result) => library.setBenchmark(candidate, result),
        now: () => Date.now(),
        log,
      });
    })();

    benchmarkRuns.set(slug, run);
    try {
      return await run;
    } finally {
      if (benchmarkRuns.get(slug) === run) {
        benchmarkRuns.delete(slug);
      }
    }
  }

  function scheduleBenchmark(modelId: string): void {
    void benchmarkModelInternal(modelId).catch((error: unknown) => {
      log("benchmark scheduling failed", {
        slug: bareSlug(modelId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function finishModelAddition(download: Promise<DownloadJob>): Promise<DownloadJob> {
    const job = await download;
    await validateAddedModel(job.slug);
    scheduleBenchmark(job.slug);
    return job;
  }

  function startDownloadWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    return finishModelAddition(library.startDownload(req));
  }

  async function startDownloadJobWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    const job = await library.startDownloadJob(req);
    void finishModelAddition(library.startDownload(req)).catch((error: unknown) => {
      log("model installation validation failed", {
        slug: job.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return job;
  }

  function matchesDownloadRequest(job: DownloadJob, req: DownloadModelRequest): boolean {
    if (req.slug && job.slug !== req.slug) return false;
    return job.hfRepo === req.hfRepo && job.file === req.file;
  }

  function downloadJobKey(job: DownloadJob): string {
    return [
      job.id,
      job.slug,
      job.hfRepo,
      job.file,
      job.totalBytes ?? "",
      job.receivedBytes,
      job.phase,
      job.error ?? "",
    ].join("\0");
  }

  function findDownloadForRequest(
    req: DownloadModelRequest,
    opts: { id?: string | null; ignoreIds?: ReadonlySet<string> } = {}
  ): DownloadJob | null {
    const matches = library.listDownloads().filter((job) => matchesDownloadRequest(job, req));
    if (opts.id) return matches.find((job) => job.id === opts.id) ?? null;
    return matches.find((job) => !opts.ignoreIds?.has(job.id)) ?? null;
  }

  function serverForRecord(record: ModelRecord): ServerKind {
    return record.slug === FALLBACK_MODEL.slug ? "utility" : "main";
  }

  function baseUrlFor(kind: ServerKind, servers: Record<ServerKind, ServerState>): string {
    const state = servers[kind];
    if (state.state === "running") return `http://127.0.0.1:${state.port}/v1`;
    const info = supervisor.ownerInfo();
    const port = info ? (kind === "utility" ? info.ports.utility : info.ports.main) : 0;
    return `http://127.0.0.1:${port}/v1`;
  }

  function recordState(
    record: ModelRecord,
    servers: Record<ServerKind, ServerState>,
    downloads: DownloadJob[]
  ): {
    state: LocalModelEntry["state"];
    download: LocalModelEntry["download"];
    error: string | null;
  } {
    const download = downloads.find((job) => job.slug === record.slug && !job.error);
    if (download) {
      return { state: "downloading", download: downloadStatus(download), error: null };
    }
    const failedDownload = downloads.find((job) => job.slug === record.slug && job.error);
    if (failedDownload) {
      return {
        state: "error",
        download: null,
        error: failedDownload.error ?? "Model download failed",
      };
    }
    if (bootstrapStage === "error") {
      return {
        state: "error",
        download: null,
        error: bootstrapError ?? "local-models bootstrap failed",
      };
    }
    if (bootstrapStage === "probing" || bootstrapStage === "engines") {
      return { state: "starting", download: null, error: null };
    }
    if (record.runtimeValidation?.status === "pending") {
      return { state: "starting", download: null, error: null };
    }
    if (record.runtimeValidation?.status === "error") {
      return {
        state: "error",
        download: null,
        error: record.runtimeValidation.error ?? "Model installation validation failed",
      };
    }
    const kind = serverForRecord(record);
    const server = servers[kind];
    if (server.state === "error") {
      return { state: "error", download: null, error: server.message };
    }
    if (server.state === "running") {
      const loaded = kind === "utility" || server.loadedModels.includes(record.slug);
      return { state: loaded ? "ready" : "startable", download: null, error: null };
    }
    // Downloaded but the server is cold: startable — ensureLoaded starts the
    // server (and, for the fallback, its lazy load) on demand.
    return { state: "startable", download: null, error: null };
  }

  function downloadStatus(job: DownloadJob): NonNullable<LocalModelEntry["download"]> {
    return {
      progress: job.totalBytes ? job.receivedBytes / job.totalBytes : 0,
      phase: job.phase,
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
    };
  }

  function oneClickModel(slug: string): typeof DEFAULT_MODEL | typeof FALLBACK_MODEL | null {
    if (slug === DEFAULT_MODEL.slug) return DEFAULT_MODEL;
    if (slug === FALLBACK_MODEL.slug) return FALLBACK_MODEL;
    return null;
  }

  function shouldOfferOneClickModel(
    model: typeof DEFAULT_MODEL | typeof FALLBACK_MODEL,
    hw: HardwareProfile | null
  ): boolean {
    return (
      model.slug === FALLBACK_MODEL.slug ||
      hw === null ||
      DEFAULT_MODEL.supportedTiers.some((tier) => tier === hw.tier)
    );
  }

  function missingOneClickEntry(
    model: typeof DEFAULT_MODEL | typeof FALLBACK_MODEL,
    hw: HardwareProfile | null,
    servers: Record<ServerKind, ServerState>,
    downloads: DownloadJob[]
  ): LocalModelEntry {
    const server = model.slug === FALLBACK_MODEL.slug ? "utility" : "main";
    const download = downloads.find((job) => job.slug === model.slug && !job.error);
    const failure = downloads.find((job) => job.slug === model.slug && job.error);
    const fit = hw
      ? estimateFit(
          {
            sizeBytes: model.downloadSizeBytes,
            trainedContextLength: model.contextLength,
          },
          hw
        )
      : {
          fit: "cpu-only" as const,
          estTokensPerSec: null,
          contextLength: model.contextLength,
          gpuLayers: 0,
          notes: ["hardware profile unavailable"],
        };
    return {
      slug: model.slug,
      displayName: model.displayName,
      baseUrl: baseUrlFor(server, servers),
      server,
      contextWindow: model.contextLength,
      maxTokens: model.contextLength,
      toolsCapable: true,
      reasoningCapable: model.slug === DEFAULT_MODEL.slug,
      fit,
      measuredTokensPerSec: null,
      state: download
        ? "downloading"
        : failure
          ? "error"
          : bootstrapStage === "error"
            ? "error"
            : "not-installed",
      download: download ? downloadStatus(download) : null,
      errorMessage: failure?.error
        ? failure.error
        : bootstrapStage === "error"
          ? (bootstrapError ?? "local-models bootstrap failed")
          : null,
    };
  }

  async function listModels(): Promise<LocalModelEntry[]> {
    const [records, hw] = await Promise.all([
      library.list(),
      probeHardware(false).catch(() => null),
    ]);
    const servers = supervisor.status();
    const downloads = library.listDownloads();
    const entries = records
      .filter((record) => record.slug !== FALLBACK_MODEL.slug || isCurrentFallbackRecord(record))
      .map((record) => {
        const kind = serverForRecord(record);
        const status = recordState(record, servers, downloads);
        const contextWindow = runtimeContextLengthFor(record);
        return {
          slug: record.slug,
          displayName: record.displayName,
          baseUrl: baseUrlFor(kind, servers),
          server: kind,
          contextWindow,
          maxTokens: contextWindow,
          toolsCapable: record.toolsCapable,
          reasoningCapable: record.reasoningCapable === true,
          fit: hw
            ? estimateFit(record, hw)
            : {
                fit: "cpu-only",
                estTokensPerSec: null,
                contextLength: contextWindow,
                gpuLayers: 0,
                notes: ["hardware profile unavailable"],
              },
          measuredTokensPerSec: record.benchmark?.tokensPerSec ?? null,
          state: status.state,
          download: status.download,
          errorMessage: status.error,
        } satisfies LocalModelEntry;
      });

    // One-click models stay visible before download. The small fallback is
    // universal; the preferred 27B model is offered only where its quant fits.
    for (const model of [FALLBACK_MODEL, DEFAULT_MODEL] as const) {
      if (
        !entries.some((entry) => entry.slug === model.slug) &&
        shouldOfferOneClickModel(model, hw)
      ) {
        entries.unshift(missingOneClickEntry(model, hw, servers, downloads));
      }
    }
    return entries;
  }

  async function status(): Promise<LocalModelsStatus> {
    const servers = supervisor.status();
    const storedFallback = await library.get(FALLBACK_MODEL.slug);
    const fallbackRecord = isCurrentFallbackRecord(storedFallback) ? storedFallback : null;
    const utilityRunning = servers.utility.state === "running";
    let diskFreeBytes = 0;
    try {
      const stats = await fs.statfs(rootDir);
      diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // statfs unsupported — panel shows "unknown"
    }
    return {
      role: supervisor.role(),
      owner: supervisor.ownerInfo(),
      hardware: profile,
      engine: engineState,
      servers,
      fallback: {
        // ready = downloaded and loadable on demand; warm = currently serving.
        // The floor is lazy (design §5) — a downloaded-but-cold fallback is the
        // healthy default, so `ready` no longer requires the utility server.
        ready:
          Boolean(fallbackRecord) &&
          fallbackRecord?.runtimeValidation?.status !== "pending" &&
          fallbackRecord?.runtimeValidation?.status !== "error",
        warm: utilityRunning,
        modelRef: FALLBACK_MODEL.ref,
        downloadSizeBytes: FALLBACK_MODEL.downloadSizeBytes,
        reason:
          fallbackRecord?.runtimeValidation?.status === "pending"
            ? "installing"
            : fallbackRecord?.runtimeValidation?.status === "error"
              ? (fallbackRecord.runtimeValidation.error ?? "installation validation failed")
              : fallbackRecord
                ? null
                : bootstrapStage === "error"
                  ? (bootstrapError ?? "local-models bootstrap failed")
                  : "not installed",
      },
      downloads: library.listDownloads(),
      storageRoot: rootDir,
      diskFreeBytes,
    };
  }

  /** getLoopbackAuth caller gate (design §6.3): refuse panels/apps/workers
   *  outright; among do-kind callers require the agent-vessel allowlist.
   *  Defense in depth — workspace DOs are trusted units; the key's threat
   *  model is foreign local processes. */
  function assertLoopbackAuthCaller(): void {
    const invocation = ctx.invocation?.current();
    if (!invocation) return; // direct host invocation (tests, CLI bridge)
    const caller = invocation.userlandCaller ?? invocation.caller;
    if (!caller?.kind) return;
    if (caller.kind !== "do") {
      throw new Error(`getLoopbackAuth: refused for caller kind "${caller.kind}"`);
    }
    const id = caller.id ?? "";
    const allowlisted = /agent|vessel/iu.test(id);
    if (!allowlisted) {
      throw new Error(`getLoopbackAuth: do-kind caller "${id}" is not an agent vessel`);
    }
  }

  const api = {
    async status(): Promise<LocalModelsStatus> {
      return status();
    },

    async listModels(): Promise<LocalModelEntry[]> {
      return listModels();
    },

    async ensureLoaded(modelId: string): Promise<{ baseUrl: string }> {
      // Lazy fallback (design §5): the LFM2.5 floor is downloaded on first
      // demand, not eagerly at bootstrap. ensureFallback is idempotent and a
      // no-op once the GGUF is present, so warm calls stay cheap. A completed
      // lazy fallback download schedules a background benchmark.
      return ensureLoadedInternal(modelId, { scheduleFallbackBenchmark: true });
    },

    /**
     * Start installation without waiting for the model transfer. The model
     * remains unavailable to agents until listModels() reports startable/ready.
     */
    async installModel(modelId: string): Promise<DownloadJob | null> {
      const slug = bareSlug(modelId);
      const model = oneClickModel(slug);
      if (!model) {
        throw new Error(`Model ${modelId} is not available for one-click installation`);
      }
      const existing = await library.get(slug);
      if (
        model.slug === FALLBACK_MODEL.slug ? isCurrentFallbackRecord(existing) : existing !== null
      ) {
        return null;
      }
      await awaitInvocation(ensureBootstrap());
      if (model.slug === FALLBACK_MODEL.slug) {
        const cachedFallbackPath = path.join(
          rootDir,
          ROOT_LAYOUT.modelsDir,
          ...FALLBACK_MODEL.hfRepo.split("/"),
          FALLBACK_MODEL.file
        );
        try {
          const cached = await fs.stat(cachedFallbackPath);
          if (cached.isFile()) {
            const record = await library.ensureFallback();
            await validateAddedModel(record.slug);
            return null;
          }
        } catch (error) {
          if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
        }
      }
      return startDownloadJobWithBenchmark({
        hfRepo: model.hfRepo,
        file: model.file,
        expectedSha256: model.sha256,
        displayName: model.displayName,
        slug: model.slug,
      });
    },

    async getLoopbackAuth(): Promise<{ apiKey: string }> {
      assertLoopbackAuthCaller();
      await awaitInvocation(ensureBootstrap());
      return { apiKey: await awaitInvocation(supervisor.apiKey()) };
    },

    async getHardwareProfile(refresh?: boolean): Promise<HardwareProfile> {
      return probeHardware(refresh === true);
    },

    async searchCatalog(query?: string): Promise<CuratedModel[]> {
      const hw = await probeHardware(false).catch(() => null);
      const tierFiltered = CURATED_CATALOG.filter(
        (model) => !hw || model.quantByTier[hw.tier] !== undefined
      );
      if (!query || !query.trim()) return tierFiltered;
      const needle = query.trim().toLowerCase();
      return tierFiltered.filter(
        (model) =>
          model.displayName.toLowerCase().includes(needle) ||
          model.hfRepo.toLowerCase().includes(needle)
      );
    },

    /** Fire-and-forget download start for panel/CLI consumers — progress
     *  arrives via status().downloads polling and download.progress events. */
    async startDownloadJob(req: DownloadModelRequest): Promise<DownloadJob> {
      return startDownloadJobWithBenchmark(req);
    },

    /** Streaming NDJSON download progress (streamingMethods). */
    downloadModel(req: DownloadModelRequest): Response {
      return jsonLineStream<DownloadJob>((push, end) => {
        let closed = false;
        let downloadId: string | null = null;
        let lastPushedKey: string | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        const ignoredDownloadIds = new Set(library.listDownloads().map((job) => job.id));

        const stop = (error?: string) => {
          if (closed) return;
          closed = true;
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
          end(error);
        };
        const pushOnce = (job: DownloadJob) => {
          const key = downloadJobKey(job);
          if (key === lastPushedKey) return;
          lastPushedKey = key;
          push(job);
        };
        const pollOnce = () => {
          if (closed) return;
          const current = findDownloadForRequest(req, {
            id: downloadId,
            ignoreIds: ignoredDownloadIds,
          });
          if (!current) return;
          downloadId = current.id;
          pushOnce(current);
          if (current.error) {
            stop(current.error);
          }
        };

        let download: Promise<DownloadJob>;
        try {
          download = startDownloadWithBenchmark(req);
        } catch (err) {
          stop(err instanceof Error ? err.message : String(err));
          return () => {};
        }

        poll = setInterval(pollOnce, 500);
        queueMicrotask(pollOnce);
        download
          .then((job) => {
            downloadId = job.id;
            pushOnce(job);
            stop();
          })
          .catch((err) => stop(err instanceof Error ? err.message : String(err)));
        return () => {
          closed = true;
          if (poll) clearInterval(poll);
        };
      });
    },

    async pauseDownload(id: string): Promise<void> {
      await library.pauseDownload(id);
    },
    async resumeDownload(id: string): Promise<void> {
      await library.resumeDownload(id);
    },
    async cancelDownload(id: string): Promise<void> {
      await library.cancelDownload(id);
    },
    async listDownloads(): Promise<DownloadJob[]> {
      return library.listDownloads();
    },

    async removeModel(slug: string): Promise<void> {
      await library.remove(slug);
      emit({ kind: "models.changed" });
    },

    async importDir(dir: string): Promise<ModelRecord[]> {
      const imported = await library.importDir(dir);
      await Promise.all(imported.map((record) => validateAddedModel(record.slug)));
      emit({ kind: "models.changed" });
      return Promise.all(
        imported.map(async (record) => (await library.get(record.slug)) ?? record)
      );
    },

    async setModelConfig(slug: string, cfg: ModelRuntimeConfig): Promise<void> {
      await library.setModelConfig(slug, cfg);
      emit({ kind: "models.changed" });
    },

    async benchmarkModel(
      slug: string,
      opts?: { force?: boolean }
    ): Promise<{ tokensPerSec: number } | null> {
      return benchmarkModelInternal(slug, opts);
    },

    async restartServer(which: ServerKind): Promise<void> {
      await supervisor.restart(which);
    },

    /** Plain log tail for panel/CLI consumers that don't stream. */
    async tailServerLogLines(which: ServerKind, lines?: number): Promise<string[]> {
      return supervisor.tailLog(which, lines ?? 200);
    },

    /** Streaming NDJSON log tail (streamingMethods). */
    tailServerLog(which: ServerKind): Response {
      return jsonLineStream<{ line: string }>((push, end) => {
        for (const line of supervisor.tailLog(which, 200)) push({ line });
        end();
        return () => {};
      });
    },

    async capabilities(): Promise<LocalModelsCapabilities> {
      return {
        managementPanel: { source: "about/local-models" },
        serverLogs: {
          utility: {
            source: "about/local-models",
            stateArgs: { openLog: "utility" },
          },
          main: {
            source: "about/local-models",
            stateArgs: { openLog: "main" },
          },
        },
      };
    },
  };

  return api;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export async function deactivate(): Promise<void> {
  // Supervisor disposal happens via the activation closure's subscriptions in
  // hosts that support it; the OS-level owner lock also releases on process
  // exit, and a dead owner is taken over on the next activation (design §4.3).
}
