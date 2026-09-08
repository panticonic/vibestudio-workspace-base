import { useEffect, useRef, useState } from "react";
import {
  pendingReviewNotice,
  isReviewPending,
} from "@vibestudio/shared/authority/reviewPending";
import type {
  TemplateExactPin,
  TemplateInspection,
} from "@vibestudio/service-schemas/templates";
import { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type { WorkspaceCreationReceipt } from "@vibestudio/workspace-contracts/types";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAtomValue } from "jotai";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import { themeColorsAtom } from "../state/themeAtoms";
import { radius, spacing, touchTarget, type } from "../design/tokens";
import { Button, IconButton } from "./ui/primitives";
import { X, Workflow } from "../design/icons";

/** Creates one ordinary workspace through the existing account control API. */
export function WorkspaceCreateSheet({
  directory,
  template: requestedTemplate,
  sourceUrl,
  onClose,
  onCreated,
}: {
  directory: MobileWorkspaceDirectory;
  template?: TemplateExactPin;
  sourceUrl?: string;
  onClose(): void;
  onCreated(): void;
}) {
  const [recoveredSource, setRecoveredSource] = useState<{
    template?: TemplateExactPin;
  } | null>(null);
  const template = recoveredSource
    ? recoveredSource.template
    : requestedTemplate;
  const [restoring, setRestoring] = useState(true);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<"fresh" | "git">(
    sourceUrl ? "git" : "fresh",
  );
  const [url, setUrl] = useState(sourceUrl ?? "");
  const sourceRequest = useRef(0);
  useEffect(
    () => () => {
      sourceRequest.current += 1;
    },
    [directory, requestedTemplate, sourceUrl],
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [created, setCreated] = useState<WorkspaceCreationReceipt | null>(null);
  const [inspection, setInspection] = useState<TemplateInspection | null>(null);
  const [candidates, setCandidates] = useState<TemplateInspection[]>([]);
  const [candidateError, setCandidateError] = useState<unknown>(null);
  const [inspecting, setInspecting] = useState(Boolean(template));
  const [showContents, setShowContents] = useState(false);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const review = pendingReviewNotice(error);
  const awaitingSystemReview = isReviewPending(error);
  const approvalWorkspaceId =
    created?.workspaceId ?? directory.systemWorkspaceId;
  const approvalCount =
    directory.pendingApprovalCounts.get(approvalWorkspaceId) ?? 0;
  const currentInspection =
    inspection &&
    (!template || sameWorkspaceTemplatePin(inspection.pin, template))
      ? inspection
      : null;
  const selectedTemplate = template ?? currentInspection?.pin;
  useEffect(() => {
    let live = true;
    void directory
      .pendingWorkspaceCreation()
      .then((saved) => {
        if (!live || !saved) return;
        setName(saved.workspace);
        setRecoveredSource({ template: saved.rootTemplate });
        setRecoveryNotice(
          `A previous creation of ${saved.workspace} may have completed. Continue to check its result before submitting anything again.`,
        );
      })
      .catch((error) => {
        if (live) setError(error);
      })
      .finally(() => {
        if (live) setRestoring(false);
      });
    return () => {
      live = false;
    };
  }, [directory]);
  useEffect(() => {
    let live = true;
    setInspecting(Boolean(template));
    setInspection(null);
    setError(null);
    setCandidateError(null);
    void (async () => {
      try {
        const available = await directory.listWorkspaceTemplateCandidates();
        if (!live) return;
        setCandidates(available);
        if (!template) return;
        const local = available.find(({ pin }) =>
          sameWorkspaceTemplatePin(pin, template),
        );
        const result =
          local ??
          (await directory.inspectWorkspaceTemplate({ pin: template }));
        if (!live) return;
        if (!sameWorkspaceTemplatePin(result.pin, template))
          throw new Error(
            "The inspected source does not match the selected workspace. Review the source again.",
          );
        setInspection(result);
        setName((current) => current || result.presentation?.name || "");
      } catch (failure) {
        if (!live) return;
        if (template) setError(failure);
        else setCandidateError(failure);
      } finally {
        if (live) setInspecting(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [directory, template, inspectionAttempt]);
  const create = async () => {
    const capturedName = name.trim();
    if (
      pending.current ||
      restoring ||
      (!created &&
        (!capturedName ||
          ((selectedTemplate || sourceKind === "git") && !currentInspection)))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const entry =
        created ??
        (await directory.createWorkspace(capturedName, currentInspection?.pin));
      setRecoveryNotice("");
      if (entry.state === "deleted")
        throw new Error(
          "The earlier creation completed, but its workspace was deleted. Choose Create again only to install a new workspace.",
        );
      setCreated(entry);
      await directory.activate(entry.workspaceId);
      onCreated();
    } catch (error) {
      setError(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close new workspace"
          disabled={busy}
          onPress={onClose}
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: colors.overlay,
          }}
        />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.surfaceRaised,
            maxHeight: "90%",
            flexGrow: 0,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
          }}
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: Math.max(insets.bottom, spacing.lg),
            gap: spacing.md,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.sm,
            }}
          >
            <Workflow size={22} color={colors.primary} />
            <Text
              accessibilityRole="header"
              style={[type.heading, { flex: 1, color: colors.text }]}
            >
              Add workspace
            </Text>
            <IconButton
              icon={X}
              label="Cancel new workspace"
              disabled={busy}
              onPress={onClose}
            />
          </View>
          <Text style={[type.body, { color: colors.textSecondary }]}>
            {created
              ? `${created.name} has been created. You can retry opening it.`
              : selectedTemplate
                ? "Review this source, then give its new workspace a name. It starts separately from your other workspaces."
                : "A separate place for a project, with its own panels, agents and basic tools."}
          </Text>
          {!selectedTemplate && !created && !recoveryNotice && (
            <View
              accessibilityRole="radiogroup"
              style={{ flexDirection: "row", gap: spacing.sm }}
            >
              {(
                [
                  {
                    value: "fresh",
                    title: "Start fresh",
                    detail: "Start with Base",
                  },
                  {
                    value: "git",
                    title: "Git URL",
                    detail: "Use a repository",
                  },
                ] as const
              ).map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityLabel={option.title}
                  accessibilityState={{
                    checked: sourceKind === option.value,
                    disabled: busy || inspecting,
                  }}
                  disabled={busy || inspecting}
                  onPress={() => setSourceKind(option.value)}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor:
                      sourceKind === option.value
                        ? colors.primary
                        : colors.border,
                    borderRadius: radius.md,
                    padding: spacing.md,
                    minHeight: touchTarget,
                  }}
                >
                  <Text
                    style={[
                      type.bodyStrong,
                      {
                        color:
                          sourceKind === option.value
                            ? colors.primary
                            : colors.text,
                      },
                    ]}
                  >
                    {option.title}
                  </Text>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    {option.detail}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {!selectedTemplate && !created && sourceKind === "git" && (
            <View style={{ gap: spacing.sm }}>
              <Text style={[type.bodyStrong, { color: colors.text }]}>
                From a Git URL
              </Text>
              <TextInput
                accessibilityLabel="Workspace source address"
                value={url}
                onChangeText={setUrl}
                editable={!inspecting}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://github.com/owner/workspace"
                style={{
                  color: colors.text,
                  borderWidth: 1,
                  borderColor: colors.border,
                  padding: spacing.md,
                  borderRadius: radius.md,
                }}
              />
              <Button
                label="Review source"
                disabled={busy || inspecting || !url.trim()}
                onPress={() => {
                  const request = ++sourceRequest.current;
                  setInspecting(true);
                  setError(null);
                  void directory
                    .inspectWorkspaceTemplate({ url: url.trim() })
                    .then((result) => {
                      if (request !== sourceRequest.current) return;
                      setInspection(result);
                      setName(result.presentation?.name ?? "");
                    })
                    .catch((error) => {
                      if (request === sourceRequest.current) setError(error);
                    })
                    .finally(() => {
                      if (request === sourceRequest.current)
                        setInspecting(false);
                    });
                }}
              />
            </View>
          )}
          {!selectedTemplate && candidates.length > 0 && (
            <View style={{ gap: spacing.sm }}>
              <Text style={[type.bodyStrong, { color: colors.text }]}>
                Local workspaces
              </Text>
              {candidates.map((candidate) => (
                <Button
                  key={JSON.stringify(candidate.pin)}
                  label={`Explore ${candidate.presentation?.name ?? "workspace"}`}
                  onPress={() => {
                    setInspection(candidate);
                    setName(candidate.presentation?.name ?? "");
                    setCandidateError(null);
                  }}
                />
              ))}
            </View>
          )}
          {candidateError !== null && !selectedTemplate && (
            <Text
              accessibilityRole="alert"
              style={[type.caption, { color: colors.danger }]}
            >
              {candidateError instanceof Error
                ? candidateError.message
                : String(candidateError)}
            </Text>
          )}
          {selectedTemplate && !created && (
            <View
              style={{
                gap: spacing.sm,
                padding: spacing.md,
                borderRadius: radius.md,
                backgroundColor: colors.surfaceSunken,
              }}
            >
              <Text style={[type.bodyStrong, { color: colors.text }]}>
                {inspecting
                  ? "Checking source…"
                  : (currentInspection?.presentation?.name ??
                    "Workspace source")}
              </Text>
              {currentInspection?.presentation?.description && (
                <Text style={[type.body, { color: colors.textSecondary }]}>
                  {currentInspection.presentation.description}
                </Text>
              )}
              <Text
                selectable
                style={[type.caption, { color: colors.textSecondary }]}
              >
                {selectedTemplate.url}
              </Text>
              <Text
                selectable
                style={[type.micro, { color: colors.textTertiary }]}
              >
                Commit {selectedTemplate.commit}
              </Text>
              <Text
                selectable
                style={[type.micro, { color: colors.textTertiary }]}
              >
                Snapshot {selectedTemplate.snapshot}
              </Text>
              {currentInspection && (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: showContents }}
                    onPress={() => setShowContents(!showContents)}
                    style={{ minHeight: touchTarget, justifyContent: "center" }}
                  >
                    <Text style={[type.bodyStrong, { color: colors.primary }]}>
                      {showContents
                        ? "Hide contents"
                        : `View ${currentInspection.repositories.length} workspace units and ${currentInspection.files.length} files`}
                    </Text>
                  </Pressable>
                  {showContents && (
                    <Text
                      selectable
                      style={[type.caption, { color: colors.textSecondary }]}
                    >
                      {[
                        ...currentInspection.repositories,
                        ...currentInspection.files,
                      ].join("\n")}
                    </Text>
                  )}
                </>
              )}
              {!inspecting && !currentInspection && (
                <Button
                  label="Check source again"
                  onPress={() => setInspectionAttempt((attempt) => attempt + 1)}
                />
              )}
            </View>
          )}
          {recoveryNotice ? (
            <Text
              accessibilityRole="text"
              style={[type.body, { color: colors.textSecondary }]}
            >
              {recoveryNotice}
            </Text>
          ) : null}
          <TextInput
            autoFocus={!selectedTemplate}
            value={name}
            onChangeText={setName}
            editable={!busy && !created && !restoring && !recoveryNotice}
            placeholder="Workspace name"
            accessibilityLabel="Workspace name"
            placeholderTextColor={colors.textTertiary}
            returnKeyType="go"
            onSubmitEditing={() => void create()}
            style={[
              type.body,
              {
                color: colors.text,
                backgroundColor: colors.surfaceSunken,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: radius.md,
                minHeight: touchTarget,
                paddingHorizontal: spacing.md,
              },
            ]}
          />
          {review && (
            <Button
              label="Open review"
              onPress={() =>
                void directory
                  .selectApproval(approvalWorkspaceId, review.approvalId)
                  .catch(setError)
              }
            />
          )}
          {!review && approvalCount > 0 && (
            <Button
              label={`Review ${approvalCount} pending ${approvalCount === 1 ? "approval" : "approvals"}`}
              onPress={() => directory.openApprovals(approvalWorkspaceId)}
            />
          )}
          {awaitingSystemReview && (
            <Text
              accessibilityLiveRegion="polite"
              style={[type.body, { color: colors.textSecondary }]}
            >
              {review?.message ?? "A System setup review is waiting for you."}
            </Text>
          )}
          {error !== null && !awaitingSystemReview && (
            <Text
              accessibilityRole="alert"
              style={[type.caption, { color: colors.danger }]}
            >
              {error instanceof Error ? error.message : String(error)}
            </Text>
          )}
          <Button
            label={
              busy
                ? created
                  ? "Opening workspace…"
                  : "Creating workspace…"
                : created
                  ? "Open workspace"
                  : recoveryNotice
                    ? "Continue previous creation"
                    : "Create workspace"
            }
            variant="filled"
            loading={busy}
            disabled={
              busy ||
              (!created &&
                (!name.trim() ||
                  Boolean(
                    (selectedTemplate || sourceKind === "git") &&
                    !currentInspection,
                  )))
            }
            onPress={() => void create()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
