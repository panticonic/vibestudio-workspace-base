import { clearWorkspaceCookies } from "./workspaceBrowserProfile";
import { extensionsMethods } from "@vibestudio/service-schemas/extensions";
import { workspaceName as displayWorkspaceName } from "./workspaceName";
import {
  templatesMethods,
  type TemplateExactPin,
} from "@vibestudio/service-schemas/templates";
import {
  createApprovalStateController,
  SHELL_APPROVAL_PENDING_CHANGED_EVENT,
  type ApprovalStateController,
} from "@vibestudio/shell-core/approvalState";
import { filterRuntimeApprovals } from "@vibestudio/shared/bootstrapApprovals";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  type WorkspacePushScope,
  type WorkspaceApprovalTarget,
} from "@vibestudio/shared/workspacePushScope";
import { approvalDeepLinkAtom } from "../state/approvalDeepLinkAtom";
import { drainBackgroundActionQueue } from "./backgroundActionQueue";
import { createStore } from "jotai";
import { Platform } from "react-native";
import {
  connectMobileAccount,
  MobileConnectionAggregateError,
  type MobileWorkspaceAccount,
  type StoredMobileConnection,
  type MobileHubWorkspace,
} from "@vibestudio/mobile-iroh";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { ShellClient } from "./shellClient";
import {
  shellClientAtom,
  panelTreeRevisionAtom,
} from "../state/shellClientAtom";
import {
  connectionStatusAtom,
  workspaceReadinessAtom,
} from "../state/connectionAtoms";
import { serverUrlAtom } from "../state/authAtoms";
import { getNativeAppStorage } from "./nativeAppStorage";

export interface MobileWorkspaceSession {
  readonly workspaceId: string;
  readonly client: ShellClient;
  readonly store: ReturnType<typeof createStore>;
  state: "opening" | "ready" | "failed";
  error: string | null;
  approvals: PendingApproval[] | null;
  approvalState: ApprovalStateController | null;
  approvalError: string | null;
  stopApprovalRecovery?: () => void;
}

/** Account-owned directory. A workspace's client and UI store are never rebound. */
export class MobileWorkspaceDirectory {
  readonly sessions = new Map<string, MobileWorkspaceSession>();
  readonly expanded = new Set<string>();
  readonly presented = new Set<string>();
  readonly hubControl;
  entries: MobileHubWorkspace[] = [];
  activeWorkspaceId: string | null = null;
  personalWorkspaceId = "";
  systemWorkspaceId = "";
  error: string | null = null;
  workspaceCreation: { template?: TemplateExactPin } | null = null;
  /** Account metadata for unopened workspaces; live controllers refine connected queues. */
  readonly pendingApprovalCounts = new Map<string, number>();
  approvalWorkspaceId: string | null = null;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly opening = new Map<string, Promise<MobileWorkspaceSession>>();
  private disposed = false;
  private closing: Promise<void> | null = null;

  constructor(
    readonly account: MobileWorkspaceAccount,
    private readonly stored: StoredMobileConnection,
  ) {
    this.hubControl = createTypedServiceClient(
      "hubControl",
      hubControlMethods,
      (_service, method, args) =>
        account.control.rpc.call("main", `hubControl.${method}`, args),
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): number => this.revision;
  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    const pair = await this.hubControl.ensureUserWorkspaces();
    this.personalWorkspaceId = pair.personal.workspaceId;
    this.systemWorkspaceId = pair.system.workspaceId;
    await this.refresh();
    const system = await this.open(this.systemWorkspaceId);
    await system.client.refreshAccountProfile();
    const saved = await getNativeAppStorage().getItem(this.selectionKey);
    const selected = this.entries.some((entry) => entry.workspaceId === saved)
      ? saved!
      : this.personalWorkspaceId;
    await this.activate(selected);
  }

  private get selectionKey(): string {
    return `vibestudio:active-workspace:${this.stored.controlPairing.endpointId}:${this.stored.credential.deviceId}`;
  }

