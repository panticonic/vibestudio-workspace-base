import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { useSyncExternalStore } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import { themeColorsAtom, colorSchemeAtom } from "../state/themeAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import { WorkspaceScope } from "../state/workspaceScope";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { PanelDrawer } from "./PanelDrawer";
import { VibestudioLogo } from "./VibestudioLogo";
import { IconButton } from "./ui/primitives";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings,
  User,
  Workflow,
  RefreshCw,
} from "../design/icons";
import { radius, spacing, touchTarget, type } from "../design/tokens";

export function WorkspaceDrawer({
  directory,
  onSelect,
  onSettings,
}: {
  directory: MobileWorkspaceDirectory;
  onSelect: () => void;
  onSettings: (workspaceId: string | null) => void;
}) {
  useSyncExternalStore(directory.subscribe, directory.getSnapshot);
  const colors = useAtomValue(themeColorsAtom);
  const scheme = useAtomValue(colorSchemeAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const insets = useSafeAreaInsets();
  const perform = (operation: Promise<unknown>) =>
    void operation.catch((error: unknown) =>
      pushToast({
        title: "Workspace needs attention",
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      }),
    );
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <View style={styles.brand}>
        <VibestudioLogo size={28} variant="symbol" />
        <View style={styles.copy}>
          <Text style={[type.heading, { color: colors.text }]}>
            Your workspaces
          </Text>
          <Text style={[type.micro, { color: colors.textTertiary }]}>
            A place for everything you're doing
          </Text>
        </View>
        <IconButton
          icon={Plus}
          label="New workspace"
          size={18}
          onPress={() => {
            directory.requestWorkspaceCreation();
            onSelect();
          }}
        />
        <IconButton
          icon={RefreshCw}
          label="Refresh workspaces"
          size={17}
          onPress={() => perform(directory.refresh())}
        />
      </View>
      {directory.approvalCount > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Approvals, ${directory.approvalCount} waiting`}
          onPress={() => {
            directory.openApprovals();
            onSelect();
          }}
          style={[
            styles.settings,
            {
              paddingHorizontal: spacing.lg,
              backgroundColor: colors.accentSoft,
            },
          ]}
        >
          <Bell size={18} color={colors.primary} />
          <Text style={[type.bodyStrong, { color: colors.primary }]}>
            Approvals
          </Text>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            {directory.approvalCount} waiting
          </Text>
        </Pressable>
      )}
      <ScrollView
        contentContainerStyle={styles.sections}
        keyboardShouldPersistTaps="handled"
      >
        {directory.error && (
          <Text
            accessibilityRole="alert"
            style={[type.caption, styles.message, { color: colors.danger }]}
          >
            {directory.error}
          </Text>
        )}
        {directory.entries.map((entry) => {
          const selected = directory.activeWorkspaceId === entry.workspaceId;
          const expanded = directory.expanded.has(entry.workspaceId);
          const session = directory.sessions.get(entry.workspaceId);
          const Icon =
            entry.privateRole === "personal"
              ? User
              : entry.privateRole === "system"
                ? Settings
                : Workflow;
          const status = session?.store.get(connectionStatusAtom);
          const subtitle =
            session?.state === "opening"
              ? "Opening…"
              : session?.state === "failed"
                ? "Needs attention"
                : status === "disconnected"
                  ? "Disconnected"
                  : entry.privateRole
                    ? "Only you"
                    : "Workspace";
          return (
            <View
              key={entry.workspaceId}
              style={[
                styles.section,
                {
                  borderColor: selected ? colors.primary : colors.borderSubtle,
                  backgroundColor: selected ? colors.surface : "transparent",
                },
              ]}
            >
              <View style={styles.heading}>
                <IconButton
                  icon={expanded ? ChevronDown : ChevronRight}
                  label={`${expanded ? "Collapse" : "Expand"} ${displayWorkspaceName(entry)}`}
                  size={16}
                  onPress={() =>
                    perform(directory.toggleExpanded(entry.workspaceId))
                  }
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Open ${displayWorkspaceName(entry)}, ${subtitle}`}
                  onPress={() => {
                    perform(directory.activate(entry.workspaceId));
                    onSelect();
                  }}
                  style={styles.workspaceButton}
                >
                  <View
                    style={[
                      styles.icon,
                      {
                        backgroundColor: selected
                          ? colors.accentSoft
                          : colors.surfaceSunken,
                      },
                    ]}
                  >
                    <Icon
                      size={17}
                      color={selected ? colors.primary : colors.textSecondary}
                    />
                  </View>
                  <View style={styles.copy}>
                    <Text
                      numberOfLines={1}
                      style={[type.bodyStrong, { color: colors.text }]}
                    >
                      {displayWorkspaceName(entry)}
                    </Text>
                    <Text style={[type.micro, { color: colors.textTertiary }]}>
                      {subtitle}
                    </Text>
                  </View>
                </Pressable>
                <IconButton
                  icon={Plus}
                  label={`New panel in ${displayWorkspaceName(entry)}`}
                  size={18}
                  onPress={() =>
                    perform(
                      directory.createPanel(entry.workspaceId).then(onSelect),
                    )
                  }
                />
              </View>
              {(directory.pendingApprovalCounts.get(entry.workspaceId) ?? 0) >
                0 && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Review approvals for ${displayWorkspaceName(entry)}`}
                  style={[styles.settings, { paddingHorizontal: spacing.md }]}
                  onPress={() => {
                    directory.openApprovals(entry.workspaceId);
                    onSelect();
                  }}
                >
                  <Bell size={15} color={colors.primary} />
                  <Text style={[type.caption, { color: colors.primary }]}>
                    {directory.pendingApprovalCounts.get(entry.workspaceId)}{" "}
                    awaiting your review
                  </Text>
                </Pressable>
              )}
              {expanded && session?.state === "ready" && (
                <WorkspaceScope
                  session={session}
                  visible={selected}
                  scheme={scheme}
                >
                  <PanelDrawer
                    embedded
                    onSelectPanel={(panelId) => {
                      perform(directory.activate(entry.workspaceId, panelId));
                      onSelect();
                    }}
                  />
                </WorkspaceScope>
              )}
              {expanded && session?.state === "failed" && (
                <View style={styles.message}>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    {session.error}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => perform(directory.open(entry.workspaceId))}
                    style={styles.retry}
                  >
                    <Text style={[type.bodyStrong, { color: colors.primary }]}>
                      Try opening again
                    </Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
      <View
        style={[
          styles.footer,
          {
            borderTopColor: colors.borderSubtle,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}
      >
        <Pressable
          style={styles.settings}
          accessibilityRole="button"
          accessibilityLabel="Open your settings"
          onPress={() => onSettings(directory.activeWorkspaceId)}
        >
          <Settings size={19} color={colors.textSecondary} />
          <View style={styles.copy}>
            <Text style={[type.bodyStrong, { color: colors.text }]}>
              Settings
            </Text>
            <Text style={[type.micro, { color: colors.textTertiary }]}>
              Your account & connections
            </Text>
          </View>
          <ChevronRight size={16} color={colors.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  sections: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  section: { borderWidth: 1, borderRadius: radius.md, overflow: "hidden" },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  workspaceButton: {
    flex: 1,
    minWidth: 0,
    minHeight: touchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  message: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  retry: { minHeight: touchTarget, justifyContent: "center" },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  settings: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: touchTarget,
    gap: spacing.sm,
  },
});
