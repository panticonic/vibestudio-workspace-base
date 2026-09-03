/**
 * ApprovalCard — the rich, presentational approval surface. It renders inside
 * the content-overlay (a separate document with NO RPC), so it is pure: it takes
 * the approval + derived caller as props and emits `ApprovalCardIntent`s up to
 * its host, which performs the actual `shellApproval.*` calls. Secret-input
 * values stay local and are only emitted on submit.
 */
import { useEffect, useState } from "react";
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Flex,
  IconButton,
  Text,
  TextField,
  Tooltip
} from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckCircledIcon,
  Cross2Icon,
  CubeIcon,
  DragHandleDots2Icon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GearIcon,
  GlobeIcon,
  LockClosedIcon,
  MinusIcon,
  PersonIcon,
  ReloadIcon
} from "@radix-ui/react-icons";
import type {
  ApprovalDetailFormat,
  PendingApproval,
  PendingCapabilityApproval,
  PendingBrowserPermissionApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval
} from "@vibestudio/shared/approvals";
import { PanelIcon } from "./PanelIcon";
import {
  formatAccount,
  formatInjection,
  getApprovalAttribution,
  getApprovalCopy,
  getApprovalOperationKindLabel,
  getRecommendedStandardDecision,
  getRequesterCategoryLabel,
  getStandardApprovalDecisionActions,
  originForUrl,
  shouldOpenApprovalDetails,
  shouldShowOperationSubstance
} from "@vibestudio/shared/approvalCopy";
import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/authorityDomains";
import {
  parseApprovalMarkdown,
  type ApprovalMarkdownInline
} from "@vibestudio/shared/approvalMarkdown";
import { DiffViewer, type DiffContentFetcher, type DiffReviewEntry } from "@workspace/ui/diff";
import {
  InstallReview,
  InstallReviewActions,
  InstallReviewOutcomeNotice,
  defaultInstallSelection,
  installAcceptanceFrom,
  installSelectionSignature,
  syncInstallSelection,
  type InstallSelection
} from "./InstallReview";
import {
  approvalAccent,
  truncateId,
  type ApprovalCardIntentBody,
  type ApprovalCardIntent,
  type ApprovalQueueInfo,
  type CallerInfo
} from "./approvalCardModel";

export interface ApprovalCardProps {
  approval: PendingApproval;
  caller: CallerInfo;
  /** Queue position for the navigator; null when a single approval is pending. */
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
  actionPending?: boolean;
  /** P3.5 diff-review payload; null/omitted → the card renders as it always has. */
  diffReview?: DiffReviewEntry[] | null;
  /** Lazy blob fetcher backing the diff viewer (host-served, content-addressed). */
  fetchContent?: DiffContentFetcher;
  /** Chrome appearance for the diff viewer's syntax theme. */
  appearance?: "light" | "dark";
  /**
   * Which surface is hosting this card (§7.2, §7.8).
   *
   * `card` is the floating content overlay — notification-shaped, host-sized,
   * draggable, and never wider than the overlay host allows. `dialog` is the
   * full surface: the card fills a window-sized dialog that the chrome owns, so
   * it drops the chrome that only makes sense while floating and lets the review
   * inside it spend the width on a second pane.
   */
  layout?: ApprovalCardLayout;
  emit: (intent: ApprovalCardIntent) => void;
}

export type ApprovalCardLayout = "card" | "dialog";