  async refresh(): Promise<void> {
    try {
      const entries = await this.hubControl.listWorkspaces();
      if (this.disposed) return;
      this.entries = entries.sort((a, b) => {
        const rank = (entry: MobileHubWorkspace) =>
          entry.workspaceId === this.personalWorkspaceId
            ? 0
            : entry.workspaceId === this.systemWorkspaceId
              ? 2
              : 1;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
      const accessible = new Set(entries.map((entry) => entry.workspaceId));
      for (const id of this.pendingApprovalCounts.keys()) {
        if (!accessible.has(id)) {
          this.pendingApprovalCounts.delete(id);
          if (this.approvalWorkspaceId === id) this.approvalWorkspaceId = null;
        }
      }
      for (const entry of entries) {
        const session = this.sessions.get(entry.workspaceId);
        if (session?.approvals == null || session.state !== "ready") {
          this.pendingApprovalCounts.set(
            entry.workspaceId,
            entry.pendingApprovalCount,
          );
        }
      }
      for (const [id, session] of this.sessions) {
        if (!entries.some((entry) => entry.workspaceId === id)) {
          session.approvalState?.stop();
          session.stopApprovalRecovery?.();
          session.client.dispose();
          this.sessions.delete(id);
          this.expanded.delete(id);
          this.presented.delete(id);
          this.pendingApprovalCounts.delete(id);
          if (this.approvalWorkspaceId === id) this.approvalWorkspaceId = null;
        }
      }
      this.error = null;
      this.changed();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.changed();
      throw error;
    }
  }

  open(workspaceId: string): Promise<MobileWorkspaceSession> {
    if (this.disposed)
      return Promise.reject(new Error("The mobile account is closed"));
    const pending = this.opening.get(workspaceId);
    if (pending) return pending;
    const existing = this.sessions.get(workspaceId);
    if (existing?.state === "ready") return Promise.resolve(existing);
    const entry = this.entries.find((item) => item.workspaceId === workspaceId);
    if (!entry)
      return Promise.reject(
        new Error("You no longer have access to this workspace"),
      );
    existing?.approvalState?.stop();
    existing?.stopApprovalRecovery?.();
    existing?.client.dispose();
    const store = createStore();
    const client = new ShellClient({
      credentials: { deviceId: this.stored.credential.deviceId },
      serverEndpointId: this.stored.controlPairing.endpointId,
      workspaceId,
      workspaceName: displayWorkspaceName(entry),
      connectWorkspace: (onRecovery) =>
        this.account.openWorkspace(workspaceId, onRecovery),
      ...(workspaceId !== this.systemWorkspaceId
        ? {
            appSourceClient: this.sessions.get(this.systemWorkspaceId)?.client,
          }
        : {}),
      onStatusChange: (status) => {
        store.set(connectionStatusAtom, status);
        this.changed();
      },
      onReadinessChange: (readiness) => {
        store.set(workspaceReadinessAtom, readiness);
        if (readiness === "reconciled")
          void drainBackgroundActionQueue(client).catch((error) =>
            console.warn(
              "[WorkspaceDirectory] Unable to send queued approval",
              error,
            ),
          );
      },
      onTreeInvalidated: (event) =>
        store.set(panelTreeRevisionAtom, event.revision),
      onPanelsChanged: () =>
        store.set(panelTreeRevisionAtom, (revision) => revision + 1),
    });
    store.set(shellClientAtom, client);
    const session: MobileWorkspaceSession = {
      workspaceId,
      client,
      store,
      state: "opening",
      error: null,
      approvals: null,
      approvalState: null,
      approvalError: null,
    };
    this.sessions.set(workspaceId, session);
    this.changed();
    const opening = client
      .init()
      .then(() => {
        if (this.disposed || this.sessions.get(workspaceId) !== session) {
          client.dispose();
          throw new Error("The workspace was closed while opening");
        }
        store.set(serverUrlAtom, client.serverUrl);
        session.state = "ready";
        session.approvalState = createApprovalStateController({
          listPending: () => client.shellApproval.listPending(),
          subscribePendingChanged: () =>
            client.events.subscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
          unsubscribePendingChanged: () =>
            client.events.unsubscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
          onPendingChanged: (listener) =>
            client.events.on(SHELL_APPROVAL_PENDING_CHANGED_EVENT, listener),
          filter: filterRuntimeApprovals,
          onChange: (pending) => {
            session.approvals = pending;
            session.approvalError = null;
            this.updateApprovalCount(workspaceId, pending.length);
            this.changed();
          },
          onError: (error, phase) => {
            session.approvalError =
              error instanceof Error ? error.message : String(error);
            console.warn(
              `[WorkspaceDirectory] Approval ${phase} failed in ${workspaceId}`,
              error,
            );
            this.changed();
          },
        });
        session.approvalState.start();
        session.stopApprovalRecovery = client.onRecoveryComplete(() => {
          void session.approvalState?.refresh("manual");
          void drainBackgroundActionQueue(client).catch((error) =>
            console.warn(
              "[WorkspaceDirectory] Unable to send queued approval",
              error,
            ),
          );
        });
        this.changed();
        return session;
      })
      .catch((error: unknown) => {
        session.state = "failed";
        session.error = error instanceof Error ? error.message : String(error);
        client.dispose();
        this.changed();
        throw error;
      })
      .finally(() => this.opening.delete(workspaceId));
    this.opening.set(workspaceId, opening);
    return opening;
  }

  async activate(workspaceId: string, panelId?: string): Promise<void> {
    if (!this.entries.some((entry) => entry.workspaceId === workspaceId)) {
      throw new Error("You do not have access to this workspace");
    }
    this.activeWorkspaceId = workspaceId;
    this.presented.add(workspaceId);
    this.expanded.add(workspaceId);
    this.changed();
    const session = await this.open(workspaceId);
    if (panelId) await session.client.panels.focus(panelId);
    // A slower workspace opening cannot take focus back from a later gesture.
    if (this.activeWorkspaceId !== workspaceId) return;
    await getNativeAppStorage().setItem(this.selectionKey, workspaceId);
    this.changed();
  }

  async toggleExpanded(workspaceId: string): Promise<void> {
    if (this.expanded.delete(workspaceId)) {
      this.changed();
      return;
    }
    this.expanded.add(workspaceId);
    this.changed();
    await this.open(workspaceId);
  }

  requestWorkspaceCreation(template?: TemplateExactPin): void {
    if (this.workspaceCreation) return;
    this.workspaceCreation = template ? { template } : {};
    this.changed();
  }

  closeWorkspaceCreation(): void {
    this.workspaceCreation = null;
    this.changed();
  }

  async inspectWorkspaceTemplate(pin: TemplateExactPin) {
    const system = await this.open(this.systemWorkspaceId);
    const extensions = createTypedServiceClient(
      "extensions",
      extensionsMethods,
      (service, method, args) =>
        system.client.transport.call("main", `${service}.${method}`, args),
    );
    const templates = createTypedServiceClient(
      "@workspace-extensions/templates",
      templatesMethods,
      (extension, method, args) => extensions.invoke(extension, method, args),
    );
    return templates.inspect({ pin });
  }

  async createWorkspace(
    name: string,
    rootTemplate?: TemplateExactPin,
  ): Promise<MobileHubWorkspace> {
    const entry = await this.hubControl.createWorkspace({
      workspace: name,
      ...(rootTemplate ? { rootTemplate } : {}),
    });
    this.entries = [
      ...this.entries.filter((item) => item.workspaceId !== entry.workspaceId),
      entry,
    ];
    this.changed();
    return entry;
  }

  async createPanel(workspaceId: string): Promise<void> {
    await this.activate(workspaceId);
    const session = await this.open(workspaceId);
    const panel = await session.client.panels.createAboutPanel("new");
    await session.client.panels.focus(panel.id);
  }

  async openPanelSource(
    workspaceId: string,
    source: string,
    options: Parameters<ShellClient["panels"]["createRootPanel"]>[1],
  ): Promise<void> {
    await this.activate(workspaceId);
    const session = await this.open(workspaceId);
    // A destination owns its tree; source panel IDs never become target parents.
    const panel = await session.client.panels.createRootPanel(source, options);
    await session.client.panels.focus(panel.id);
  }

  async clearBrowserCookies(workspaceId: string): Promise<void> {
    if (
      this.disposed ||
      !this.entries.some((entry) => entry.workspaceId === workspaceId)
    ) {
      throw new Error("You no longer have access to this workspace");
    }
    await clearWorkspaceCookies(
      `${this.stored.controlPairing.endpointId.toLowerCase()}:${this.stored.credential.deviceId}`,
      workspaceId,
    );
  }

  updateApprovalCount(workspaceId: string, count: number): void {
    if (this.pendingApprovalCounts.get(workspaceId) === count) return;
    this.pendingApprovalCounts.set(workspaceId, count);
    if (count === 0 && this.approvalWorkspaceId === workspaceId)
      this.approvalWorkspaceId = null;
    this.changed();
  }

  get approvalCount(): number {
    return [...this.pendingApprovalCounts.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  async resolveNotificationWorkspace(
    scope: WorkspacePushScope,
  ): Promise<MobileWorkspaceSession> {
    const system = this.sessions.get(this.systemWorkspaceId)?.client;
    if (!system) throw new Error("Your account is not connected");
    const profile = await system.refreshAccountProfile();
    if (
      scope.serverId !== system.transport.serverId ||
      scope.userId !== profile.userId
    ) {
      throw new Error("This notification belongs to another account");
    }
    return this.open(scope.workspaceId);
  }

  async openApproval(target: WorkspaceApprovalTarget): Promise<void> {
    const session = await this.resolveNotificationWorkspace(target);
    session.store.set(approvalDeepLinkAtom, target.approvalId);
    this.approvalWorkspaceId = target.workspaceId;
    this.changed();
  }

  openApprovals(workspaceId?: string): void {
    const target =
      workspaceId ??
      (this.activeWorkspaceId &&
      this.pendingApprovalCounts.get(this.activeWorkspaceId)
        ? this.activeWorkspaceId
        : [...this.pendingApprovalCounts].find(([, count]) => count > 0)?.[0]);
    this.approvalWorkspaceId = target ?? null;
    if (target)
      void this.open(target)
        .then(async (session) => {
          if (session.approvalError) {
            session.approvalError = null;
            this.changed();
            await session.approvalState?.refresh("manual");
          }
        })
        .catch(() => this.changed());
    this.changed();
  }

  closeApprovals(): void {
    this.approvalWorkspaceId = null;
    this.changed();
  }

  dispose(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.approvalState?.stop();
      session.stopApprovalRecovery?.();
    }
    this.sessions.clear();
    const results = await Promise.allSettled(
      sessions.map((session) => session.client.close()),
    );
    results.push(...(await Promise.allSettled([this.account.close()])));
    this.changed();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new MobileConnectionAggregateError(
        failures,
        "Unable to close all mobile workspace resources",
      );
  }
}

export async function createMobileWorkspaceDirectory(
  stored: StoredMobileConnection,
  signal?: AbortSignal,
): Promise<MobileWorkspaceDirectory> {
  const account = await connectMobileAccount(
    stored,
    Platform.OS === "ios" ? "app-scheme" : "client-loopback",
  );
  const directory = new MobileWorkspaceDirectory(account, stored);
  const onAbort = () => {
    void directory
      .dispose()
      .catch((error) =>
        console.warn(
          "[WorkspaceDirectory] Cancelled connection cleanup failed",
          error,
        ),
      );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new Error("Connection cancelled");
    await directory.init();
    return directory;
  } catch (error) {
    await directory.dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
