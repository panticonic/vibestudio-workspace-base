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
    pendingWorkspaceCreation: jest.fn(async () => null),
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
  expect(directory.inspectWorkspaceTemplate).toHaveBeenCalledWith({ pin });
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  expect(view.getByText(pin.url)).toBeTruthy();
  fireEvent.changeText(view.getByLabelText("Workspace name"), "My board");
  fireEvent.press(view.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  expect(directory.createWorkspace).toHaveBeenCalledWith("My board", pin);
  expect(directory.activate).toHaveBeenCalledWith("board");
});

it("keeps a pending exact inspection from creating a workspace", async () => {
  const { directory, view, onCreated } = fixture();
  view.unmount();
  directory.inspectWorkspaceTemplate.mockImplementationOnce(
    () => new Promise(() => {}),
  );
  const local = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={pin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  fireEvent.press(local.getByRole("button", { name: "Create workspace" }));
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  local.unmount();
});

it("uses the host inspection for an exact local pin handed to the sheet", async () => {
  const { directory, view, onCreated } = fixture();
  view.unmount();
  directory.inspectWorkspaceTemplate.mockClear();
  directory.inspectWorkspaceTemplate.mockResolvedValueOnce({
    pin,
    presentation: { name: "Local checkout" },
    repositories: ["panels/board"],
    files: ["package.json"],
  });
  const local = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={pin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  await waitFor(() =>
    expect(local.getByLabelText("Workspace name").props.value).toBe(
      "Local checkout",
    ),
  );
  fireEvent.press(local.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(directory.inspectWorkspaceTemplate).toHaveBeenCalledWith({ pin });
  expect(directory.createWorkspace).toHaveBeenCalledWith("Local checkout", pin);
});

it("cannot create from a stale inspection while an exact pin changes", async () => {
  const { directory, view, onCreated } = fixture();
  await waitFor(() =>
    expect(view.getByLabelText("Workspace name").props.value).toBe(
      "Task Board",
    ),
  );
  const nextPin = { ...pin, commit: "c".repeat(40) };
  directory.inspectWorkspaceTemplate.mockImplementationOnce(
    () => new Promise(() => undefined),
  );
  view.rerender(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={nextPin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  const create = view.getByRole("button", { name: "Create workspace" });
  expect(create.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(create);
  expect(directory.createWorkspace).not.toHaveBeenCalled();
});

it("does not create a workspace when exact source inspection fails", async () => {
  const { directory, view, onCreated } = fixture();
  view.unmount();
  directory.inspectWorkspaceTemplate.mockClear();
  directory.inspectWorkspaceTemplate.mockRejectedValueOnce(
    new Error("Exact source unavailable"),
  );
  const local = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={pin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  await local.findByText("Exact source unavailable");
  expect(directory.inspectWorkspaceTemplate).toHaveBeenCalledWith({ pin });
  expect(directory.createWorkspace).not.toHaveBeenCalled();
});

it("keeps fresh creation independent of Git source inspection", async () => {
  const { directory, view, onCreated } = fixture();
  view.unmount();
  directory.inspectWorkspaceTemplate.mockRejectedValueOnce(
    new Error("Exact source unavailable") as never,
  );
  const local = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  await waitFor(() =>
    expect(local.getByLabelText("Workspace name").props.editable).toBe(true),
  );
  fireEvent.changeText(local.getByLabelText("Workspace name"), "Blank board");
  fireEvent.press(local.getByRole("radio", { name: "Git URL" }));
  fireEvent.press(local.getByRole("button", { name: "Create workspace" }));
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  fireEvent.press(local.getByRole("radio", { name: "Start fresh" }));
  fireEvent.press(local.getByRole("button", { name: "Create workspace" }));
  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(directory.createWorkspace).toHaveBeenCalledWith(
    "Blank board",
    undefined,
  );
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

it("rejects an inspection for a different exact source", async () => {
  const { directory, view, onCreated } = fixture();
  await waitFor(() =>
    expect(view.getByLabelText("Workspace name").props.value).toBe(
      "Task Board",
    ),
  );
  const nextPin = { ...pin, commit: "c".repeat(40) };
  view.rerender(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      template={nextPin}
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  await view.findByText(
    "The inspected source does not match the selected workspace. Review the source again.",
  );
  const create = view.getByRole("button", { name: "Create workspace" });
  expect(create.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(create);
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});

it("reviews a website source URL before creating its exact workspace", async () => {
  const { directory, view, onCreated } = fixture();
  view.unmount();
  directory.inspectWorkspaceTemplate.mockClear();
  const source = render(
    <WorkspaceCreateSheet
      directory={directory as unknown as MobileWorkspaceDirectory}
      sourceUrl="https://example.com/task-board.git"
      onClose={jest.fn()}
      onCreated={onCreated}
    />,
  );
  expect(source.getByLabelText("Workspace source address").props.value).toBe(
    "https://example.com/task-board.git",
  );
  fireEvent.changeText(source.getByLabelText("Workspace name"), "My board");
  expect(
    source.getByRole("button", { name: "Create workspace" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  fireEvent.press(source.getByRole("button", { name: "Review source" }));
  await waitFor(() =>
    expect(source.getByLabelText("Workspace name").props.value).toBe(
      "Task Board",
    ),
  );
  expect(directory.inspectWorkspaceTemplate).toHaveBeenCalledWith({
    url: "https://example.com/task-board.git",
  });
  expect(directory.createWorkspace).not.toHaveBeenCalled();
  fireEvent.press(source.getByRole("button", { name: "Create workspace" }));
  await waitFor(() =>
    expect(directory.createWorkspace).toHaveBeenCalledWith("Task Board", pin),
  );
});
