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
const clients = vi.hoisted(() => ({
  templates: { catalog: vi.fn(), inspect: vi.fn() },
  hubControl: {
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    routeWorkspace: vi.fn(),
  },
}));
vi.mock("./SourceCopySection", () => ({ SourceCopySection: () => null }));
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

import { TemplatesSection } from "./TemplatesSection";
import { settingsDialogAtom } from "../state/appModeAtoms";
it("reviews a source, creates its exact snapshot and retries opening without duplicating it", async () => {
  const store = createStore();
  clients.hubControl.routeWorkspace.mockRejectedValueOnce(
    new Error("Connection interrupted"),
  );
  render(
    <Provider store={store}>
      <Theme>
        <TemplatesSection />
      </Theme>
    </Provider>,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Workspace source address" }),
    { target: { value: "https://example.test/garden.git" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Review workspace" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Create workspace" }),
  );
  await screen.findByText("Connection interrupted");
  expect(clients.hubControl.createWorkspace).toHaveBeenCalledWith({
    workspace: "garden",
    rootTemplate: pin,
  });
  fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
  await waitFor(() =>
    expect(clients.hubControl.routeWorkspace).toHaveBeenCalledTimes(2),
  );
  expect(clients.hubControl.createWorkspace).toHaveBeenCalledTimes(1);
  expect(store.get(settingsDialogAtom)).toBeNull();
});
