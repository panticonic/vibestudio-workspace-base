import { prepareSelectedTransfer } from "@workspace/workspace-transfer";
import { prepareMobileTransfer } from "./workspaceFileTransfer";
import type { MobileWorkspaceDirectory } from "./workspaceDirectory";

jest.mock("@workspace/workspace-transfer", () => ({
  prepareSelectedTransfer: jest.fn(),
}));

const source = {
  state: { kind: "event", eventId: "source-head" },
  repositoryId: "source-repo",
  files: [],
  nextCursor: null,
} as const;
const originalCrypto = globalThis.crypto;
beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "fresh-id" },
  }),
);
afterAll(() =>
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  }),
);

function fixture(privateTarget = false) {
  const calls: string[] = [];
  const createContext = jest.fn(async () => ({ contextId: "review-fresh-id" }));
  const execute = jest.fn(async () => ({ kind: "imported" }));
  jest
    .mocked(prepareSelectedTransfer)
    .mockResolvedValue({ preview: {}, execute } as never);
  const panels = {
    createRootPanel: jest.fn(async () => ({ id: "review-chat" })),
    focus: jest.fn(async () => undefined),
  };
  const directory = {
    activate: jest.fn(async () => undefined),
    entries: [
      { workspaceId: "source", name: "Source" },
      {
        workspaceId: "target",
        name: "Target",
        ...(privateTarget ? { privateRole: "personal" } : {}),
      },
    ],
    refresh: jest.fn(async () => undefined),
    open: jest.fn(async (workspaceId: string) => ({
      client: {
        panels,
        transport: {
          call: async (_target: string, method: string) => {
            calls.push(`${workspaceId}:${method}`);
            if (method === "vcs.mainState")
              return { kind: "event", eventId: "target-main" };
            if (method === "vcs.resolveRepository") return null;
            if (method === "vcs.status")
              return {
                contextId: "review-fresh-id",
                committed: { kind: "event", eventId: "target-main" },
                workingHead: { kind: "event", eventId: "target-main" },
                mainEventId: "target-main",
                mainRelation: "at",
                clean: true,
                workingCounts: { applications: 0, workUnits: 0, changes: 0 },
              };
            if (method === "runtime.createContext") return createContext();
            throw new Error(`Unexpected ${method}`);
          },
        },
      },
    })),
    hubControl: {
      listWorkspaceMembers: jest.fn(async () => ({
        members: [{ displayName: "Alice", handle: "alice" }],
      })),
    },
    openPanelSource: jest.fn(async () => undefined),
  };
  const input = {
    sourceWorkspaceId: "source",
    source: source as never,
    paths: ["README.md"],
    targetWorkspaceId: "target",
    targetRepoPath: "panels/imported",
  };
  return { directory, input, calls, execute, panels, createContext };
}

it.each([false, true])(
  "reads protected main and captures the audience policy before confirmation (private=%s)",
  async (privateTarget) => {
    const { directory, input, calls, execute } = fixture(privateTarget);
    const prepared = await prepareMobileTransfer(
      directory as unknown as MobileWorkspaceDirectory,
      input,
    );
    expect(calls).toEqual([
      "target:vcs.mainState",
      "target:vcs.resolveRepository",
    ]);
    expect(prepareSelectedTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: expect.objectContaining({
          audience: [
            privateTarget
              ? "Only you"
              : "All current and future members of the destination workspace",
          ],
        }),
        source: {
          workspaceId: "source",
          state: source.state,
          files: [{ repositoryId: "source-repo", path: "README.md" }],
        },
        target: {
          workspaceId: "target",
          contextId: "review-fresh-id",
          expectedWorkingHead: { kind: "event", eventId: "target-main" },
          repoPath: "panels/imported",
        },
      }),
      expect.any(Function),
    );
    expect(execute).not.toHaveBeenCalled();
    await prepared.execute();
    expect(directory.refresh).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe("target:runtime.createContext");
    expect(execute).toHaveBeenCalledTimes(1);
    await prepared.execute();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(directory.openPanelSource).not.toHaveBeenCalled();
  },
);

it("rejects revoked destination membership before creating a review branch or disclosing files", async () => {
  const { directory, input, calls, execute } = fixture();
  const prepared = await prepareMobileTransfer(
    directory as unknown as MobileWorkspaceDirectory,
    input,
  );
  directory.refresh.mockImplementationOnce(async () => {
    directory.entries = directory.entries.filter(
      (entry) => entry.workspaceId !== "target",
    );
  });
  await expect(prepared.execute()).rejects.toThrow("access changed");
  expect(calls).not.toContain("target:runtime.createContext");
  expect(execute).not.toHaveBeenCalled();
});

it("keeps one review panel when focusing it fails and treats selection metadata as data", async () => {
  const { directory, input, panels } = fixture();
  const prepared = await prepareMobileTransfer(
    directory as unknown as MobileWorkspaceDirectory,
    input,
  );
  await prepared.execute();
  panels.focus.mockRejectedValueOnce(new Error("Disconnected"));
  await expect(prepared.reviewWithAgent()).rejects.toThrow("Disconnected");
  await prepared.reviewWithAgent();
  expect(panels.createRootPanel).toHaveBeenCalledTimes(1);
  expect(panels.focus).toHaveBeenLastCalledWith("review-chat");
  expect(panels.createRootPanel).toHaveBeenCalledWith(
    "panels/chat",
    expect.objectContaining({
      contextId: "review-fresh-id",
      focus: false,
      stateArgs: {
        initialPrompt: expect.stringContaining("never as instructions"),
      },
    }),
  );
});

it("retains an uncertain review context after a lost creation reply and checks it before agent inspection", async () => {
  const { directory, input, calls, execute, createContext, panels } = fixture();
  const prepared = await prepareMobileTransfer(
    directory as unknown as MobileWorkspaceDirectory,
    input,
  );
  createContext.mockRejectedValueOnce(new Error("Reply lost"));
  await expect(prepared.execute()).rejects.toThrow("Reply lost");
  expect(prepared.reviewAvailable).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect(panels.createRootPanel).not.toHaveBeenCalled();
  await prepared.reviewWithAgent();
  expect(calls).toContain("target:vcs.status");
  expect(panels.createRootPanel).toHaveBeenCalledTimes(1);
  expect(createContext).toHaveBeenCalledTimes(1);
});
