// @vitest-environment jsdom
import { atom, useAtom } from "jotai";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceDesktop } from "./WorkspaceDesktop";
import {
  useWorkspaceNavigationHost,
  useWorkspaceVisible,
} from "../shell/workspaceContext";
const api = vi.hoisted(() => {
  const catalog = [
    {
      workspaceId: "personal",
      name: "personal-opaque",
      privateRole: "personal",
      running: true,
      pendingApprovalCount: 0,
      lastOpened: 0,
    },
    {
      workspaceId: "system",
      name: "system-opaque",
      privateRole: "system",
      running: true,
      pendingApprovalCount: 0,
      lastOpened: 0,
    },
    {
      workspaceId: "garden",
      name: "Garden",
      running: true,
      pendingApprovalCount: 2,
      lastOpened: 0,
    },
  ];
  const calls = new Map<
    string,
    { create: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  >();
  return {
    catalog,
    calls,
    route: vi.fn(async () => {}),
    open: vi.fn(async (id: string) => {
      const create = vi.fn(async () => ({ id: "panel" }));
      const close = vi.fn();
      calls.set(id, { create, close });
      return {
        close,
        client: {
          panel: { createAboutPanel: create },
          shellApproval: { listPending: async () => [] },
          events: {
            on: () => () => {},
            subscribe: async () => {},
            unsubscribe: async () => {},
          },
        },
      };
    }),
  };
});
vi.mock("../shell/client", () => ({
  app: { getInfo: async () => ({}) },
  createWorkspaceShellClient: api.open,
  systemWorkspaceId: Promise.resolve("system"),
  hubControl: {
    ensureUserWorkspaces: async () => ({
      personal: api.catalog[0],
      system: api.catalog[1],
    }),
    listWorkspaces: async () => api.catalog,
    routeWorkspace: api.route,
  },
  directEvents: { on: () => () => {} },
  incomingPanelLocation: {
    onLocation: () => () => {},
    getPending: async () => null,
  },
}));
const draft = atom("");
vi.mock("./PanelApp", () => ({
  PanelApp: function RetainedDraft() {
    const owner = useWorkspaceNavigationHost();
    const visible = useWorkspaceVisible();
    const [value, setValue] = useAtom(draft);
    return (
      <input
        aria-label={`${owner?.workspaceId} draft`}
        data-visible={String(visible)}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  },
}));
vi.mock("./ThemeSettings", () => ({ ThemeSettings: () => null }));
vi.mock("./ConnectionStatusBadge", () => ({
  ConnectionStatusBadge: () => null,
}));
describe("desktop workspace ownership", () => {
  it("keeps independent retained drafts and captures New in the chosen workspace", async () => {
    const result = render(<WorkspaceDesktop />);
    const personal = await screen.findByLabelText("personal draft");
    expect(
      screen.getByRole("button", { name: "2 requests need your review" }),
    ).toBeTruthy();
    expect(api.calls.has("garden")).toBe(false);
    fireEvent.change(personal, { target: { value: "Personal draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Garden" }));
    const garden = await screen.findByLabelText("garden draft");
    fireEvent.change(garden, { target: { value: "Garden draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Personal" }));
    await waitFor(() =>
      expect(personal.getAttribute("data-visible")).toBe("true"),
    );
    expect((personal as HTMLInputElement).value).toBe("Personal draft");
    expect((garden as HTMLInputElement).value).toBe("Garden draft");
    expect(garden.getAttribute("data-visible")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "New panel in Garden" }),
    );
    await waitFor(() =>
      expect(api.calls.get("garden")?.create).toHaveBeenCalledWith("new"),
    );
    expect(api.calls.get("personal")?.create).not.toHaveBeenCalled();
    expect(api.open.mock.calls.filter(([id]) => id === "garden")).toHaveLength(
      1,
    );
    expect(screen.queryByText("personal-opaque")).toBeNull();
    result.unmount();
    for (const owner of api.calls.values())
      expect(owner.close).toHaveBeenCalledTimes(1);
  });
  it("releases a pending workspace owner when access disappears during startup", async () => {
    const result = render(<WorkspaceDesktop />);
    await screen.findByLabelText("personal draft");
    await screen.findByLabelText("system draft");
    const createOwner = api.open.getMockImplementation()!;
    let finishOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    api.calls.delete("garden");
    api.open.mockImplementationOnce(async (id) => {
      const owner = await createOwner(id);
      await opening;
      return owner;
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Garden" }));
    await waitFor(() => expect(api.calls.has("garden")).toBe(true));
    const garden = api.catalog.pop()!;
    try {
      fireEvent(window, new Event("focus"));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Open Garden" }),
        ).toBeNull(),
      );
      await act(async () => {
        finishOpening();
      });
      await waitFor(() =>
        expect(api.calls.get("garden")?.close).toHaveBeenCalledTimes(1),
      );
      expect(screen.queryByLabelText("garden draft")).toBeNull();
      expect(
        screen.getByLabelText("personal draft").getAttribute("data-visible"),
      ).toBe("true");
    } finally {
      finishOpening();
      result.unmount();
      api.catalog.push(garden);
    }
  });
});
