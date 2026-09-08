import { submitWorkspaceCreation, readWorkspaceCreationSubmission } from "@vibestudio/service-schemas/clients/workspaceCreationClient";
import type { WorkspaceCreationReceipt } from "@vibestudio/workspace-contracts/types";
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
import { actionableRuntimeApprovals } from "@vibestudio/shared/approvalVisibility";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  type WorkspacePushScope,
  type WorkspaceApprovalTarget,
} from "@vibestudio/shared/workspacePushScope";
import {
  approvalPresentationKey,
  createApprovalPresentationState,
  reconcileApprovalPresentation,
  selectApprovalPresentation,
  stepApprovalPresentation,
} from "@vibestudio/shared/approvalPresentation";
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
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { RpcDestination } from "@vibestudio/rpc";
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

export interface MobileApprovalOwner {
  readonly owner: RpcDestination;
  readonly label: string;
  readonly shellApproval: MobileWorkspaceSession["client"]["shellApproval"];
  readonly events: EventsClient;
  readonly session?: MobileWorkspaceSession;
  approvals: PendingApproval[] | null;
  approvalState: ApprovalStateController | null;
  approvalError: string | null;
}

/** Account-owned directory. A workspace's client and UI store are never rebound. */
export class MobileWorkspaceDirectory {
  readonly sessions = new Map<string, MobileWorkspaceSession>();
  readonly workspaceApprovalOwners = new Map<string, MobileApprovalOwner>();
  readonly expanded = new Set<string>();
  readonly presented = new Set<string>();
  readonly hubControl;
  readonly hubApproval: MobileApprovalOwner;
  entries: MobileHubWorkspace[] = [];
  activeWorkspaceId: string | null = null;
  personalWorkspaceId = "";
  systemWorkspaceId = "";
  error: string | null = null;
  workspaceCreation: { template?: TemplateExactPin; sourceUrl?: string } | null = null;
  /** Account metadata for unopened workspaces; live controllers refine connected queues. */
  readonly pendingApprovalCounts = new Map<string, number>();
  approvalPresentation = createApprovalPresentationState();
  private requestedApproval: {
    workspaceId: string;
    approvalId?: string;
    phase?: "loading";
  } | null = null;

  get approvalItems() {
    const workspaceItems = this.entries.flatMap((entry) =>
      (this.sessions.get(entry.workspaceId)?.approvals ?? []).map(
        (approval) => ({
          owner: { kind: "workspace" as const, workspaceId: entry.workspaceId },
          workspaceId: entry.workspaceId,
          approvalId: approval.approvalId,
          actionable: approval.lifecycle?.state !== "preparing",
          approval,
        }),
      ),
    );
    return [
      ...(this.hubApproval.approvals ?? []).map((approval) => ({
        owner: this.hubApproval.owner,
        approvalId: approval.approvalId,
        actionable: approval.lifecycle?.state !== "preparing",
        approval,
      })),
      ...workspaceItems,
    ];
  }

  get selectedApproval() {
    return this.approvalItems.find(
      (item) =>
        approvalPresentationKey(item) === this.approvalPresentation.selectedKey,
    );
  }

  get approvalWorkspaceId(): string | null {
    return (
      (this.requestedApproval?.phase === "loading"
        ? null
        : this.requestedApproval?.workspaceId) ??
      (this.approvalPresentation.open
        ? this.selectedApproval?.owner.kind === "workspace"
          ? this.selectedApproval.owner.workspaceId
          : null
        : null)
    );
  }

  get selectedApprovalOwner(): MobileApprovalOwner | null {
    const selected = this.selectedApproval;
    if (!selected) return null;
    if (selected.owner.kind === "hub") return this.hubApproval;
    return this.workspaceApprovalOwners.get(selected.owner.workspaceId) ?? null;
  }

  get approvalOwnerErrors(): string[] {
    return [
      ...(this.hubApproval.approvalError
        ? [`Account: ${this.hubApproval.approvalError}`]
        : []),
      ...[...this.sessions.values()].flatMap((session) =>
        session.approvalError
          ? [`${session.client.workspaceName}: ${session.approvalError}`]
          : [],
      ),
    ];
  }

  get failedApprovalOwners(): readonly MobileApprovalOwner[] {
    return [
      ...(this.hubApproval.approvalError ? [this.hubApproval] : []),
      ...[...this.workspaceApprovalOwners.values()].filter(
        (owner) => owner.approvalError,
      ),
    ];
  }

  async retryFailedApprovalOwners(): Promise<void> {
    const failed = this.failedApprovalOwners;
    await Promise.all(
      failed.map(async (owner) => {
        const controller = owner.approvalState;
        if (!controller) return;
        await controller.refresh("manual");
      }),
    );
  }

  stepApproval(delta: number): void {
    this.requestedApproval = null;
    this.approvalPresentation = stepApprovalPresentation(
      this.approvalPresentation,
      this.approvalItems,
      delta,
    );
    this.changed();
  }

