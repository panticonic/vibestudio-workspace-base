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
  templates: { catalog: vi.fn(), inspect: vi.fn() },
  hubControl: {
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    routeWorkspace: vi.fn(),
  },
}));
vi.mock("../shell/workspaceContext", () => ({
  useShellWorkspaceClient: () => clients,
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
const catalog = {
  version: 1,
  systemEpoch: 1,
  coordinates: { ...pin, url: "git+https://example.test/catalog.git" },
  stale: false,
  entries: [],
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  clients.templates.catalog.mockResolvedValue(catalog);
  clients.templates.inspect.mockResolvedValue(inspection);
  clients.hubControl.listWorkspaces.mockResolvedValue([
    {
      workspaceId: "shared-id",
      name: "Shared garden",
      running: true,
      lastOpened: 1,
    },
  ]);
  clients.hubControl.createWorkspace.mockResolvedValue({
    workspaceId: "new-id",
    name: "garden",
    running: true,
    lastOpened: 0,
  });
  clients.hubControl.routeWorkspace.mockResolvedValue(undefined);
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
  it("routes by immutable workspace id through the retained account session", async () => {
    const store = draw();
    fireEvent.click(
      await screen.findByRole("button", { name: /Shared garden/ }),
    );
    await waitFor(() =>
      expect(clients.hubControl.routeWorkspace).toHaveBeenCalledWith({
        workspaceId: "shared-id",
      }),
    );
    expect(store.get(workspaceChooserDialogOpenAtom)).toBe(false);
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
        workspace: "my-garden",
        rootTemplate: pin,
      }),
    );
    await waitFor(() =>
      expect(clients.hubControl.routeWorkspace).toHaveBeenCalledWith({
        workspaceId: "new-id",
      }),
    );
  });
  it("reopens an already-created workspace after route failure without creating another", async () => {
    clients.hubControl.routeWorkspace.mockRejectedValueOnce(
      new Error("Connection interrupted"),
    );
    draw();
    fireEvent.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    await waitFor(() =>
      expect(clients.hubControl.routeWorkspace).toHaveBeenCalledTimes(2),
    );
    expect(clients.hubControl.createWorkspace).toHaveBeenCalledTimes(1);
    expect(clients.hubControl.createWorkspace).toHaveBeenCalledWith({
      workspace: "garden",
    });
  });
});
