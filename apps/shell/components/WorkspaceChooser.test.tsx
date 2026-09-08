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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const clients = vi.hoisted(() => ({
  templates: { inspect: vi.fn() },
  review: vi.fn(),
  hubControl: {
    getProfile: vi.fn(),
    workspaceCreationReceipt: vi.fn(),
    listWorkspaces: vi.fn(),
    listTemplateCandidates: vi.fn(),
    createWorkspace: vi.fn(),
    routeWorkspace: vi.fn(),
  },
  openWorkspace: vi.fn(),
}));
vi.mock("../shell/client", () => ({
  systemWorkspaceId: Promise.resolve("system-id"),
}));
vi.mock("../shell/workspaceContext", () => ({
  useShellWorkspaceClient: () => clients,
  useWorkspaceDesktopHost: () => ({ openWorkspace: clients.openWorkspace }),
}));
vi.mock("./ApprovalPresentationContext", () => ({
  useApprovalPresentation: () => ({ request: clients.review }),
}));
const pin = {
  url: "git+https://example.test/garden.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
const inspection = {
  pin,
  presentation: { name: "Garden", description: "A place for growing ideas." },
  repositories: ["panels/garden"],
  files: [],
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  clients.hubControl.getProfile.mockResolvedValue({ userId: "alice" });
  clients.templates.inspect.mockResolvedValue(inspection);
  clients.hubControl.listWorkspaces.mockResolvedValue([
    {
      workspaceId: "shared-id",
      name: "Shared garden",
      running: true,
      lastOpened: 1,
    },
  ]);
  clients.hubControl.listTemplateCandidates.mockResolvedValue([]);
  clients.hubControl.createWorkspace.mockResolvedValue({
    workspaceId: "new-id",
    name: "garden",
    running: true,
    lastOpened: 0,
  });
  clients.hubControl.routeWorkspace.mockResolvedValue(undefined);
  clients.openWorkspace.mockResolvedValue(undefined);
});

import { WorkspaceChooser } from "./WorkspaceChooser";
import {
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
} from "../state/appModeAtoms";
function draw(prefill = false) {
  const store = createStore();
  store.set(workspaceChooserDialogOpenAtom, true);
  if (prefill) store.set(workspaceChooserTemplateAtom, pin);
  render(
    <Provider store={store}>
      <Theme>
        <WorkspaceChooser />
      </Theme>
    </Provider>,
  );
  return store;
}
describe("WorkspaceChooser", () => {
  it("opens the exact source setup review without navigating the active workspace", async () => {
    clients.templates.inspect.mockRejectedValue(
      Object.assign(new Error("Review pending"), {
        code: "EREVIEWPENDING",
        data: {
          authorityFailure: {
            reasonCode: "review-pending",
            remediation: {
              review: { approvalId: "setup-review", title: "System setup" },
            },
          },
        },
      }),
    );
    const store = draw(true);
    fireEvent.click(await screen.findByRole("button", { name: "Open review" }));
    await waitFor(() =>
      expect(clients.review).toHaveBeenCalledWith("system-id", "setup-review"),
    );
    expect(clients.openWorkspace).not.toHaveBeenCalled();
    expect(store.get(workspaceChooserDialogOpenAtom)).toBe(false);
  });

  it("reports candidate discovery failure instead of silently hiding selected sources", async () => {
    clients.hubControl.listTemplateCandidates.mockRejectedValue(
      new Error("candidate transport unavailable"),
    );
    draw(true);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load workspace sources: candidate transport unavailable",
    );
    expect(clients.templates.inspect).not.toHaveBeenCalled();
    expect(clients.hubControl.createWorkspace).not.toHaveBeenCalled();
  });

  it("opens creation directly without duplicating the sidebar workspace list", async () => {
    draw();
    await screen.findByRole("textbox", { name: "Workspace source address" });
    expect(clients.hubControl.listWorkspaces).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Shared garden/ })).toBeNull();
    expect(clients.openWorkspace).not.toHaveBeenCalled();
  });
  it("reinspects an exact panel-supplied source and waits for explicit creation", async () => {
    draw(true);
    await screen.findByRole("button", { name: "Create workspace" });
    expect(clients.templates.inspect).toHaveBeenCalledWith({ pin });
    expect(clients.hubControl.createWorkspace).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "my-garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(clients.hubControl.createWorkspace).toHaveBeenCalledWith({
        operationId: expect.any(String),
        workspace: "my-garden",
        rootTemplate: pin,
      }),
    );
    await waitFor(() =>
      expect(clients.openWorkspace).toHaveBeenCalledWith("new-id"),
    );
  });
  it("uses the host-validated candidate for an exact onboarding pin", async () => {
    clients.hubControl.listTemplateCandidates.mockResolvedValue([inspection]);
    draw(true);

    await screen.findByRole("button", { name: "Create workspace" });
    expect(clients.templates.inspect).not.toHaveBeenCalled();
  });
  it("creates directly from a host-validated local candidate", async () => {
    clients.hubControl.listTemplateCandidates.mockResolvedValue([inspection]);
    draw();
    fireEvent.click(
      await screen.findByRole("button", { name: "Explore Garden" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "local-garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(clients.hubControl.createWorkspace).toHaveBeenCalledWith({
        operationId: expect.any(String),
        workspace: "local-garden",
        rootTemplate: pin,
      }),
    );
    expect(clients.templates.inspect).not.toHaveBeenCalled();
  });
  it("reopens an already-created workspace after route failure without creating another", async () => {
    clients.openWorkspace.mockRejectedValueOnce(
      new Error("Connection interrupted"),
    );
    draw();
    fireEvent.click(await screen.findByRole("radio", { name: /Start fresh/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    await waitFor(() => expect(clients.openWorkspace).toHaveBeenCalledTimes(2));
    expect(clients.hubControl.createWorkspace).toHaveBeenCalledTimes(1);
    expect(clients.hubControl.createWorkspace).toHaveBeenCalledWith({
      operationId: expect.any(String),
      workspace: "garden",
    });
  });
});
