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
        call: jest.fn(async (_target, method) =>
          method === "hubControl.ensureUserWorkspaces"
            ? { personal: entries[1], system: entries[0] }
            : entries,
        ),
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
