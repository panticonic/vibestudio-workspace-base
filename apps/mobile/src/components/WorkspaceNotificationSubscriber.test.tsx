import { render } from "@testing-library/react-native";
import { WorkspaceNotificationSubscriber } from "./WorkspaceNotificationSubscriber";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";

it("presents an unvisited connected workspace's events through the account host and stops on removal", () => {
  let emit!: (payload: unknown) => void;
  const stop = jest.fn();
  const client = {
    events: {
      subscribe: jest.fn(async () => undefined),
      unsubscribe: jest.fn(async () => undefined),
      on: jest.fn((_event, listener) => {
        emit = listener;
        return stop;
      }),
    },
    onDirectEvent: jest.fn(() => stop),
    transport: { onReconnect: jest.fn(() => stop) },
  };
  const session = { workspaceId: "system", client };
  const directory = {
    entries: [{ workspaceId: "system", name: "System" }],
    sessions: new Map([["system", session]]),
    activate: jest.fn(),
  };
  const notify = jest.fn();
  const view = render(
    <WorkspaceNotificationSubscriber
      directory={directory as unknown as MobileWorkspaceDirectory}
      session={session as unknown as MobileWorkspaceSession}
      notify={notify}
    />,
  );
  emit({ id: "notice", title: "Ready", message: "Your tools are ready" });
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      id: '["system","notice"]',
      title: "System · Ready",
      actionLabel: "Open workspace",
    }),
  );
  expect(directory.activate).not.toHaveBeenCalled();
  directory.sessions.delete("system");
  emit({ title: "Stale" });
  expect(notify).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(3);
  emit({ title: "Stopped" });
  expect(notify).toHaveBeenCalledTimes(1);
});
