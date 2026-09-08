import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { WorkspaceCreateSheet } from "../components/WorkspaceCreateSheet";
import { WorkspaceApprovalSurface } from "../components/WorkspaceApprovalSurface";
import { pushToastAtom } from "../state/toastAtoms";
import { useSyncExternalStore } from "react";
import { WorkspaceSessionEffects } from "../components/WorkspaceSessionEffects";
import {
  View,
  Text,
  Modal,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import {
  createDrawerNavigator,
  useNavigation,
  DrawerActions,
} from "@workspace/mobile-navigation";
import { useAtomValue, useSetAtom } from "jotai";
import { MainScreen } from "../components/MainScreen";
import { WorkspaceDrawer } from "../components/WorkspaceDrawer";
import { workspaceDirectoryAtom } from "../state/workspaceDirectoryAtom";
import {
  WorkspaceDirectoryContext,
  WorkspaceScope,
} from "../state/workspaceScope";
import {
  colorSchemeAtom,
  themeColorsAtom,
  themePreferenceAtom,
} from "../state/themeAtoms";
import { mobileNavigationLayout } from "../shellCore/mobileLayout";
import { ActionSheetHost } from "../components/ui/ActionSheetHost";
import { Button } from "../components/ui/primitives";
import { spacing, type } from "../design/tokens";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

export type DrawerParamList = { PanelContent: undefined };
const Drawer = createDrawerNavigator<DrawerParamList>();

export function MainNavigator() {
  const directory = useAtomValue(workspaceDirectoryAtom);
  const { width, height } = useWindowDimensions();
  const layout = mobileNavigationLayout(width, height);
  const persistent = layout.kind === "tablet";
  if (!directory) return null;
  return (
    <WorkspaceDirectoryContext.Provider value={directory}>
      <Drawer.Navigator
        defaultStatus={persistent ? "open" : "closed"}
        screenOptions={{
          headerShown: false,
          drawerType: persistent ? "permanent" : "front",
          drawerStyle: { width: layout.drawerWidth },
          swipeEnabled: !persistent,
          swipeEdgeWidth: 50,
        }}
        drawerContent={(props: {
          navigation: {
            closeDrawer: () => void;
            navigate: (
              screen: string,
              params?: { workspaceId?: string },
            ) => void;
          };
        }) => (
          <WorkspaceDrawer
            directory={directory}
            onSettings={(workspaceId) => {
              props.navigation.closeDrawer();
              props.navigation.navigate("Settings", {
                workspaceId: workspaceId ?? undefined,
              });
            }}
            onSelect={() => {
              if (!persistent) props.navigation.closeDrawer();
            }}
          />
        )}
      >
        <Drawer.Screen name="PanelContent" component={WorkspaceScreens} />
      </Drawer.Navigator>
    </WorkspaceDirectoryContext.Provider>
  );
}

function WorkspaceScreens() {
  const directory = useAtomValue(workspaceDirectoryAtom)!;
  return <RetainedWorkspaceScreens directory={directory} />;
}

function RetainedWorkspaceScreens({
  directory,
}: {
  directory: MobileWorkspaceDirectory;
}) {
  useSyncExternalStore(directory.subscribe, directory.getSnapshot);
  const scheme = useAtomValue(colorSchemeAtom);
  const setThemePreference = useSetAtom(themePreferenceAtom);
  const colors = useAtomValue(themeColorsAtom);
  const navigation = useNavigation();
  const notify = useSetAtom(pushToastAtom);
  const approvalOwner = directory.selectedApprovalOwner;
  const approvalSession = approvalOwner?.session;
  const selected = directory.activeWorkspaceId;
  const selectedSession = selected
    ? directory.sessions.get(selected)
    : undefined;
  const selectedEntry = directory.entries.find(
    (entry) => entry.workspaceId === selected,
  );
  const ready = selectedSession?.state === "ready";
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {[...directory.sessions.values()]
        .filter((session) => session.state === "ready")
        .map((session) => (
          <WorkspaceSessionEffects
            key={session.workspaceId}
            directory={directory}
            session={session}
            notify={notify}
            theme={scheme === "light" ? "light" : "dark"}
          />
        ))}
      {[...directory.sessions.values()]
        .filter(
          (session) =>
            session.state === "ready" &&
            directory.presented.has(session.workspaceId),
        )
        .map((session) => {
          const visible = session.workspaceId === selected;
          return (
            <View
              key={session.workspaceId}
              style={{ flex: 1, display: visible ? "flex" : "none" }}
              pointerEvents={visible ? "auto" : "none"}
              accessibilityElementsHidden={!visible}
              importantForAccessibility={
                visible ? "auto" : "no-hide-descendants"
              }
            >
              <WorkspaceScope
                session={session}
                visible={visible}
                scheme={scheme}
              >
                <MainScreen setThemePreference={setThemePreference} />
                {visible && <ActionSheetHost />}
              </WorkspaceScope>
            </View>
          );
        })}
      {directory.workspaceCreation && (
        <WorkspaceCreateSheet
          key={JSON.stringify(directory.workspaceCreation)}
          directory={directory}
          template={directory.workspaceCreation.template}
          sourceUrl={directory.workspaceCreation.sourceUrl}
          onClose={() => directory.closeWorkspaceCreation()}
          onCreated={() => directory.closeWorkspaceCreation()}
        />
      )}
      {approvalOwner &&
        approvalOwner.approvals !== null &&
        (!approvalSession || approvalSession.state === "ready") &&
        (approvalSession ? (
          <WorkspaceScope session={approvalSession} visible scheme={scheme}>
            <WorkspaceApprovalSurface
              directory={directory}
              owner={approvalOwner}
              notify={notify}
            />
          </WorkspaceScope>
        ) : (
          <WorkspaceApprovalSurface
            directory={directory}
            owner={approvalOwner}
            notify={notify}
          />
        ))}
      {directory.approvalOwnerErrors.length > 0 && !approvalOwner && (
        <Modal transparent visible animationType="fade">
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              padding: spacing.xl,
              backgroundColor: "rgba(0,0,0,0.45)",
            }}
          >
            <View
              accessibilityViewIsModal
              style={{
                padding: spacing.xl,
                gap: spacing.md,
                borderRadius: 20,
                backgroundColor: colors.surfaceRaised,
              }}
            >
              <Text
                accessibilityRole="header"
                style={[type.heading, { color: colors.text }]}
              >
                Approvals unavailable
              </Text>
              <Text style={{ color: colors.textSecondary }}>
                {directory.approvalOwnerErrors.join(" ")}
              </Text>
              <Button
                label="Try again"
                onPress={() => void directory.retryFailedApprovalOwners()}
              />
            </View>
          </View>
        </Modal>
      )}
      {directory.approvalWorkspaceId &&
        (!approvalSession ||
          approvalSession.state !== "ready" ||
          approvalSession.approvals === null) && (
          <Modal
            transparent
            visible
            animationType="fade"
            onRequestClose={() => directory.closeApprovals()}
          >
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                padding: spacing.xl,
                backgroundColor: "rgba(0,0,0,0.45)",
              }}
            >
              <View
                accessibilityViewIsModal
                style={{
                  padding: spacing.xl,
                  gap: spacing.md,
                  borderRadius: 20,
                  backgroundColor: colors.surfaceRaised,
                }}
              >
                <Text
                  accessibilityRole="header"
                  style={[type.heading, { color: colors.text }]}
                >
                  {displayWorkspaceName(
                    directory.entries.find(
                      (entry) =>
                        entry.workspaceId === directory.approvalWorkspaceId,
                    )!,
                  )}{" "}
                  · Approvals
                </Text>
                {approvalSession?.state === "failed" ||
                approvalSession?.approvalError ? (
                  <>
                    <Text style={{ color: colors.textSecondary }}>
                      {approvalSession.error ?? approvalSession.approvalError}
                    </Text>
                    <Button
                      label="Try again"
                      onPress={() =>
                        directory.openApprovals(directory.approvalWorkspaceId!)
                      }
                    />
                  </>
                ) : (
                  <>
                    <ActivityIndicator color={colors.textSecondary} />
                    <Text style={{ color: colors.textSecondary }}>
                      Connecting to this workspace’s approval queue…
                    </Text>
                  </>
                )}
                <Button
                  label="Close"
                  onPress={() => directory.closeApprovals()}
                />
              </View>
            </View>
          </Modal>
        )}
      {!ready && (
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: spacing.xl,
            gap: spacing.md,
          }}
        >
          <Text
            accessibilityRole="header"
            style={[type.heading, { color: colors.text }]}
          >
            {selectedEntry
              ? displayWorkspaceName(selectedEntry)
              : "Workspace unavailable"}
          </Text>
          <Text
            accessibilityRole={
              selectedSession?.state === "failed" ? "alert" : "text"
            }
            style={[type.body, { color: colors.textSecondary }]}
          >
            {selectedSession?.state === "opening"
              ? "Opening your workspace…"
              : (selectedSession?.error ??
                "This workspace is no longer available to your account. Choose another workspace to continue.")}
          </Text>
          {selectedSession?.state === "failed" && selected && (
            <Button
              label="Try again"
              onPress={() => {
                void directory.open(selected).catch(() => undefined);
              }}
            />
          )}
          <Button
            label="Your workspaces"
            onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
          />
        </View>
      )}
    </View>
  );
}
