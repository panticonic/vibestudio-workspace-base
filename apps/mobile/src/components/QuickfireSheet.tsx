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
 * The conversation *inside* the sheet is now shared too: this file owns the
 * sheet — the modal, the swipe, the keyboard avoidance, the compose row — and
 * `@workspace/quickfire-core/ui` owns the heading, the transcript, the tool
 * records and the Markdown, drawn through this app's native skin. What used to
 * be ~500 lines of hand-rolled transcript here is a `<ConversationBody/>`.
 *
 * Lifecycle rules that matter here (§1.4):
 *  - Opening over a slot is what binds the conversation. Swiping the sheet away
 *    is a view change only — the conversation persists.
 *  - Clearing immediately archives the old conversation and binds a fresh one.
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
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import { useAtomValue, useSetAtom } from "jotai";
import {
  useQuickfireSessionCore,
  type QuickfireSessionSource,
  type QuickfireTransport,
} from "@workspace/quickfire-core/session";
import {
  ConversationBody,
  ConversationHeader,
  QuickfireSkinProvider,
  type ConversationIntent,
} from "@workspace/quickfire-core/ui";
import {
  classifyQuickfireLink,
  suggestedOpeners,
  type QuickfireComposeView,
} from "@workspace/quickfire-core";
import { themeColorsAtom } from "../state/themeAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import {
  dismissQuickfireSheetAtom,
  quickfireSheetAtom,
  type QuickfireSheetRequest,
} from "../state/commandSheetAtoms";
import { hairline, radius, shadow, spacing, type } from "../design/tokens";
import { SendHorizontal, Square } from "../design/icons";
import { IconButton } from "./ui/primitives";
import { openExternalUrl } from "../services/nativeCapabilities";
import { useNativeSkin } from "./overlay/nativeSkin";

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
  /**
   * Open a destination an agent wrote. Routed through the app's own address
   * handling so a workspace link becomes a panel; only genuinely external
   * schemes leave the app.
   */
  openLink: (href: string) => void;
}

export function QuickfireSheet({
  transport,
  panelTitle,
  openChatPanel,
  openLink,
}: QuickfireSheetProps) {
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
        ...(conversation.replyTo
          ? { replyTo: { participantId: conversation.replyTo.participantId } }
          : {}),
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

  const streamingRef = useRef(view.streaming);
  useEffect(() => {
    // A turn ending is the thing you were waiting for; say so in the hand.
    if (streamingRef.current && !view.streaming && view.transcript.length > 0) {
      ReactNativeHapticFeedback.trigger("impactLight");
    }
    streamingRef.current = view.streaming;
  }, [view.streaming, view.transcript.length]);

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

  /**
   * One link policy, shared with desktop: workspace destinations open as panels
   * through the app's own address handling, and only genuinely external schemes
   * are handed to the OS.
   */
  const handleLink = useCallback(
    (href: string) => {
      const target = classifyQuickfireLink(href);
      if (!target) return;
      if (target.kind === "external") {
        void openExternalUrl(target.url).catch(() => undefined);
        return;
      }
      openLink(href);
      close();
    },
    [close, openLink]
  );
  const skin = useNativeSkin(colors, { openLink: handleLink });

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
    // The one moment in this surface where something leaves your hands.
    ReactNativeHapticFeedback.trigger("impactLight");
    void session.send(text).catch(report("Could not send"));
  }, [draft, report, session]);

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

  /**
   * The same compose view the desktop chrome builds. Assembling it here is what
   * lets the shared conversation components render on both clients without a
   * mobile-shaped variant of every prop.
   */
  const compose = useMemo<QuickfireComposeView>(
    () => ({
      kind: isConversation ? "conversation" : "slot",
      panelTitle: headerTitle,
      hint: isConversation
        ? "Reply here, or open the chat panel for the whole conversation."
        : "Ask about this panel. I can describe what it is and how it is running.",
      transcriptOrder: "oldest-first",
      disabledReason: view.error,
      transcript: view.transcript,
      olderCount: view.olderCount,
      expandable: view.expandable,
      credentialRequest: view.credentialRequest,
      resume: view.resume,
      focusMessageId: request?.conversation?.focusMessageId ?? null,
      connecting: view.connecting,
      streaming: view.streaming,
      promoted: view.promoted,
      hasConversation: view.hasConversation,
      error: view.error,
      ...(isConversation
        ? {}
        : { suggestions: suggestedOpeners({ title: panelTitle, kind: "workspace" }) }),
    }),
    [headerTitle, isConversation, panelTitle, request?.conversation?.focusMessageId, view]
  );

  const onIntent = useCallback(
    (intent: ConversationIntent) => {
      switch (intent.kind) {
        case "clear":
          void session.clear().catch(report("Could not clear the conversation"));
          return;
        case "promote":
          handlePromote();
          return;
        case "focus-promoted":
          handleFocusPromoted();
          return;
        case "start-fresh":
          void session.startFresh().catch(report("Could not start a conversation"));
          return;
        case "show-older":
          session.showOlder();
          return;
        case "stop":
          void session.stop().catch(report("Could not stop the turn"));
          return;
        case "send":
          void session.send(intent.text).catch(report("Could not send"));
          return;
        case "retarget":
          // Mobile binds to the panel on screen; choosing another one is done by
          // switching panels, which is the drawer's job, not this sheet's.
          return;
      }
    },
    [handleFocusPromoted, handlePromote, report, session]
  );

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
      <QuickfireSkinProvider value={skin}>
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
                  <ConversationHeader compose={compose} onIntent={onIntent} />
                </View>

                <ScrollView
                  ref={scrollRef}
                  style={styles.transcript}
                  contentContainerStyle={styles.transcriptContent}
                  keyboardShouldPersistTaps="handled"
                >
                  <ConversationBody
                    compose={compose}
                    now={Date.now()}
                    onIntent={onIntent}
                    onCardAction={(action, value) => {
                      // Images arrive inline here (no process boundary), so the
                      // only card actions left are promotion and resending.
                      if (action === "retry" && value) {
                        void session.send(value).catch(report("Could not send"));
                      } else if (action === "open-chat") {
                        handlePromote();
                      }
                    }}
                  />
                </ScrollView>

                {view.promoted ? null : (
                  <View
                    style={[
                      styles.compose,
                      { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
                    ]}
                  >
                    <TextInput
                      testID="quickfire-compose"
                      accessibilityLabel={
                        isConversation ? "Reply to this conversation" : "Ask about this panel"
                      }
                      value={draft}
                      onChangeText={setDraft}
                      onSubmitEditing={handleSend}
                      editable={composeDisabledReason === null}
                      multiline
                      returnKeyType="send"
                      blurOnSubmit
                      style={[styles.composeInput, { color: colors.text }]}
                      placeholder={isConversation ? "Reply…" : "Ask about this panel…"}
                      placeholderTextColor={colors.textTertiary}
                    />
                    {view.streaming ? (
                      <IconButton
                        icon={Square}
                        label="Stop"
                        onPress={() => onIntent({ kind: "stop" })}
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
                )}

                {composeDisabledReason ? (
                  <Text style={[type.caption, styles.error, { color: colors.danger }]}>
                    {composeDisabledReason}
                  </Text>
                ) : null}
              </Animated.View>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </View>
      </QuickfireSkinProvider>
    </Modal>
  );
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
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: hairline,
  },
  transcript: {
    flex: 1,
    marginTop: spacing.sm,
  },
  transcriptContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  error: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
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
