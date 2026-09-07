import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { useAtomValue } from "jotai";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
import { approvalDeepLinkAtom } from "../state/approvalDeepLinkAtom";
import type { ToastInput } from "../state/toastAtoms";
import { ApprovalSheet } from "./ApprovalSheet";

/** Approvals have a captured workspace; opening one does not mount its panels. */
export function WorkspaceApprovalSurface({
  directory,
  session,
  notify,
}: {
  directory: MobileWorkspaceDirectory;
  session: MobileWorkspaceSession;
  notify: (toast: ToastInput) => void;
}) {
  const linkedId = useAtomValue(approvalDeepLinkAtom);
  const pending = session.approvals ?? [];
  const linked = pending.find((approval) => approval.approvalId === linkedId);
  const approvals = linked
    ? [linked, ...pending.filter((approval) => approval !== linked)]
    : pending;
  const client = session.client;
  const refresh = async () => {
    await session.approvalState?.refresh("manual");
  };
  return (
    <ApprovalSheet
      visible
      workspaceName={client.workspaceName}
      workspaceNames={Object.fromEntries(
        directory.entries.map((entry) => [
          entry.workspaceId,
          displayWorkspaceName(entry),
        ]),
      )}
      approvals={approvals}
      onClose={() => directory.closeApprovals()}
      onResolve={async (approvalId, decision) => {
        await client.shellApproval.resolve(approvalId, decision);
        await refresh();
      }}
      onSubmitClientConfig={async (approvalId, values) => {
        await client.shellApproval.submitClientConfig(approvalId, values);
        await refresh();
      }}
      onSubmitCredentialInput={async (approvalId, values) => {
        await client.shellApproval.submitCredentialInput(approvalId, values);
        await refresh();
      }}
      onSubmitSecretInput={async (approvalId, values) => {
        await client.shellApproval.submitSecretInput(approvalId, values);
        await refresh();
      }}
      onFetchDiffContent={async (approvalId, hash) => {
        const approval = session.approvals?.find(
          (item) => item.approvalId === approvalId,
        );
        if (
          !approval?.diffReview?.some((entry) =>
            entry.changedFiles.some(
              (file) => file.oldHash === hash || file.newHash === hash,
            ),
          )
        ) {
          throw new Error(
            "This file is not part of the pending reviewed change.",
          );
        }
        return client.blobstore.getText(hash);
      }}
      onNavigateToPanel={(panelId) => {
        directory.closeApprovals();
        void directory
          .activate(session.workspaceId, panelId)
          .catch((error: unknown) =>
            notify({
              title: "Could not open the requesting panel",
              message: String(error),
              tone: "danger",
            }),
          );
      }}
      onOpenDiffFile={async (file, entry) => {
        const panel = await client.panels.createRootPanel(
          "about/workspace-history",
          {
            focus: true,
            stateArgs: {
              diffTarget: {
                repoPath: entry.repoPath,
                path: file.path,
                oldHash: file.oldHash,
                newHash: file.newHash,
                oldState: entry.oldState,
                newState: entry.newState,
                binary: file.binary,
                tooLarge: file.tooLarge,
                files: entry.changedFiles,
              },
            },
          },
        );
        directory.closeApprovals();
        await directory.activate(session.workspaceId, panel.id);
      }}
      onResolveInstallReview={async (approvalId, resolution) => {
        const outcome = await client.shellApproval.resolveInstallReview(
          approvalId,
          resolution,
        );
        await refresh();
        const failures = outcome.landing?.failed ?? [];
        const entryPoint =
          failures.length === 0 && outcome.entryPoint?.kind === "panel"
            ? outcome.entryPoint
            : null;
        const detail = outcome.detail ?? outcome.subject;
        const distinctDetail =
          detail &&
          detail.replace(/[.!]$/, "") !== outcome.heading.replace(/[.!]$/, "");
        notify({
          title: outcome.heading,
          message: failures.length
            ? failures
                .map((part) => `${part.title}: ${part.reason}`)
                .join(" · ")
            : [client.workspaceName, distinctDetail ? detail : null]
                .filter(Boolean)
                .join(" · "),
          tone: failures.length
            ? "danger"
            : outcome.decision === "accepted"
              ? "success"
              : "info",
          ...(entryPoint
            ? {
                actionLabel: `Open ${entryPoint.title}`,
                onAction: async () => {
                  const panel = await client.panels.createRootPanel(
                    entryPoint.repoPath,
                    { title: entryPoint.title, focus: true },
                  );
                  await directory.activate(session.workspaceId, panel.id);
                },
              }
            : {}),
        });
      }}
    />
  );
}
