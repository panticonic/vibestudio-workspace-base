import {
  WorkspaceMembersCard,
  type WorkspaceMember,
} from "./WorkspaceMembersCard";
import type { MobileHubWorkspace } from "@vibestudio/mobile-iroh";
import { workspaceName as displayWorkspaceName } from "../services/workspaceName";
import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import type {
  WorkspaceRpcPolicy,
  WorkspaceRpcScope,
} from "@vibestudio/identity/workspaceRpcPolicy";
import { themeColorsAtom } from "../state/themeAtoms";
import { showActionSheetAtom } from "../state/actionSheetAtoms";
import { ArrowRight, Plus, X, Lock } from "../design/icons";
import { spacing, radius, touchTarget, type } from "../design/tokens";
import {
  Badge,
  Button,
  Card,
  IconButton,
  SectionHeader,
} from "./ui/primitives";

type PolicySnapshot = Awaited<
  ReturnType<MobileWorkspaceDirectory["hubControl"]["getWorkspaceRpcPolicy"]>
>;
type Direction = "incoming" | "outgoing";

/** A view of the host's policy, with no independently stored connection records. */
export function WorkspaceConnectionsSection({
  directory,
  initialWorkspaceId,
}: {
  directory: MobileWorkspaceDirectory;
  initialWorkspaceId?: string;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const [selectedId, setSelectedId] = useState(
    initialWorkspaceId ?? directory.personalWorkspaceId,
  );
  const selected = directory.entries.find(
    (entry) => entry.workspaceId === selectedId,
  );
  return (
    <>
      <SectionHeader label="Workspace connections" />
      <Card>
        <Text style={[type.heading, { color: colors.text }]}>
          Choose what can connect
        </Text>
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          Let specific operations ask for access between workspaces. Files,
          tools and shared results still need their own approval.
        </Text>
        <Button
          label={`Managing ${selected ? displayWorkspaceName(selected) : "workspace"}`}
          onPress={() =>
            showActionSheet({
              title: "Manage a workspace",
              items: directory.entries.map((entry) => ({
                id: entry.workspaceId,
                label: displayWorkspaceName(entry),
                description: entry.privateRole
                  ? "Only you"
                  : "Workspace connections",
              })),
              onSelect: setSelectedId,
            })
          }
        />
      </Card>
      {selected && (
        <PolicyEditor key={selectedId} directory={directory} entry={selected} />
      )}
    </>
  );
}

function PolicyEditor({
  directory,
  entry,
}: {
  directory: MobileWorkspaceDirectory;
  entry: MobileHubWorkspace;
}) {
  const workspaceId = entry.workspaceId;
  const workspaceName = displayWorkspaceName(entry);
  const colors = useAtomValue(themeColorsAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<Direction>("outgoing");
  const [peerId, setPeerId] = useState("");
  const [operation, setOperation] = useState("");
  const [target, setTarget] = useState("");
  const [purpose, setPurpose] = useState<WorkspaceRpcScope["purpose"]>("call");
  const [actorId, setActorId] = useState("");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const canManage = members.some(
    (member) => member.userId === actorId && member.role === "admin",
  );
  const [editing, setEditing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const peer = directory.entries.find((entry) => entry.workspaceId === peerId);
  useEffect(() => {
    let live = true;
    Promise.all([
      directory.hubControl.getWorkspaceRpcPolicy({ workspaceId }),
      directory.hubControl.listWorkspaceMembers({ workspace: entry.name }),
      directory.sessions
        .get(directory.systemWorkspaceId)!
        .client.refreshAccountProfile(),
    ])
      .then(([next, roster, profile]) => {
        if (!live) return;
        setSnapshot(next);
        setMembers(roster.members);
        setActorId(profile.userId);
        setError(null);
      })
      .catch((error: unknown) => {
        if (live)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [directory, workspaceId, entry.name, refresh]);

  async function save(policy: WorkspaceRpcPolicy): Promise<void> {
    if (!snapshot || busy || !canManage) return;
    setBusy(true);
    setError(null);
    try {
      const next = await directory.hubControl.setWorkspaceRpcPolicy({
        workspaceId,
        policy,
        expectedPolicy: snapshot.policy,
      });
      setSnapshot(next);
      setEditing(false);
      setOperation("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const incomingLocked = direction === "incoming" && snapshot?.incomingLocked;
  return (
    <>
      {snapshot && (
        <WorkspaceMembersCard
          directory={directory}
          entry={entry}
          members={members}
          canManage={canManage}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
      <Card>
        <View style={styles.tabs}>
          {(["outgoing", "incoming"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              accessibilityState={{ selected: direction === value }}
              onPress={() => {
                setDirection(value);
                setEditing(false);
              }}
              style={[
                styles.tab,
                {
                  backgroundColor:
                    direction === value
                      ? colors.accentSoft
                      : colors.surfaceSunken,
                },
              ]}
            >
              <Text
                style={[
                  type.bodyStrong,
                  {
                    color:
                      direction === value
                        ? colors.primary
                        : colors.textSecondary,
                  },
                ]}
              >
                {value === "incoming" ? "Incoming calls" : "Outgoing calls"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          {direction === "outgoing"
            ? `Operations ${workspaceName} may request elsewhere.`
            : `Operations other workspaces may request from ${workspaceName}.`}
        </Text>
        {error && (
          <View
            accessibilityRole="alert"
            style={[styles.notice, { backgroundColor: colors.dangerSoft }]}
          >
            <Text style={[type.caption, { color: colors.danger }]}>
              {error}
            </Text>
            <Button
              label="Reload settings"
              onPress={() => setRefresh((value) => value + 1)}
            />
          </View>
        )}
        {!snapshot && !error && (
          <Text style={[type.caption, { color: colors.textTertiary }]}>
            Loading connections…
          </Text>
        )}
        {incomingLocked ? (
          <View
            style={[styles.notice, { backgroundColor: colors.surfaceSunken }]}
          >
            <Lock size={20} color={colors.textSecondary} />
            <Text style={[type.bodyStrong, { color: colors.text }]}>
              System keeps its door closed
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              Other workspaces cannot call into System. Replies to operations
              you start here can still return.
            </Text>
          </View>
        ) : (
          snapshot && (
            <>
              {snapshot.policy[direction].length === 0 && !editing && (
                <View style={styles.empty}>
                  <Text style={[type.bodyStrong, { color: colors.text }]}>
                    No operations allowed yet
                  </Text>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    Start with one useful connection. Anything outside these
                    rules is blocked before it can ask for approval.
                  </Text>
                </View>
              )}
              {snapshot.policy[direction].map((scope) => {
                const name =
                  directory.entries.find(
                    (entry) => entry.workspaceId === scope.workspaceId,
                  )?.name ?? scope.workspaceId;
                return (
                  <View
                    key={JSON.stringify(scope)}
                    style={[styles.rule, { borderColor: colors.borderSubtle }]}
                  >
                    <View style={styles.ruleCopy}>
                      <Text style={[type.bodyStrong, { color: colors.text }]}>
                        {direction === "incoming"
                          ? `${name} → ${workspaceName}`
                          : `${workspaceName} → ${name}`}
                      </Text>
                      <Text
                        selectable
                        style={[type.caption, { color: colors.textSecondary }]}
                      >
                        {scope.target} · {scope.operation}
                      </Text>
                      <Text
                        style={[type.micro, { color: colors.textTertiary }]}
                      >
                        {scope.purpose === "discover"
                          ? "Discover availability"
                          : "Request access"}{" "}
                        · {scope.userId === actorId ? "You" : scope.userId}
                      </Text>
                    </View>
                    <IconButton
                      icon={X}
                      label={`Remove ${scope.operation} connection with ${name}`}
                      disabled={busy || !canManage}
                      onPress={() =>
                        void save({
                          ...snapshot.policy,
                          [direction]: snapshot.policy[direction].filter(
                            (item) => item !== scope,
                          ),
                        })
                      }
                    />
                  </View>
                );
              })}
              {!canManage ? null : !editing ? (
                <Button
                  label="Allow an operation to ask"
                  icon={Plus}
                  onPress={() => setEditing(true)}
                />
              ) : (
                <View style={styles.form}>
                  <Button
                    label={
                      peer
                        ? displayWorkspaceName(peer)
                        : "Choose another workspace"
                    }
                    onPress={() =>
                      showActionSheet({
                        title: "Connect with",
                        items: directory.entries
                          .filter((entry) => entry.workspaceId !== workspaceId)
                          .map((entry) => ({
                            id: entry.workspaceId,
                            label: displayWorkspaceName(entry),
                            description: entry.privateRole
                              ? "Only you"
                              : "Results may be visible to workspace members",
                          })),
                        onSelect: setPeerId,
                      })
                    }
                  />
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    Target
                  </Text>
                  <TextInput
                    value={target}
                    onChangeText={setTarget}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Exact RPC target"
                    placeholder="Service or entity target"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.surfaceSunken,
                      },
                    ]}
                  />
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    Method
                  </Text>
                  <TextInput
                    value={operation}
                    onChangeText={setOperation}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Exact RPC method"
                    placeholder="Method name"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.surfaceSunken,
                      },
                    ]}
                  />
                  <Text style={[type.micro, { color: colors.textTertiary }]}>
                    Use the operation name supplied by the workspace. Wildcards
                    are not allowed.
                  </Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.tabs}
                  >
                    {(["call", "discover"] as const).map((value) => (
                      <Pressable
                        key={value}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: purpose === value }}
                        onPress={() => setPurpose(value)}
                        style={[
                          styles.tab,
                          {
                            backgroundColor:
                              purpose === value
                                ? colors.accentSoft
                                : colors.surfaceSunken,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            type.caption,
                            {
                              color:
                                purpose === value
                                  ? colors.primary
                                  : colors.textSecondary,
                            },
                          ]}
                        >
                          {value === "call"
                            ? "Request access"
                            : "Discover availability"}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                  <View
                    style={[
                      styles.notice,
                      { backgroundColor: colors.accentSoft },
                    ]}
                  >
                    <ArrowRight size={18} color={colors.primary} />
                    <Text style={[type.bodyStrong, { color: colors.text }]}>
                      {direction === "outgoing"
                        ? workspaceName
                        : peer
                          ? displayWorkspaceName(peer)
                          : "Another workspace"}{" "}
                      →{" "}
                      {direction === "incoming"
                        ? workspaceName
                        : peer
                          ? displayWorkspaceName(peer)
                          : "Another workspace"}
                    </Text>
                    <Text
                      style={[type.caption, { color: colors.textSecondary }]}
                    >
                      For your account only. The other workspace must allow this
                      operation too. This rule does not grant access to its
                      files or tools.
                    </Text>
                    {peer && !peer.privateRole && (
                      <Badge
                        label="Check who can see shared results"
                        tone="warning"
                      />
                    )}
                  </View>
                  <Button
                    label="Save rule"
                    loading={busy}
                    disabled={
                      !peerId ||
                      !operation.trim() ||
                      !target.trim() ||
                      !actorId ||
                      operation.includes("*") ||
                      target.includes("*")
                    }
                    onPress={() =>
                      void save({
                        ...snapshot.policy,
                        [direction]: [
                          ...snapshot.policy[direction],
                          {
                            workspaceId: peerId,
                            userId: actorId,
                            target: target.trim(),
                            operation: operation.trim(),
                            purpose,
                          },
                        ],
                      })
                    }
                  />
                  <Button
                    label="Cancel"
                    variant="ghost"
                    disabled={busy}
                    onPress={() => setEditing(false)}
                  />
                </View>
              )}
            </>
          )
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: spacing.sm },
  tab: {
    minHeight: touchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  notice: { padding: spacing.md, borderRadius: radius.md, gap: spacing.sm },
  empty: { paddingVertical: spacing.lg, gap: spacing.sm },
  rule: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
  },
  ruleCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  form: { gap: spacing.md },
  input: {
    minHeight: touchTarget,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
  },
});
