import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { WorkspaceCreateSheet } from "./WorkspaceCreateSheet";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

const pin = {
  url: "git+https://example.com/task-board.git",
  ref: "refs/tags/v1.0.0",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
function fixture(options: { pendingReview?: boolean } = {}) {
  const directory = {
    systemWorkspaceId: "system",
    pendingApprovalCounts: new Map(
      options.pendingReview ? [["system", 1]] : [],
    ),
    sessions: new Map(
      options.pendingReview
        ? [["system", { approvals: [{ kind: "unit-install-review" }] }]]
        : [],
    ),
    openApprovals: jest.fn(),
    selectApproval: jest.fn(async () => undefined),
    inspectWorkspaceTemplate: jest.fn(async () => {
      if (options.pendingReview)
        throw Object.assign(
          new Error("Extension is not installed: templates"),
          {
            code: "EREVIEWPENDING",
            errorData: {
              authorityFailure: {
                reasonCode: "review-pending",
                remediation: {
                  kind: "resolve-open-review",
                  review: {
                    approvalId: "review-templates",
                    title: "System tools",
                  },
                },
              },
            },
          },
        );
      return {
        pin,
        presentation: { name: "Task Board" },
        repositories: ["panels/board"],
        files: ["package.json"],
      };
    }),
    createWorkspace: jest.fn(async () => ({
      workspaceId: "board",
      name: "My board",
    })),
    activate: jest.fn(async () => undefined),
  };
  const onCreated = jest.fn();
  const view = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={pin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  return { directory, onCreated, view };
}

it("reinspects an exact source and waits for explicit named creation", async () => {
  const { directory, view, onCreated } = fixture();
  await waitFor(() =>
    expect(view.getByLabelText("Workspace name").props.value).toBe(
      "Task Board",
    ),
  );
  expect(directory.inspectWorkspaceTemplate).toHaveBeenCalledWith(pin);
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  expect(view.getByText(pin.url)).toBeTruthy();
  fireEvent.changeText(view.getByLabelText("Workspace name"), "My board");
  fireEvent.press(view.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  expect(directory.createWorkspace).toHaveBeenCalledWith("My board", pin);
  expect(directory.activate).toHaveBeenCalledWith("board");
});

it("retries opening a created workspace without creating it again", async () => {
  const { directory, view, onCreated } = fixture();
  directory.activate.mockRejectedValueOnce(
    new Error("Connection interrupted") as never,
  );
  await waitFor(() =>
    expect(view.getByLabelText("Workspace name").props.value).toBe(
      "Task Board",
    ),
  );
  fireEvent.press(view.getByRole("button", { name: "Create workspace" }));
  await waitFor(() =>
    expect(view.getByText("Connection interrupted")).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: "Open workspace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  expect(directory.createWorkspace).toHaveBeenCalledTimes(1);
  expect(directory.activate).toHaveBeenCalledTimes(2);
});

it("shows the captured System setup review instead of a raw extension failure", async () => {
  const { directory, view } = fixture({ pendingReview: true });
  await waitFor(() =>
    expect(
      view.getByText("Waiting for you to finish reviewing System tools."),
    ).toBeTruthy(),
  );
  expect(view.queryByText("Extension is not installed: templates")).toBeNull();
  fireEvent.press(view.getByRole("button", { name: "Open review" }));
  expect(directory.selectApproval).toHaveBeenCalledWith(
    "system",
    "review-templates",
  );
  expect(directory.createWorkspace).not.toHaveBeenCalled();
});
