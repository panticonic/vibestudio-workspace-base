/**
 * CommandSheet — the mobile command palette (quickfire-overlay-spec §7.1).
 *
 * A searchable bottom sheet over the same engine the desktop overlay runs:
 * `@workspace/omnibox-core` ranks, `@workspace/quickfire-core` projects rows and
 * resolves what activating one means, and the argument state machine is the
 * shared reducer — so `>theme dark` behaves identically on both clients.
 *
 * Two adaptations to the platform, both deliberate:
 *
 *  - There is no keyboard-driven selection model. Rows are tapped; the ghost
 *    completion and ↑/↓ cycle have no phone equivalent, so they are absent
 *    rather than faked. Backspace-on-empty still pops an argument for hardware
 *    keyboards, and a filled argument chip is tappable, which is the touch
 *    equivalent.
 *  - The `/` scope does not render inline. Selecting the ✦ chip (or typing `/`)
 *    hands off to `QuickfireSheet`, which is a full-height surface — the same
 *    conversation, presented the way a phone can actually use it.
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
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import {
  commandSpecFromWire,
  filledArgChips,
  parseInlineCommand,
  reduceArgSession,
  startArgSession,
  activeArgSpec,
  type ArgSession,
  type CommandSpec,
  type PanelDescriptor,
  type SurfaceContext,
} from "@workspace/omnibox-core";
import {
  QUICKFIRE_MODE_CHIPS,
  QUICKFIRE_MODE_PLACEHOLDER,
  buildPaletteRows,
  buildRowTargets,
  emptyMessageFor,
  inputForMode,
  modeForInput,
  parseGotoScope,
  stripModePrefix,
  type QuickfireGroup,
  type QuickfireMode,
  type QuickfireRow,
} from "@workspace/quickfire-core";
import type { QuickfireSessionSummary } from "@workspace/quickfire-core/service";
import type { BrowserAddressSuggestion } from "@vibestudio/shared/panelChrome";
import { themeColorsAtom } from "../state/themeAtoms";
import { pushToastAtom } from "../state/toastAtoms";
import {
  commandSheetAtom,
  dismissCommandSheetAtom,
  openQuickfireSheetAtom,
} from "../state/commandSheetAtoms";
import { hairline, radius, shadow, spacing, type } from "../design/tokens";
import { Search, X } from "../design/icons";
import {
  buildMobileSlate,
  type MobileCommandOutcome,
  type MobileSlateDeps,
} from "../commands/slate";

/** Row height from §7.1. */
const ROW_HEIGHT = 48;
const SLIDE_DISTANCE = 560;
/** Same debounce the address field uses, so history feels identical. */
const HISTORY_DEBOUNCE_MS = 120;

export interface CommandSheetProps {
  /** Everything the slate's implementations need. */
  slateDeps: MobileSlateDeps;
  /** Descriptor of the panel commands act on; drives availability predicates. */
  focusedPanel?: PanelDescriptor;
  /** The "already open" index for the `@` scope and `panel` arguments. */
  openPanels: SurfaceContext["openPanels"]["entries"];
  /** Commands contributed by the focused panel, in wire form. */
  contributedCommands: Array<{
    panelId: string;
    commands: Array<Parameters<typeof commandSpecFromWire>[0]>;
  }>;
  /** Dispatch a contributed command back to its panel; false when unreachable. */
  runContributedCommand: (panelId: string, commandId: string) => boolean;
}

interface RowSection {
  key: string;
  title: string;
  data: QuickfireRow[];
}

