import { render } from "@testing-library/react-native";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";
import type { ApprovalSheetProps } from "./ApprovalSheet";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
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
    workspaceId,
    approvalId: approval.approvalId,
    actionable: true,
    approval,
  });
  const directory = {
    entries: [
      { workspaceId: "system", name: "System" },
      { workspaceId: "personal", name: "Personal" },
    ],
    sessions: new Map([
      ["system", system],
      ["personal", personal],
    ]),
    approvalItems: [item("system"), item("personal")],
    unloadedApprovalWorkspaces: [],
    selectedApproval: item("system"),
    approvalPresentation: {
      selectedKey: approvalPresentationKey(item("system")),
      open: true,
    },
    stepApproval: jest.fn(),
    closeApprovals: jest.fn(),
    activate: jest.fn(),
  };
  render(
    <WorkspaceApprovalSurface
      directory={directory as unknown as MobileWorkspaceDirectory}
      session={system as unknown as MobileWorkspaceSession}
      notify={jest.fn()}
    />,
  );
  return { directory, system, personal };
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
    workspaceId: "personal",
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
    workspaceId: "personal",
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
  await expect(mockSheet.onResolve("same-id", "once")).rejects.toThrow(
    "no longer selected",
  );
  expect(system.client.shellApproval.resolve).not.toHaveBeenCalled();
});
