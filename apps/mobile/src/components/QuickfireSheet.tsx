/**
 * QuickfireSheet — the panel-scoped agent conversation on mobile
 * (quickfire-overlay-spec §7.2, structure mirroring §4.3).
 *
 * A full-height sheet over the panel the user is looking at. Unlike desktop
 * there is no overlay surface and no props bridge: the sheet drives the
 * `quickfire` service and the channel directly, through the shared
 * `useQuickfireSessionCore`, so both clients resolve, join, reduce and drive the
 * *same* durable conversation.
 *
 * Lifecycle rules that matter here (§1.4):
 *  - Opening over a slot is what binds the conversation. Swiping the sheet away
 *    is a view change only — the conversation persists.
 *  - Clearing is two-step and explicit; there is no timer anywhere in this file.
 *  - Promotion transfers ownership to a chat panel, after which this sheet
 *    offers "continued in chat panel →" plus "start a new conversation here"
 *    instead of a compose row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import {
  useQuickfireSessionCore,
  type QuickfireSessionSource,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";
import type { QuickfireTranscriptEntry } from "@workspace/quickfire-core";
import { themeColorsAtom, type ThemeColors } from "../state/themeAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import {
  dismissQuickfireSheetAtom,
  quickfireSheetAtom,
  type QuickfireSheetRequest,
} from "../state/commandSheetAtoms";
import { hairline, radius, shadow, spacing, type } from "../design/tokens";
import { Copy, RotateCcw, SendHorizontal, Sparkles, Square } from "../design/icons";
import { IconButton } from "./ui/primitives";

const SLIDE_DISTANCE = 720;

export interface QuickfireSheetProps {
  /** The `quickfire` service plus a channel join, from `ShellClient`. */
  transport: QuickfireTransport;
  /** Title of the bound panel, for the header. */
  panelTitle: string;
  /**
   * Open (or focus) the chat panel that owns a promoted conversation. Mobile
   * has no panes, so this is the detail view swapping to the chat panel.
   */
  openChatPanel: (channelId: string) => Promise<void>;
}

