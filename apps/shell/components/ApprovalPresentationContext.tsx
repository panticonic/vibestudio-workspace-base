import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { actionableRuntimeApprovals } from "@vibestudio/shared/approvalVisibility";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { ShellWorkspaceClient } from "../shell/workspaceClient";
import {
  approvalPresentationKey,
  createApprovalPresentationState,
  reconcileApprovalPresentation,
  selectApprovalPresentation,
  stepApprovalPresentation,
  type ApprovalPresentationState
} from "@vibestudio/shared/approvalPresentation";

type Owner = { token: symbol; pending: readonly PendingApproval[] };
export type PresentedApproval = {
  workspaceId: string;
  approval: PendingApproval;
  approvalId: string;
  actionable: boolean;
};

/** A window presentation index. Requests and decision authority stay with their workspace controllers. */
export function useApprovalPresentationController(client: ShellWorkspaceClient) {
  const [owners, setOwners] = useState(new Map<string, Owner>());
  const [state, setState] = useState<ApprovalPresentationState>(createApprovalPresentationState);
  const [requestedWorkspace, setRequestedWorkspace] = useState<{
    workspaceId: string;
    approvalId?: string;
  } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const entries = useMemo<PresentedApproval[]>(
    () =>
      [...owners].flatMap(([workspaceId, owner]) => {
        const actionable = new Set(
          actionableRuntimeApprovals([...owner.pending]).map((approval) => approval.approvalId)
        );
        return owner.pending.map((approval) => ({
          workspaceId,
          approval,
          approvalId: approval.approvalId,
          actionable: actionable.has(approval.approvalId)
        }));
      }),
    [owners]
  );
  let next = reconcileApprovalPresentation(state, entries);
  if (requestedWorkspace) {
    const requested =
      entries.find(
        (entry) =>
          entry.workspaceId === requestedWorkspace.workspaceId &&
          (!requestedWorkspace.approvalId || entry.approvalId === requestedWorkspace.approvalId) &&
          entry.actionable
      ) ??
      entries.find(
        (entry) =>
          entry.workspaceId === requestedWorkspace.workspaceId &&
          (!requestedWorkspace.approvalId || entry.approvalId === requestedWorkspace.approvalId)
      );
    if (requested) {
      next = selectApprovalPresentation(next, entries, approvalPresentationKey(requested));
      setRequestedWorkspace(null);
    }
  }
  if (next !== state) setState(next);
  const publish = useCallback(
    (workspaceId: string, token: symbol, pending: readonly PendingApproval[]) => {
      setOwners((current) => {
        if (
          current.get(workspaceId)?.token === token &&
          current.get(workspaceId)?.pending === pending
        )
          return current;
        return new Map(current).set(workspaceId, { token, pending });
      });
    },
    []
  );
  const remove = useCallback((workspaceId: string, token: symbol) => {
    setOwners((current) => {
      if (current.get(workspaceId)?.token !== token) return current;
      const copy = new Map(current);
      copy.delete(workspaceId);
      return copy;
    });
  }, []);
  const request = useCallback(
    (workspaceId: string, approvalId?: string) =>
      setRequestedWorkspace({ workspaceId, approvalId }),
    []
  );
  const minimize = useCallback(() => setState((current) => ({ ...current, open: false })), []);
  const expand = useCallback(() => setState((current) => ({ ...current, open: true })), []);
  const step = useCallback(
    (delta: number) => setState((current) => stepApprovalPresentation(current, entries, delta)),
    [entries]
  );
  return {
    client,
    entries,
    state: next,
    host,
    setHost,
    anchorId,
    setAnchorId,
    publish,
    remove,
    request,
    minimize,
    expand,
    step
  };
}

export type ApprovalPresentation = ReturnType<typeof useApprovalPresentationController>;
export const ApprovalPresentationContext = createContext<ApprovalPresentation | null>(null);
export function useApprovalPresentation() {
  const presentation = useContext(ApprovalPresentationContext);
  if (!presentation) throw new Error("Approval presentation requires the desktop window owner");
  return presentation;
}
