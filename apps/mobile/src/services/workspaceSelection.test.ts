import type {
  MobileHubWorkspace,
  MobileHubWorkspaceRoute,
  StoredMobileConnection,
  StoredRoutedMobileConnection,
} from "@vibestudio/mobile-iroh";
import {
  listMobileWorkspaces,
  selectMobileWorkspace,
  type MobileWorkspaceSelectionDependencies,
} from "./workspaceSelection";

jest.mock("@vibestudio/mobile-iroh", () => ({
  loadShellCredential: jest.fn(),
  persistStoredMobileConnection: jest.fn(),
  // Switching re-targets the stored connection: same credential and control
  // reach, new workspace, and the previous workspace's reach is dropped.
  selectMobileConnectionWorkspace: (
    connection: {
      credential: { deviceId: string; refreshToken: string };
      controlPairing: Record<string, unknown>;
      pairedAt: number;
    },
    selectedWorkspaceId: string,
  ) => ({
    schemaVersion: 5,
    transport: "iroh",
    phase: "paired",
    endpointIdentityId: "identity-1",
    credential: connection.credential,
    controlPairing: connection.controlPairing,
    selectedWorkspaceId,
    pairedAt: connection.pairedAt,
  }),
  createRoutedMobileConnection: (
    paired: Record<string, unknown>,
    workspacePairing: Record<string, unknown>,
  ) => ({ ...paired, phase: "routed", workspacePairing }),
}));

const DEVICE_ID = `dev_${"d".repeat(24)}`;
const REFRESH_TOKEN = "r".repeat(43);
const ROTATED_TOKEN = "n".repeat(43);
const CONTROL_PAIRING = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};
const WORKSPACE_A_PAIRING = {
  endpointId: "bb".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};
const WORKSPACE_B_PAIRING = {
  endpointId: "cc".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};
const storedA: StoredRoutedMobileConnection = {
  schemaVersion: 5,
  transport: "iroh",
  phase: "routed",
  endpointIdentityId: "identity-1",
  credential: { deviceId: DEVICE_ID, refreshToken: REFRESH_TOKEN },
  controlPairing: CONTROL_PAIRING,
  selectedWorkspaceId: "ws-a",
  workspacePairing: WORKSPACE_A_PAIRING,
  pairedAt: 123,
};

const workspaces: MobileHubWorkspace[] = [
  {
    workspaceId: "ws-a",
    name: "alpha",
    lastOpened: 10,
    running: true,
  },
  {
    workspaceId: "ws-b",
    name: "beta",
    lastOpened: 5,
    running: false,
  },
];

const routeB: MobileHubWorkspaceRoute = {
  workspace: "beta",
  workspaceId: "ws-b",
  running: true,
  serverUrl: "https://workspace.example",
  workspaceReach: WORKSPACE_B_PAIRING,
  serverId: `srv_${"s".repeat(24)}`,
  serverBootId: `boot_${"b".repeat(24)}`,
};

function dependencies(
  options: {
    events?: string[];
    stored?: StoredMobileConnection | null;
    currentStored?: StoredRoutedMobileConnection;
    route?: () => Promise<MobileHubWorkspaceRoute>;
    reload?: () => Promise<{ reloading: boolean }>;
    persist?: (stored: StoredMobileConnection) => Promise<void>;
  } = {},
): {
  deps: MobileWorkspaceSelectionDependencies;
  listWorkspaces: jest.Mock;
  routeWorkspace: jest.Mock;
  persistCredential: jest.Mock;
} {
  const events = options.events ?? [];
  const listWorkspaces = jest.fn(async () => {
    events.push("list");
    return workspaces;
  });
  const routeWorkspace = jest.fn(
    async ({ workspaceId }: { workspaceId: string }) => {
      events.push(`route:${workspaceId}`);
      return options.route ? options.route() : routeB;
    },
  );
  const persistCredential = jest.fn(async (stored: StoredMobileConnection) => {
    events.push(
      `persist:${
        stored.phase === "routed"
          ? stored.workspacePairing.endpointId.slice(0, 12)
          : stored.phase
      }`,
    );
    await options.persist?.(stored);
  });
  return {
    deps: {
      control: { listWorkspaces, routeWorkspace },
      loadCredential: async () =>
        options.stored === undefined
          ? (options.currentStored ?? storedA)
          : options.stored,
      persistCredential,
      reloadBootstrap: async () => {
        events.push("reload");
        return options.reload ? options.reload() : { reloading: true };
      },
    },
    listWorkspaces,
    routeWorkspace,
    persistCredential,
  };
}

describe("mobile workspace selection", () => {
  it("lists visible workspaces through the stable control connection", async () => {
    const events: string[] = [];
    const { deps, listWorkspaces } = dependencies({ events });

    await expect(listMobileWorkspaces(deps)).resolves.toEqual(workspaces);

    expect(listWorkspaces).toHaveBeenCalledWith();
    expect(events).toEqual(["list"]);
  });

  it("routes over retained control and persists the exact reach before reload", async () => {
    const events: string[] = [];
    const currentStored = {
      ...storedA,
      credential: { ...storedA.credential, refreshToken: ROTATED_TOKEN },
    };
    const { deps, routeWorkspace, persistCredential } = dependencies({
      events,
      currentStored,
    });

    await expect(selectMobileWorkspace("ws-b", deps)).resolves.toEqual(routeB);

    expect(routeWorkspace).toHaveBeenCalledWith({ workspaceId: "ws-b" });
    expect(persistCredential).toHaveBeenCalledTimes(2);
    expect(persistCredential.mock.calls.map(([stored]) => stored)).toEqual([
      {
        ...currentStored,
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      {
        ...currentStored,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing: WORKSPACE_B_PAIRING,
      },
    ]);
    expect(events).toEqual([
      "persist:paired",
      "route:ws-b",
      "persist:cccccccccccc",
      "reload",
    ]);
  });

  it("restores the prior reach and leaves the active session untouched when reload fails", async () => {
    const events: string[] = [];
    const activeWorkspaceClose = jest.fn();
    const { deps, persistCredential } = dependencies({
      events,
      reload: async () => {
        throw new Error("native reload unavailable");
      },
    });

    await expect(selectMobileWorkspace("ws-b", deps)).rejects.toThrow(
      "native reload unavailable",
    );

    expect(persistCredential.mock.calls.map((call) => call[0])).toEqual([
      {
        ...storedA,
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      {
        ...storedA,
        phase: "routed",
        selectedWorkspaceId: "ws-b",
        workspacePairing: WORKSPACE_B_PAIRING,
      },
      storedA,
    ]);
    expect(events).toEqual([
      "persist:paired",
      "route:ws-b",
      "persist:cccccccccccc",
      "reload",
      "persist:bbbbbbbbbbbb",
    ]);
    expect(activeWorkspaceClose).not.toHaveBeenCalled();
  });

  it("does not write or reload when routing fails", async () => {
    const events: string[] = [];
    const { deps, persistCredential } = dependencies({
      events,
      route: async () => {
        throw new Error("membership denied");
      },
    });

    await expect(selectMobileWorkspace("ws-b", deps)).rejects.toThrow(
      "membership denied",
    );
    expect(persistCredential.mock.calls.map((call) => call[0])).toEqual([
      {
        ...storedA,
        phase: "paired",
        selectedWorkspaceId: "ws-b",
        workspacePairing: undefined,
      },
      storedA,
    ]);
    expect(events).toEqual([
      "persist:paired",
      "route:ws-b",
      "persist:bbbbbbbbbbbb",
    ]);
  });
});
