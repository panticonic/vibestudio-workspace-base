import { presentWorkspaceNotification } from "./workspaceNotifications";
import type { MobileWorkspaceDirectory } from "./workspaceDirectory";
import type { ToastInput } from "../state/toastAtoms";

function fixture() {
  const activate = jest.fn(async (_workspaceId: string) => undefined);
  const directory = {
    entries: [{ workspaceId: "background", name: "Project" }],
    activate,
  } as unknown as Pick<MobileWorkspaceDirectory, "entries" | "activate">;
  const notify = jest.fn<void, [ToastInput]>();
  return { directory, activate, notify };
}

it("presents a background workspace notification without changing focus until clicked", async () => {
  const { directory, activate, notify } = fixture();
  presentWorkspaceNotification(directory, notify, "background", {
    id: "notice",
    title: "Finished",
    message: "Ready to review",
  });
  expect(activate).not.toHaveBeenCalled();
  const toast = notify.mock.calls[0]![0];
  expect(toast).toMatchObject({
    title: "Project · Finished",
    message: "Ready to review",
    actionLabel: "Open workspace",
    id: JSON.stringify(["background", "notice"]),
  });
  await toast.onAction?.();
  expect(activate).toHaveBeenCalledWith("background");
});

it("preserves an original action and its captured owner", async () => {
  const { directory, activate, notify } = fixture();
  const original = jest.fn();
  presentWorkspaceNotification(directory, notify, "background", {
    message: "Review needed",
    actionLabel: "Review",
    onAction: original,
  });
  const toast = notify.mock.calls[0]![0];
  expect(toast.actionLabel).toBe("Review");
  await toast.onAction?.();
  expect(original).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
});

it("does not present events from a workspace whose access was removed", () => {
  const { directory, notify } = fixture();
  presentWorkspaceNotification(directory, notify, "revoked", {
    message: "Old event",
  });
  expect(notify).not.toHaveBeenCalled();
});
