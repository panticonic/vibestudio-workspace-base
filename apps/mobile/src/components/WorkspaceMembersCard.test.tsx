import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { WorkspaceMembersCard } from "./WorkspaceMembersCard";
import { ActionSheetHost } from "./ui/ActionSheetHost";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

it("reviews adding a member to the captured workspace before mutation", async () => {
  const add = jest.fn(async () => undefined);
  const onChanged = jest.fn();
  const view = render(
    <Provider store={createStore()}>
      <WorkspaceMembersCard
        directory={
          {
            hubControl: { addWorkspaceMember: add },
          } as unknown as MobileWorkspaceDirectory
        }
        entry={{
          workspaceId: "project",
          name: "Research",
          running: true,
          lastOpened: 0,
          pendingApprovalCount: 0,
        }}
        members={[]}
        canManage
        onChanged={onChanged}
      />
      <ActionSheetHost />
    </Provider>,
  );
  fireEvent.changeText(view.getByLabelText("Person's handle"), "@bob");
  fireEvent.press(view.getByText("Review addition"));
  expect(add).not.toHaveBeenCalled();
  expect(view.getByText("Share Research")).toBeTruthy();
  fireEvent.press(view.getByText("Add @bob as a member"));
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({
      workspace: "Research",
      handle: "bob",
      role: "member",
    }),
  );
  expect(onChanged).toHaveBeenCalled();
});

it("never offers to share a private workspace", () => {
  const view = render(
    <WorkspaceMembersCard
      directory={{} as MobileWorkspaceDirectory}
      entry={{
        workspaceId: "system",
        name: "system-internal-name",
        privateRole: "system",
        running: true,
        lastOpened: 0,
        pendingApprovalCount: 0,
      }}
      members={[]}
      canManage
      onChanged={jest.fn()}
    />,
  );
  expect(
    view.getByText("System belongs only to you and cannot be shared."),
  ).toBeTruthy();
  expect(view.queryByLabelText("Person's handle")).toBeNull();
});
