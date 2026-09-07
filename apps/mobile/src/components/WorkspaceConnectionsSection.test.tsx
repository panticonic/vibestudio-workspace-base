import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { WorkspaceConnectionsSection } from "./WorkspaceConnectionsSection";
import { ActionSheetHost } from "./ui/ActionSheetHost";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

function fixture(incomingLocked = false, role = "admin") {
  const policy = { incoming: [], outgoing: [] };
  const snapshot = {
    workspaceId: incomingLocked ? "system" : "personal",
    incomingLocked,
    policy,
  };
  const directory = {
    personalWorkspaceId: "personal",
    systemWorkspaceId: "system",
    entries: [
      { workspaceId: "personal", name: "Personal", privateRole: "personal" },
      { workspaceId: "system", name: "System", privateRole: "system" },
      { workspaceId: "project", name: "Research" },
    ],
    sessions: new Map([
      [
        "system",
        {
          client: {
            refreshAccountProfile: jest.fn(async () => ({ userId: "alice" })),
          },
        },
      ],
    ]),
    hubControl: {
      listWorkspaceMembers: jest.fn(async () => ({
        members: [
          {
            userId: "alice",
            handle: "alice",
            displayName: "Alice",
            role,
            accountRole: "admin",
          },
        ],
      })),
      getWorkspaceRpcPolicy: jest.fn(async () => snapshot),
      setWorkspaceRpcPolicy: jest.fn(async (request) => ({
        ...snapshot,
        policy: request.policy,
      })),
    },
  };
  const view = render(
    <Provider store={createStore()}>
      <WorkspaceConnectionsSection
        directory={directory as unknown as MobileWorkspaceDirectory}
        initialWorkspaceId={snapshot.workspaceId}
      />
      <ActionSheetHost />
    </Provider>,
  );
  return { ...view, directory, policy };
}

describe("mobile workspace connections", () => {
  it("previews and saves an exact target/method scope using the loaded policy as CAS", async () => {
    const view = fixture();
    await waitFor(() =>
      expect(view.getByText("Allow an operation to ask")).toBeTruthy(),
    );
    fireEvent.press(view.getByText("Allow an operation to ask"));
    fireEvent.press(view.getByText("Choose another workspace"));
    fireEvent.press(view.getByText("Research"));
    fireEvent.changeText(
      view.getByLabelText("Exact RPC target"),
      "do:research",
    );
    fireEvent.changeText(view.getByLabelText("Exact RPC method"), "getSummary");
    await waitFor(() =>
      expect(view.getByText("Personal → Research")).toBeTruthy(),
    );
    fireEvent.press(view.getByText("Save rule"));
    await waitFor(() =>
      expect(
        view.directory.hubControl.setWorkspaceRpcPolicy,
      ).toHaveBeenCalledWith({
        workspaceId: "personal",
        expectedPolicy: view.policy,
        policy: {
          incoming: [],
          outgoing: [
            {
              workspaceId: "project",
              userId: "alice",
              target: "do:research",
              operation: "getSummary",
              purpose: "call",
            },
          ],
        },
      }),
    );
  });

  it("does not grant management controls from the global account role", async () => {
    const view = fixture(false, "member");
    await waitFor(() =>
      expect(view.getByText("No operations allowed yet")).toBeTruthy(),
    );
    expect(view.queryByText("Allow an operation to ask")).toBeNull();
    expect(
      view.directory.hubControl.setWorkspaceRpcPolicy,
    ).not.toHaveBeenCalled();
  });

  it("does not offer an approval bypass for System incoming calls", async () => {
    const view = fixture(true);
    await waitFor(() =>
      expect(view.getByText("Allow an operation to ask")).toBeTruthy(),
    );
    fireEvent.press(view.getByText("Incoming calls"));
    expect(view.getByText("System keeps its door closed")).toBeTruthy();
    expect(view.queryByText("Allow an operation to ask")).toBeNull();
    expect(
      view.directory.hubControl.setWorkspaceRpcPolicy,
    ).not.toHaveBeenCalled();
  });
});
