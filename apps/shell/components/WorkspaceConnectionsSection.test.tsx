// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock("../shell/client", () => ({
  account: { getProfile: async () => ({ userId: "alice" }) },
  hubControl: {
    listWorkspaces: api.list,
    listWorkspaceMembers: async () => ({
      workspace: "Garden project",
      workspaceId: "project-id",
      members: [{ userId: "alice", role: "admin" }],
    }),
    getWorkspaceRpcPolicy: api.get,
    setWorkspaceRpcPolicy: api.set,
  },
}));
import { WorkspaceConnectionsSection } from "./WorkspaceConnectionsSection";
const scope = {
  workspaceId: "personal-id",
  userId: "alice",
  target: "calendar-service",
  operation: "calendar.create",
  purpose: "call" as const,
};
const policy = { incoming: [], outgoing: [scope] };
const snapshot = { workspaceId: "project-id", policy, incomingLocked: false };
function show(workspaceId = "project-id") {
  return render(
    <Theme>
      <WorkspaceConnectionsSection initialWorkspaceId={workspaceId} />
    </Theme>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([
    {
      workspaceId: "personal-id",
      name: "Personal",
      privateRole: "personal",
      running: true,
      pendingApprovalCount: 0,
      lastOpened: 0,
    },
    {
      workspaceId: "system-id",
      name: "System",
      privateRole: "system",
      running: true,
      pendingApprovalCount: 0,
      lastOpened: 0,
    },
    {
      workspaceId: "project-id",
      name: "Garden project",
      running: true,
      pendingApprovalCount: 0,
      lastOpened: 0,
    },
  ]);
  api.get.mockResolvedValue(snapshot);
  api.set.mockResolvedValue({
    ...snapshot,
    policy: { incoming: [], outgoing: [] },
  });
});
afterEach(cleanup);
describe("WorkspaceConnectionsSection", () => {
  it("reviews the exact source, destination, operation and account before removing a rule", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove calendar.create on calendar-service permission",
      }),
    );
    expect(api.set).not.toHaveBeenCalled();
    const review = screen.getByRole("region", {
      name: "Review workspace permission",
    });
    expect(review.textContent).toContain("Garden project");
    expect(review.textContent).toContain("Personal");
    expect(review.textContent).toContain("calendar.create");
    fireEvent.click(screen.getByRole("button", { name: "Remove permission" }));
    await waitFor(() =>
      expect(api.set).toHaveBeenCalledWith({
        workspaceId: "project-id",
        expectedPolicy: policy,
        policy: { incoming: [], outgoing: [] },
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Permission removed.",
    );
  });
  it("keeps System ingress visibly closed without offering an override", async () => {
    api.get.mockResolvedValue({
      workspaceId: "system-id",
      incomingLocked: true,
      policy: { incoming: [], outgoing: [] },
    });
    show("system-id");
    expect(
      await screen.findByText(/System receives no application calls/),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Add permission" }),
    ).toHaveLength(1);
    expect(api.set).not.toHaveBeenCalled();
  });
  it("shows stale-policy rejection without silently overwriting another device's changes", async () => {
    api.set.mockRejectedValue(
      new Error("Connections changed on another device. Reload settings."),
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove calendar.create on calendar-service permission",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove permission" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed on another device",
    );
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "Review workspace permission" }),
    ).toBeTruthy();
  });
  it("does not discover peers or load policies until a workspace is deliberately selected", async () => {
    render(
      <Theme>
        <WorkspaceConnectionsSection />
      </Theme>,
    );
    expect(
      await screen.findByText(/Workspaces keep their own boundaries/),
    ).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});
