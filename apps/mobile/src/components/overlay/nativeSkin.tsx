/**
 * The mobile half of the overlay's rendering: React Native views for the shared
 * primitive contract (`@workspace/quickfire-core/ui`).
 *
 * The sheet used to hand-render its own transcript — its own Markdown walker,
 * its own tool records, its own relative-time helper — beside a desktop overlay
 * doing the same job differently. Now both draw the same component tree and this
 * file answers "what is a card surface with a warning tone?" in React Native
 * terms, exactly as `apps/shell/overlay/domSkin.tsx` answers it in DOM terms.
 *
 * Two React Native facts shape it:
 *  - Text may only nest text. `Pressable variant="quiet"` is therefore a
 *    `<Text onPress>`, and the skin deliberately provides no `Image`, so the
 *    shared renderer falls back to alt text inside the paragraph it belongs to.
 *  - There is no cascade. Every tone resolves through one `toneOf` table, which
 *    is what keeps this file a translation layer rather than a second design.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image as RNImage,
  Platform,
  Pressable as RNPressable,
  StyleSheet,
  Text as RNText,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type {
  QuickfireBoxProps,
  QuickfireCodeProps,
  QuickfireDisclosureProps,
  QuickfireFigureProps,
  QuickfireIconProps,
  QuickfirePressableProps,
  QuickfireSkin,
  QuickfireSpace,
  QuickfireTextProps,
} from "@workspace/quickfire-core/ui";
import type { QuickfireTone } from "@workspace/quickfire-core";
import type { ThemeColors } from "../../state/themeAtoms";
import { hairline, radius, spacing, type } from "../../design/tokens";
import {
  Bell,
  Brain,
  Check,
  Clock3,
  Copy,
  Gavel,
  Info,
  LayoutTemplate,
  Paperclip,
  Sparkles,
  TriangleAlert,
  User,
  Wrench,
  X,
  type IconComponent,
} from "../../design/icons";
import { copyToClipboard } from "../../services/nativeCapabilities";

const GLYPHS: Record<QuickfireIconProps["name"], IconComponent> = {
  you: User,
  agent: Sparkles,
  person: User,
  spark: Sparkles,
  tool: Wrench,
  check: Check,
  cross: X,
  alert: TriangleAlert,
  info: Info,
  clock: Clock3,
  reasoning: Brain,
  card: LayoutTemplate,
  paperclip: Paperclip,
  bell: Bell,
  gavel: Gavel,
};

const SPACE: Record<QuickfireSpace, number> = {
  none: 0,
  xs: spacing.xxs,
  sm: spacing.xs,
  md: spacing.sm,
  lg: spacing.lg,
};

interface Tone {
  /** Foreground for text and icons. */
  fg: string;
  /** Fill behind a card or rail. */
  wash: string;
  /** Border, rail, and outline. */
  edge: string;
}

/** 8-digit hex is the cheapest honest alpha on both platforms' colour parsers. */
function withAlpha(color: string, hex: string): string {
  return /^#[0-9a-f]{6}$/iu.test(color) ? `${color}${hex}` : color;
}

function toneTable(colors: ThemeColors): Record<QuickfireTone | "muted", Tone> {
  return {
    neutral: { fg: colors.text, wash: colors.surfaceSunken, edge: colors.borderSubtle },
    muted: { fg: colors.textSecondary, wash: colors.surfaceSunken, edge: colors.borderSubtle },
    accent: { fg: colors.primary, wash: colors.accentSoft, edge: withAlpha(colors.primary, "55") },
    success: {
      fg: colors.success,
      wash: colors.successSoft,
      edge: withAlpha(colors.success, "55"),
    },
    warning: {
      fg: colors.warning,
      wash: colors.warningSoft,
      edge: withAlpha(colors.warning, "55"),
    },
    danger: { fg: colors.danger, wash: colors.dangerSoft, edge: withAlpha(colors.danger, "55") },
    info: { fg: colors.info, wash: colors.infoSoft, edge: withAlpha(colors.info, "55") },
    reasoning: {
      fg: colors.accent,
      wash: withAlpha(colors.accent, "1f"),
      edge: withAlpha(colors.accent, "55"),
    },
  };
}

/**
 * Build the skin for one palette. Memoize it per theme in the surface that
 * mounts it — a new object identity on every render would remount the whole
 * transcript, and disclosures would snap shut mid-read.
 */
export interface NativeSkinOptions {
  /**
   * Open a destination from agent prose. Required rather than defaulted to
   * `Linking.openURL`: a workspace panel link handed to the system browser
   * leaves the app to show something the app itself owns.
   */
  openLink: (href: string) => void;
}

