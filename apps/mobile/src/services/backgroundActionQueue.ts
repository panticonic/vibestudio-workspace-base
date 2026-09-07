import type { ShellClient } from "./shellClient";
import {
  sameWorkspacePushScope,
  workspaceNotificationKey,
  type WorkspaceApprovalTarget,
  type WorkspacePushScope,
} from "@vibestudio/shared/workspacePushScope";
import {
  clearAction as clearActionCore,
  enqueueAction as enqueueActionCore,
  loadDeepLink,
  loadPendingActions as loadPendingActionsCore,
  serializeDeepLink,
  serializePendingActions,
  sameApprovalTarget,
  type BackgroundApprovalDecision,
  type QueuedBackgroundAction,
} from "./backgroundActionQueueCore";
import { getNativeAppStorage, type NativeAppStorage } from "./nativeAppStorage";
const ACTION_QUEUE_KEY = "vibestudio:push:queued-actions";
const DEEP_LINK_KEY = "vibestudio:push:pending-deep-link";
export const SYNCING_NOTIFICATION_BODY = "Sent — syncing…";
interface NotifeeLike {
  cancelNotification(id: string): Promise<void>;
  displayNotification?(notification: Record<string, unknown>): Promise<void>;
}
// Multiple immutable workspace sessions can reconcile at once. Serialize the
// storage mutation, without holding this lock across a remote approval decision.
let storageMutation = Promise.resolve();
function mutate<T>(
  task: (storage: NativeAppStorage) => Promise<T>,
): Promise<T> {
  const next = storageMutation.then(() => task(getNativeAppStorage()));
  storageMutation = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
async function readActions(
  storage: NativeAppStorage,
  now = Date.now(),
): Promise<QueuedBackgroundAction[]> {
  return loadPendingActionsCore(await storage.getItem(ACTION_QUEUE_KEY), now);
}
async function writeActions(
  storage: NativeAppStorage,
  actions: QueuedBackgroundAction[],
): Promise<void> {
  if (actions.length === 0) await storage.removeItem(ACTION_QUEUE_KEY);
  else
    await storage.setItem(ACTION_QUEUE_KEY, serializePendingActions(actions));
}
export function enqueueAction(action: QueuedBackgroundAction): Promise<void> {
  return mutate(async (storage) =>
    writeActions(
      storage,
      enqueueActionCore(
        await readActions(storage, action.queuedAt),
        action,
        action.queuedAt,
      ),
    ),
  );
}
export function queueBackgroundAction(
  target: WorkspaceApprovalTarget,
  decision: BackgroundApprovalDecision,
  queuedAt = Date.now(),
): Promise<void> {
  return enqueueAction({ ...target, decision, queuedAt });
}
export function loadPendingActions(
  now = Date.now(),
): Promise<QueuedBackgroundAction[]> {
  return mutate(async (storage) => {
    const actions = await readActions(storage, now);
    await writeActions(storage, actions);
    return actions;
  });
}
export function clearAction(target: WorkspaceApprovalTarget): Promise<void> {
  return mutate(async (storage) =>
    writeActions(storage, clearActionCore(await readActions(storage), target)),
  );
}
export const pruneStale = loadPendingActions;
export function enqueueDeepLink(
  target: WorkspaceApprovalTarget,
): Promise<void> {
  return mutate((storage) =>
    storage.setItem(DEEP_LINK_KEY, serializeDeepLink(target)),
  );
}
export function takePendingDeepLink(
  account: Pick<WorkspacePushScope, "serverId" | "userId">,
): Promise<WorkspaceApprovalTarget | null> {
  return mutate(async (storage) => {
    const target = loadDeepLink(await storage.getItem(DEEP_LINK_KEY));
    if (
      !target ||
      target.serverId !== account.serverId ||
      target.userId !== account.userId
    )
      return null;
    await storage.removeItem(DEEP_LINK_KEY);
    return target;
  });
}
export async function updateActionNotification(
  notifee: NotifeeLike | null,
  target: WorkspaceApprovalTarget,
  notification?: {
    title?: string;
    data?: Record<string, unknown>;
    android?: Record<string, unknown>;
    ios?: Record<string, unknown>;
  },
): Promise<void> {
  await notifee?.displayNotification?.({
    id: workspaceNotificationKey(target, target.approvalId),
    title: notification?.title ?? "Approval",
    body: SYNCING_NOTIFICATION_BODY,
    data: { ...notification?.data, ...target },
    android: notification?.android,
    ios: notification?.ios,
  });
}
export async function drainBackgroundActionQueue(
  shellClient: ShellClient,
  notifee?: NotifeeLike | null,
): Promise<void> {
  const scope = shellClient.pushScope;
  if (!scope) return;
  const actions = await loadPendingActions();
  for (const action of actions) {
    if (!sameWorkspacePushScope(scope, action)) continue;
    try {
      await shellClient.shellApproval.resolve(
        action.approvalId,
        action.decision,
      );
      await mutate(async (storage) =>
        writeActions(
          storage,
          (await readActions(storage)).filter(
            (current) =>
              !sameApprovalTarget(current, action) ||
              current.decision !== action.decision ||
              current.queuedAt !== action.queuedAt,
          ),
        ),
      );
      await notifee?.cancelNotification(
        workspaceNotificationKey(action, action.approvalId),
      );
    } catch (error) {
      console.warn(
        `[PushQueue] Failed to drain action for ${action.approvalId}:`,
        error,
      );
    }
  }
}
export const backgroundActionQueueStorageKeys = {
  ACTION_QUEUE_KEY,
  DEEP_LINK_KEY,
} as const;
