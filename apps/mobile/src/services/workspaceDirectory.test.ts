import type { PendingApproval } from "@vibestudio/shared/approvals";
import { MobileWorkspaceDirectory } from "./workspaceDirectory";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import type {
  StoredMobileConnection,
  MobileWorkspaceAccount,
} from "@vibestudio/mobile-iroh";

const mockClients: Array<{ config: Record<string, any>; client: any }> = [];
const mockOpening = new Map<string, Promise<void>>();
jest.mock("./shellClient", () => ({
  ShellClient: jest.fn().mockImplementation((config) => {
    const client = {
      workspaceId: config["workspaceId"],
      workspaceName: config.workspaceName,
      transport: {
        status: "connected",
        serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa",
      },
      hostLaunch: config["appSourceClient"]?.hostLaunch ?? {
        source: "apps/mobile",
      },
      events: {
        subscribe: jest.fn(async () => undefined),
        unsubscribe: jest.fn(async () => undefined),
        on: jest.fn(() => () => {}),
      },
      shellApproval: { listPending: jest.fn(async () => []) },
      onRecoveryComplete: jest.fn(() => () => {}),
      serverUrl: `http://localhost/${config["workspaceId"]}`,
      init: jest.fn(async () => {
        await config.connectWorkspace(() => undefined);
        await mockOpening.get(config["workspaceId"]);
      }),
      close: jest.fn(async () => undefined),
      dispose: jest.fn(),
      refreshAccountProfile: jest.fn(async () => ({ userId: "alice" })),
      panels: {
        focus: jest.fn(async () => undefined),
        createAboutPanel: jest.fn(async () => ({ id: "new-panel" })),
        createRootPanel: jest.fn(async () => ({ id: "destination-panel" })),
      },
    };
    mockClients.push({ config, client });
    return client;
  }),
}));
jest.mock("@vibestudio/mobile-iroh", () => ({
  connectMobileAccount: jest.fn(),
  MobileConnectionAggregateError: AggregateError,
}));
jest.mock("@vibestudio/service-schemas/clients/eventsClient", () => ({
  EventsClient: jest.fn().mockImplementation(() => ({
    subscribe: jest.fn(async () => undefined),
    unsubscribe: jest.fn(async () => undefined),
    on: jest.fn(() => () => {}),
  })),
}));

