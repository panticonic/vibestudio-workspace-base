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
    listTemplateCandidates: vi.fn(),
    createWorkspace: vi.fn(),
    routeWorkspace: vi.fn(),
  },
}));
const approvalPresentation = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./SourceCopySection", () => ({ SourceCopySection: () => null }));
vi.mock("../shell/workspaceContext", () => ({
  useShellWorkspaceClient: () => clients,
}));
vi.mock("../shell/client", () => ({
  systemWorkspaceId: Promise.resolve("system-id"),
}));
vi.mock("./ApprovalPresentationContext", () => ({
  useApprovalPresentation: () => approvalPresentation,
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
  clients.hubControl.listTemplateCandidates.mockResolvedValue([]);
  clients.hubControl.createWorkspace.mockResolvedValue({
    workspaceId: "new-id",
    name: "garden",
    running: true,
    lastOpened: 0,
  });
  clients.hubControl.routeWorkspace.mockResolvedValue(undefined);
});

import { TemplatesSection } from "./TemplatesSection";
import {
  settingsDialogAtom,
  workspaceChooserDialogOpenAtom,
  workspaceChooserTemplateAtom,
} from "../state/appModeAtoms";
it("hands the reviewed exact source to the canonical workspace chooser", async () => {
  const store = createStore();
  store.set(settingsDialogAtom, { section: "templates" });
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
    await screen.findByRole("button", { name: "Continue in app" }),
  );
  expect(store.get(workspaceChooserTemplateAtom)).toEqual(pin);
  expect(store.get(workspaceChooserDialogOpenAtom)).toBe(true);
  expect(store.get(settingsDialogAtom)).toBeNull();
  expect(clients.hubControl.createWorkspace).not.toHaveBeenCalled();
  expect(clients.hubControl.routeWorkspace).not.toHaveBeenCalled();
});

it("opens the shared approval presenter for a catalog acquisition", async () => {
  clients.templates.catalog.mockRejectedValueOnce(
    Object.assign(new Error("wrapped extension failure"), {
      code: "EACQUIRE",
      errorData: {
        acquisition: {
          acquisitionId: "acq-catalog-network",
          renderedAction: "read responses from github.com",
          pending: true,
        },
      },
    }),
  );
  render(
    <Provider store={createStore()}>
      <Theme>
        <TemplatesSection />
      </Theme>
    </Provider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open approval" }));
  await waitFor(() =>
    expect(approvalPresentation.request).toHaveBeenCalledWith(
      "system-id",
      "acq-catalog-network",
    ),
  );
});

it("reports local candidate discovery failure", async () => {
  clients.hubControl.listTemplateCandidates.mockRejectedValueOnce(
    new Error("candidate transport unavailable"),
  );
  render(
    <Provider store={createStore()}>
      <Theme>
        <TemplatesSection />
      </Theme>
    </Provider>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not load workspace sources: candidate transport unavailable",
  );
});
