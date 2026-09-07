import type { ToastInput } from "../state/toastAtoms";
import type { MobileWorkspaceDirectory } from "./workspaceDirectory";
import { workspaceName } from "./workspaceName";

/** Present workspace events in the account toast host, retaining their owner. */
export function presentWorkspaceNotification(
  directory: Pick<MobileWorkspaceDirectory, "entries" | "activate">,
  notify: (toast: ToastInput) => void,
  workspaceId: string,
  toast: ToastInput,
): void {
  const entry = directory.entries.find(
    (item) => item.workspaceId === workspaceId,
  );
  if (!entry) return;
  const name = workspaceName(entry);
  notify({
    ...toast,
    ...(toast.id ? { id: JSON.stringify([workspaceId, toast.id]) } : {}),
    title: toast.title ? `${name} · ${toast.title}` : name,
    // An existing action already captures its workspace client. Preserve it;
    // a generic notification can instead offer explicit workspace navigation.
    ...(toast.onAction
      ? {}
      : {
          actionLabel: "Open workspace",
          onAction: async () => {
            try {
              await directory.activate(workspaceId);
            } catch (error) {
              notify({
                title: name,
                message: error instanceof Error ? error.message : String(error),
                tone: "danger",
              });
            }
          },
        }),
  });
}
