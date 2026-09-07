import {
  listMobileWorkspaces,
  selectMobileWorkspace,
  type MobileWorkspaceSelectionDependencies,
} from "./workspaceSelection";

describe("mobile workspace selection", () => {
  const dependencies = (): MobileWorkspaceSelectionDependencies => ({
    listWorkspaces: jest.fn(async () => [
      {
        workspaceId: "personal",
        name: "Personal",
        running: true,
        lastOpened: 0,
        pendingApprovalCount: 0,
      },
    ]),
    activateWorkspace: jest.fn(async () => undefined),
  });
  it("lists the account directory without opening workspace sessions", async () => {
    const deps = dependencies();
    await expect(listMobileWorkspaces(deps)).resolves.toMatchObject([
      { workspaceId: "personal" },
    ]);
    expect(deps.activateWorkspace).not.toHaveBeenCalled();
  });
  it("switches through the retained workspace directory", async () => {
    const deps = dependencies();
    await selectMobileWorkspace("project", deps);
    expect(deps.activateWorkspace).toHaveBeenCalledWith("project");
  });
  it("keeps routing failures visible and does not redirect to another workspace", async () => {
    const deps = dependencies();
    jest
      .mocked(deps.activateWorkspace)
      .mockRejectedValue(new Error("Membership removed"));
    await expect(selectMobileWorkspace("project", deps)).rejects.toThrow(
      "Membership removed",
    );
    expect(deps.activateWorkspace).toHaveBeenCalledTimes(1);
  });
  it("rejects ambiguous workspace identities before activation", async () => {
    const deps = dependencies();
    await expect(selectMobileWorkspace(" project ", deps)).rejects.toThrow(
      "valid workspace",
    );
    expect(deps.activateWorkspace).not.toHaveBeenCalled();
  });
});
