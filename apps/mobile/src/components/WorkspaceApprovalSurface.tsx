import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
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
  const items = directory.approvalItems;
  const selected = directory.selectedApproval;
  if (!selected || selected.workspaceId !== session.workspaceId) return null;
  const selectedKey = approvalPresentationKey(selected);
  const remaining = directory.unloadedApprovalWorkspaces;
  const loading = remaining
    .filter(({ state }) => state === "loading")
    .map(({ entry }) => displayWorkspaceName(entry));
  const unavailable = remaining
    .filter(({ state }) => state !== "loading")
    .map(({ entry }) => displayWorkspaceName(entry));
  const queueStatus = remaining.length
    ? {
        message: [
          loading.length ? `Loading reviews from ${loading.join(", ")}…` : null,
          unavailable.length
            ? `More reviews in ${unavailable.join(", ")}.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        ...(unavailable.length
          ? {
              actionLabel: "Load remaining reviews",
              onAction: () => directory.openApprovals(),
            }
          : {}),
      }
    : undefined;
  const assertCurrent = (approvalId = selected.approvalId) => {
    if (
      !directory.approvalPresentation.open ||
      directory.sessions.get(session.workspaceId) !== session ||
      directory.approvalPresentation.selectedKey !== selectedKey ||
      approvalId !== selected.approvalId ||
      !directory.approvalItems.some(
        (item) => approvalPresentationKey(item) === selectedKey,
      )
    ) {
      throw new Error(
        "This approval is no longer selected. Review the current request.",
      );
    }
  };
  const client = session.client;
  const refresh = async () => {
    await session.approvalState?.refresh("manual");
  };
  return (
    <ApprovalSheet
      key={selectedKey}
      visible
      workspaceName={client.workspaceName}
      workspaceNames={Object.fromEntries(
        directory.entries.map((entry) => [
          entry.workspaceId,
          displayWorkspaceName(entry),
        ]),
      )}
      approval={selected.approval}
      queue={{
        index: items.findIndex(
          (item) => approvalPresentationKey(item) === selectedKey,
        ),
        total: items.length,
        status: queueStatus,
        onPrevious: () => directory.stepApproval(-1),
        onNext: () => directory.stepApproval(1),
      }}
      onClose={() => directory.closeApprovals()}
      onResolve={async (approvalId, decision) => {
        assertCurrent(approvalId);
        await client.shellApproval.resolve(approvalId, decision);
        await refresh();
      }}
      onSubmitClientConfig={async (approvalId, values) => {
        assertCurrent(approvalId);
        await client.shellApproval.submitClientConfig(approvalId, values);
        await refresh();
      }}
      onSubmitCredentialInput={async (approvalId, values) => {
        assertCurrent(approvalId);
        await client.shellApproval.submitCredentialInput(approvalId, values);
        await refresh();
      }}
      onSubmitSecretInput={async (approvalId, values) => {
        assertCurrent(approvalId);
        await client.shellApproval.submitSecretInput(approvalId, values);
        await refresh();
      }}
      onFetchDiffContent={async (approvalId, hash) => {
        assertCurrent(approvalId);
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
        assertCurrent();
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
        assertCurrent();
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
        assertCurrent(approvalId);
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
