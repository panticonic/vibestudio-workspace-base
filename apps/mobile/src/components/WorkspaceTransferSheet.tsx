import { useRef, useState } from "react";
import {
  Modal,
  ScrollView,
  Text,
  TextInput,
  View,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "jotai";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";
import {
  listTransferFiles,
  moreTransferFiles,
  prepareMobileTransfer,
} from "../services/workspaceFileTransfer";
import { workspaceName } from "../services/workspaceName";
import { themeColorsAtom } from "../state/themeAtoms";
import { spacing, radius, touchTarget, type } from "../design/tokens";
import { Button, IconButton } from "./ui/primitives";
import { X, Check } from "../design/icons";

type Source = Awaited<ReturnType<typeof listTransferFiles>>;
type Prepared = Awaited<ReturnType<typeof prepareMobileTransfer>>;

/** A selected disclosure, with one captured preview and one explicit Copy action. */
export function WorkspaceTransferSheet({
  directory,
  initialWorkspaceId,
  onClose,
}: {
  directory: MobileWorkspaceDirectory;
  initialWorkspaceId: string;
  onClose(): void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();
  const [sourceId, setSourceId] = useState(initialWorkspaceId);
  const [targetId, setTargetId] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [copied, setCopied] = useState(false);
  const [attemptFailed, setAttemptFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const inputStyle = {
    minHeight: touchTarget,
    borderWidth: 1,
    borderRadius: radius.md,
    borderColor: colors.border,
    color: colors.text,
    padding: spacing.md,
  };
  const picker = (
    selected: string,
    select: (id: string) => void,
    excluded?: string,
  ) => (
    <View style={{ gap: spacing.xs }}>
      {directory.entries
        .filter((entry) => entry.workspaceId !== excluded)
        .map((entry) => (
          <Pressable
            key={entry.workspaceId}
            accessibilityRole="radio"
            accessibilityState={{
              selected: selected === entry.workspaceId,
              disabled: busy,
            }}
            disabled={busy}
            onPress={() => select(entry.workspaceId)}
            style={{
              minHeight: touchTarget,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: spacing.md,
              borderRadius: radius.md,
              backgroundColor:
                selected === entry.workspaceId
                  ? colors.accentSoft
                  : colors.surfaceSunken,
            }}
          >
            <Text style={{ color: colors.text }}>{workspaceName(entry)}</Text>
            {selected === entry.workspaceId && (
              <Check size={18} color={colors.primary} />
            )}
          </Pressable>
        ))}
    </View>
  );
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View
        style={{
          flex: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          backgroundColor: colors.background,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            padding: spacing.md,
          }}
        >
          <Text
            accessibilityRole="header"
            style={[type.heading, { flex: 1, color: colors.text }]}
          >
            Copy selected files
          </Text>
          <IconButton
            icon={X}
            label="Close file copy"
            disabled={busy}
            onPress={onClose}
          />
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
        >
          {error && (
            <Text accessibilityRole="alert" style={{ color: colors.danger }}>
              {error}
            </Text>
          )}
          {prepared ? (
            <>
              <Text style={[type.heading, { color: colors.text }]}>
                {prepared.preview.sourceLabel} →{" "}
                {prepared.preview.destinationLabel}
              </Text>
              <Text style={{ color: colors.textSecondary }}>
                {prepared.preview.destinationRepoPath} ·{" "}
                {prepared.preview.files.length} files ·{" "}
                {prepared.preview.totalBytes.toLocaleString()} bytes
              </Text>
              <Text style={{ color: colors.textSecondary }}>
                Audience:{" "}
                {prepared.preview.audience.join(", ") ||
                  "the destination members"}
                .
              </Text>
              {prepared.preview.files.map((file) => (
                <View key={file.destinationPath} style={{ gap: spacing.xs }}>
                  <Text selectable style={{ color: colors.text }}>
                    {file.sourcePath} → {file.destinationPath}
                  </Text>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    {file.size.toLocaleString()} bytes
                  </Text>
                </View>
              ))}
              <Text style={{ color: colors.textSecondary }}>
                The copy stays in a separate review branch. Publishing it to the
                workspace’s main version requires a later review.
              </Text>
              {attemptFailed ? (
                <>
                  <Text
                    accessibilityRole="alert"
                    style={{ color: colors.text }}
                  >
                    {prepared.reviewAvailable
                      ? "Some selected files may already be in the destination review branch. Check that branch before starting another copy."
                      : "The copy could not start. Make a fresh review before trying again."}
                  </Text>
                  {prepared.reviewAvailable && (
                    <Button
                      label="Check review branch with agent"
                      disabled={busy}
                      onPress={() =>
                        void run(async () => {
                          await prepared.reviewWithAgent();
                          onClose();
                        })
                      }
                    />
                  )}
                  <Button
                    label="Make a fresh review"
                    disabled={busy}
                    onPress={() => {
                      setPrepared(null);
                      setAttemptFailed(false);
                      setError(null);
                    }}
                  />
                </>
              ) : copied ? (
                <>
                  <Text
                    accessibilityRole="alert"
                    style={[type.bodyStrong, { color: colors.text }]}
                  >
                    Copied into a review branch
                  </Text>
                  <Button
                    label="Review with agent"
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        await prepared.reviewWithAgent();
                        onClose();
                      })
                    }
                  />
                  <Button label="Done" onPress={onClose} />
                </>
              ) : (
                <>
                  <Button
                    label={busy ? "Copying…" : "Copy to review branch"}
                    disabled={busy}
                    onPress={() =>
                      void run(async () => {
                        try {
                          await prepared.execute();
                          setCopied(true);
                        } catch (failure) {
                          setAttemptFailed(true);
                          throw failure;
                        }
                      })
                    }
                  />
                  <Button
                    label="Change selection"
                    disabled={busy}
                    onPress={() => {
                      setPrepared(null);
                      setError(null);
                    }}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <Text style={[type.bodyStrong, { color: colors.text }]}>
                From workspace
              </Text>
              {picker(sourceId, (id) => {
                setSourceId(id);
                setSource(null);
                setPaths([]);
                if (targetId === id) setTargetId("");
              })}
              <TextInput
                accessibilityLabel="Source repository path"
                placeholder="Repository path, e.g. panels/notes"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                editable={!busy}
                value={sourcePath}
                onChangeText={(value) => {
                  setSourcePath(value);
                  setSource(null);
                  setPaths([]);
                }}
                style={inputStyle}
              />
              <Button
                label="Choose files"
                disabled={busy || !sourcePath.trim()}
                onPress={() =>
                  void run(async () => {
                    setSource(
                      await listTransferFiles(
                        directory,
                        sourceId,
                        sourcePath.trim(),
                      ),
                    );
                    setPaths([]);
                    if (!targetPath) setTargetPath(sourcePath.trim());
                  })
                }
              />
              {source && (
                <>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    Select files from the source workspace’s main version.
                  </Text>
                  {source.files.map((file) => (
                    <Pressable
                      key={file.path}
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: paths.includes(file.path),
                        disabled: busy,
                      }}
                      disabled={busy}
                      onPress={() =>
                        setPaths((current) =>
                          current.includes(file.path)
                            ? current.filter((path) => path !== file.path)
                            : [...current, file.path],
                        )
                      }
                      style={{
                        minHeight: touchTarget,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: spacing.md,
                      }}
                    >
                      <View
                        style={{
                          width: 24,
                          height: 24,
                          borderWidth: 1,
                          borderRadius: 5,
                          borderColor: colors.border,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {paths.includes(file.path) && (
                          <Check size={18} color={colors.primary} />
                        )}
                      </View>
                      <Text style={{ flex: 1, color: colors.text }}>
                        {file.path}
                      </Text>
                    </Pressable>
                  ))}
                  {source.nextCursor && (
                    <Button
                      label="More files"
                      disabled={busy}
                      onPress={() =>
                        void run(async () => {
                          const next = await moreTransferFiles(
                            directory,
                            sourceId,
                            source,
                            source.nextCursor!,
                          );
                          setSource({
                            ...source,
                            files: [...source.files, ...next.files],
                            nextCursor: next.nextCursor,
                          });
                        })
                      }
                    />
                  )}
                </>
              )}
              <Text style={[type.bodyStrong, { color: colors.text }]}>
                To workspace
              </Text>
              {picker(targetId, setTargetId, sourceId)}
              <TextInput
                accessibilityLabel="Destination repository path"
                placeholder="Destination repository path"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                editable={!busy}
                value={targetPath}
                onChangeText={setTargetPath}
                style={inputStyle}
              />
              <Button
                label={busy ? "Preparing…" : "Review copy"}
                disabled={
                  busy ||
                  !source ||
                  paths.length === 0 ||
                  !targetId ||
                  !targetPath.trim()
                }
                onPress={() =>
                  void run(async () => {
                    setPrepared(
                      await prepareMobileTransfer(directory, {
                        sourceWorkspaceId: sourceId,
                        source: source!,
                        paths,
                        targetWorkspaceId: targetId,
                        targetRepoPath: targetPath.trim(),
                      }),
                    );
                  })
                }
              />
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