export function ApprovalCard({
  approval,
  caller,
  queue,
  decisionError,
  actionPending = false,
  diffReview,
  fetchContent,
  appearance = "light",
  layout = "card",
  emit
}: ApprovalCardProps) {
  const lifecycleState = approval.lifecycle?.state ?? "ready";
  const [lifecycleNow, setLifecycleNow] = useState(() => Date.now());
  useEffect(() => {
    if (lifecycleState !== "preparing") return;
    setLifecycleNow(Date.now());
    const interval = window.setInterval(() => setLifecycleNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [lifecycleState]);
  const validationPending = lifecycleState === "preparing";
  const validationTerminal = lifecycleState === "failed" || lifecycleState === "cancelled";
  // Secret-config / credential-input values are held locally and only leave the
  // surface on submit.
  const [secretConfigValues, setSecretConfigValues] = useState<Record<string, string>>({});
  // The install review's selection lives here so the keyboard shortcuts accept
  // what is actually on screen rather than recomputing the default slate.
  const [installSelection, setInstallSelection] = useState<InstallSelection>(() =>
    approval.kind === "unit-install-review" ? defaultInstallSelection(approval.parts) : new Map()
  );
  const [taskRuleSelection, setTaskRuleSelection] = useState<Set<string>>(
    () =>
      new Set(
        approval.kind === "capability" && approval.cardType === "task.rules"
          ? (approval.authorityFacets ?? [])
              .filter((facet) => facet.defaultSelected !== false)
              .map((facet) => facet.selectionKey)
          : []
      )
  );
  // A pending review can be refreshed underneath an open card — another device
  // resolves something, the server re-derives the snapshot. The selection is
  // re-seated on the new parts rather than left pointing at the old ones, because
  // an acceptance naming an identity key the snapshot no longer carries is one
  // the server rejects wholesale, and the user never did anything wrong.
  const installOffer =
    approval.kind === "unit-install-review" ? installSelectionSignature(approval.parts) : "";
  const [seenInstallOffer, setSeenInstallOffer] = useState(installOffer);
  if (installOffer !== seenInstallOffer) {
    setSeenInstallOffer(installOffer);
    if (approval.kind === "unit-install-review") {
      const parts = approval.parts;
      setInstallSelection((previous) => syncInstallSelection(parts, previous));
    }
  }
  const taskRuleOffer =
    approval.kind === "capability" && approval.cardType === "task.rules"
      ? JSON.stringify(
          (approval.authorityFacets ?? []).map((facet) => [
            facet.selectionKey,
            facet.defaultSelected !== false
          ])
        )
      : "";
  const [seenTaskRuleOffer, setSeenTaskRuleOffer] = useState(taskRuleOffer);
  if (taskRuleOffer !== seenTaskRuleOffer) {
    setSeenTaskRuleOffer(taskRuleOffer);
    setTaskRuleSelection(
      new Set(
        approval.kind === "capability" && approval.cardType === "task.rules"
          ? (approval.authorityFacets ?? [])
              .filter((facet) => facet.defaultSelected !== false)
              .map((facet) => facet.selectionKey)
          : []
      )
    );
  }
  const emitForApproval = (intent: ApprovalCardIntentBody) => {
    emit({ ...intent, approvalId: approval.approvalId });
  };
  const handleKeyboardDecision = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
    // Enter belongs to whatever control has focus. Without this, opening a part
    // of an install review from the keyboard would expand the row and accept the
    // whole review in the same keystroke, and Enter on "Not now" would cancel and
    // install at once. The card's Enter shortcut is for the card, not for a
    // button that already has its own meaning for the key.
    if (
      event.key === "Enter" &&
      event.target instanceof Element &&
      event.target.closest("button, [role='button'], a[href]")
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      event.preventDefault();
      emitForApproval({ type: "minimize" });
    } else if (event.key === "ArrowLeft" && queue?.canPrev) {
      event.preventDefault();
      emitForApproval({ type: "browse", dir: "prev" });
    } else if (event.key === "ArrowRight" && queue?.canNext) {
      event.preventDefault();
      emitForApproval({ type: "browse", dir: "next" });
    } else if (key === "d" && !validationPending) {
      event.preventDefault();
      if (approval.kind === "browser-permission") {
        // Browser permission decisions have no one-shot "deny": dismissing
        // denies only this request, while "block" is the explicit durable act.
        emitForApproval({ type: "decide", decision: "dismiss" });
      } else if (approval.kind === "unit-install-review") {
        // D is the decline key everywhere else, and it means the same here:
        // cancel leaves the workspace untouched. It never installs.
        emitForApproval({
          type: "resolve-install-review",
          resolution: { decision: "cancel" }
        });
      } else if (approval.kind === "capability" && approval.cardType === "task.rules") {
        emitForApproval({
          type: "resolve-task-rules",
          resolution: { decision: "cancel" }
        });
      } else if (approval.kind !== "device-code") {
        emitForApproval({ type: "decide", decision: "deny" });
      }
    } else if (event.key === "Enter" && !actionPending && lifecycleState === "ready") {
      event.preventDefault();
      if (approval.kind === "client-config") {
        emitForApproval({
          type: "submit-client-config",
          values: secretConfigValues
        });
      } else if (approval.kind === "credential-input") {
        emitForApproval({
          type: "submit-credential-input",
          values: secretConfigValues
        });
      } else if (approval.kind === "secret-input") {
        emitForApproval({
          type: "submit-secret-input",
          values: secretConfigValues
        });
      } else if (approval.kind === "unit-install-review") {
        // Enter accepts the review exactly as it stands on screen — the default
        // slate, or whatever the user has unchecked.
        emitForApproval({
          type: "resolve-install-review",
          resolution: installAcceptanceFrom(approval, installSelection)
        });
      } else if (approval.kind === "capability" && approval.cardType === "task.rules") {
        emitForApproval({
          type: "resolve-task-rules",
          resolution: { decision: "accept", selected: [...taskRuleSelection] }
        });
      } else if (approval.kind !== "device-code") {
        emitForApproval({
          type: "decide",
          decision:
            approval.kind === "browser-permission"
              ? "once"
              : getRecommendedStandardDecision(approval)
        });
      }
    }
  };

  const copy = getApprovalCopy(approval);
  const attribution = getApprovalAttribution(approval);
  const accent = approvalAccent(approval);

  const lifecycleActions = validationPending ? (
    <Button variant="soft" color="gray" onClick={() => emitForApproval({ type: "minimize" })}>
      Run in background
    </Button>
  ) : validationTerminal ? (
    <Button
      variant="soft"
      color="gray"
      onClick={() => emitForApproval({ type: "decide", decision: "dismiss" })}
    >
      Dismiss
    </Button>
  ) : null;
  const actions =
    approval.kind === "client-config" ? (
      <ClientConfigActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({
            type: "submit-client-config",
            values: secretConfigValues
          })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "credential-input" ? (
      <CredentialInputActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({
            type: "submit-credential-input",
            values: secretConfigValues
          })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "device-code" ? (
      <DeviceCodeActions onCancel={() => emitForApproval({ type: "device-cancel" })} />
    ) : approval.kind === "browser-permission" ? (
      <BrowserPermissionActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
      />
    ) : // The install review owns its own actions, because they carry the
    // selection. There is no generic "allow" that could stand in for them.
    approval.kind === "unit-install-review" ? null : approval.kind === "capability" &&
      approval.cardType === "task.rules" ? (
      <Flex gap="2">
        <Button
          onClick={() =>
            emitForApproval({
              type: "resolve-task-rules",
              resolution: {
                decision: "accept",
                selected: [...taskRuleSelection]
              }
            })
          }
          disabled={taskRuleSelection.size === 0}
        >
          {approval.authorityFacets?.length === 1 ? "Allow" : "Allow selected"}
        </Button>
        <Button
          variant="soft"
          color="gray"
          onClick={() =>
            emitForApproval({
              type: "resolve-task-rules",
              resolution: { decision: "cancel" }
            })
          }
        >
          Don't allow
        </Button>
      </Flex>
    ) : approval.kind === "secret-input" ? (
      <SecretInputActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({
            type: "submit-secret-input",
            values: secretConfigValues
          })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : (
      <StandardApprovalActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
        onBlock={() => emitForApproval({ type: "decide", decision: "lock" })}
      />
    );

  return (
    <div
      key={approval.approvalId}
      className="approval-card"
      data-approval-tone={accent}
      data-approval-card=""
      data-approval-id={approval.approvalId}
      data-layout={layout}
      /*
        Floating, the card IS the dialog and says so. Inside the full surface the
        surrounding element already carries `role="dialog"` and the modal
        semantics, and a second dialog nested in the first announces a room
        inside a room. The keyboard contract does not move either way: the
        shortcuts, the focus stop, and the handler stay on this element, so
        `Enter`, `D`, `Escape` and the queue arrows behave identically in both.
      */
      {...(layout === "card"
        ? { role: "dialog", "aria-modal": "false" as const }
        : { role: "group" })}
      tabIndex={0}
      autoFocus
      aria-keyshortcuts="Enter D Escape ArrowLeft ArrowRight"
      onKeyDown={handleKeyboardDecision}
      aria-labelledby={`approval-title-${approval.approvalId}`}
      aria-describedby={`approval-summary-${approval.approvalId}`}
      aria-busy={actionPending}
    >
      <span key={approval.approvalId} className="approval-attention-pulse" aria-hidden="true" />
      <div className="approval-card-scroll">
        <Flex align="start" gap="3" className="approval-card-body">
          <Box className="approval-icon-box" data-beacon="true">
            <ApprovalKindIcon approval={approval} caller={caller} size={18} />
          </Box>

          <Flex
            direction="column"
            gap="1"
            className="approval-card-main"
            style={{ minWidth: 0, flex: 1 }}
          >
            {approval.kind === "capability" && approval.authorityRow ? (
              <Flex gap="1" wrap="wrap">
                {(approval.authorityFacets?.length
                  ? [...new Set(approval.authorityFacets.map(({ row }) => row.domain))]
                  : [approval.authorityRow.domain]
                ).map((domain) => (
                  <Badge key={domain} color="blue" variant="soft">
                    {AUTHORITY_DOMAINS[domain].label}
                  </Badge>
                ))}
                {approval.authorityRow.provenance.surface ? (
                  <Badge color="blue" variant="soft">
                    {approval.authorityRow.provenance.surface}
                  </Badge>
                ) : null}
              </Flex>
            ) : null}
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Text
                id={`approval-title-${approval.approvalId}`}
                size="3"
                weight="bold"
                style={{
                  lineHeight: 1.25,
                  color: "var(--gray-12)",
                  overflowWrap: "anywhere"
                }}
              >
                {copy.title}
              </Text>
              {queue && queue.total > 1 ? (
                <QueueNavigator
                  index={queue.index}
                  total={queue.total}
                  canPrev={queue.canPrev}
                  canNext={queue.canNext}
                  onPrev={() => emitForApproval({ type: "browse", dir: "prev" })}
                  onNext={() => emitForApproval({ type: "browse", dir: "next" })}
                />
              ) : null}
            </Flex>

            <Box id={`approval-summary-${approval.approvalId}`}>
              <ApprovalMarkdown source={copy.summary} tone="muted" compact />
            </Box>
            {approval.kind === "capability" &&
            approval.authorityFacets &&
            approval.authorityFacets.length > 1 ? (
              <Flex
                direction="column"
                gap="1"
                mt="1"
                p="2"
                style={{
                  border: "1px solid var(--gray-a5)",
                  borderRadius: 6,
                  background: "var(--gray-a2)"
                }}
              >
                <Text size="1" weight="medium">
                  {approval.cardType === "task.rules"
                    ? "Choose what this chat may do:"
                    : "This decision allows all of these:"}
                </Text>
                {approval.authorityFacets.map((facet) => (
                  <Flex key={facet.selectionKey} gap="2" align="start">
                    {approval.cardType === "task.rules" ? (
                      <Checkbox
                        checked={taskRuleSelection.has(facet.selectionKey)}
                        onCheckedChange={(checked) =>
                          setTaskRuleSelection((current) => {
                            const next = new Set(current);
                            if (checked === true) next.add(facet.selectionKey);
                            else next.delete(facet.selectionKey);
                            return next;
                          })
                        }
                        aria-label={facet.title}
                      />
                    ) : (
                      <Text size="1" color="gray" aria-hidden>
                        •
                      </Text>
                    )}
                    <Flex direction="column" gap="0" style={{ minWidth: 0 }}>
                      <Text size="1">{facet.title}</Text>
                      <Text size="1" color="gray" style={{ overflowWrap: "anywhere" }}>
                        {facet.resource
                          ? `${facet.resource.label}: ${facet.resource.value}`
                          : facet.row.resource}
                      </Text>
                    </Flex>
                  </Flex>
                ))}
              </Flex>
            ) : null}
            {lifecycleState !== "ready" ? (
              <Flex direction="column" gap="1">
                <Flex align="center" gap="2">
                  {lifecycleState === "preparing" ? (
                    <ReloadIcon
                      aria-hidden
                      style={{
                        animation: "app-tree-spin 0.7s linear infinite"
                      }}
                    />
                  ) : null}
                  <Text
                    size="1"
                    color={lifecycleState === "failed" ? "red" : "gray"}
                    role="status"
                    aria-live="polite"
                  >
                    {lifecycleState === "preparing"
                      ? `${approval.lifecycle?.progress?.label ?? "Checking builds, schemas, and authority"}${
                          approval.lifecycle?.progress?.total !== undefined
                            ? ` (${approval.lifecycle.progress.completed ?? 0} of ${approval.lifecycle.progress.total})`
                            : ""
                        }… ${Math.max(0, Math.floor((lifecycleNow - approval.requestedAt) / 1_000))}s elapsed`
                      : (approval.lifecycle?.diagnostics?.[0] ??
                        (lifecycleState === "cancelled"
                          ? "Publication was cancelled."
                          : "Workspace validation failed."))}
                  </Text>
                </Flex>
                {lifecycleState === "preparing" && approval.lifecycle?.progress?.detail ? (
                  <Text size="1" color="gray">
                    {approval.lifecycle.progress.detail}
                  </Text>
                ) : null}
              </Flex>
            ) : null}

            <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
              <CallerChip caller={caller} onShow={() => emitForApproval({ type: "show-panel" })} />
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                {caller.kindLabel.toLowerCase()}
              </Text>
              {attribution.target ? (
                <>
                  <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                    {attribution.relation ?? "for"}
                  </Text>
                  <span className="approval-caller-chip" data-clickable="false">
                    <span className="approval-caller-chip-title">{attribution.target}</span>
                  </span>
                </>
              ) : null}
            </Flex>

            {/* The warning states its fact at the card's own volume. Native
                code running outside our protections is worth saying every time
                and §7.2 keeps it unhidable — but saying it in alarm red on a
                surface whose whole job is to describe a workspace made the one
                genuinely loud case indistinguishable from the ordinary one. */}
            {copy.warning ? (
              <Flex
                align="start"
                gap="1"
                style={{
                  color: accent === "red" ? "var(--red-11)" : "var(--amber-11)"
                }}
              >
                <Box style={{ flexShrink: 0, paddingTop: 2 }}>
                  <ExclamationTriangleIcon width={13} height={13} />
                </Box>
                <ApprovalMarkdown
                  source={copy.warning}
                  tone={accent === "red" ? "danger" : "caution"}
                  compact
                />
              </Flex>
            ) : null}
            {decisionError ? (
              approval.kind === "unit-install-review" ? (
                // An install that was refused is a fact about the user's
                // workspace, not a broken button: it gets the review's own words.
                <Flex align="start" gap="1" style={{ color: "var(--red-11)" }}>
                  <Box style={{ flexShrink: 0, paddingTop: 2 }}>
                    <ExclamationTriangleIcon width={13} height={13} />
                  </Box>
                  <InstallReviewOutcomeNotice
                    outcome={{
                      source: "refused",
                      mode: approval.mode,
                      message: decisionError
                    }}
                  />
                </Flex>
              ) : (
                <Flex
                  align="center"
                  gap="1"
                  style={{ color: "var(--red-11)" }}
                  role="alert"
                  aria-live="assertive"
                >
                  <ExclamationTriangleIcon width={13} height={13} />
                  <Text size="1" style={{ lineHeight: 1.35 }}>
                    Approval action failed: {decisionError}
                  </Text>
                </Flex>
              )
            ) : null}

            {diffReview && diffReview.length > 0 && fetchContent ? (
              <DiffReviewSection
                entries={diffReview}
                fetchContent={fetchContent}
                appearance={appearance}
                onOpenInWorkspaceHistory={(file, entry) =>
                  emitForApproval({
                    type: "open-in-workspace-history",
                    target: {
                      repoPath: entry.repoPath,
                      path: file.path,
                      oldHash: file.oldHash,
                      newHash: file.newHash,
                      oldState: entry.oldState,
                      newState: entry.newState,
                      binary: file.binary,
                      tooLarge: file.tooLarge,
                      // Ship the whole changed-file set so Workspace History can step
                      // across every file of the entry, not just the focused one.
                      files: entry.changedFiles
                    }
                  })
                }
              />
            ) : null}

            {approval.kind === "capability" && shouldShowOperationSubstance(approval) ? (
              <Box className="approval-operation-substance">
                <Text as="div" size="1" color="gray" weight="bold">
                  What exactly
                </Text>
                <Text as="div" size="2">
                  {approval.operationSubstance.summary}
                </Text>
                {approval.operationSubstance.detail ? (
                  <Text as="div" size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                    {approval.operationSubstance.detail}
                  </Text>
                ) : null}
                {approval.operationSubstance.facts?.length ? (
                  <dl className="approval-operation-facts">
                    {approval.operationSubstance.facts.map((fact) => (
                      <div key={`${fact.label}:${fact.value}`} className="approval-operation-fact">
                        <dt>
                          <Text as="span" size="1" color="gray">
                            {fact.label}
                          </Text>
                        </dt>
                        <dd>
                          <Text as="span" size="1" weight="medium">
                            {fact.value}
                          </Text>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </Box>
            ) : null}

            {/* The install review IS the card: parts, rows, selection, and its
                own two actions. It is not a disclosure under a request summary,
                because the list of parts is the decision. */}
            {approval.kind === "unit-install-review" ? (
              <InstallReview
                approval={approval}
                selection={installSelection}
                onSelectionChange={setInstallSelection}
                layout={layout}
              />
            ) : (
              <ApprovalDetails
                approval={approval}
                caller={caller}
                defaultOpen={shouldOpenApprovalDetails(approval)}
              />
            )}
            {approval.kind === "device-code" ? <DeviceCodeBody approval={approval} /> : null}
            {approval.kind === "client-config" ||
            approval.kind === "credential-input" ||
            approval.kind === "secret-input" ? (
              <SecretConfigFields
                approval={approval}
                values={secretConfigValues}
                onChange={(name, value) =>
                  setSecretConfigValues((previous) => ({
                    ...previous,
                    [name]: value
                  }))
                }
              />
            ) : null}
          </Flex>

          <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
            {/* Only the floating card can be dragged; the full surface is placed
                by the window, so the grip would be a control that does nothing. */}
            {layout === "card" ? (
              <Tooltip content="Drag to move">
                <span
                  className="approval-drag-handle"
                  data-overlay-drag-handle=""
                  role="presentation"
                  aria-hidden="true"
                >
                  <DragHandleDots2Icon />
                </span>
              </Tooltip>
            ) : null}
            <Tooltip content="Minimize to notifications">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                onClick={() => emitForApproval({ type: "minimize" })}
                aria-label="Minimize approval"
              >
                <MinusIcon />
              </IconButton>
            </Tooltip>
          </Flex>
        </Flex>
      </div>

      {/* A persistent action area that never covers content (§7.8). The install
          review's actions live here rather than at the end of its list, because
          `Add to workspace` under fifty-three parts is a decision you have to go
          looking for. */}
      <fieldset className="approval-card-footer" disabled={actionPending} aria-busy={actionPending}>
        {!validationPending && !validationTerminal && approval.kind === "unit-install-review" ? (
          <InstallReviewActions
            approval={approval}
            selection={installSelection}
            busy={actionPending}
            onResolve={(resolution) =>
              emitForApproval({ type: "resolve-install-review", resolution })
            }
          />
        ) : null}
        {lifecycleActions ?? actions}
        {actionPending ? (
          <Text size="1" color="gray" ml="2" role="status" aria-live="polite">
            Saving…
          </Text>
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * Diff-review section (P3.5). One collapsible-free block per repo entry with a
 * per-repo header carrying the host-computed diffstat totals, plus the shared
 * `DiffViewer`. For a multi-repo batch it also shows an aggregate header. The
 * whole section is presentation over host-computed data and never gates the
 * Allow/Deny controls in the footer.
 */
function DiffReviewSection({
  entries,
  fetchContent,
  appearance,
  onOpenInWorkspaceHistory
}: {
  entries: DiffReviewEntry[];
  fetchContent: DiffContentFetcher;
  appearance: "light" | "dark";
  onOpenInWorkspaceHistory: ComponentProps<typeof DiffViewer>["onOpenInWorkspaceHistory"];
}) {
  // Line totals are shown only when EVERY entry carries them — the host omits
  // insertions/deletions for any entry with a skipped (binary/oversized/
  // truncated) file, and a partial batch total would mislead.
  const hasLineTotals = entries.every((entry) => entry.diffStat.insertions != null);
  const totals = entries.reduce(
    (acc, entry) => ({
      filesChanged: acc.filesChanged + entry.diffStat.filesChanged,
      insertions: acc.insertions + (entry.diffStat.insertions ?? 0),
      deletions: acc.deletions + (entry.diffStat.deletions ?? 0)
    }),
    { filesChanged: 0, insertions: 0, deletions: 0 }
  );
  const isBatch = entries.length > 1;
  return (
    <Box
      mt="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 6,
        backgroundColor: "var(--color-panel-translucent)",
        maxWidth: 720
      }}
    >
      <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="1" weight="medium">
            Review changes
          </Text>
          {isBatch ? (
            <Badge color="gray" variant="soft">
              {entries.length} repos · {totals.filesChanged} files
            </Badge>
          ) : null}
          {hasLineTotals ? (
            <Flex align="center" gap="2" style={{ marginLeft: "auto" }}>
              <Text size="1" style={{ color: "var(--green-11)" }}>
                +{totals.insertions}
              </Text>
              <Text size="1" style={{ color: "var(--red-11)" }}>
                −{totals.deletions}
              </Text>
            </Flex>
          ) : null}
        </Flex>
        {entries.map((entry) => (
          <Box key={`${entry.repoPath}:${entry.newState}`} style={{ minWidth: 0 }}>
            <Flex align="center" gap="2" mb="1" wrap="wrap">
              <Badge color="sky" variant="soft" radius="full">
                {entry.repoPath}
              </Badge>
              <Text size="1" color="gray" style={{ marginLeft: "auto" }}>
                {entry.diffStat.filesChanged} files
                {entry.diffStat.insertions != null
                  ? ` · +${entry.diffStat.insertions} −${entry.diffStat.deletions ?? 0}`
                  : ""}
                {entry.truncated ? " · truncated" : ""}
              </Text>
            </Flex>
            <DiffViewer
              entry={entry}
              fetchContent={fetchContent}
              appearance={appearance}
              onOpenInWorkspaceHistory={onOpenInWorkspaceHistory}
            />
          </Box>
        ))}
      </Flex>
    </Box>
  );
}

export function ApprovalKindIcon({
  approval,
  caller,
  size = 18
}: {
  approval: PendingApproval;
  caller?: CallerInfo;
  size?: number;
}) {
  // Parts arriving, not a hazard. A warning triangle over `Welcome — here's
  // what's in your workspace` told every new user their own base template was
  // dangerous, and an icon that means "danger" everywhere means nothing once it
  // is also the icon for "here is your workspace".
  if (approval.kind === "unit-install-review") return <CubeIcon width={size} height={size} />;
  if (approval.kind === "device-code") return <ExternalLinkIcon width={size} height={size} />;
  if (approval.kind === "capability" && caller?.icon) {
    return (
      <PanelIcon
        icon={caller.icon}
        source={caller.iconSourcePath}
        size={size}
        fallback="worker"
      />
    );
  }
  if (approval.kind === "capability") return <GlobeIcon width={size} height={size} />;
  if (approval.kind === "browser-permission") return <GlobeIcon width={size} height={size} />;
  if (approval.kind === "client-config" || approval.kind === "credential-input")
    return <GearIcon width={size} height={size} />;
  return <LockClosedIcon width={size} height={size} />;
}

function QueueNavigator({
  index,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext
}: {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <Flex align="center" gap="1" style={{ marginLeft: "auto", flexShrink: 0 }}>
      <Tooltip content={canPrev ? "Previous pending approval" : "No earlier approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canPrev}
          onClick={onPrev}
          aria-label="Previous approval"
        >
          <ChevronLeftIcon />
        </IconButton>
      </Tooltip>
      <Text size="1" color="gray" style={{ minWidth: 32, textAlign: "center" }}>
        {index + 1} / {total}
      </Text>
      <Tooltip content={canNext ? "Next pending approval" : "No more approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canNext}
          onClick={onNext}
          aria-label="Next approval"
        >
          <ChevronRightIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

const APPROVAL_CALLER_ICON_SIZE = 14;

function CallerChip({ caller, onShow }: { caller: CallerInfo; onShow: () => void }) {
  const clickable = caller.panelId !== undefined;
  const tooltip = clickable ? `Show panel — ${caller.label}` : caller.label;
  return (
    <Tooltip content={tooltip}>
      <span
        className="approval-caller-chip"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        data-clickable={clickable ? "true" : "false"}
        onClick={clickable ? onShow : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onShow();
                }
              }
            : undefined
        }
      >
        <span className="approval-caller-chip-kind" aria-hidden="true">
          <PanelIcon
            icon={caller.icon}
            source={caller.iconSourcePath}
            size={APPROVAL_CALLER_ICON_SIZE}
            fallback={
              caller.kind === "panel"
                ? "panel"
                : caller.kind === "app"
                  ? "app"
                  : caller.kind === "extension"
                    ? "extension"
                    : caller.kind === "system"
                      ? "system"
                      : "worker"
            }
          />
        </span>
        <span className="approval-caller-chip-title">{caller.label}</span>
      </span>
    </Tooltip>
  );
}

function StandardApprovalActions({
  approval,
  decide,
  onBlock
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval;
  decide: (decision: ApprovalDecision) => void;
  onBlock: () => void;
}) {
  const recommendedDecision = getRecommendedStandardDecision(approval);
  const isSevereCapability = approval.kind === "capability" && approval.severity === "severe";
  const actions = getStandardApprovalDecisionActions(approval);
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      {actions.map((action) => {
        const recommended = action.decision === recommendedDecision;
        const destructive = action.decision === "deny" || action.decision === "lock";
        return (
          <DecisionButton
            key={action.decision}
            decision={action.decision}
            label={action.label}
            description={action.description}
            color={
              destructive
                ? "red"
                : recommended
                  ? isSevereCapability && action.decision === "once"
                    ? "amber"
                    : isSevereCapability && action.decision === "version"
                      ? "red"
                      : "sky"
                  : undefined
            }
            variant={recommended ? "solid" : "surface"}
            {...(action.decision === "deny"
              ? { icon: <CrossCircledIcon />, style: { marginLeft: 6 } }
              : {})}
            onClick={() => (action.decision === "lock" ? onBlock() : decide(action.decision))}
          />
        );
      })}
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function BrowserPermissionActions({
  approval: _approval,
  decide
}: {
  approval: PendingBrowserPermissionApproval;
  decide: (decision: ApprovalDecision) => void;
}) {
  const copy = HOST_APPROVAL_COPY.actions.browserPermission;
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        decision="once"
        label={copy.once.label}
        description={copy.once.description}
        color="sky"
        variant="solid"
        onClick={() => decide("once")}
      />
      <DecisionButton
        decision="session"
        label={copy.session.label}
        description={copy.session.description}
        variant="surface"
        onClick={() => decide("session")}
      />
      <DecisionButton
        decision="always"
        label={copy.always.label}
        description={copy.always.description}
        variant="surface"
        onClick={() => decide("always")}
      />
      <DecisionButton
        decision="block"
        label={copy.block.label}
        description={copy.block.description}
        color="red"
        variant="surface"
        onClick={() => decide("block")}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function ClientConfigActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss
}: {
  approval: PendingClientConfigApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingFields
            : HOST_APPROVAL_COPY.forms.saveServiceDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.saveService}
        </Button>
      </Tooltip>
      <DecisionButton
        decision="deny"
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.saveServiceDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function SecretInputActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss
}: {
  approval: PendingSecretInputApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingValues
            : HOST_APPROVAL_COPY.forms.submitDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.submit}
        </Button>
      </Tooltip>
      <DecisionButton
        decision="deny"
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.inputDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function CredentialInputActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss
}: {
  approval: PendingCredentialInputApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingSecret
            : HOST_APPROVAL_COPY.forms.saveServiceDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.saveService}
        </Button>
      </Tooltip>
      <DecisionButton
        decision="deny"
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.saveServiceDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function DecisionButton({
  decision,
  label,
  description,
  color,
  variant = "soft",
  icon = <CheckCircledIcon />,
  style,
  onClick
}: {
  decision: ApprovalDecision;
  label: string;
  description: string;
  color?: "amber" | "red" | "sky";
  variant?: "solid" | "soft" | "surface" | "outline";
  icon?: ReactNode;
  style?: CSSProperties;
  onClick: () => void;
}) {
  return (
    <Tooltip content={description}>
      <Button
        size="1"
        variant={variant}
        color={color}
        style={style}
        onClick={onClick}
        data-approval-decision={decision}
      >
        {icon}
        {label}
      </Button>
    </Tooltip>
  );
}

function DeviceCodeBody({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <Box
      mt="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 6,
        backgroundColor: "var(--color-panel-translucent)",
        maxWidth: 680
      }}
    >
      <Flex direction="column" gap="2">
        <Text size="1" color="gray">
          {HOST_APPROVAL_COPY.deviceSignIn.enterCode}
        </Text>
        <Code
          size="6"
          weight="bold"
          style={{
            letterSpacing: "0.3em",
            paddingInline: 12,
            paddingBlock: 6,
            userSelect: "all",
            alignSelf: "flex-start"
          }}
        >
          {approval.userCode}
        </Code>
        <Text size="1" color="gray">
          at <InlineCode>{originForUrl(approval.verificationUri)}</InlineCode>
        </Text>
        <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
          {HOST_APPROVAL_COPY.deviceSignIn.verificationHelp}
        </Text>
      </Flex>
    </Box>
  );
}

function DeviceCodeActions({ onCancel }: { onCancel: () => void }) {
  return (
    <Button onClick={onCancel} size="2" variant="soft" color="gray">
      {HOST_APPROVAL_COPY.forms.cancel}
    </Button>
  );
}

function DeviceCodeDetails({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Verify at"
        value={<InlineCode>{approval.verificationUri}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Provider"
        value={<InlineCode>{originForUrl(approval.oauthTokenOrigin)}</InlineCode>}
      />
    </>
  );
}

function Detail({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <Flex align="start" gap="2" style={{ minWidth: 0, color: "var(--gray-11)" }}>
      <Box style={{ display: "inline-flex", flexShrink: 0, paddingTop: 2 }}>{icon}</Box>
      <Text size="1" color="gray" style={{ width: 78, flexShrink: 0 }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, flex: 1 }}>{value}</Box>
    </Flex>
  );
}

function ApprovalDetails({
  approval,
  caller,
  defaultOpen
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  defaultOpen: boolean;
}) {
  const detailsProps = defaultOpen ? { open: true } : {};
  return (
    <>
      <details className="approval-details" {...detailsProps}>
        <summary>
          <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
          Request details
        </summary>
        <Flex direction="column" gap="2" pt="2">
          <Detail
            icon={<PersonIcon />}
            label="Requester"
            value={
              <InlineCode>
                {caller.kindLabel} · {caller.label}
              </InlineCode>
            }
          />
          {approval.requester?.breadcrumbs && approval.requester.breadcrumbs.length > 1 ? (
            <Detail
              icon={<GearIcon />}
              label="Chain"
              value={<RequesterBreadcrumbs approval={approval} />}
            />
          ) : null}
          {approval.kind === "credential" ? (
            <CredentialDetails approval={approval} />
          ) : approval.kind === "client-config" ? (
            <ClientConfigDetails approval={approval} />
          ) : approval.kind === "credential-input" ? (
            <CredentialInputDetails approval={approval} />
          ) : approval.kind === "device-code" ? (
            <DeviceCodeDetails approval={approval} />
          ) : approval.kind === "unit-install-review" ? null : approval.kind === "secret-input" ? (
            <SecretInputDetails approval={approval} />
          ) : approval.kind === "browser-permission" ? (
            <BrowserPermissionDetails approval={approval} />
          ) : (
            <CapabilityDetails approval={approval} />
          )}
        </Flex>
      </details>
      <details className="approval-details">
        <summary>
          <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
          Developer details
        </summary>
        <Flex direction="column" gap="2" pt="2">
          <Detail
            icon={<PersonIcon />}
            label="Caller ID"
            value={
              <Tooltip content="Click to select">
                <Code
                  size="1"
                  variant="soft"
                  color="gray"
                  style={{
                    cursor: "text",
                    userSelect: "all",
                    maxWidth: "100%",
                    overflowWrap: "anywhere"
                  }}
                >
                  {approval.callerId}
                </Code>
              </Tooltip>
            }
          />
          {approval.requester ? (
            <Detail
              icon={<LockClosedIcon />}
              label="Trust key"
              value={<IdCode value={approval.requester.stableIdentityKey} />}
            />
          ) : null}
          {approval.requester?.eval ? (
            <Detail
              icon={<GearIcon />}
              label="Eval"
              value={
                <Flex align="center" gap="1" wrap="wrap">
                  {approval.requester.eval.ownerId ? (
                    <InlineCode>owner {approval.requester.eval.ownerId}</InlineCode>
                  ) : null}
                  {approval.requester.eval.subKey ? (
                    <InlineCode>scope {approval.requester.eval.subKey}</InlineCode>
                  ) : null}
                  {approval.requester.eval.runId ? (
                    <InlineCode>run {approval.requester.eval.runId}</InlineCode>
                  ) : null}
                </Flex>
              }
            />
          ) : null}
          {approval.operation ? (
            <Detail
              icon={<GearIcon />}
              label="Operation"
              value={
                <Flex align="center" gap="1" wrap="wrap">
                  <InlineCode>
                    {getApprovalOperationKindLabel(approval.operation.kind)} ·{" "}
                    {approval.operation.verb}
                  </InlineCode>
                  {approval.operation.object ? (
                    <InlineCode>{approval.operation.object.value}</InlineCode>
                  ) : null}
                </Flex>
              }
            />
          ) : null}
          {approval.kind === "capability" && approval.snapshot ? (
            <>
              <Detail
                icon={<GearIcon />}
                label="RPC"
                value={
                  <InlineCode>
                    {approval.snapshot.service}.{approval.snapshot.method}
                  </InlineCode>
                }
              />
              <Detail
                icon={<LockClosedIcon />}
                label="Authority"
                value={<InlineCode>{approval.capability}</InlineCode>}
              />
              <Detail
                icon={<LockClosedIcon />}
                label="Authority target"
                value={
                  <InlineCode>
                    {approval.grantResourceKey ?? approval.snapshot.resourceKey}
                  </InlineCode>
                }
              />
            </>
          ) : null}
          <Detail
            icon={<GlobeIcon />}
            label="Requester repo"
            value={<InlineCode>{approval.repoPath}</InlineCode>}
          />
          <Detail
            icon={<LockClosedIcon />}
            label="Requester version"
            value={<IdCode value={approval.effectiveVersion} />}
          />
        </Flex>
      </details>
    </>
  );
}

function RequesterBreadcrumbs({ approval }: { approval: PendingApproval }) {
  const breadcrumbs = approval.requester?.breadcrumbs ?? [];
  return (
    <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
      {breadcrumbs.flatMap((breadcrumb, index) => {
        const categoryLabel =
          breadcrumb.category === "unknown" ? null : getRequesterCategoryLabel(breadcrumb.category);
        const text = categoryLabel
          ? breadcrumb.label
            ? `${categoryLabel}: ${breadcrumb.label}`
            : categoryLabel
          : breadcrumb.label;
        if (!text) return [];
        return [
          <Flex key={`${breadcrumb.id}:${index}`} align="center" gap="1" style={{ minWidth: 0 }}>
            {index > 0 ? (
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                &gt;
              </Text>
            ) : null}
            <Badge color="gray" variant="soft" style={{ maxWidth: 260 }}>
              {text}
            </Badge>
          </Flex>
        ];
      })}
    </Flex>
  );
}

function SecretConfigFields({
  approval,
  values,
  onChange
}: {
  approval:
    | PendingClientConfigApproval
    | PendingCredentialInputApproval
    | PendingSecretInputApproval;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <Flex direction="column" gap="2" pt="1" style={{ maxWidth: 620 }}>
      <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
        {approval.kind === "secret-input"
          ? HOST_APPROVAL_COPY.forms.ephemeralSecretHelp
          : HOST_APPROVAL_COPY.forms.storedSecretHelp}
      </Text>
      {approval.fields.map((field) => (
        <Flex key={field.name} direction="column" gap="1">
          <Flex align="center" gap="2" wrap="wrap">
            <Text size="1" weight="medium">
              {field.label}
            </Text>
            {field.required ? (
              <Badge color="amber" variant="soft">
                {HOST_APPROVAL_COPY.chrome.required}
              </Badge>
            ) : null}
            {field.type === "secret" ? (
              <Badge color="gray" variant="soft">
                {HOST_APPROVAL_COPY.chrome.secret}
              </Badge>
            ) : null}
          </Flex>
          <TextField.Root
            size="2"
            type={field.type === "secret" ? "password" : "text"}
            value={values[field.name] ?? ""}
            placeholder={field.label}
            onChange={(event) => onChange(field.name, event.currentTarget.value)}
          />
          {field.description ? (
            <Text size="1" color="gray">
              {field.description}
            </Text>
          ) : null}
        </Flex>
      ))}
    </Flex>
  );
}

function ClientConfigDetails({ approval }: { approval: PendingClientConfigApproval }) {
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  const tokenOrigin = originForUrl(approval.tokenUrl);
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Client"
        value={<IdCode value={approval.configId} />}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Authorize"
        value={
          <Code size="1" variant="soft" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>
            {approval.authorizeUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Token URL"
        value={
          <Code
            size="1"
            color="amber"
            variant="soft"
            style={{ maxWidth: 520, overflowWrap: "anywhere" }}
          >
            {approval.tokenUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Binding"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            <Badge color="amber" variant="soft">
              Secret use limited to {tokenOrigin}
            </Badge>
            {authorizeOrigin !== tokenOrigin ? (
              <Badge color="gray" variant="outline">
                Sign-in starts at {authorizeOrigin}
              </Badge>
            ) : null}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
    </>
  );
}

function SecretInputDetails({ approval }: { approval: PendingSecretInputApproval }) {
  return (
    <>
      {approval.description ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Request"
          value={
            <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {approval.description}
            </Text>
          }
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<FormattedDetailValue value={detail.value} format={detail.format} />}
        />
      ))}
    </>
  );
}

function CredentialInputDetails({ approval }: { approval: PendingCredentialInputApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [
    approval.oauthAuthorizeOrigin,
    approval.oauthTokenOrigin,
    approval.oauthUserinfoOrigin
  ].filter((origin): origin is string => typeof origin === "string" && origin.length > 0);

  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Account"
        value={<InlineCode>{formatAccount(approval)}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      {approval.bindingLabel ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Binding"
          value={<InlineCode>{approval.bindingLabel}</InlineCode>}
        />
      ) : null}
      {approval.grantResource ? (
        <Detail
          icon={<GlobeIcon />}
          label="Grant"
          value={
            <InlineCode>
              {approval.grantResource.bindingId} {approval.grantResource.action}{" "}
              {approval.grantResource.resource}
            </InlineCode>
          }
        />
      ) : null}
      {approval.gitOperation ? (
        <>
          <Detail
            icon={<LockClosedIcon />}
            label="Operation"
            value={<InlineCode>{approval.gitOperation.label}</InlineCode>}
          />
          <Detail
            icon={<GlobeIcon />}
            label="Remote"
            value={<InlineCode>{approval.gitOperation.remote}</InlineCode>}
          />
        </>
      ) : null}
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      {oauthOrigins.length > 0 ? (
        <Detail
          icon={<GlobeIcon />}
          label="OAuth"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {oauthOrigins.map((origin) => (
                <Code
                  key={origin}
                  size="1"
                  color={approval.oauthAudienceDomainMismatch ? "red" : "gray"}
                  variant="soft"
                  style={{ maxWidth: 360 }}
                >
                  {origin}
                </Code>
              ))}
            </Flex>
          }
        />
      ) : null}
      {approval.oauthAudienceDomainMismatch ? (
        <Detail
          icon={<ExclamationTriangleIcon />}
          label="Warning"
          value={
            <Badge color="red" variant="soft">
              OAuth domain differs from audience
            </Badge>
          }
        />
      ) : null}
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  const detailRows = approval.details ?? [];
  return (
    <>
      {approval.resource ? (
        <Detail
          icon={<GlobeIcon />}
          label={approval.resource.label}
          value={<InlineCode>{approval.resource.value}</InlineCode>}
        />
      ) : null}
      {detailRows.map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<InlineCode>{detail.value}</InlineCode>}
        />
      ))}
    </>
  );
}

function BrowserPermissionDetails({ approval }: { approval: PendingBrowserPermissionApproval }) {
  return (
    <>
      <Detail
        icon={<GlobeIcon />}
        label="Site"
        value={<InlineCode>{approval.origin}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Permissions"
        value={<InlineCode>{approval.capabilities.join(", ")}</InlineCode>}
      />
      <Detail
        icon={<GearIcon />}
        label="Device"
        value={<InlineCode>{approval.deviceLabel}</InlineCode>}
      />
    </>
  );
}

function ApprovalMarkdown({
  source,
  tone = "default",
  compact = false
}: {
  source: string;
  tone?: "default" | "muted" | "caution" | "danger";
  compact?: boolean;
}) {
  const blocks = parseApprovalMarkdown(source);
  if (blocks.length === 0) return null;
  const color =
    tone === "danger"
      ? "var(--red-11)"
      : tone === "caution"
        ? "var(--amber-11)"
        : tone === "muted"
          ? "var(--gray-11)"
          : undefined;
  return (
    <Flex
      direction="column"
      gap={compact ? "1" : "2"}
      style={{ color, lineHeight: 1.4, minWidth: 0 }}
    >
      {blocks.map((block, index) => {
        if (block.kind === "code-block") {
          return (
            <pre
              key={index}
              style={{
                margin: 0,
                maxWidth: "100%",
                overflowX: "auto",
                borderRadius: 6,
                padding: "6px 8px",
                background: "var(--gray-a3)",
                fontSize: 12
              }}
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "bullet-list" || block.kind === "ordered-list") {
          const Tag = block.kind === "bullet-list" ? "ul" : "ol";
          return (
            <Tag key={index} style={{ margin: 0, paddingLeft: 18 }}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Text as="span" size="1" style={{ lineHeight: 1.4 }}>
                    <ApprovalMarkdownInlineNodes nodes={item} />
                  </Text>
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <Text key={index} size="1" style={{ lineHeight: 1.4, overflowWrap: "anywhere" }}>
            <ApprovalMarkdownInlineNodes nodes={block.children} />
          </Text>
        );
      })}
    </Flex>
  );
}

function ApprovalMarkdownInlineNodes({ nodes }: { nodes: ApprovalMarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <Code key={index} size="1" variant="soft">
              {node.text}
            </Code>
          );
        }
        if (node.kind === "strong") {
          return (
            <strong key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </strong>
          );
        }
        if (node.kind === "emphasis") {
          return (
            <em key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </em>
          );
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

function FormattedDetailValue({ value, format }: { value: string; format?: ApprovalDetailFormat }) {
  if (format === "markdown") return <ApprovalMarkdown source={value} compact />;
  if (format === "tree") return <CollapsibleTree value={value} />;
  if (format === "plain") {
    return (
      <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
        {value}
      </Text>
    );
  }
  return <InlineCode>{value}</InlineCode>;
}

function CollapsibleTree({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const lines = value.split("\n");
  const summary = lines[0] ?? "";
  const hasBody = lines.length > 1;
  if (!hasBody) {
    return (
      <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
        {summary}
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="1">
      <Flex
        align="center"
        gap="1"
        onClick={() => setOpen((prev) => !prev)}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text size="1" style={{ lineHeight: 1.35, color: "var(--gray-11)", flexShrink: 0 }}>
          {open ? "▾" : "▸"}
        </Text>
        <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
          {summary}
        </Text>
      </Flex>
      {open ? (
        <pre
          style={{
            margin: 0,
            maxWidth: "100%",
            overflowX: "auto",
            borderRadius: 6,
            padding: "6px 8px",
            background: "var(--gray-a3)",
            fontSize: 12
          }}
        >
          <code>{lines.slice(1).join("\n")}</code>
        </pre>
      ) : null}
    </Flex>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <Code size="1" variant="soft" style={{ maxWidth: "100%" }}>
      {children}
    </Code>
  );
}

function IdCode({ value, prefix }: { value: string; prefix?: string }) {
  const fullText = prefix ? `${prefix} ${value}` : value;
  const display = `${prefix ? `${prefix} ` : ""}${truncateId(value)}`;
  return (
    <Code size="1" variant="soft" title={fullText} style={{ maxWidth: "100%" }}>
      {display}
    </Code>
  );
}
