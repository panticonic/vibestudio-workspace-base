import {
  BACKGROUND_ACTION_QUEUE_TTL_MS,
  clearAction,
  enqueueAction,
  loadDeepLink,
  loadPendingActions,
  serializeDeepLink,
  serializePendingActions,
} from "./backgroundActionQueueCore";
const scope = {
  serverId: "srv_aaaaaaaaaaaaaaaaaaaaaaaa",
  workspaceId: "project",
  userId: "alice",
};
const target = { ...scope, approvalId: "approval-1" };

describe("workspace-scoped background approval actions", () => {
  it("persists the captured workspace and account and clears only that target", () => {
    const action = { ...target, decision: "deny" as const, queuedAt: 1000 };
    const queued = enqueueAction([], action, 1000);
    expect(loadPendingActions(serializePendingActions(queued), 1000)).toEqual([
      action,
    ]);
    expect(clearAction(queued, { ...target, workspaceId: "other" })).toEqual([
      action,
    ]);
    expect(clearAction(queued, target)).toEqual([]);
  });
  it("keeps colliding approval ids in different workspaces and accounts independent", () => {
    const original = { ...target, decision: "once" as const, queuedAt: 1 };
    const other = {
      ...original,
      workspaceId: "other",
      decision: "deny" as const,
    };
    const queued = enqueueAction(
      enqueueAction([original], other, 2),
      { ...original, decision: "version", queuedAt: 3 },
      3,
    );
    expect(queued).toEqual([
      other,
      { ...original, decision: "version", queuedAt: 3 },
    ]);
  });
  it("does not guess the destination of legacy unscoped actions or links", () => {
    expect(
      loadPendingActions(
        JSON.stringify({
          version: 1,
          actions: [
            { approvalId: "approval-1", decision: "deny", queuedAt: 1 },
          ],
        }),
        2,
      ),
    ).toEqual([]);
    expect(
      loadDeepLink(JSON.stringify({ approvalId: "approval-1" })),
    ).toBeNull();
  });
  it("drops expired decisions and keeps the explicit deep-link target", () => {
    const now = BACKGROUND_ACTION_QUEUE_TTL_MS + 10;
    expect(
      loadPendingActions(
        serializePendingActions([{ ...target, decision: "deny", queuedAt: 0 }]),
        now,
      ),
    ).toEqual([]);
    expect(loadDeepLink(serializeDeepLink(target))).toEqual(target);
  });
});