export function createNativeSkin(colors: ThemeColors, options: NativeSkinOptions): QuickfireSkin {
  const tones = toneTable(colors);
  const toneOf = (name: QuickfireTone | "muted" | undefined): Tone =>
    tones[name ?? "neutral"] ?? tones.neutral;

  function Box({
    children,
    gap,
    pad,
    row,
    surface,
    tone,
    align,
    grow,
    scroll,
    testId,
    live,
    emphasis,
    // `hover` is deliberately unread: a phone has no pointer to reveal with, so
    // secondary controls are simply always visible here.
    hover: _hover,
  }: QuickfireBoxProps) {
    const resolved = toneOf(tone);
    const style: ViewStyle = {
      flexDirection: row ? "row" : "column",
      ...(row ? { flexWrap: "wrap" } : {}),
      ...(gap ? { gap: SPACE[gap] } : {}),
      ...(align === "center"
        ? { alignItems: "center" }
        : align === "baseline"
          ? { alignItems: "baseline" }
          : {}),
      ...(grow ? { flex: 1, minWidth: 0 } : {}),
      ...(scroll ? { overflow: "scroll" } : {}),
      ...padding(pad),
      ...surfaceStyle(surface, resolved, tone),
      ...(emphasis
        ? { borderWidth: 1, borderColor: resolved.edge, borderRadius: radius.md }
        : {}),
    };
    return (
      <View
        style={style}
        testID={testId}
        {...(live ? { accessibilityLiveRegion: "polite" as const } : {})}
      >
        {children}
      </View>
    );
  }

  function padding(pad: QuickfireSpace | undefined): ViewStyle {
    if (!pad || pad === "none") return {};
    if (pad === "xs") return { padding: SPACE.xs };
    if (pad === "sm") return { paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md };
    if (pad === "md") return { paddingVertical: SPACE.md, paddingHorizontal: SPACE.lg };
    return { padding: SPACE.lg };
  }

  function surfaceStyle(
    surface: QuickfireBoxProps["surface"],
    tone: Tone,
    toneName: QuickfireTone | undefined
  ): ViewStyle {
    switch (surface) {
      case "card":
        // The agent's prose gets no container at all: on a phone, a bubble
        // around every paragraph costs the width the words needed.
        return toneName === undefined || toneName === "neutral"
          ? { paddingVertical: SPACE.xs }
          : {
              backgroundColor: tone.wash,
              borderRadius: radius.md,
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
            };
      case "sunken":
        return { backgroundColor: colors.surfaceSunken, borderRadius: radius.md };
      case "outline":
        return {
          borderWidth: hairline,
          borderColor: tone.edge,
          borderRadius: radius.md,
          overflow: "hidden",
        };
      case "rail":
        return {
          borderLeftWidth: 2,
          borderLeftColor: tone.edge,
          backgroundColor: tone.wash,
          borderTopRightRadius: radius.md,
          borderBottomRightRadius: radius.md,
          paddingLeft: spacing.sm,
        };
      default:
        return {};
    }
  }

  function textStyle(variant: QuickfireTextProps["variant"]): TextStyle {
    switch (variant) {
      case "strong":
        return { ...type.body, fontWeight: "700" };
      case "emphasis":
        return { ...type.body, fontStyle: "italic" };
      case "strike":
        return { ...type.body, textDecorationLine: "line-through" };
      case "heading":
        return type.heading;
      case "label":
        return type.micro;
      case "caption":
        return type.caption;
      case "code":
        return {
          fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
          fontSize: 13,
        };
      default:
        return type.body;
    }
  }

  function Text({ children, variant, tone, clamp, selectable, testId }: QuickfireTextProps) {
    return (
      <RNText
        testID={testId}
        selectable={selectable}
        numberOfLines={clamp ? 1 : undefined}
        style={[
          textStyle(variant),
          { color: tone ? toneOf(tone).fg : colors.text },
          variant === "label" ? { textTransform: "uppercase" } : null,
          variant === "code" ? { backgroundColor: colors.codeBackground } : null,
        ]}
      >
        {children}
      </RNText>
    );
  }

  function Pressable({
    children,
    onPress,
    label,
    variant = "ghost",
    tone,
    disabled,
    testId,
  }: QuickfirePressableProps) {
    const resolved = toneOf(tone);
    if (variant === "quiet") {
      // Inline, inside running prose: it must be a Text or the paragraph breaks.
      return (
        <RNText
          accessibilityRole="link"
          accessibilityLabel={label}
          testID={testId}
          onPress={disabled ? undefined : onPress}
          style={{ color: resolved.fg, textDecorationLine: "underline" }}
        >
          {children}
        </RNText>
      );
    }
    return (
      <RNPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onPress={onPress}
        testID={testId}
        hitSlop={6}
        style={({ pressed }) => [
          styles.press,
          variant === "primary"
            ? { borderWidth: 1, borderColor: resolved.edge, paddingHorizontal: spacing.md }
            : null,
          pressed ? { backgroundColor: resolved.wash } : null,
          disabled ? { opacity: 0.42 } : null,
        ]}
      >
        {children}
      </RNPressable>
    );
  }

  function Icon({ name, tone, size = "md" }: QuickfireIconProps) {
    const Glyph = GLYPHS[name] ?? Info;
    return <Glyph size={size === "sm" ? 13 : 15} color={toneOf(tone).fg} />;
  }

  function Spinner({ tone }: { tone?: QuickfireTone }) {
    return <ActivityIndicator size="small" color={toneOf(tone).fg} />;
  }

  function Divider() {
    return <View style={[styles.rule, { backgroundColor: colors.borderSubtle }]} />;
  }

  function Pill({ children, tone }: { children?: ReactNode; tone?: QuickfireTone }) {
    const resolved = toneOf(tone);
    return (
      <View
        style={[styles.pill, { backgroundColor: resolved.wash, borderColor: resolved.edge }]}
      >
        <RNText style={[type.micro, { color: resolved.fg }]}>{children}</RNText>
      </View>
    );
  }

  function Disclosure({
    summary,
    children,
    defaultOpen,
    tone,
    label,
    testId,
  }: QuickfireDisclosureProps) {
    const [open, setOpen] = useState(defaultOpen === true);
    const resolved = toneOf(tone);
    return (
      <View testID={testId}>
        <RNPressable
          accessibilityRole="button"
          accessibilityLabel={`${open ? "Hide" : "Show"} ${label}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          hitSlop={4}
          style={styles.disclosureSummary}
        >
          <RNText style={[type.micro, { color: resolved.fg }]}>{open ? "▾" : "▸"}</RNText>
          {summary}
        </RNPressable>
        {open ? <View style={styles.disclosureBody}>{children}</View> : null}
      </View>
    );
  }

  function Code({ text, language, caption }: QuickfireCodeProps) {
    const [copied, setCopied] = useState(false);
    // Mermaid renders through the DOM, which this platform does not have. The
    // source is shown and labelled rather than silently dropped; the chat panel
    // is where a diagram becomes a picture.
    const label = (caption ?? language ?? "").toUpperCase();
    return (
      <View style={[styles.code, { borderColor: colors.borderSubtle }]}>
        <View style={[styles.codeBar, { borderBottomColor: colors.borderSubtle }]}>
          <RNText style={[type.micro, { color: colors.textTertiary }]} numberOfLines={1}>
            {language === "mermaid" ? "DIAGRAM SOURCE" : label}
          </RNText>
          <RNPressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "Copied" : "Copy this block"}
            hitSlop={8}
            onPress={() => {
              copyToClipboard(text);
              setCopied(true);
            }}
          >
            {copied ? (
              <Check size={13} color={colors.success} />
            ) : (
              <Copy size={13} color={colors.textTertiary} />
            )}
          </RNPressable>
        </View>
        <RNText
          selectable
          style={[styles.codeText, { color: colors.text, backgroundColor: colors.codeBackground }]}
        >
          {text}
        </RNText>
      </View>
    );
  }

  function Figure({ src, alt, caption }: QuickfireFigureProps) {
    return (
      <View style={[styles.figure, { borderColor: colors.borderSubtle }]}>
        <RNImage
          source={{ uri: src }}
          accessibilityLabel={alt}
          resizeMode="contain"
          style={styles.figureImage}
        />
        {caption ? (
          <RNText style={[type.micro, styles.figureCaption, { color: colors.textTertiary }]}>
            {caption}
          </RNText>
        ) : null}
      </View>
    );
  }

  /** No blink: an animated cursor on a phone costs a frame loop for a hint. */
  function Caret() {
    return <RNText style={{ color: colors.primary }}>▌</RNText>;
  }

  return {
    Box,
    Text,
    Pressable,
    Icon,
    Spinner,
    Divider,
    Pill,
    Disclosure,
    Code,
    Figure,
    Caret,
    openUrl: options.openLink,
    copy: (text) => copyToClipboard(text),
  };
}

/** Memoized skin for the current palette. */
export function useNativeSkin(colors: ThemeColors, options: NativeSkinOptions): QuickfireSkin {
  const openLink = options.openLink;
  return useMemo(() => createNativeSkin(colors, { openLink }), [colors, openLink]);
}

const styles = StyleSheet.create({
  press: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  rule: {
    height: hairline,
    width: "100%",
    marginVertical: spacing.xs,
  },
  pill: {
    borderWidth: hairline,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  disclosureSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  disclosureBody: {
    paddingBottom: spacing.xs,
  },
  code: {
    borderWidth: hairline,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  codeBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    borderBottomWidth: hairline,
  },
  figure: {
    borderWidth: hairline,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  figureImage: {
    width: "100%",
    height: 200,
  },
  figureCaption: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  codeText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 12,
    lineHeight: 17,
    padding: spacing.sm,
  },
});