export function CommandSheet({
  slateDeps,
  focusedPanel,
  openPanels,
  contributedCommands,
  runContributedCommand,
}: CommandSheetProps) {
  const request = useAtomValue(commandSheetAtom);
  const dismiss = useSetAtom(dismissCommandSheetAtom);
  const openQuickfire = useSetAtom(openQuickfireSheetAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const colors = useAtomValue(themeColorsAtom);
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<QuickfireMode>("all");
  const [value, setValue] = useState("");
  const [argSession, setArgSession] = useState<ArgSession | null>(null);
  const [conversations, setConversations] = useState<QuickfireSessionSummary[] | null>(null);
  const [history, setHistory] = useState<BrowserAddressSuggestion[]>([]);
  const inputRef = useRef<TextInput | null>(null);
  const translateY = useRef(new Animated.Value(SLIDE_DISTANCE)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const close = useCallback(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: SLIDE_DISTANCE,
        duration: 180,
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

  // Adopt each open request: the caller decides the scope (✦ button → all,
  // long-press on the active panel → "go to").
  useEffect(() => {
    if (!request) return;
    setMode(request.mode);
    setValue(inputForMode(request.query ?? "", "all", request.mode));
    setArgSession(null);
    setConversations(null);
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
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [backdropOpacity, request, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_evt, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_evt, gesture) => {
          if (gesture.dy > 90 || gesture.vy > 0.8) close();
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

  const slate = useMemo(() => buildMobileSlate(), []);
  const contributed = useMemo(
    () =>
      contributedCommands.flatMap((contribution) =>
        contribution.commands.map((command) =>
          commandSpecFromWire(command, { panelId: contribution.panelId })
        )
      ),
    [contributedCommands]
  );
  const commands = useMemo<CommandSpec[]>(() => [...slate, ...contributed], [contributed, slate]);
  const slateById = useMemo(() => new Map(slate.map((command) => [command.id, command])), [slate]);

  const ctx = useMemo<SurfaceContext>(
    () => ({
      platform: "mobile",
      openPanels: { entries: openPanels },
      ...(focusedPanel ? { focusedPanel } : {}),
    }),
    [focusedPanel, openPanels]
  );

  const searchQuery = argSession ? argSession.query : stripModePrefix(value, mode);

  // Browser history for the `@` scope and mixed mode, through the same client
  // call the address field in `AppBar` makes — one ranking path, one answer.
  // Search engines are dropped (an address-bar affordance, not a destination)
  // and favicons are not fetched, matching the desktop overlay's rows.
  const historyQuery = mode === "goto" ? parseGotoScope(searchQuery).query : searchQuery;
  const wantsHistory = !argSession && (mode === "all" || mode === "goto");
  useEffect(() => {
    if (!request || !wantsHistory) {
      setHistory([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void slateDeps.panels
        .getBrowserAddressOptions(historyQuery)
        .then((options) => {
          if (live) {
            setHistory(options.suggestions.filter((item) => item.source !== "search-engine"));
          }
        })
        .catch(() => {
          // A sheet that cannot reach history is still a working sheet.
          if (live) setHistory([]);
        });
    }, HISTORY_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [historyQuery, request, slateDeps.panels, wantsHistory]);

  const handOffToQuickfire = useCallback(
    (draft: string, options?: { send?: boolean }) => {
      const slotId = slateDeps.activePanelId;
      if (!slotId) {
        pushToast({
          title: "No panel is open",
          message: "The command agent is bound to the panel you are looking at.",
          tone: "warning",
        });
        return;
      }
      close();
      openQuickfire({
        slotId,
        ...(draft.trim() ? { draft: draft.trim() } : {}),
        ...(options?.send && draft.trim() ? { send: true } : {}),
      });
    },
    [close, openQuickfire, pushToast, slateDeps.activePanelId]
  );

  const groups = useMemo<QuickfireGroup[]>(() => {
    if (conversations) {
      // The picker replaces the ranked list while it is up: it was opened by an
      // explicit command, and mixing it with suggestions would make tapping
      // ambiguous.
      return [
        {
          key: "quickfire-conversations",
          label: "Command agent conversations",
          rows: conversations.map((row) => ({
            id: `quickfire-slot:${row.slotId}`,
            title: openPanels.find((entry) => entry.id === row.slotId)?.title ?? row.slotId,
            meta: row.promotedAt === null ? "conversation" : "continued in a chat panel",
            icon: "✦",
          })),
        },
      ];
    }
    return buildPaletteRows({ mode, argSession, query: searchQuery, ctx, commands, history });
  }, [argSession, commands, conversations, ctx, history, mode, openPanels, searchQuery]);

  const sections = useMemo<RowSection[]>(
    () => groups.map((group) => ({ key: group.key, title: group.label, data: group.rows })),
    [groups]
  );

  const rowTargets = useMemo(
    () => buildRowTargets(groups, commands, { argSession }),
    [argSession, commands, groups]
  );

  const applyOutcome = useCallback(
    (outcome: MobileCommandOutcome) => {
      if (outcome.message) {
        pushToast({
          message: outcome.message,
          ...(outcome.tone ? { tone: outcome.tone } : {}),
        });
      }
      if (outcome.quickfire) {
        handOffToQuickfire(outcome.quickfire.prompt ?? "");
        return;
      }
      if (outcome.scope) {
        setArgSession(null);
        setConversations(null);
        setMode(outcome.scope.mode);
        setValue(inputForMode(outcome.scope.query ?? "", "all", outcome.scope.mode));
        return;
      }
      if (outcome.close) {
        close();
        return;
      }
      // Non-navigating commands leave the sheet up for chaining, but the
      // argument breadcrumb is spent.
      setArgSession(null);
    },
    [close, handOffToQuickfire, pushToast]
  );

  const execute = useCallback(
    (command: CommandSpec, args: Record<string, string>) => {
      const runner = slateById.get(command.id);
      if (runner) {
        void Promise.resolve(runner.run(args, slateDeps))
          .then((outcome) => applyOutcome(outcome ?? {}))
          .catch((error: unknown) => {
            pushToast({
              title: "Command failed",
              message: error instanceof Error ? error.message : String(error),
              tone: "danger",
            });
            close();
          });
        return;
      }
      if (!command.panelId) return;
      const delivered = runContributedCommand(
        command.panelId,
        command.id.slice(command.panelId.length + 1)
      );
      if (!delivered) {
        pushToast({
          title: "Panel command is not ready",
          message: "Open the panel and try again.",
          tone: "warning",
        });
        return;
      }
      close();
    },
    [applyOutcome, close, pushToast, runContributedCommand, slateById, slateDeps]
  );

  const applySessionOutcome = useCallback(
    (outcome: ReturnType<typeof reduceArgSession>) => {
      if (outcome.kind === "execute") {
        setArgSession(null);
        execute(outcome.command, outcome.args);
        return;
      }
      if (outcome.kind === "exit") {
        setArgSession(null);
        setValue(outcome.restoreQuery);
        return;
      }
      setArgSession(outcome.session);
    },
    [execute]
  );

  const activateCommand = useCallback(
    (command: CommandSpec) => {
      const inline = parseInlineCommand(stripModePrefix(value, mode), [command], ctx);
      const outcome = startArgSession(command, {
        ...(inline ? { prefilled: inline.filled, seedQuery: inline.residual } : {}),
        restoreQuery: value,
      });
      if (outcome.kind === "execute") {
        execute(command, outcome.args);
        return;
      }
      if (outcome.kind === "session") setArgSession(outcome.session);
    },
    [ctx, execute, mode, value]
  );

  const activateRow = useCallback(
    (row: QuickfireRow) => {
      if (row.disabled) return;
      const target = rowTargets.get(row.id);
      if (!target) return;
      switch (target.kind) {
        case "command":
          activateCommand(target.command);
          return;
        case "option": {
          if (!argSession) return;
          applySessionOutcome(reduceArgSession(argSession, { type: "enter", value: target.value }));
          return;
        }
        case "panel":
          slateDeps.navigateToPanel(target.panelId);
          close();
          return;
        case "quickfire-slot":
          // Move to the slot, then open quickfire over it so the conversation
          // binds to the panel the user just went to.
          slateDeps.navigateToPanel(target.slotId);
          setConversations(null);
          close();
          openQuickfire({ slotId: target.slotId });
          return;
        case "url":
          void slateDeps.panels
            .createBrowserUrlPanel(null, target.url, { focus: true })
            .catch((error: unknown) =>
              pushToast({
                title: "Could not open that address",
                message: error instanceof Error ? error.message : String(error),
                tone: "danger",
              })
            );
          close();
          return;
        case "quickfire-ask":
          // Same gesture as desktop: the sheet hands off to the conversation
          // over the active panel and the prompt goes with it.
          handOffToQuickfire(target.prompt, { send: true });
          return;
        case "chat":
          void slateDeps.panels
            .createRootPanel("panels/chat", {
              focus: true,
              stateArgs: { initialPrompt: target.prompt },
            })
            .catch((error: unknown) =>
              pushToast({
                title: "Could not start a chat",
                message: error instanceof Error ? error.message : String(error),
                tone: "danger",
              })
            );
          close();
          return;
      }
    },
    [
      activateCommand,
      applySessionOutcome,
      argSession,
      close,
      handOffToQuickfire,
      openQuickfire,
      pushToast,
      rowTargets,
      slateDeps,
    ]
  );

  const handleChangeText = useCallback(
    (next: string) => {
      setConversations(null);
      if (argSession) {
        // The shared reducer owns what typing means inside a session (it is
        // also what clears a validation error), so route through it.
        applySessionOutcome(reduceArgSession(argSession, { type: "input", value: next }));
        return;
      }
      const nextMode = modeForInput(next, mode);
      if (nextMode === "quickfire") {
        handOffToQuickfire(stripModePrefix(next, "quickfire"));
        return;
      }
      setMode(nextMode);
      setValue(next);
    },
    [applySessionOutcome, argSession, handOffToQuickfire, mode]
  );

  const handleSelectMode = useCallback(
    (next: QuickfireMode) => {
      if (next === "quickfire") {
        handOffToQuickfire(stripModePrefix(value, mode));
        return;
      }
      setArgSession(null);
      setValue(inputForMode(value, mode, next));
      setMode(next);
    },
    [handOffToQuickfire, mode, value]
  );

  const handleSubmit = useCallback(() => {
    if (argSession) {
      applySessionOutcome(reduceArgSession(argSession, { type: "enter" }));
      return;
    }
    const first = groups.flatMap((group) => group.rows).find((row) => !row.disabled);
    if (first) activateRow(first);
  }, [activateRow, applySessionOutcome, argSession, groups]);

  /** Hardware keyboards get the desktop's "backspace on empty pops an argument". */
  const handleKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key !== "Backspace") return;
      if (argSession) {
        if (argSession.query.length > 0) return;
        applySessionOutcome(reduceArgSession(argSession, { type: "backspace" }));
        return;
      }
      if (value.length === 0 && mode !== "all") handleSelectMode("all");
    },
    [applySessionOutcome, argSession, handleSelectMode, mode, value.length]
  );

  const chips = argSession ? filledArgChips(argSession) : [];
  const activeArg = argSession ? activeArgSpec(argSession) : undefined;
  const emptyMessage = groups.length
    ? null
    : emptyMessageFor({ argSession, query: searchQuery });

  if (!request) return null;

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
            accessibilityLabel="Dismiss commands"
            testID="command-sheet-backdrop"
          />
        </Animated.View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.avoider}
          pointerEvents="box-none"
        >
          <SafeAreaView edges={["bottom"]} style={styles.safeArea} pointerEvents="box-none">
            <Animated.View
              testID="command-sheet"
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

              {argSession ? (
                <View style={styles.chipRow}>
                  <View style={[styles.chip, { backgroundColor: colors.accentSoft }]}>
                    <Text style={[type.caption, { color: colors.primary }]} numberOfLines={1}>
                      {argSession.spec.title}
                    </Text>
                  </View>
                  {chips.map((chip) => (
                    <Pressable
                      key={chip.arg.name}
                      accessibilityRole="button"
                      accessibilityLabel={`Change ${chip.arg.label}: ${chip.value}`}
                      onPress={() =>
                        applySessionOutcome(reduceArgSession(argSession, { type: "backspace" }))
                      }
                      style={[styles.chip, { backgroundColor: colors.surfaceSunken }]}
                    >
                      <Text style={[type.caption, { color: colors.textSecondary }]}>
                        {chip.arg.label}: {chip.value}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              <View
                style={[
                  styles.searchRow,
                  { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
                ]}
              >
                <Search size={17} color={colors.textTertiary} />
                <TextInput
                  ref={inputRef}
                  testID="command-sheet-input"
                  accessibilityLabel="Search commands and panels"
                  value={argSession ? argSession.query : value}
                  onChangeText={handleChangeText}
                  onKeyPress={handleKeyPress}
                  onSubmitEditing={handleSubmit}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  style={[styles.searchInput, { color: colors.text }]}
                  placeholder={activeArg?.label ?? QUICKFIRE_MODE_PLACEHOLDER[mode]}
                  placeholderTextColor={colors.textTertiary}
                />
                <Pressable
                  onPress={close}
                  accessibilityRole="button"
                  accessibilityLabel="Close commands"
                  hitSlop={8}
                >
                  <X size={17} color={colors.textTertiary} />
                </Pressable>
              </View>

              {argSession?.error ? (
                <Text style={[type.caption, styles.error, { color: colors.danger }]}>
                  {argSession.error}
                </Text>
              ) : null}

              {argSession ? null : (
                <View style={styles.modeRow}>
                  {QUICKFIRE_MODE_CHIPS.map((chip) => {
                    const selected = chip.mode === mode;
                    return (
                      <Pressable
                        key={chip.mode}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={chip.label}
                        onPress={() => handleSelectMode(chip.mode)}
                        style={[
                          styles.modeChip,
                          {
                            backgroundColor: selected ? colors.accentSoft : colors.surfaceSunken,
                            borderColor: selected ? colors.primary : colors.borderSubtle,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            type.caption,
                            { color: selected ? colors.primary : colors.textSecondary },
                          ]}
                        >
                          {chip.mode === "quickfire" ? `✦ ${chip.label}` : chip.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {emptyMessage ? (
                <Text style={[type.caption, styles.empty, { color: colors.textTertiary }]}>
                  {emptyMessage}
                </Text>
              ) : (
                <SectionList
                  sections={sections}
                  keyExtractor={(row) => row.id}
                  stickySectionHeadersEnabled
                  keyboardShouldPersistTaps="handled"
                  style={styles.list}
                  renderSectionHeader={({ section }) => (
                    <Text
                      style={[
                        type.micro,
                        styles.sectionHeader,
                        { color: colors.textTertiary, backgroundColor: colors.surfaceRaised },
                      ]}
                    >
                      {section.title.toUpperCase()}
                    </Text>
                  )}
                  renderItem={({ item }) => (
                    <Pressable
                      testID={`command-row-${item.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={item.title}
                      accessibilityState={{ disabled: item.disabled === true }}
                      disabled={item.disabled}
                      onPress={() => activateRow(item)}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && { backgroundColor: colors.surfaceSunken },
                        item.disabled ? styles.disabled : null,
                      ]}
                    >
                      <Text style={[styles.rowIcon, { color: colors.textSecondary }]}>
                        {item.icon ?? "›"}
                      </Text>
                      <View style={styles.rowCopy}>
                        <Text
                          style={[
                            type.bodyStrong,
                            { color: item.danger ? colors.danger : colors.text },
                          ]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        {item.meta ? (
                          <Text
                            style={[type.caption, { color: colors.textTertiary }]}
                            numberOfLines={1}
                            ellipsizeMode="middle"
                          >
                            {item.meta}
                          </Text>
                        ) : null}
                      </View>
                      {item.badge ? (
                        <Text style={[type.micro, { color: colors.textTertiary }]}>
                          {item.badge}
                        </Text>
                      ) : null}
                    </Pressable>
                  )}
                />
              )}
            </Animated.View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
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
    maxHeight: "82%",
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
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: hairline,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    paddingVertical: 0,
  },
  error: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  modeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  modeChip: {
    borderRadius: radius.pill,
    borderWidth: hairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  empty: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    textAlign: "center",
  },
  list: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  sectionHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxs,
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: ROW_HEIGHT,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    gap: spacing.md,
  },
  rowIcon: {
    width: 22,
    textAlign: "center",
    fontSize: 15,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
  },
  disabled: {
    opacity: 0.4,
  },
});