export function QuickfireSheet({ transport, panelTitle, openChatPanel }: QuickfireSheetProps) {
  const request = useAtomValue(quickfireSheetAtom);
  const dismiss = useSetAtom(dismissQuickfireSheetAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();

  const source = useMemo<QuickfireSessionSource | null>(() => {
    if (!request) return null;
    if (request.conversation) {
      const conversation = request.conversation;
      return {
        kind: "conversation",
        channelId: conversation.channelId,
        contextId: conversation.contextId,
        clientId: `conversation:${conversation.channelId}`,
        ...(conversation.focusMessageId ? { focusMessageId: conversation.focusMessageId } : {}),
        ...(conversation.replyTo ? { replyTo: { participantId: conversation.replyTo.participantId } } : {}),
      };
    }
    return request.slotId ? { kind: "slot", slotId: request.slotId } : null;
  }, [request]);
  const session = useQuickfireSessionCore(source, transport);
  const view = session.view;
  const isConversation = session.mode === "conversation";
  const headerTitle = request?.conversation
    ? (request.conversation.title ??
      (request.conversation.replyTo?.handle
        ? `@${request.conversation.replyTo.handle}`
        : request.conversation.channelId))
    : panelTitle;

  const [draft, setDraft] = useState("");
  /** Two-step clear: the first press arms it, the second performs it (§4.3). */
  const [clearArmed, setClearArmed] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const translateY = useRef(new Animated.Value(SLIDE_DISTANCE)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const close = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SLIDE_DISTANCE,
        duration: 190,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      // Only a run that actually finished dismisses. An animation stopped by
      // unmount or by a new open request must not reach back into the store.
    ]).start(({ finished }) => {
      if (finished) dismiss();
    });
  }, [backdropOpacity, dismiss, translateY]);

  useEffect(() => {
    if (!request) return;
    // A handed-off send opens with an empty compose box: the text is already on
    // its way, not waiting for a second tap.
    setDraft(request.send ? "" : (request.draft ?? ""));
    setClearArmed(false);
    translateY.setValue(SLIDE_DISTANCE);
    backdropOpacity.setValue(0);
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        stiffness: 220,
        damping: 28,
        mass: 1,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [backdropOpacity, request, translateY]);

  useEffect(() => {
    if (view.transcript.length === 0) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 32);
    return () => clearTimeout(timer);
  }, [view.transcript]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_evt, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_evt, gesture) => {
          // Swiping away is a view change; the conversation is untouched.
          if (gesture.dy > 120 || gesture.vy > 0.8) close();
          else {
            Animated.spring(translateY, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 4,
            }).start();
          }
        },
      }),
    [close, translateY]
  );

  const report = useCallback(
    (title: string) => (error: unknown) =>
      pushToast({
        title,
        message: error instanceof Error ? error.message : String(error),
        tone: "danger",
      }),
    [pushToast]
  );

  /**
   * Deliver a handed-off send exactly once per request. The session core queues
   * the text until the binding resolves, so this does not wait for the channel.
   */
  const handedOffRef = useRef<QuickfireSheetRequest | null>(null);
  useEffect(() => {
    const text = request?.send ? (request.draft ?? "").trim() : "";
    if (!text || handedOffRef.current === request) return;
    handedOffRef.current = request;
    void session.send(text).catch(report("Could not send"));
  }, [report, request, session]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setClearArmed(false);
    void session.send(text).catch(report("Could not send"));
  }, [draft, report, session]);

  const handleClear = useCallback(() => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    void session.clear().catch(report("Could not clear the conversation"));
  }, [clearArmed, report, session]);

  const handlePromote = useCallback(() => {
    void session
      .promote()
      .then(async (promoted) => {
        if (!promoted) {
          pushToast({
            title: "This panel has no conversation to open",
            message: "Ask something first, then open it as a chat panel.",
            tone: "warning",
          });
          return;
        }
        await openChatPanel(promoted.channelId);
        close();
      })
      .catch(report("Could not open the chat panel"));
  }, [close, openChatPanel, pushToast, report, session]);

  const handleFocusPromoted = useCallback(() => {
    const channelId = view.channelId;
    if (!channelId) return;
    void openChatPanel(channelId)
      .then(() => close())
      .catch(report("Could not open the chat panel"));
  }, [close, openChatPanel, report, view.channelId]);

  if (!request) return null;

  const composeDisabledReason = view.error ?? null;

  return (
    <Modal
      transparent
      visible
      statusBarTranslucent
      animationType="none"
      presentationStyle="overFullScreen"
      onRequestClose={close}
    >
      <View style={styles.root}>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.overlay, opacity: backdropOpacity }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityLabel="Dismiss the command agent"
            testID="quickfire-backdrop"
          />
        </Animated.View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.avoider}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={["bottom"]} style={styles.safeArea} pointerEvents="box-none">
            <Animated.View
              testID="quickfire-sheet"
              accessibilityViewIsModal
              style={[
                styles.sheet,
                shadow.sheet,
                {
                  backgroundColor: colors.surfaceRaised,
                  borderColor: colors.border,
                  shadowColor: colors.shadow,
                  paddingBottom: Math.max(insets.bottom, spacing.md),
                  transform: [{ translateY }],
                },
              ]}
            >
              <View {...panResponder.panHandlers} style={styles.grabArea}>
                <View style={[styles.grabber, { backgroundColor: colors.border }]} />
              </View>

              <View style={[styles.header, { borderBottomColor: colors.borderSubtle }]}>
                <Sparkles size={17} color={colors.primary} />
                <Text
                  style={[type.bodyStrong, styles.headerTitle, { color: colors.text }]}
                  numberOfLines={1}
                >
                  {headerTitle}
                </Text>
                {isConversation ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={clearArmed ? "Really clear conversation" : "Clear conversation"}
                    disabled={!view.hasConversation}
                    onPress={handleClear}
                    hitSlop={6}
                    style={[
                      styles.clearButton,
                      {
                        backgroundColor: clearArmed ? colors.dangerSoft : "transparent",
                        opacity: view.hasConversation ? 1 : 0.4,
                      },
                    ]}
                  >
                    <RotateCcw size={16} color={clearArmed ? colors.danger : colors.textSecondary} />
                    {clearArmed ? (
                      <Text style={[type.caption, { color: colors.danger }]}>really clear?</Text>
                    ) : null}
                  </Pressable>
                )}
                <IconButton
                  icon={Copy}
                  label={isConversation ? "Open in chat panel" : "Open conversation as chat panel"}
                  onPress={handlePromote}
                  disabled={!view.hasConversation || view.promoted}
                  color={colors.textSecondary}
                  size={17}
                />
              </View>

              {view.promoted ? (
                <View style={styles.promoted}>
                  <Text style={[type.body, { color: colors.textSecondary }]}>
                    This conversation continues in a chat panel, which now owns it.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Continued in chat panel"
                    onPress={handleFocusPromoted}
                    style={[styles.promotedAction, { borderColor: colors.primary }]}
                  >
                    <Text style={[type.bodyStrong, { color: colors.primary }]}>
                      continued in chat panel →
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start a new conversation here"
                    onPress={() => {
                      void session.startFresh().catch(report("Could not start a conversation"));
                    }}
                    style={[styles.promotedAction, { borderColor: colors.borderSubtle }]}
                  >
                    <Text style={[type.bodyStrong, { color: colors.textSecondary }]}>
                      start a new conversation here
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  {view.resume ? (
                    <View
                      testID="quickfire-resume-chip"
                      style={[styles.resume, { backgroundColor: colors.surfaceSunken }]}
                    >
                      <Text style={[type.caption, { color: colors.textSecondary }]}>
                        {resumeLabel(view.resume)}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Show all in a chat panel"
                        onPress={handlePromote}
                        hitSlop={6}
                      >
                        <Text style={[type.caption, { color: colors.primary }]}>show all →</Text>
                      </Pressable>
                    </View>
                  ) : null}

                  <ScrollView
                    ref={scrollRef}
                    style={styles.transcript}
                    contentContainerStyle={styles.transcriptContent}
                    keyboardShouldPersistTaps="handled"
                  >
                    {view.transcript.length === 0 ? (
                      <Text style={[type.body, styles.hint, { color: colors.textTertiary }]}>
                        {view.connecting
                          ? "Starting a conversation about this panel…"
                          : "Ask about this panel. I can describe what it is and how it is running."}
                      </Text>
                    ) : (
                      <>
                        {view.olderCount > 0 ? (
                          <Text style={[type.caption, { color: colors.textTertiary }]}>
                            {view.olderCount} older entries hidden
                          </Text>
                        ) : null}
                        {view.transcript.map((entry) => (
                          <QuickfireTranscriptRow key={entry.id} entry={entry} colors={colors} />
                        ))}
                      </>
                    )}
                  </ScrollView>

                  {composeDisabledReason ? (
                    <Text style={[type.caption, styles.error, { color: colors.danger }]}>
                      {composeDisabledReason}
                    </Text>
                  ) : null}

                  <View
                    style={[
                      styles.compose,
                      { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
                    ]}
                  >
                    <TextInput
                      testID="quickfire-compose"
                      accessibilityLabel="Ask about this panel"
                      value={draft}
                      onChangeText={setDraft}
                      onSubmitEditing={handleSend}
                      editable={composeDisabledReason === null}
                      multiline
                      returnKeyType="send"
                      blurOnSubmit
                      style={[styles.composeInput, { color: colors.text }]}
                      placeholder="Ask about this panel…"
                      placeholderTextColor={colors.textTertiary}
                    />
                    {view.streaming ? (
                      <IconButton
                        icon={Square}
                        label="Stop"
                        onPress={() => {
                          void session.stop().catch(report("Could not stop the turn"));
                        }}
                        color={colors.danger}
                        size={17}
                      />
                    ) : (
                      <IconButton
                        icon={SendHorizontal}
                        label="Send"
                        onPress={handleSend}
                        disabled={draft.trim().length === 0 || composeDisabledReason !== null}
                        color={colors.primary}
                        size={17}
                      />
                    )}
                  </View>
                </>
              )}
            </Animated.View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function QuickfireTranscriptRow({
  entry,
  colors,
}: {
  entry: QuickfireTranscriptEntry;
  colors: ThemeColors;
}) {
  if (entry.kind !== "message") {
    const title =
      entry.kind === "approval"
        ? entry.question
        : entry.kind === "activity"
          ? entry.label
          : entry.title;
    const detail = entry.kind === "notice" ? entry.detail : entry.kind === "approval" ? entry.reason : undefined;
    return (
      <View
        testID={`quickfire-message-${entry.id}`}
        style={[styles.message, { backgroundColor: colors.surfaceSunken }]}
      >
        <Text style={[type.micro, { color: colors.textTertiary }]}>
          {entry.kind === "approval"
            ? entry.status === "pending"
              ? "Approval needed"
              : `Approval ${entry.status}`
            : entry.kind === "activity"
              ? "Agent"
              : entry.title}
        </Text>
        <Text style={[type.body, { color: colors.text }]}>
          {title}
          {detail ? ` — ${detail}` : ""}
        </Text>
      </View>
    );
  }
  return (
    <View
      testID={`quickfire-message-${entry.id}`}
      style={[
        styles.message,
        {
          backgroundColor: entry.author === "you" ? colors.accentSoft : colors.surfaceSunken,
          borderColor: entry.error ? colors.danger : "transparent",
        },
      ]}
    >
      <Text style={[type.micro, { color: colors.textTertiary }]}>{entry.authorLabel}</Text>
      <Text style={[type.body, { color: colors.text }]}>
        {entry.text}
        {entry.streaming ? " ▌" : ""}
      </Text>
      {entry.toolChips?.length ? (
        <View style={styles.toolChips}>
          {entry.toolChips.map((chip, index) => (
            <View
              key={`${chip.name}:${index}`}
              style={[
                styles.toolChip,
                { backgroundColor: colors.surface },
                chip.state === "failed"
                  ? { borderColor: colors.danger }
                  : chip.state === "running"
                    ? { borderColor: colors.primary }
                    : null,
              ]}
            >
              <Text
                style={[
                  type.micro,
                  {
                    color:
                      chip.state === "failed"
                        ? colors.danger
                        : chip.state === "running"
                          ? colors.primary
                          : colors.textSecondary,
                  },
                ]}
              >
                {chip.state === "running"
                  ? `◌ ${chip.name}`
                  : chip.state === "failed"
                    ? `✕ ${chip.name}`
                    : chip.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** "Resumed · 3 messages · 2h ago"; each segment is omitted when unknown. */
function resumeLabel(resume: { messageCount: number | null; lastActivityAt: number | null }): string {
  const parts = ["Resumed"];
  if (resume.messageCount !== null) {
    parts.push(`${resume.messageCount} message${resume.messageCount === 1 ? "" : "s"}`);
  }
  if (resume.lastActivityAt !== null) parts.push(relativeTime(resume.lastActivityAt));
  return parts.join(" · ");
}

function relativeTime(epochMs: number): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  avoider: {
    flex: 1,
    justifyContent: "flex-end",
  },
  safeArea: {
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: hairline,
    height: "92%",
  },
  grabArea: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: hairline,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
  },
  clearButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  promoted: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  promotedAction: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
  },
  resume: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  transcript: {
    flex: 1,
    marginTop: spacing.sm,
  },
  transcriptContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  hint: {
    paddingVertical: spacing.xl,
  },
  message: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: 2,
  },
  toolChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  toolChip: {
    borderRadius: radius.pill,
    borderWidth: hairline,
    borderColor: "transparent",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  error: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  compose: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: hairline,
  },
  composeInput: {
    flex: 1,
    minWidth: 0,
    maxHeight: 120,
    fontSize: 16,
    paddingVertical: spacing.sm,
  },
});
