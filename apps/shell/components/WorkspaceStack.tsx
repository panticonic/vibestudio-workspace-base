import { workspaceLabel } from "../shell/workspaceLabel";
import type { ReactNode } from "react";
import {
  CaretRightIcon,
  GearIcon,
  HomeIcon,
  PlusIcon,
  StackIcon,
} from "@radix-ui/react-icons";
import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
import "./workspaceStack.css";

export type WorkspaceSectionState =
  | "opening"
  | "ready"
  | "closed"
  | "disconnected"
  | "access-removed";
export interface WorkspaceSection {
  workspace: HubWorkspaceEntry;
  state: WorkspaceSectionState;
  expanded: boolean;
  focused: boolean;
  approvalCount: number;
  tree: ReactNode;
}

/** The navigation contains workspace sections; each supplied tree owns its own client. */
export function WorkspaceStack({
  sections,
  onToggleExpanded,
  onOpenWorkspace,
  onCreatePanel,
  onReviewApprovals,
  onAddWorkspace,
  scrollRef,
}: {
  sections: readonly WorkspaceSection[];
  scrollRef(element: HTMLElement | null): void;
  onToggleExpanded(workspaceId: string): void;
  onOpenWorkspace(workspaceId: string): void;
  onCreatePanel(workspaceId: string): void;
  onReviewApprovals(workspaceId: string): void;
  onAddWorkspace(): void;
}) {
  const rank = (entry: WorkspaceSection) =>
    entry.workspace.privateRole === "personal"
      ? 0
      : entry.workspace.privateRole === "system"
        ? 2
        : 1;
  const ordered = [...sections].sort((a, b) => rank(a) - rank(b));
  return (
    <nav ref={scrollRef} className="workspace-stack" aria-label="Workspaces">
      <div className="workspace-stack-heading">
        <span>Your workspaces</span>
        <button
          type="button"
          className="workspace-stack-add"
          aria-label="Add workspace"
          onClick={onAddWorkspace}
        >
          <PlusIcon />
        </button>
      </div>
      {ordered.map(
        ({ workspace, state, expanded, focused, approvalCount, tree }) => {
          const icon =
            workspace.privateRole === "personal" ? (
              <HomeIcon />
            ) : workspace.privateRole === "system" ? (
              <GearIcon />
            ) : (
              <StackIcon />
            );
          const unavailable = state === "access-removed";
          return (
            <section
              key={workspace.workspaceId}
              className={`workspace-section${focused ? " workspace-section-focused" : ""}${workspace.privateRole === "system" ? " workspace-section-system" : ""}`}
              aria-label={`${workspaceLabel(workspace)} workspace`}
            >
              <div className="workspace-section-heading">
                <button
                  type="button"
                  className="workspace-section-toggle"
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${workspaceLabel(workspace)}`}
                  aria-expanded={expanded}
                  onClick={() => onToggleExpanded(workspace.workspaceId)}
                >
                  <CaretRightIcon
                    className={expanded ? "workspace-caret-expanded" : ""}
                  />
                </button>
                <button
                  type="button"
                  className="workspace-section-select"
                  aria-label={`Open ${workspaceLabel(workspace)}`}
                  aria-current={focused ? "location" : undefined}
                  disabled={unavailable}
                  onClick={() => onOpenWorkspace(workspace.workspaceId)}
                >
                  <span className="workspace-section-symbol">{icon}</span>
                  <span className="workspace-section-label">
                    <span className="workspace-section-name">
                      {workspaceLabel(workspace)}
                    </span>
                    <span className="workspace-section-caption">
                      {workspace.privateRole ? "Only you" : "Workspace"}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="workspace-section-new"
                  aria-label={`New panel in ${workspaceLabel(workspace)}`}
                  title={`New panel in ${workspaceLabel(workspace)}`}
                  disabled={state !== "ready"}
                  onClick={() => onCreatePanel(workspace.workspaceId)}
                >
                  <PlusIcon />
                </button>
              </div>
              {approvalCount > 0 ? (
                <button
                  type="button"
                  className="workspace-section-attention"
                  onClick={() => onReviewApprovals(workspace.workspaceId)}
                >
                  <span className="workspace-attention-dot" />
                  <span>
                    {approvalCount}{" "}
                    {approvalCount === 1 ? "request needs" : "requests need"}{" "}
                    your review
                  </span>
                </button>
              ) : null}
              {expanded ? (
                <div className="workspace-section-tree">
                  {state === "ready" ? (
                    tree
                  ) : (
                    <div className="workspace-section-state" role="status">
                      <span>
                        {state === "opening"
                          ? `Opening ${workspaceLabel(workspace)}…`
                          : state === "closed"
                            ? "Open this workspace to show its panels."
                            : state === "disconnected"
                              ? "Waiting for the connection."
                              : "Your access to this workspace was removed."}
                      </span>
                      {state === "closed" ? (
                        <button
                          type="button"
                          onClick={() => onOpenWorkspace(workspace.workspaceId)}
                        >
                          Open workspace
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          );
        },
      )}
    </nav>
  );
}
