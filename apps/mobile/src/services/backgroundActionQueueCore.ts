import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import {
  readWorkspacePushScope,
  sameWorkspacePushScope,
  type WorkspaceApprovalTarget,
} from "@vibestudio/shared/workspacePushScope";

export const BACKGROUND_ACTION_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
export type BackgroundApprovalDecision = Exclude<ApprovalDecisionId, "dismiss">;
export interface QueuedBackgroundAction extends WorkspaceApprovalTarget {
  decision: BackgroundApprovalDecision;
  queuedAt: number;
}

export function readApprovalTarget(
  value: unknown,
): WorkspaceApprovalTarget | null {
  const scope = readWorkspacePushScope(value);
  if (!scope) return null;
  const approvalId = (value as Record<string, unknown>)["approvalId"];
  return typeof approvalId === "string" && approvalId.trim()
    ? { ...scope, approvalId }
    : null;
}
export function sameApprovalTarget(
  left: WorkspaceApprovalTarget,
  right: WorkspaceApprovalTarget,
): boolean {
  return (
    sameWorkspacePushScope(left, right) && left.approvalId === right.approvalId
  );
}
export function loadPendingActions(
  raw: string | null | undefined,
  now = Date.now(),
): QueuedBackgroundAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) return [];
    return pruneStaleActions(
      parsed.actions.filter(
        (value): value is QueuedBackgroundAction =>
          readApprovalTarget(value) !== null &&
          isBackgroundDecision(value.decision) &&
          Number.isFinite(value.queuedAt),
      ),
      now,
    );
  } catch {
    return [];
  }
}
export function serializePendingActions(
  actions: QueuedBackgroundAction[],
): string {
  return JSON.stringify({ version: 2, actions });
}
export function enqueueAction(
  actions: QueuedBackgroundAction[],
  action: QueuedBackgroundAction,
  now = Date.now(),
): QueuedBackgroundAction[] {
  return [
    ...pruneStaleActions(actions, now).filter(
      (entry) => !sameApprovalTarget(entry, action),
    ),
    action,
  ];
}
export function clearAction(
  actions: QueuedBackgroundAction[],
  target: WorkspaceApprovalTarget,
): QueuedBackgroundAction[] {
  return actions.filter((entry) => !sameApprovalTarget(entry, target));
}
export function pruneStaleActions(
  actions: QueuedBackgroundAction[],
  now = Date.now(),
): QueuedBackgroundAction[] {
  return actions.filter(
    (entry) => now - entry.queuedAt <= BACKGROUND_ACTION_QUEUE_TTL_MS,
  );
}
export function loadDeepLink(
  raw: string | null | undefined,
): WorkspaceApprovalTarget | null {
  if (!raw) return null;
  try {
    return readApprovalTarget(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function serializeDeepLink(target: WorkspaceApprovalTarget): string {
  return JSON.stringify(target);
}
export function isBackgroundDecision(
  value: unknown,
): value is BackgroundApprovalDecision {
  return (
    value === "once" ||
    value === "session" ||
    value === "version" ||
    value === "deny"
  );
}