  private reconcileApprovals(): void {
    const wasOpen =
      this.approvalPresentation.open || this.requestedApproval !== null;
    const items = this.approvalItems;
    this.approvalPresentation = reconcileApprovalPresentation(
      this.approvalPresentation,
      items,
    );
    const requested = this.requestedApproval;
    if (requested?.phase === "loading") return;
    if (requested) {
      const item = items.find(
        (item) =>
          item.owner.kind === "workspace" &&
          item.owner.workspaceId === requested.workspaceId &&
          (!requested.approvalId || item.approvalId === requested.approvalId),
      );
      if (item) {
        this.approvalPresentation = selectApprovalPresentation(
          this.approvalPresentation,
          items,
          approvalPresentationKey(item),
        );
        this.requestedApproval = null;
      } else if (
        this.sessions.get(requested.workspaceId)?.approvals !== null &&
        this.sessions.get(requested.workspaceId)?.state === "ready"
      ) {
        this.requestedApproval = null;
      }
    }
    if (!this.requestedApproval && wasOpen && !items.length) {
      const loading = this.unloadedApprovalWorkspaces.find(
        ({ state }) => state !== "unopened",
      );
      if (loading)
        this.requestedApproval = { workspaceId: loading.entry.workspaceId };
    }
  }
  private revision = 0;
  private selectionGeneration = 0;
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
        account.control.rpc.call("main", `hubControl.${method}`, args, {
          authorityAcquisition: "wait",
        }),
    );
    const shellApproval = createTypedServiceClient(
      "shellApproval",
      shellApprovalMethods,
      (_service, method, args) =>
        account.control.rpc.call("main", `shellApproval.${method}`, args),
    );
    this.hubApproval = {
      owner: { kind: "hub" },
      label: "Account",
      shellApproval,
      events: new EventsClient(account.control.rpc),
      approvals: null,
      approvalState: null,
      approvalError: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): number => this.revision;
  private changed(): void {
    this.reconcileApprovals();
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    this.startHubApprovalState();
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

  private startHubApprovalState(): void {
    const owner = this.hubApproval;
    owner.approvalState = createApprovalStateController({
      listPending: () => owner.shellApproval.listPending(),
      subscribePendingChanged: () =>
        owner.events.subscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
      unsubscribePendingChanged: () =>
        owner.events.unsubscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT),
      onPendingChanged: (listener) =>
        owner.events.on(SHELL_APPROVAL_PENDING_CHANGED_EVENT, listener),
      filter: filterRuntimeApprovals,
      onChange: (pending) => {
        if (this.disposed) return;
        owner.approvals = pending;
        owner.approvalError = null;
        this.changed();
      },
      onError: (error, phase) => {
        if (this.disposed) return;
        owner.approvalError =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[WorkspaceDirectory] Account approval ${phase} failed`,
          error,
        );
        this.changed();
      },
    });
    owner.approvalState.start();
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
          if (this.requestedApproval?.workspaceId === id)
            this.requestedApproval = null;
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
          this.workspaceApprovalOwners.delete(id);
          this.expanded.delete(id);
          this.presented.delete(id);
          this.pendingApprovalCounts.delete(id);
          if (this.requestedApproval?.workspaceId === id)
            this.requestedApproval = null;
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
    const approvalOwner: MobileApprovalOwner = {
      owner: { kind: "workspace", workspaceId },
      label: client.workspaceName,
      shellApproval: client.shellApproval,
      events: client.events,
      session,
      approvals: null,
      approvalState: null,
      approvalError: null,
    };
    this.sessions.set(workspaceId, session);
    this.workspaceApprovalOwners.set(workspaceId, approvalOwner);
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
            if (this.sessions.get(workspaceId) !== session || this.disposed)
              return;
            session.approvals = pending;
            session.approvalError = null;
            approvalOwner.approvals = pending;
            approvalOwner.approvalError = null;
            this.updateApprovalCount(
              workspaceId,
              actionableRuntimeApprovals(pending).length,
            );
            this.changed();
          },
          onError: (error, phase) => {
            session.approvalError =
              error instanceof Error ? error.message : String(error);
            approvalOwner.approvalError = session.approvalError;
            console.warn(
              `[WorkspaceDirectory] Approval ${phase} failed in ${workspaceId}`,
              error,
            );
            this.changed();
          },
        });
        approvalOwner.approvalState = session.approvalState;
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
    const selectionGeneration = ++this.selectionGeneration;
    this.activeWorkspaceId = workspaceId;
    this.presented.add(workspaceId);
    this.expanded.add(workspaceId);
    this.changed();
    const session = await this.open(workspaceId);
    if (selectionGeneration !== this.selectionGeneration) return;
    if (panelId) await session.client.panels.focus(panelId);
    // A slower workspace opening cannot take focus back from a later gesture.
    if (selectionGeneration !== this.selectionGeneration) return;
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

  requestWorkspaceCreation(source: { template?: TemplateExactPin; sourceUrl?: string } = {}): void {
    this.workspaceCreation = source;
    this.changed();
  }

  closeWorkspaceCreation(): void {
    this.workspaceCreation = null;
    this.changed();
  }

  async inspectWorkspaceTemplate(locator: import("@vibestudio/service-schemas/templates").TemplateLocator) {
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
    return templates.inspect(locator);
  }

  async listWorkspaceTemplateCandidates() {
    return this.hubControl.listTemplateCandidates();
  }

  async pendingWorkspaceCreation() {
    const profile = await this.hubControl.getProfile(undefined);
    if (!profile) throw new Error("The authenticated account is unavailable.");
    return readWorkspaceCreationSubmission(await getNativeAppStorage().getItem(`workspace-creation:${profile.userId}`));
  }

  async createWorkspace(
    name: string,
    rootTemplate?: TemplateExactPin,
  ): Promise<WorkspaceCreationReceipt> {
    const profile = await this.hubControl.getProfile(undefined);
    if (!profile) throw new Error("The authenticated account is unavailable; workspace creation was not submitted.");
    const storage = getNativeAppStorage();
    const receipt = await submitWorkspaceCreation(this.hubControl, {
      workspace: name, ...(rootTemplate ? { rootTemplate } : {}),
    }, {
      key: `workspace-creation:${profile.userId}`,
      getItem: key => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: key => storage.removeItem(key),
      newOperationId: () => crypto.randomUUID(),
    });
    await this.refresh();
    return receipt;
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
    this.changed();
  }

  get approvalCount(): number {
    return (
      actionableRuntimeApprovals(this.hubApproval.approvals ?? []).length +
      [...this.pendingApprovalCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      )
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
    await this.requestApproval(target.workspaceId, target.approvalId, () =>
      this.resolveNotificationWorkspace(target),
    );
  }

  get unloadedApprovalWorkspaces() {
    return this.entries.flatMap((entry) => {
      if (!(this.pendingApprovalCounts.get(entry.workspaceId) ?? 0)) return [];
      const session = this.sessions.get(entry.workspaceId);
      if (
        session?.state === "ready" &&
        session.approvals !== null &&
        !session.approvalError
      )
        return [];
      const state = !session
        ? "unopened"
        : session.state === "failed" || session.approvalError
          ? "failed"
          : "loading";
      return [{ entry, state }];
    });
  }

  openApprovals(workspaceId?: string): void {
    const pendingOwners = [...this.pendingApprovalCounts]
      .filter(([, count]) => count > 0)
      .map(([id]) => id);
    const target =
      workspaceId ?? (this.selectedApproval ? undefined : pendingOwners[0]);
    this.requestedApproval = target ? { workspaceId: target } : null;
    this.approvalPresentation = { ...this.approvalPresentation, open: true };
    // Opening the shared queue connects its pending owners, without presenting
    // their panel trees or changing the user's focused workspace.
    for (const ownerId of new Set([
      ...pendingOwners,
      ...(target ? [target] : []),
    ])) {
      void this.open(ownerId)
        .then(async (session) => {
          if (session.approvalError) {
            session.approvalError = null;
            this.changed();
            await session.approvalState?.refresh("manual");
          }
        })
        .catch(() => this.changed());
    }
    this.changed();
  }

  selectApproval(workspaceId: string, approvalId: string): Promise<void> {
    return this.requestApproval(workspaceId, approvalId, () =>
      this.open(workspaceId),
    );
  }

  private async requestApproval(
    workspaceId: string,
    approvalId: string,
    resolveSession: () => Promise<MobileWorkspaceSession>,
  ): Promise<void> {
    const request: NonNullable<MobileWorkspaceDirectory["requestedApproval"]> =
      { workspaceId, approvalId, phase: "loading" };
    this.requestedApproval = request;
    // Verification/loading owns an intent, not authority to show another
    // request. Later Close, Next, or Open gestures retire this exact intent.
    try {
      const session = await resolveSession();
      if (this.requestedApproval !== request) return;
      await session.approvalState?.refresh("manual");
      if (this.requestedApproval !== request) return;
      if (
        this.sessions.get(workspaceId) !== session ||
        !session.approvals?.some(
          (approval) => approval.approvalId === approvalId,
        )
      ) {
        throw new Error("This review is no longer pending.");
      }
      delete request.phase;
      this.changed();
    } catch (error) {
      if (this.requestedApproval !== request) return;
      this.requestedApproval = null;
      this.changed();
      throw error;
    }
  }

  closeApprovals(): void {
    this.requestedApproval = null;
    this.approvalPresentation = { ...this.approvalPresentation, open: false };
    this.changed();
  }

  dispose(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    this.disposed = true;
    this.hubApproval.approvalState?.stop();
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      session.approvalState?.stop();
      session.stopApprovalRecovery?.();
    }
    this.sessions.clear();
    this.workspaceApprovalOwners.clear();
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