const entries = [
  {
    workspaceId: "system",
    name: "System",
    privateRole: "system",
    running: true,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
  {
    workspaceId: "personal",
    name: "Personal",
    privateRole: "personal",
    running: true,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
  {
    workspaceId: "project",
    name: "Project",
    running: false,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
];
function fixture() {
  const account = {
    control: {
      rpc: {
        call: jest.fn(async (_target, method) => {
          if (method === "hubControl.ensureUserWorkspaces")
            return { personal: entries[1], system: entries[0] };
          if (method === "shellApproval.listPending") return [];
          return entries;
        }),
      },
    },
    openWorkspace: jest.fn(
      async (_workspaceId: string, _onRecovery?: unknown) => ({}),
    ),
    close: jest.fn(async () => undefined),
  };
  const stored = {
    controlPairing: { endpointId: "a".repeat(64) },
    credential: { deviceId: "device-a" },
  };
  const directory = new MobileWorkspaceDirectory(
    account as unknown as MobileWorkspaceAccount,
    stored as StoredMobileConnection,
  );
  return { directory, account };
}

beforeEach(() => {
  mockClients.length = 0;
  mockOpening.clear();
});

describe("mobile workspace directory", () => {
  it("merges hub approvals without creating a fake workspace session", async () => {
    const { directory, account } = fixture();
    await directory.init();
    const request = {
      approvalId: "hub-review",
      callerId: "hub-control",
      callerKind: "worker" as const,
      repoPath: "workers/account-task",
      effectiveVersion: "v1",
      requestedByUserId: "alice",
      requestedAt: 1,
      kind: "capability" as const,
      capability: "account.manage",
      title: "Manage account",
    };
    (account.control.rpc.call as jest.Mock).mockImplementation(
      async (_target, method) => {
        if (method === "hubControl.ensureUserWorkspaces")
          return { personal: entries[1], system: entries[0] };
        if (method === "shellApproval.listPending") return [request];
        return entries;
      },
    );

    await directory.hubApproval.approvalState!.refresh("manual");

    expect(directory.approvalItems).toEqual([
      expect.objectContaining({
        owner: { kind: "hub" },
        approvalId: "hub-review",
      }),
    ]);
    expect(directory.selectedApprovalOwner).toBe(directory.hubApproval);
    expect(directory.approvalCount).toBe(1);
    expect(directory.sessions.has("hub")).toBe(false);
    await directory.dispose();
  });

  it("retains a visible account queue error until a successful refresh", async () => {
    const { directory, account } = fixture();
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    await directory.init();
    jest
      .mocked(account.control.rpc.call)
      .mockRejectedValueOnce(new Error("account queue unavailable"));
    await directory.hubApproval.approvalState!.refresh("manual");
    expect(directory.approvalOwnerErrors).toEqual([
      "Account: account queue unavailable",
    ]);
    expect(directory.failedApprovalOwners).toEqual([directory.hubApproval]);
    jest.mocked(account.control.rpc.call).mockResolvedValueOnce([]);
    await directory.retryFailedApprovalOwners();
    expect(directory.approvalOwnerErrors).toEqual([]);
    expect(directory.failedApprovalOwners).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[WorkspaceDirectory] Account approval refresh:manual failed",
      expect.any(Error),
    );
    warn.mockRestore();
    await directory.dispose();
  });

  it("keeps the System app source separate from lazily opened workspace clients", async () => {
    const { directory, account } = fixture();
    await directory.init();
    expect(account.openWorkspace.mock.calls.map(([id]) => id)).toEqual([
      "system",
      "personal",
    ]);
    const system = directory.sessions.get("system")!;
    const personal = directory.sessions.get("personal")!;
    expect(
      mockClients.find(({ config }) => config["workspaceId"] === "personal")
        ?.config["appSourceClient"],
    ).toBe(system.client);
    expect(personal.store.get(shellClientAtom)).toBe(personal.client);
    expect(directory.presented.has("system")).toBe(false);
    await directory.toggleExpanded("project");
    expect(directory.sessions.get("project")?.state).toBe("ready");
    expect(directory.activeWorkspaceId).toBe("personal");
    expect(directory.presented.has("project")).toBe(false);
    await directory.dispose();
  });

  it("preserves separate panel focus for identical slot ids across workspace switches", async () => {
    const { directory } = fixture();
    await directory.init();
    const personal = directory.sessions.get("personal")!;
    personal.store.set(activePanelIdAtom, "personal-panel");
    await directory.activate("project", "project-panel");
    const project = directory.sessions.get("project")!;
    project.store.set(activePanelIdAtom, "project-panel");
    await directory.activate("personal");
    expect(directory.sessions.get("personal")).toBe(personal);
    expect(personal.store.get(activePanelIdAtom)).toBe("personal-panel");
    expect(project.store.get(activePanelIdAtom)).toBe("project-panel");
    expect(project.client.panels.focus).toHaveBeenCalledWith("project-panel");
    expect(personal.client.panels.focus).not.toHaveBeenCalledWith(
      "project-panel",
    );
    await directory.dispose();
  });

  it("does not let a slow opening reclaim focus or mutate another workspace client", async () => {
    const { directory } = fixture();
    await directory.init();
    let finish!: () => void;
    mockOpening.set(
      "project",
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const opening = directory.activate("project");
    const second = directory.open("project");
    await directory.activate("personal");
    finish();
    await opening;
    await second;
    expect(directory.activeWorkspaceId).toBe("personal");
    expect(
      mockClients.filter(({ config }) => config["workspaceId"] === "project"),
    ).toHaveLength(1);
    await directory.dispose();
  });

  it("keeps the latest panel choice while the same workspace is opening", async () => {
    const { directory } = fixture();
    await directory.init();
    let finish!: () => void;
    mockOpening.set(
      "project",
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const first = directory.activate("project", "older-panel");
    const second = directory.activate("project", "newer-panel");
    finish();
    await Promise.all([first, second]);
    const session = directory.sessions.get("project")!;
    expect(session.client.panels.focus).toHaveBeenCalledTimes(1);
    expect(session.client.panels.focus).toHaveBeenCalledWith("newer-panel");
    await directory.dispose();
  });

  it("creates in the captured workspace without reclaiming focus after another gesture", async () => {
    const { directory } = fixture();
    await directory.init();
    const personal = directory.sessions.get("personal")!;
    let finish!: (value: { id: string; title: string }) => void;
    jest.mocked(personal.client.panels.createAboutPanel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const creating = directory.createPanel("personal");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await directory.activate("project");
    finish({ id: "captured-new-panel", title: "New panel" });
    await creating;
    expect(directory.activeWorkspaceId).toBe("project");
    expect(personal.client.panels.focus).toHaveBeenCalledWith(
      "captured-new-panel",
    );
    expect(
      directory.sessions.get("project")!.client.panels.createAboutPanel,
    ).not.toHaveBeenCalled();
    await directory.dispose();
  });

  it("rejects notification targets belonging to another user before opening their workspace", async () => {
    const { directory, account } = fixture();
    await directory.init();
    await expect(
      directory.resolveNotificationWorkspace({
        serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa",
        userId: "bob",
        workspaceId: "project",
      }),
    ).rejects.toThrow("another account");
    expect(account.openWorkspace).toHaveBeenCalledTimes(2);
    await expect(
      directory.openApproval({
        serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa",
        userId: "bob",
        workspaceId: "project",
        approvalId: "wrong-account-review",
      }),
    ).rejects.toThrow("another account");
    expect(directory.approvalWorkspaceId).toBeNull();
    expect(account.openWorkspace).toHaveBeenCalledTimes(2);
    await directory.dispose();
  });
});

it("opens a referenced source in its accessible owning workspace without moving a source panel", async () => {
  const { directory } = fixture();
  await directory.init();
  const personal = directory.sessions.get("personal")!;
  await directory.openPanelSource("project", "panels/chat", {
    ref: "feature",
    contextId: "target-context",
    stateArgs: { document: "notes" },
    focus: true,
  });
  const project = directory.sessions.get("project")!;
  expect(project.client.panels.createRootPanel).toHaveBeenCalledWith(
    "panels/chat",
    {
      ref: "feature",
      contextId: "target-context",
      stateArgs: { document: "notes" },
      focus: true,
    },
  );
  expect(personal.client.panels.createRootPanel).not.toHaveBeenCalled();
  expect(directory.activeWorkspaceId).toBe("project");
  await expect(
    directory.openPanelSource("unavailable", "about/new", {}),
  ).rejects.toThrow("access");
  expect(directory.activeWorkspaceId).toBe("project");
  await directory.dispose();
});

it("shows unopened workspace attention without opening sessions and removes revoked entries", async () => {
  const { directory, account } = fixture();
  await directory.init();
  account.control.rpc.call.mockResolvedValueOnce(
    entries.map((entry) => ({
      ...entry,
      pendingApprovalCount: entry.workspaceId === "project" ? 3 : 0,
    })),
  );
  await directory.refresh();
  expect(directory.pendingApprovalCounts.get("project")).toBe(3);
  expect(directory.approvalCount).toBe(3);
  expect(account.openWorkspace).toHaveBeenCalledTimes(2);
  directory.openApprovals("project");
  await directory.open("project");
  expect(directory.activeWorkspaceId).toBe("personal");
  expect(account.openWorkspace).toHaveBeenCalledWith(
    "project",
    expect.any(Function),
  );
  account.control.rpc.call.mockResolvedValueOnce(
    entries.filter((entry) => entry.workspaceId !== "project"),
  );
  await directory.refresh();
  expect(directory.pendingApprovalCounts.has("project")).toBe(false);
  await directory.dispose();
});

it("presents background approvals without switching workspace, preserves selection, and navigates colliding IDs safely", async () => {
  const { directory } = fixture();
  await directory.init();
  const system = directory.sessions.get("system")!;
  const personal = directory.sessions.get("personal")!;
  const request = {
    approvalId: "same-id",
    callerId: "worker-1",
    callerKind: "worker" as const,
    repoPath: "workers/example",
    effectiveVersion: "v1",
    requestedAt: 1,
    kind: "capability" as const,
    capability: "read",
    title: "Read document",
  };
  jest
    .mocked(system.client.shellApproval.listPending)
    .mockResolvedValue([request]);
  await system.approvalState!.refresh("manual");
  expect(directory.approvalWorkspaceId).toBe("system");
  expect(directory.activeWorkspaceId).toBe("personal");
  directory.closeApprovals();
  await system.approvalState!.refresh("manual");
  expect(directory.approvalWorkspaceId).toBeNull();
  jest
    .mocked(personal.client.shellApproval.listPending)
    .mockResolvedValue([request]);
  await personal.approvalState!.refresh("manual");
  expect(directory.approvalWorkspaceId).toBe("system");
  directory.stepApproval(-1);
  expect(directory.approvalWorkspaceId).toBe("personal");
  expect(directory.activeWorkspaceId).toBe("personal");
  jest.mocked(personal.client.shellApproval.listPending).mockResolvedValue([]);
  await personal.approvalState!.refresh("manual");
  expect(directory.approvalWorkspaceId).toBe("system");
  directory.closeApprovals();
  await expect(
    directory.selectApproval("system", "missing-review"),
  ).rejects.toThrow("no longer pending");
  expect(directory.approvalWorkspaceId).toBeNull();
  await directory.selectApproval("system", "same-id");
  expect(directory.approvalWorkspaceId).toBe("system");
  expect(directory.activeWorkspaceId).toBe("personal");
  await directory.dispose();
});

it("loads unopened pending owners into the global queue without presenting or focusing their panels", async () => {
  const { directory, account } = fixture();
  await directory.init();
  const request = {
    approvalId: "same-id",
    callerId: "worker-1",
    callerKind: "worker" as const,
    repoPath: "workers/example",
    effectiveVersion: "v1",
    requestedAt: 1,
    kind: "capability" as const,
    capability: "read",
    title: "Read document",
  };
  const personal = directory.sessions.get("personal")!;
  jest
    .mocked(personal.client.shellApproval.listPending)
    .mockResolvedValue([request]);
  await personal.approvalState!.refresh("manual");
  directory.updateApprovalCount("project", 1);
  let finish!: () => void;
  mockOpening.set(
    "project",
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  directory.openApprovals();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(account.openWorkspace).toHaveBeenCalledWith(
    "project",
    expect.any(Function),
  );
  expect(directory.unloadedApprovalWorkspaces).toEqual([
    expect.objectContaining({ state: "loading" }),
  ]);
  expect(directory.activeWorkspaceId).toBe("personal");
  expect(directory.presented.has("project")).toBe(false);
  const project = directory.sessions.get("project")!;
  jest
    .mocked(project.client.shellApproval.listPending)
    .mockResolvedValue([request]);
  finish();
  await directory.open("project");
  await project.approvalState!.refresh("manual");
  expect(
    directory.approvalItems.map(({ owner }) =>
      owner.kind === "workspace" ? owner.workspaceId : "hub",
    ),
  ).toEqual(["personal", "project"]);
  expect(directory.approvalWorkspaceId).toBe("personal");
  directory.stepApproval(1);
  expect(directory.approvalWorkspaceId).toBe("project");
  expect(directory.activeWorkspaceId).toBe("personal");
  expect(directory.presented.has("project")).toBe(false);
  await directory.dispose();
});

it("does not reopen a dismissed shared queue when an earlier exact selection finishes refreshing", async () => {
  const { directory } = fixture();
  await directory.init();
  const system = directory.sessions.get("system")!;
  const request = {
    approvalId: "exact-review",
    callerId: "worker-1",
    callerKind: "worker" as const,
    repoPath: "workers/example",
    effectiveVersion: "v1",
    requestedAt: 1,
    kind: "capability" as const,
    capability: "read",
    title: "Read document",
  };
  jest
    .mocked(system.client.shellApproval.listPending)
    .mockResolvedValue([request]);
  await system.approvalState!.refresh("manual");
  let finish!: () => void;
  jest.spyOn(system.approvalState!, "refresh").mockImplementationOnce(
    () =>
      new Promise<PendingApproval[]>((resolve) => {
        finish = () => resolve([request]);
      }),
  );
  const selecting = directory.selectApproval("system", "exact-review");
  await new Promise((resolve) => setTimeout(resolve, 0));
  directory.closeApprovals();
  finish();
  await selecting;
  expect(directory.approvalWorkspaceId).toBeNull();
  expect(directory.activeWorkspaceId).toBe("personal");
  await directory.dispose();
});
