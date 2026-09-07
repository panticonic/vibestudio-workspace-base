import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";
import type {
  MobileApprovalOwner,
  MobileWorkspaceDirectory,
} from "../services/workspaceDirectory";
import type { ToastInput } from "../state/toastAtoms";
import { ApprovalSheet, type ApprovalSheetProps } from "./ApprovalSheet";

/** Approvals retain their exact hub/workspace owner while the shared queue is open. */
export function WorkspaceApprovalSurface({
  directory,
  owner,
  notify,
}: {
  directory: MobileWorkspaceDirectory;
  owner: MobileApprovalOwner;
  notify: (toast: ToastInput) => void;
}) {
  const items = directory.approvalItems;
  const selected = directory.selectedApproval;
  if (!selected || directory.selectedApprovalOwner !== owner) return null;
  const selectedKey = approvalPresentationKey(selected);
  const remaining = directory.unloadedApprovalWorkspaces;
  const loading = remaining
    .filter(({ state }) => state === "loading")
    .map(({ entry }) => displayWorkspaceName(entry));
  const unavailable = remaining
    .filter(({ state }) => state !== "loading")
    .map(({ entry }) => displayWorkspaceName(entry));
  const ownerErrors = directory.approvalOwnerErrors;
  const queueStatus =
    remaining.length || ownerErrors.length
      ? {
          message: [
            loading.length
              ? `Loading reviews from ${loading.join(", ")}…`
              : null,
            unavailable.length
              ? `More reviews in ${unavailable.join(", ")}.`
              : null,
            ...ownerErrors,
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
      directory.selectedApprovalOwner !== owner ||
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
  const client = owner.session?.client;
  const refresh = async () => {
    await owner.approvalState?.refresh("manual");
  };
  const workspaceActions = client
    ? {
        onFetchDiffContent: async (approvalId: string, hash: string) => {
          assertCurrent(approvalId);
          const approval = owner.approvals?.find(
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
        },
        onNavigateToPanel: (panelId: string) => {
          assertCurrent();
          directory.closeApprovals();
          void directory
            .activate(owner.session!.workspaceId, panelId)
            .catch((error: unknown) =>
              notify({
                title: "Could not open the requesting panel",
                message: String(error),
                tone: "danger",
              }),
            );
        },
        onOpenDiffFile: async (
          file: Parameters<
            NonNullable<ApprovalSheetProps["onOpenDiffFile"]>
          >[0],
          entry: Parameters<
            NonNullable<ApprovalSheetProps["onOpenDiffFile"]>
          >[1],
        ) => {
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
          await directory.activate(owner.session!.workspaceId, panel.id);
        },
      }
    : {};
  return (
    <ApprovalSheet
      key={selectedKey}
      visible
      workspaceName={owner.label}
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
      {...workspaceActions}
      onClose={() => directory.closeApprovals()}
      onResolve={async (approvalId, decision) => {
        assertCurrent(approvalId);
        await owner.shellApproval.resolve(approvalId, decision);
        await refresh();
      }}
      onSubmitClientConfig={async (approvalId, values) => {
        assertCurrent(approvalId);
        await owner.shellApproval.submitClientConfig(approvalId, values);
        await refresh();
      }}
      onSubmitCredentialInput={async (approvalId, values) => {
        assertCurrent(approvalId);
        await owner.shellApproval.submitCredentialInput(approvalId, values);
        await refresh();
      }}
      onSubmitSecretInput={async (approvalId, values) => {
        assertCurrent(approvalId);
        await owner.shellApproval.submitSecretInput(approvalId, values);
        await refresh();
      }}
      onResolveInstallReview={async (approvalId, resolution) => {
        assertCurrent(approvalId);
        const outcome = await owner.shellApproval.resolveInstallReview(
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
            : [owner.label, distinctDetail ? detail : null]
                .filter(Boolean)
                .join(" · "),
          tone: failures.length
            ? "danger"
            : outcome.decision === "accepted"
              ? "success"
              : "info",
          ...(entryPoint && owner.session
            ? {
                actionLabel: `Open ${entryPoint.title}`,
                onAction: async () => {
                  const panel = await client!.panels.createRootPanel(
                    entryPoint.repoPath,
                    { title: entryPoint.title, focus: true },
                  );
                  await directory.activate(
                    owner.session!.workspaceId,
                    panel.id,
                  );
                },
              }
            : {}),
        });
      }}
    />
  );
}
