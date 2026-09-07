// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../shell/client", () => ({
  hubControl: {
    listWorkspaceMembers: api.list,
    addWorkspaceMember: api.add,
    removeWorkspaceMember: api.remove,
  },
}));
import { WorkspaceMembersSection } from "./WorkspaceMembersSection";
const workspace = {
  workspaceId: "garden",
  name: "Garden",
  running: true,
  pendingApprovalCount: 0,
  lastOpened: 0,
};
const roster = {
  workspace: "Garden",
  workspaceId: "garden",
  members: [
    {
      userId: "alice",
      displayName: "Alice",
      handle: "alice",
      role: "admin",
      accountRole: "member",
    },
    {
      userId: "bob",
      displayName: "Bob",
      handle: "bob",
      role: "member",
      accountRole: "admin",
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue(roster);
  api.add.mockResolvedValue({});
  api.remove.mockResolvedValue({});
});
afterEach(cleanup);
it("reviews a workspace role change with its captured workspace before writing", async () => {
  render(
    <Theme>
      <WorkspaceMembersSection workspace={workspace} userId="alice" />
    </Theme>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Make admin" }));
  expect(api.add).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Review workspace membership" })
      .textContent,
  ).toContain("Give Bob workspace admin access to Garden?");
  fireEvent.click(screen.getByRole("button", { name: "Confirm access" }));
  await waitFor(() =>
    expect(api.add).toHaveBeenCalledWith({
      workspace: "Garden",
      userId: "bob",
      role: "admin",
    }),
  );
});
it("does not turn a server admin into a workspace manager", async () => {
  render(
    <Theme>
      <WorkspaceMembersSection workspace={workspace} userId="bob" />
    </Theme>,
  );
  await screen.findByText("Bob (you)");
  expect(screen.queryByRole("button", { name: "Add person" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});
it("keeps private workspaces unshareable without requesting a roster", async () => {
  render(
    <Theme>
      <WorkspaceMembersSection
        workspace={{ ...workspace, privateRole: "personal" }}
        userId="alice"
      />
    </Theme>,
  );
  expect(screen.getByText(/cannot be shared/)).toBeTruthy();
  expect(api.list).not.toHaveBeenCalled();
});
