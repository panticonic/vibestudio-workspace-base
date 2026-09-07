import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import type { MobileHubWorkspace } from "@vibestudio/mobile-iroh";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import { workspaceName } from "../services/workspaceName";
import { themeColorsAtom } from "../state/themeAtoms";
import { showActionSheetAtom } from "../state/actionSheetAtoms";
import { spacing, radius, touchTarget, type } from "../design/tokens";
import { Button, Card } from "./ui/primitives";

export type WorkspaceMember = Awaited<
  ReturnType<MobileWorkspaceDirectory["hubControl"]["listWorkspaceMembers"]>
>["members"][number];

export function WorkspaceMembersCard({
  directory,
  entry,
  members,
  canManage,
  onChanged,
}: {
  directory: MobileWorkspaceDirectory;
  entry: MobileHubWorkspace;
  members: WorkspaceMember[];
  canManage: boolean;
  onChanged(): void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const showActionSheet = useSetAtom(showActionSheetAtom);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const label = workspaceName(entry);
  const mutate = async (operation: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setHandle("");
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={[type.heading, { color: colors.text }]}>People</Text>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {entry.privateRole
          ? `${label} belongs only to you and cannot be shared.`
          : `Members can see the panels and work shared in ${label}.`}
      </Text>
      {!entry.privateRole &&
        members.map((member) => (
          <View
            key={member.userId}
            style={{ gap: spacing.xs, paddingVertical: spacing.sm }}
          >
            <Text style={[type.bodyStrong, { color: colors.text }]}>
              {member.displayName || member.handle}
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              @{member.handle} ·{" "}
              {member.role === "admin" ? "Administrator" : "Member"}
            </Text>
            {canManage && (
              <Button
                label={`Manage @${member.handle}`}
                disabled={busy}
                onPress={() =>
                  showActionSheet({
                    title: `${label} · @${member.handle}`,
                    items: [
                      {
                        id: "role",
                        label:
                          member.role === "admin"
                            ? "Make member"
                            : "Make administrator",
                        description:
                          member.role === "admin"
                            ? "Keep access and remove workspace management permissions."
                            : "Allow this person to manage members and workspace connections.",
                      },
                      {
                        id: "remove",
                        label: "Remove from workspace",
                        description: `End this person's access to ${label}.`,
                        tone: "danger",
                      },
                    ],
                    onSelect: (action) =>
                      void mutate(() =>
                        action === "remove"
                          ? directory.hubControl.removeWorkspaceMember({
                              workspace: entry.name,
                              userId: member.userId,
                            })
                          : directory.hubControl.addWorkspaceMember({
                              workspace: entry.name,
                              userId: member.userId,
                              role:
                                member.role === "admin" ? "member" : "admin",
                            }),
                      ),
                  })
                }
              />
            )}
          </View>
        ))}
      {!entry.privateRole && !canManage && (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          A workspace administrator manages people and connections.
        </Text>
      )}
      {!entry.privateRole && canManage && (
        <>
          <TextInput
            value={handle}
            onChangeText={setHandle}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            accessibilityLabel="Person's handle"
            placeholder="Add someone by handle"
            placeholderTextColor={colors.textTertiary}
            style={[
              type.body,
              {
                minHeight: touchTarget,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                color: colors.text,
                paddingHorizontal: spacing.md,
              },
            ]}
          />
          <Button
            label="Review addition"
            disabled={busy || !handle.trim()}
            onPress={() => {
              const capturedHandle = handle.trim().replace(/^@/, "");
              showActionSheet({
                title: `Share ${label}`,
                items: [
                  {
                    id: "add",
                    label: `Add @${capturedHandle} as a member`,
                    description: `They will be able to see work shared in ${label}.`,
                  },
                ],
                onSelect: () =>
                  void mutate(() =>
                    directory.hubControl.addWorkspaceMember({
                      workspace: entry.name,
                      handle: capturedHandle,
                      role: "member",
                    }),
                  ),
              });
            }}
          />
        </>
      )}
      {error && (
        <Text
          accessibilityRole="alert"
          style={[type.caption, { color: colors.danger }]}
        >
          {error}
        </Text>
      )}
    </Card>
  );
}
