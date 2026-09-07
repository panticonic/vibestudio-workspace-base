import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { WorkspaceDrawer } from "./WorkspaceDrawer";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

jest.mock("@workspace/mobile-navigation", () => ({
  useNavigation: () => ({ getParent: () => ({ navigate: jest.fn() }) }),
}));
jest.mock("./PanelDrawer", () => ({ PanelDrawer: () => null }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function fixture() {
  const directory = {
    subscribe: () => () => {},
    getSnapshot: () => 0,
    entries: [
      { workspaceId: "personal", name: "Personal", privateRole: "personal" },
      {
        workspaceId: "project",
        name: "The research workspace with a long name",
      },
      { workspaceId: "system", name: "System", privateRole: "system" },
    ],
    activeWorkspaceId: "personal",
    expanded: new Set(["personal"]),
    sessions: new Map(),
    pendingApprovalCounts: new Map([["project", 2]]),
    approvalCount: 2,
    activate: jest.fn(async () => undefined),
    toggleExpanded: jest.fn(async () => undefined),
    createPanel: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
    openApprovals: jest.fn(),
  };
  const onSelect = jest.fn();
  const onSettings = jest.fn();
  const view = render(
    <Provider store={createStore()}>
      <WorkspaceDrawer
        directory={directory as unknown as MobileWorkspaceDirectory}
        onSelect={onSelect}
        onSettings={onSettings}
      />
    </Provider>,
  );
  return { ...view, directory, onSelect, onSettings };
}

describe("stacked mobile workspaces", () => {
  it("opens settings for the workspace captured at the drawer action", () => {
    const view = fixture();
    fireEvent.press(view.getByLabelText("Open your settings"));
    expect(view.onSettings).toHaveBeenCalledWith("personal");
  });
  it("creates a new panel in the heading workspace rather than the focused workspace", async () => {
    const view = fixture();
    fireEvent.press(
      view.getByLabelText(
        "New panel in The research workspace with a long name",
      ),
    );
    await waitFor(() =>
      expect(view.directory.createPanel).toHaveBeenCalledWith("project"),
    );
    expect(view.directory.activate).not.toHaveBeenCalled();
  });
  it("expands a workspace tree without switching the visible workspace", () => {
    const view = fixture();
    fireEvent.press(view.getByLabelText("Expand System"));
    expect(view.directory.toggleExpanded).toHaveBeenCalledWith("system");
    expect(view.directory.activate).not.toHaveBeenCalled();
    expect(view.onSelect).not.toHaveBeenCalled();
  });
  it("opens approvals for their captured workspace while leaving panel focus alone", () => {
    const view = fixture();
    fireEvent.press(
      view.getByLabelText(
        "Review approvals for The research workspace with a long name",
      ),
    );
    expect(view.directory.openApprovals).toHaveBeenCalledWith("project");
    expect(view.directory.activate).not.toHaveBeenCalled();
  });
});
