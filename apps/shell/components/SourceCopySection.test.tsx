// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  route: vi.fn(),
  owner: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
  main: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
  files: vi.fn(),
  resolve: vi.fn(),
  panel: vi.fn(),
  focus: vi.fn(),
  close: vi.fn(),
}));
const control = vi.hoisted(() => ({
  listWorkspaces: api.list,
  routeWorkspace: api.route,
}));
vi.mock("../shell/workspaceContext", () => ({
  useShellWorkspaceClient: () => ({ hubControl: control }),
}));
vi.mock("../shell/client", () => ({ createWorkspaceShellClient: api.owner }));
vi.mock("@workspace/workspace-transfer", () => ({
  prepareSelectedTransfer: api.prepare,
}));
import { SourceCopySection } from "./SourceCopySection";
const rows = [
  {
    workspaceId: "personal",
    name: "Personal",
    privateRole: "personal",
    running: true,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
  {
    workspaceId: "garden",
    name: "Garden",
    running: true,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
  {
    workspaceId: "other",
    name: "Other",
    running: true,
    lastOpened: 0,
    pendingApprovalCount: 0,
  },
];
const state = { kind: "event", eventId: "source-main" };
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  api.list.mockResolvedValue(rows);
  api.route.mockResolvedValue(undefined);
  api.main.mockResolvedValue(state);
  api.status.mockResolvedValue({ workingHead: state });
  api.create.mockImplementation(async ({ contextId }) => ({ contextId }));
  api.resolve.mockResolvedValue({ repositoryId: "repo-1" });
  api.files.mockResolvedValue({
    files: [
      { path: "notes.md", mode: 0o644 },
      { path: "private.txt", mode: 0o644 },
    ],
    nextCursor: null,
  });
  api.owner.mockResolvedValue({
    client: {
      sourceFiles: {
        runtime: { createContext: api.create },
        vcs: {
          mainState: api.main,
          status: api.status,
          resolveRepository: api.resolve,
          listFiles: api.files,
        },
      },
      panel: { createPanel: api.panel, focus: api.focus },
    },
    close: api.close,
  });
  api.execute.mockResolvedValue({
    kind: "imported",
    result: { eventId: "copied-event" },
  });
  api.panel.mockResolvedValue({ id: "review-panel" });
  api.focus.mockResolvedValue(undefined);
  api.prepare.mockImplementation(async (input) => ({
    execute: api.execute,
    preview: {
      sourceLabel: input.attribution.sourceLabel,
      destinationLabel: input.attribution.destinationLabel,
      destinationRepoPath: input.target.repoPath,
      audience: input.attribution.audience,
      totalBytes: 5,
      files: input.source.files.map((file: { path: string }) => ({
        destinationPath: file.path,
        size: 5,
      })),
    },
  }));
});
const view = (id = "personal") => (
  <Provider store={createStore()}>
    <Theme>
      <SourceCopySection initialWorkspaceId={id} />
    </Theme>
  </Provider>
);
async function reviewCopy() {
  fireEvent.click(await screen.findByRole("button", { name: "Browse files" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Copy notes.md" }),
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "To workspace" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Garden" }));
  fireEvent.click(screen.getByRole("button", { name: "Review 1 file" }));
  await screen.findByRole("button", { name: "Copy 1 file" });
}
it("keeps preview read-only and confirms a captured copy once despite focus changes", async () => {
  const rendered = render(view());
  await reviewCopy();
  expect(api.create).not.toHaveBeenCalled();
  expect(api.execute).not.toHaveBeenCalled();
  expect(api.prepare.mock.calls[0]![0]).toMatchObject({
    source: {
      workspaceId: "personal",
      state,
      files: [{ repositoryId: "repo-1", path: "notes.md" }],
    },
    target: { workspaceId: "garden", expectedWorkingHead: state },
  });
  expect(screen.queryByText("private.txt")).toBeNull();
  expect(screen.getByText(/including future members/)).toBeTruthy();
  rendered.rerender(view("other"));
  const confirm = screen.getByRole("button", { name: "Copy 1 file" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByRole("button", { name: "Review with an agent" });
  expect(api.execute).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.owner.mock.calls.map(([id]) => id)).toEqual([
    "personal",
    "garden",
  ]);
  rendered.unmount();
  await waitFor(() => expect(api.close).toHaveBeenCalledTimes(2));
});
it("retries opening the same destination review panel without creating another", async () => {
  render(view());
  await reviewCopy();
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 file" }));
  const open = await screen.findByRole("button", {
    name: "Review with an agent",
  });
  api.route.mockRejectedValueOnce(new Error("Route interrupted"));
  fireEvent.click(open);
  await screen.findByText("Route interrupted");
  fireEvent.click(screen.getByRole("button", { name: "Review with an agent" }));
  await waitFor(() => expect(api.focus).toHaveBeenCalledWith("review-panel"));
  expect(api.panel).toHaveBeenCalledTimes(1);
  expect(api.route).toHaveBeenLastCalledWith({ workspaceId: "garden" });
  expect(api.panel.mock.calls[0]![1]).toMatchObject({
    contextId: api.create.mock.calls[0]![0].contextId,
    isRoot: true,
  });
});
it("rechecks destination access before creating the review branch or sending selected bytes", async () => {
  render(view());
  await reviewCopy();
  api.list.mockResolvedValue(
    rows.filter((row) => row.workspaceId !== "garden"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 file" }));
  await screen.findByText(
    "Workspace access changed. Choose the workspaces again.",
  );
  expect(api.create).not.toHaveBeenCalled();
  expect(api.execute).not.toHaveBeenCalled();
});

it("keeps an interrupted copy inspectable without repeating the failed operation", async () => {
  api.execute.mockRejectedValue(new Error("Connection lost after upload"));
  render(view());
  await reviewCopy();
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 file" }));
  await screen.findByText("Connection lost after upload");
  expect(
    screen.getByText(/Some selected files may already be in the destination/),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy 1 file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review with an agent" }));
  await waitFor(() => expect(api.focus).toHaveBeenCalledWith("review-panel"));
  expect(api.execute).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.panel.mock.calls[0]![1].stateArgs.initialPrompt).toContain(
    "was interrupted and may be incomplete",
  );
});

it("can inspect the reserved branch after losing the creation acknowledgement", async () => {
  api.create.mockRejectedValue(new Error("Creation reply lost"));
  render(view());
  await reviewCopy();
  fireEvent.click(screen.getByRole("button", { name: "Copy 1 file" }));
  await screen.findByText("Creation reply lost");
  expect(screen.getByText(/No files were sent/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy 1 file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review with an agent" }));
  await waitFor(() => expect(api.focus).toHaveBeenCalledWith("review-panel"));
  expect(api.status).toHaveBeenCalledWith({
    contextId: api.create.mock.calls[0]![0].contextId,
  });
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.execute).not.toHaveBeenCalled();
});
