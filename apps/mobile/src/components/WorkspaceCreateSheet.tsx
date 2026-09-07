import { useEffect, useRef, useState } from "react";
import type {
  TemplateExactPin,
  TemplateInspection,
} from "@vibestudio/service-schemas/templates";
import type { MobileHubWorkspace } from "@vibestudio/mobile-iroh";
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
  template,
  onClose,
  onCreated,
}: {
  directory: MobileWorkspaceDirectory;
  template?: TemplateExactPin;
  onClose(): void;
  onCreated(): void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [created, setCreated] = useState<MobileHubWorkspace | null>(null);
  const [inspection, setInspection] = useState<TemplateInspection | null>(null);
  const [inspecting, setInspecting] = useState(Boolean(template));
  const [showContents, setShowContents] = useState(false);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const approvalWorkspaceId =
    created?.workspaceId ?? directory.systemWorkspaceId;
  const approvalCount =
    directory.pendingApprovalCounts.get(approvalWorkspaceId) ?? 0;
  useEffect(() => {
    if (!template) return;
    let live = true;
    setInspecting(true);
    setInspection(null);
    setError(null);
    void directory
      .inspectWorkspaceTemplate(template)
      .then((result) => {
        if (!live) return;
        setInspection(result);
        setName((current) => current || result.presentation?.name || "");
      })
      .catch((failure: unknown) => {
        if (live)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      })
      .finally(() => {
        if (live) setInspecting(false);
      });
    return () => {
      live = false;
    };
  }, [directory, template, inspectionAttempt]);
  const create = async () => {
    const capturedName = name.trim();
    if (
      pending.current ||
      (!created && (!capturedName || (template && !inspection)))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const entry =
        created ??
        (await directory.createWorkspace(capturedName, inspection?.pin));
      setCreated(entry);
      await directory.activate(entry.workspaceId);
      onCreated();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
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
              New workspace
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
              : template
                ? "Review this source, then give its new workspace a name. It starts separately from your other workspaces."
                : "A separate place for a project, with its own panels, agents and basic tools."}
          </Text>
          {template && !created && (
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
                  : (inspection?.presentation?.name ?? "Workspace source")}
              </Text>
              {inspection?.presentation?.description && (
                <Text style={[type.body, { color: colors.textSecondary }]}>
                  {inspection.presentation.description}
                </Text>
              )}
              <Text
                selectable
                style={[type.caption, { color: colors.textSecondary }]}
              >
                {template.url}
              </Text>
              <Text
                selectable
                style={[type.micro, { color: colors.textTertiary }]}
              >
                Commit {template.commit}
              </Text>
              <Text
                selectable
                style={[type.micro, { color: colors.textTertiary }]}
              >
                Snapshot {template.snapshot}
              </Text>
              {inspection && (
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
                        : `View ${inspection.repositories.length} workspace units and ${inspection.files.length} files`}
                    </Text>
                  </Pressable>
                  {showContents && (
                    <Text
                      selectable
                      style={[type.caption, { color: colors.textSecondary }]}
                    >
                      {[...inspection.repositories, ...inspection.files].join(
                        "\n",
                      )}
                    </Text>
                  )}
                </>
              )}
              {!inspecting && !inspection && (
                <Button
                  label="Check source again"
                  onPress={() => setInspectionAttempt((attempt) => attempt + 1)}
                />
              )}
            </View>
          )}
          <TextInput
            autoFocus={!template}
            value={name}
            onChangeText={setName}
            editable={!busy && !created}
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
          {approvalCount > 0 && (
            <Button
              label={`Review ${approvalCount} pending ${approvalCount === 1 ? "approval" : "approvals"}`}
              onPress={() => directory.openApprovals(approvalWorkspaceId)}
            />
          )}
          {error && (
            <Text
              accessibilityRole="alert"
              style={[type.caption, { color: colors.danger }]}
            >
              {error}
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
                  : "Create workspace"
            }
            variant="filled"
            loading={busy}
            disabled={
              busy ||
              (!created && (!name.trim() || Boolean(template && !inspection)))
            }
            onPress={() => void create()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
