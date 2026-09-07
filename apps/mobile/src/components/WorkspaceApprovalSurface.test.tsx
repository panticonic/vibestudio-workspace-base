import { render } from "@testing-library/react-native";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";
import type { ApprovalSheetProps } from "./ApprovalSheet";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import { WorkspaceApprovalSurface } from "./WorkspaceApprovalSurface";

let mockSheet: ApprovalSheetProps;
jest.mock("./ApprovalSheet", () => ({
  ApprovalSheet: (props: ApprovalSheetProps) => {
    mockSheet = props;
    return null;
  },
}));

function fixture() {
  const approval = {
    approvalId: "same-id",
    kind: "capability",
    title: "Read",
    capability: "read",
  };
  const system = {
    workspaceId: "system",
    approvals: [approval],
    client: {
      workspaceName: "System",
      shellApproval: { resolve: jest.fn(async (): Promise<void> => undefined) },
    },
    approvalState: { refresh: jest.fn(async () => undefined) },
  };
  const personal = {
    ...system,
    workspaceId: "personal",
    client: {
      workspaceName: "Personal",
      shellApproval: { resolve: jest.fn(async (): Promise<void> => undefined) },
    },
  };
  const item = (workspaceId: string) => ({
    owner: { kind: "workspace" as const, workspaceId },
    workspaceId,
    approvalId: approval.approvalId,
    actionable: true,
    approval,
  });
  const directory: any = {
    entries: [
      { workspaceId: "system", name: "System" },
      { workspaceId: "personal", name: "Personal" },
    ],
    sessions: new Map([
      ["system", system],
      ["personal", personal],
    ]),
    workspaceApprovalOwners: new Map(),
    approvalItems: [item("system"), item("personal")],
    unloadedApprovalWorkspaces: [],
    selectedApproval: item("system"),
    selectedApprovalOwner: null,
    approvalOwnerErrors: [],
    approvalPresentation: {
      selectedKey: approvalPresentationKey(item("system")),
      open: true,
    },
    stepApproval: jest.fn(),
    closeApprovals: jest.fn(),
    activate: jest.fn(),
  };
  const owner = {
    owner: { kind: "workspace" as const, workspaceId: "system" },
    label: "System",
    shellApproval: system.client.shellApproval,
    events: {},
    session: system,
    approvals: system.approvals,
    approvalState: system.approvalState,
    approvalError: null,
  };
  directory.workspaceApprovalOwners.set("system", owner);
  directory.selectedApprovalOwner = owner;
  const rendered = render(
    <WorkspaceApprovalSurface
      directory={directory as unknown as MobileWorkspaceDirectory}
      owner={owner as never}
      notify={jest.fn()}
    />,
  );
  return { directory, system, personal, rendered, approval };
}

it("keeps a submitted decision and its refresh on the captured workspace", async () => {
  const { directory, system, personal } = fixture();
  let finish!: () => void;
  system.client.shellApproval.resolve.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = mockSheet.onResolve("same-id", "once");
  directory.approvalPresentation.selectedKey = approvalPresentationKey({
    owner: { kind: "workspace", workspaceId: "personal" },
    approvalId: "same-id",
  });
  finish();
  await pending;
  expect(system.client.shellApproval.resolve).toHaveBeenCalledWith(
    "same-id",
    "once",
  );
  expect(system.approvalState.refresh).toHaveBeenCalledWith("manual");
  expect(personal.client.shellApproval.resolve).not.toHaveBeenCalled();
  expect(directory.activate).not.toHaveBeenCalled();
});

it("rejects a stale callback after selecting a colliding request from another workspace", async () => {
  const { directory, system, personal } = fixture();
  directory.approvalPresentation.selectedKey = approvalPresentationKey({
    owner: { kind: "workspace", workspaceId: "personal" },
    approvalId: "same-id",
  });
  await expect(mockSheet.onResolve("same-id", "once")).rejects.toThrow(
    "no longer selected",
  );
  expect(system.client.shellApproval.resolve).not.toHaveBeenCalled();
  expect(personal.client.shellApproval.resolve).not.toHaveBeenCalled();
});

it("rejects an old owner's callback after access removal or session replacement", async () => {
  const { directory, system } = fixture();
  directory.sessions.delete("system");
  directory.selectedApprovalOwner = null;
  await expect(mockSheet.onResolve("same-id", "once")).rejects.toThrow(
    "no longer selected",
  );
  expect(system.client.shellApproval.resolve).not.toHaveBeenCalled();
});

it("resolves an account approval through its captured hub owner", async () => {
  const { directory, system, rendered, approval } = fixture();
  const hubApproval = { ...approval, approvalId: "hub-review" };
  const hubItem = {
    owner: { kind: "hub" as const },
    approvalId: hubApproval.approvalId,
    actionable: true,
    approval: hubApproval,
  };
  const hubOwner = {
    owner: hubItem.owner,
    label: "Account",
    shellApproval: { resolve: jest.fn(async () => undefined) },
    events: {},
    approvals: [hubApproval],
    approvalState: { refresh: jest.fn(async () => undefined) },
    approvalError: null,
  };
  directory.approvalItems = [hubItem];
  directory.selectedApproval = hubItem;
  directory.selectedApprovalOwner = hubOwner;
  directory.approvalOwnerErrors = ["Account: account queue unavailable"];
  directory.approvalPresentation.selectedKey = approvalPresentationKey(hubItem);
  rendered.rerender(
    <WorkspaceApprovalSurface
      directory={directory as MobileWorkspaceDirectory}
      owner={hubOwner as never}
      notify={jest.fn()}
    />,
  );

  await mockSheet.onResolve("hub-review", "once");

  expect(hubOwner.shellApproval.resolve).toHaveBeenCalledWith(
    "hub-review",
    "once",
  );
  expect(hubOwner.approvalState.refresh).toHaveBeenCalledWith("manual");
  expect(system.client.shellApproval.resolve).not.toHaveBeenCalled();
  expect(mockSheet.onNavigateToPanel).toBeUndefined();
  expect(mockSheet.onFetchDiffContent).toBeUndefined();
  expect(mockSheet.onOpenDiffFile).toBeUndefined();
  expect(mockSheet.queue.status?.message).toContain(
    "Account: account queue unavailable",
  );
});
