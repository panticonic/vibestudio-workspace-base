/**
 * Mobile RPC client for React Native — Iroh transport.
 *
 * Native bootstrap and the workspace app share one Keychain-backed endpoint
 * identity. Returning connections authenticate that Endpoint ID plus the stored
 * device credential, and every RPC owns an independent QUIC stream.
 */

import {
  isRpcConnectionLost,
  type RpcCallOptions,
  type RpcClient,
  type RpcContextHandler,
  type RpcConnectionStatus,
  type RpcEventContext,
  type RpcStreamOptions,
} from "@vibestudio/rpc";
import type { RecoveryKind } from "@vibestudio/rpc/protocol/recoveryCoordinator";
import type { IrohClientSession } from "@vibestudio/rpc/transports/irohClient";
import { Platform } from "react-native";
import type { PanelEntityId } from "@vibestudio/shared/panel/ids";
import { authMethods } from "@vibestudio/service-schemas/auth";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  loadShellCredential,
  MobileConnectionAggregateError,
  reconnectMobileSession,
  type IrohConnection,
} from "@vibestudio/mobile-iroh";

export interface ReconnectProgress {
  attempt: number;
  phase: "scheduled" | "connecting" | "failed";
  reason: string;
  nextRetryInMs?: number;
}

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[VibestudioMobileSmoke] phase=${phase}${suffix}`);
}

function optionsForSelectedPipe<T extends RpcCallOptions | RpcStreamOptions>(
  options: T | undefined,
  hub: boolean,
): T | undefined {
  if (!hub || !options) return options;
  const { destination: _destination, ...rest } = options;
  return (Object.keys(rest).length ? rest : undefined) as T | undefined;
}

export type ConnectionStatus = RpcConnectionStatus;

/** Whether an idempotent shell operation should be retried on the same pipe. */
export function isTransientMobileTransportFailure(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      errorKind?: unknown;
    };
    if (
      candidate.errorKind !== undefined &&
      candidate.errorKind !== "transport"
    )
      return false;
    if (
      isRpcConnectionLost(current) ||
      candidate.code === "IROH_RESPONSE_HEAD_TIMEOUT"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export interface MobileRpcClientConfig {
  /** Immutable workspace session factory supplied by the retained account. */
  connectWorkspace?: (
    onRecovery: (kind: RecoveryKind) => void | Promise<void>,
  ) => Promise<IrohConnection>;
  initialConnectionRetry?: {
    maxMs?: number;
    delayMs?: number;
    maxDelayMs?: number;
  };
}

export function createMobileRpcClient(
  config: MobileRpcClientConfig = {},
): MobileRpcClient {
  return new MobileRpcClient(config);
}

export class MobileRpcClient implements Pick<
  RpcClient,
  "selfId" | "expose" | "call" | "emit" | "on" | "stream" | "streamReadable"
> {
  private readonly config: MobileRpcClientConfig;
  private connection: IrohConnection | null = null;
  private rpc: RpcClient | null = null;
  private controlRpc: RpcClient | null = null;
  // Dedupes concurrent connect attempts: the Iroh handshake is eager + async,
  // so a stray call() racing connectAndWait() must not open a second pipe.
  private connecting: Promise<RpcClient> | null = null;
  private retirement: Promise<void> | null = null;
  // One lifetime covers connection establishment and the adopted session.
  // Teardown retires it before async close, so late callbacks cannot affect a
  // replacement session and a late handshake closes its own unused connection.
  private connectionToken: object | null = null;
  private connectionSubscriptions: Array<() => void> = [];
  private currentCallerId: string | null = null;
  private authenticatedServerId: string | null = null;
  private statusState: ConnectionStatus = "disconnected";
  private readonly statusListeners = new Set<
    (status: ConnectionStatus) => void
  >();
  private readonly reconnectProgressListeners = new Set<
    (progress: ReconnectProgress) => void
  >();
  private readonly recoveryListeners = new Map<
    RecoveryKind,
    Set<() => void | Promise<void>>
  >();
  private readonly eventSubscriptions = new Map<
    string,
    Set<(event: RpcEventContext) => void>
  >();
  private readonly activeEventUnsubs = new Map<string, () => void>();
  private readonly exposedHandlers = new Map<
    string,
    RpcContextHandler<any, any>
  >();

  constructor(config: MobileRpcClientConfig) {
    this.config = config;
  }

  get selfId(): string {
    return this.currentCallerId ?? "shell:pending";
  }

  get serverId(): string | null {
    return this.authenticatedServerId;
  }

  get status(): ConnectionStatus {
    return this.connection?.session.status() ?? this.statusState;
  }

  connect(): void {
    // The shared connection job reports its terminal failure once.
    void this.ensureRpc().catch(() => undefined);
  }

  async connectAndWait(timeoutMs?: number | null): Promise<void> {
    const token = this.ensureConnectionLifetime();
    try {
      await this.ensureRpc(timeoutMs);
      this.assertConnectionLifetime(token);
    } catch (error) {
      this.assertConnectionLifetime(token);
      if (error instanceof ConnectSupersededError) throw error;
      throw error;
    }
  }

  reconnect(): void {
    const closing = this.teardown();
    const token = this.ensureConnectionLifetime();
    this.startConnectionJob(token, undefined, closing);
  }

  onReconnectProgress(
    listener: (progress: ReconnectProgress) => void,
  ): () => void {
    this.reconnectProgressListeners.add(listener);
    return () => this.reconnectProgressListeners.delete(listener);
  }

  async waitUntilConnected(timeoutMs: number): Promise<void> {
    if (this.status === "connected") return;
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const remove = this.onStatusChange((status) => {
        if (status !== "connected") return;
        if (timeout) clearTimeout(timeout);
        remove();
        resolve();
      });
      timeout = setTimeout(
        () => {
          remove();
          reject(
            new Error(
              "The secure workspace connection did not recover in time",
            ),
          );
        },
        Math.max(1, timeoutMs),
      );
    });
  }

  private emitReconnectProgress(progress: ReconnectProgress): void {
    for (const listener of this.reconnectProgressListeners) listener(progress);
  }

  disconnect(): void {
    if (!this.connectionToken && !this.connection && !this.connecting) {
      this.setStatus("disconnected");
      return;
    }
    void this.close().catch((error) =>
      this.reportTransportFailure("Disconnect teardown failed", error),
    );
  }

  /** Deterministic ownership handoff used before the native RN runtime reloads. */
  async close(): Promise<void> {
    await this.teardown();
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  async call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T> {
    const workspaceRpc = await this.ensureRpc();
    const hub = options?.destination?.kind === "hub";
    const selected = hub ? this.controlRpc : workspaceRpc;
    if (!selected)
      throw new Error("Stable hub control connection not established");
    const selectedOptions = optionsForSelectedPipe(options, hub);
    return selected.call<T>(targetId, method, args, selectedOptions);
  }

  expose<TArgs extends unknown[], TReturn>(
    method: string,
    handler: RpcContextHandler<TArgs, TReturn>,
  ): void {
    if (this.exposedHandlers.has(method)) {
      throw new Error(`Mobile RPC method "${method}" is already exposed`);
    }
    this.exposedHandlers.set(method, handler);
    this.rpc?.expose(method, handler, { kind: "closed", reason: "Mobile presentation host methods are entered through the host dispatcher." });
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions,
  ): Promise<Response> {
    const workspaceRpc = await this.ensureRpc();
    const hub = options?.destination?.kind === "hub";
    const selected = hub ? this.controlRpc : workspaceRpc;
    if (!selected)
      throw new Error("Stable hub control connection not established");
    return selected.stream(
      targetId,
      method,
      args,
      optionsForSelectedPipe(options, hub),
    );
  }

  /**
   * Like {@link stream} but yields the decoded head + a raw `ReadableStream`
   * body — RN's whatwg-fetch `Response` cannot consume a ReadableStream. The
   * panel-asset façade (B2) reads panel bundles through this. `options.body`
   * streams a request body on the same request-owned QUIC stream.
   */
  async streamReadable(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcStreamOptions,
  ): ReturnType<RpcClient["streamReadable"]> {
    const workspaceRpc = await this.ensureRpc();
    const hub = options?.destination?.kind === "hub";
    const selected = hub ? this.controlRpc : workspaceRpc;
    if (!selected)
      throw new Error("Stable hub control connection not established");
    return selected.streamReadable(
      targetId,
      method,
      args,
      optionsForSelectedPipe(options, hub),
    );
  }

  /**
   * Open a dedicated per-panel "panel" session over the existing pipe. The
   * server attributes calls by the authenticated SESSION principal, so a panel
   * needs its OWN grant-redeemed "panel" session — relaying over the shell
   * session makes its calls show up as "shell", which capability-gated services
   * (e.g. PubSub `subscribe`, allowed: panel/do) reject. This rides the SAME pipe
   * (a logical session, not a 2nd connection), so it does not trip the runtime
   * lease gate (that gates panel HOSTING, not sessions). The grant is one-shot,
   * so `getToken` refetches a fresh one on every (re)open.
   */
  async openPanelSession(
    runtimeEntityId: PanelEntityId,
    connectionId: string,
  ): Promise<IrohClientSession> {
    const rpc = await this.ensureRpc();
    const connection = this.connection;
    if (!connection) throw new Error("Iroh connection not established");
    const authClient = createTypedServiceClient(
      "auth",
      authMethods,
      (service, method, args) => rpc.call("main", `${service}.${method}`, args),
    );
    const session = connection.transport.openSession({
      // Reuse the lease's connectionId and grant for the runtime ENTITY id (not
      // the slot id) so the server's authorizePanelConnection(callerId,
      // connectionId) matches the materializer's lease (keyed by entity id +
      // that connectionId). The grant principal becomes this session's callerId,
      // which equals the panel bundle's RPC `from` (cfg.entityId) so routed
      // responses match their recorded origin.
      connectionId,
      clientPlatform: "mobile",
      oauthCallbackMode:
        Platform.OS === "ios" ? "app-scheme" : "client-loopback",
      getToken: async () => {
        const grant = await authClient.grantConnection(runtimeEntityId);
        return grant.token;
      },
    });
    await session.ready?.();
    return session;
  }

  async emit(targetId: string, event: string, payload: unknown): Promise<void> {
    return (await this.ensureRpc()).emit(targetId, event, payload);
  }

  on(event: string, listener: (event: RpcEventContext) => void): () => void {
    let listeners = this.eventSubscriptions.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventSubscriptions.set(event, listeners);
    }
    listeners.add(listener);
    this.attachEventSubscription(event);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.eventSubscriptions.delete(event);
        this.activeEventUnsubs.get(event)?.();
        this.activeEventUnsubs.delete(event);
      }
    };
  }

  onReconnect(listener: () => void): () => void {
    return this.onRecovery("resubscribe", listener);
  }

  onRecovery(
    kind: RecoveryKind,
    listener: () => void | Promise<void>,
  ): () => void {
    let listeners = this.recoveryListeners.get(kind);
    if (!listeners) {
      listeners = new Set();
      this.recoveryListeners.set(kind, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
  }

  private ensureConnectionLifetime(): object {
    return (this.connectionToken ??= {});
  }

  private assertConnectionLifetime(token: object): void {
    if (this.connectionToken !== token) throw new ConnectSupersededError();
  }

  private async ensureRpc(timeoutMs?: number | null): Promise<RpcClient> {
    if (this.rpc) return this.rpc;
    if (this.connecting) return this.connecting;
    return this.startConnectionJob(this.ensureConnectionLifetime(), timeoutMs);
  }

  private startConnectionJob(
    token: object,
    timeoutMs?: number | null,
    retirement = this.retirement,
  ): Promise<RpcClient> {
    // This one promise includes preceding retirement and every initial attempt.
    // A failed job remains terminal until an explicit new connection intent.
    const connecting = (async () => {
      await retirement;
      this.assertConnectionLifetime(token);
      this.setStatus("connecting");
      return this.establishConnectionWithRetry(token, timeoutMs);
    })();
    this.connecting = connecting;
    void connecting.catch((error) => {
      if (this.connectionToken !== token) return;
      this.reportTransportFailure("Connection failed", error, token);
    });
    return connecting;
  }

  private async establishConnection(token: object): Promise<RpcClient> {
    let connection: IrohConnection | undefined;
    const current = () =>
      this.connectionToken === token &&
      connection !== undefined &&
      this.connection === connection;
    const recover = (kind: RecoveryKind) => {
      if (current()) this.emitRecovery(kind);
    };
    try {
      connection = this.config.connectWorkspace
        ? await this.config.connectWorkspace(recover)
        : await this.restoreBootstrapSession(recover, token);
    } catch (error) {
      this.assertConnectionLifetime(token);
      throw error;
    }
    if (this.connectionToken !== token) {
      return this.retireAttemptAndThrow(
        connection,
        new ConnectSupersededError(),
      );
    }
    const subscriptions: Array<() => void> = [];
    const events = new Map<string, () => void>();
    try {
      if (
        connection.serverId &&
        this.authenticatedServerId &&
        connection.serverId !== this.authenticatedServerId
      ) {
        throw new Error(
          "The workspace route changed the authenticated account server",
        );
      }
      if (!connection.hubControlRpc)
        throw new Error(
          "Mobile session did not retain its stable hub control pipe",
        );
      const rpc = connection.rpc;
      for (const [method, handler] of this.exposedHandlers)
        rpc.expose(method, handler, {"kind":"closed","reason":"This handler controls an internal execution or presentation surface."});
      subscriptions.push(
        connection.session.onStatusChange((status) => {
          if (current()) this.setStatus(status);
        }),
      );
      const stopProgress = connection.transport.onReconnectProgress?.(
        (progress) => {
          if (current()) this.emitReconnectProgress(progress);
        },
      );
      if (stopProgress) subscriptions.push(stopProgress);
      for (const event of this.eventSubscriptions.keys())
        events.set(event, this.subscribeToRpcEvent(rpc, event));
      this.assertConnectionLifetime(token);
    } catch (error) {
      return this.retireAttemptAndThrow(connection, error, [
        ...subscriptions,
        ...events.values(),
      ]);
    }
    this.authenticatedServerId ??= connection.serverId ?? null;
    this.connection = connection;
    this.currentCallerId = connection.callerId;
    this.rpc = connection.rpc;
    this.controlRpc = connection.hubControlRpc;
    this.connectionSubscriptions = subscriptions;
    for (const [event, stop] of events) this.activeEventUnsubs.set(event, stop);
    this.setStatus(connection.session.status());
    smokePhase("workspace-iroh-connected", { callerId: connection.callerId });
    return this.rpc;
  }

  private async restoreBootstrapSession(
    onRecovery: (kind: RecoveryKind) => void,
    token: object,
  ): Promise<IrohConnection> {
    const stored = await loadShellCredential();
    this.assertConnectionLifetime(token);
    if (!stored) {
      throw new Error("No stored Iroh shell credential — re-pair this device");
    }
    smokePhase("workspace-iroh-connect-start", {
      phase: stored.phase,
      endpointId:
        stored.phase === "routed"
          ? stored.workspacePairing.endpointId.slice(0, 12)
          : stored.controlPairing.endpointId.slice(0, 12),
    });
    return reconnectMobileSession(
      stored,
      Platform.OS === "ios" ? "app-scheme" : "client-loopback",
      onRecovery,
    );
  }

  private async establishConnectionWithRetry(
    token: object,
    timeoutMs?: number | null,
  ): Promise<RpcClient> {
    const retry = this.config.initialConnectionRetry ?? {};
    const startedAt = Date.now();
    const maxMs =
      typeof timeoutMs === "number"
        ? timeoutMs
        : typeof retry.maxMs === "number"
          ? retry.maxMs
          : 120_000;
    const deadline = startedAt + maxMs;
    const baseDelayMs =
      typeof retry.delayMs === "number" && retry.delayMs >= 0
        ? retry.delayMs
        : 750;
    const maxDelayMs =
      typeof retry.maxDelayMs === "number" && retry.maxDelayMs >= 0
        ? retry.maxDelayMs
        : 5_000;
    let attempt = 0;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      this.assertConnectionLifetime(token);
      attempt += 1;
      this.emitReconnectProgress({
        attempt,
        phase: "connecting",
        reason: attempt === 1 ? "initial connection" : "retry",
      });
      try {
        const rpc = await this.establishConnection(token);
        this.assertConnectionLifetime(token);
        if (attempt > 1) {
          smokePhase("workspace-iroh-retry-connected", { attempt });
        }
        return rpc;
      } catch (error) {
        this.assertConnectionLifetime(token);
        // An intentional teardown (disconnect/dispose) landed
        // mid-connect. Do NOT retry — that would resurrect a pipe the caller
        // just asked to drop. Propagate so the awaiting init() unwinds.
        if (error instanceof ConnectSupersededError) throw error;
        lastError = error;
        this.emitReconnectProgress({
          attempt,
          phase: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        // Setup owns and closes rejected attempts before they reach this loop.
        // Failed cleanup is terminal: do not build another connection over it.
        if (error instanceof MobileConnectionAggregateError) throw error;
        this.assertConnectionLifetime(token);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const delayMs = Math.min(
          baseDelayMs * 2 ** Math.max(0, attempt - 1),
          maxDelayMs,
          remainingMs,
        );
        smokePhase("workspace-iroh-retry", {
          attempt,
          delayMs,
          message: errorMessage(error),
        });
        console.warn(
          `[MobileRpcClient] Initial Iroh connection failed; retrying in ${delayMs}ms`,
          error,
        );
        this.emitReconnectProgress({
          attempt,
          phase: "scheduled",
          reason: errorMessage(error),
          nextRetryInMs: delayMs,
        });
        await sleep(delayMs);
      }
    }

    this.assertConnectionLifetime(token);
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `Could not reach your workspace server after ${Math.round(maxMs / 1000)} seconds. It may be asleep or offline — retry, or re-pair only if the server was replaced.`,
        );
  }

  private async teardown(): Promise<void> {
    this.connectionToken = null;
    this.connecting = null;
    const closing = this.closeConnectionResources();
    this.setStatus("disconnected");
    await closing;
  }

  /** Detach the exact adopted connection before asynchronous native cleanup. */
  private async closeConnectionResources(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.rpc = null;
    this.controlRpc = null;
    this.currentCallerId = null;
    const subscriptions = [
      ...this.connectionSubscriptions.splice(0),
      ...this.activeEventUnsubs.values(),
    ];
    this.activeEventUnsubs.clear();
    await this.retireResources(connection, subscriptions);
  }

  private retireResources(
    connection: IrohConnection | null,
    subscriptions: Array<() => void>,
  ): Promise<void> {
    if (!connection && subscriptions.length === 0)
      return this.retirement ?? Promise.resolve();
    const cleanup = closeConnectionResources(connection, subscriptions);
    const previous = this.retirement;
    const retirement = previous
      ? Promise.allSettled([previous, cleanup]).then((results) => {
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length)
            throw new MobileConnectionAggregateError(
              failures,
              "Mobile connection resources could not all be closed",
            );
        })
      : cleanup;
    this.retirement = retirement;
    void retirement.then(
      () => {
        if (this.retirement === retirement) this.retirement = null;
      },
      () => undefined,
    );
    return retirement;
  }

  private async retireAttemptAndThrow(
    connection: IrohConnection,
    error: unknown,
    subscriptions: Array<() => void> = [],
  ): Promise<never> {
    try {
      await this.retireResources(connection, subscriptions);
    } catch (cleanupError) {
      throw new MobileConnectionAggregateError(
        [error, cleanupError],
        "Mobile connection setup failed and its resources could not all be closed",
      );
    }
    throw error;
  }

  private reportTransportFailure(
    context: string,
    error: unknown,
    token: object | null = null,
  ): void {
    const reason = `${context}: ${errorMessage(error)}`;
    console.error(`[MobileRpcClient] ${reason}`, error);
    if (this.connectionToken === token) {
      this.emitReconnectProgress({ attempt: 0, phase: "failed", reason });
      this.setStatus("disconnected");
    }
  }

  private attachEventSubscription(event: string): void {
    if (!this.rpc || this.activeEventUnsubs.has(event)) return;
    this.activeEventUnsubs.set(
      event,
      this.subscribeToRpcEvent(this.rpc, event),
    );
  }

  private subscribeToRpcEvent(rpc: RpcClient, event: string): () => void {
    return rpc.on(event, (ev) => {
      if (this.rpc !== rpc) return;
      for (const listener of this.eventSubscriptions.get(event) ?? [])
        listener(ev);
    }, {"kind":"closed","reason":"This listener consumes host or implementation lifecycle events."});
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusState = status;
    for (const listener of this.statusListeners) listener(status);
  }

  /**
   * Fire the recovery listeners for `kind`. Driven by the Iroh session's
   * post-auth recovery signal: "resubscribe" on
   * a normal reconnect, "cold-recover" when the server restarted (serverBootId
   * changed) / the session was dirty — so ShellClient's cold-recover listener
   * actually fires instead of only ever running the lighter resubscribe.
   */
  private emitRecovery(kind: RecoveryKind): void {
    for (const listener of this.recoveryListeners.get(kind) ?? [])
      void listener();
  }
}

/** Thrown by an in-flight establishConnection() that teardown() invalidated. */
class ConnectSupersededError extends Error {
  constructor() {
    super("Iroh connect superseded by disconnect/reconnect");
    this.name = "ConnectSupersededError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeConnectionResources(
  connection: IrohConnection | null,
  subscriptions: Array<() => void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const stop of subscriptions) {
    try {
      stop();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await connection?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new MobileConnectionAggregateError(
      failures,
      "Mobile connection resources could not all be closed",
    );
}
