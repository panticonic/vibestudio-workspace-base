/**
 * The desktop half of the overlay's rendering: DOM nodes for the shared
 * primitive contract (`@workspace/quickfire-core/ui`).
 *
 * Nothing here knows what a transcript is. It knows that a "card surface with a
 * warning tone" is a `div` with two data attributes, and that the styling for
 * that pair lives in `quickfire.css` — which is why the whole conversation can
 * be one component tree shared with a React Native sheet.
 *
 * Two desktop-specific behaviours worth naming:
 *  - Every control preventDefaults its mousedown. The overlay's caret lives in
 *    the palette input at the top of the card; a click that blurs it makes the
 *    surface feel like it stopped listening.
 *  - Links are real anchors. This surface is a separate `WebContentsView`, and
 *    the host's window-open handling is what turns a click into a browser panel.
 */

import { lazy, Suspense, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
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
} from "@workspace/ui/icons";
import type {
  QuickfireBoxProps,
  QuickfireCodeProps,
  QuickfireDisclosureProps,
  QuickfireFigureProps,
  QuickfireIconProps,
  QuickfireImageProps,
  QuickfirePressableProps,
  QuickfireSkin,
  QuickfireTextProps,
} from "@workspace/quickfire-core/ui";

const GLYPHS = {
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
} as const;

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
  hover,
}: QuickfireBoxProps) {
  return (
    <div
      className="qf-box"
      data-row={row ? "" : undefined}
      data-gap={gap}
      data-pad={pad}
      data-surface={surface}
      data-tone={tone}
      data-align={align}
      data-grow={grow ? "" : undefined}
      data-scroll={scroll ? "" : undefined}
      data-emphasis={emphasis ? "" : undefined}
      data-hover={hover ? "" : undefined}
      data-testid={testId}
      {...(live ? { "aria-live": "polite" as const } : {})}
    >
      {children}
    </div>
  );
}

function Text({ children, variant, tone, clamp, selectable, testId }: QuickfireTextProps) {
  const Tag = variant === "code" ? "code" : "span";
  return (
    <Tag
      className="qf-text"
      data-variant={variant}
      data-tone={tone}
      data-clamp={clamp ? "" : undefined}
      data-selectable={selectable ? "" : undefined}
      data-testid={testId}
    >
      {children}
    </Tag>
  );
}

/** Keep the caret where the user left it: the palette input owns focus. */
const holdFocus = (event: MouseEvent) => event.preventDefault();

function Pressable({
  children,
  onPress,
  label,
  variant = "ghost",
  href,
  tone,
  disabled,
  testId,
}: QuickfirePressableProps) {
  if (href) {
    // A real anchor, for the hover target and the status text it gives — but
    // the navigation is ours: the default would escape the workspace.
    return (
      <a
        className="qf-press"
        data-variant={variant}
        data-tone={tone}
        href={href}
        rel="noreferrer"
        aria-label={label}
        title={href}
        data-testid={testId}
        onMouseDown={holdFocus}
        onClick={(event) => {
          event.preventDefault();
          onPress();
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="qf-press"
      data-variant={variant}
      data-tone={tone}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
      onMouseDown={holdFocus}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

function Icon({ name, tone, size = "md" }: QuickfireIconProps) {
  const Glyph = GLYPHS[name] ?? Info;
  return (
    <span className="qf-icon" data-tone={tone} aria-hidden="true">
      <Glyph size={size === "sm" ? 12 : 14} strokeWidth={2} />
    </span>
  );
}

function Spinner({ tone }: { tone?: QuickfireIconProps["tone"] }) {
  return <span className="qf-spinner" data-tone={tone} aria-hidden="true" />;
}

function Divider() {
  return <hr className="qf-rule" />;
}

/** DOM collapses a newline to a space, so an authored hard break needs an element. */
function Break() {
  return <br />;
}

function Pill({ children, tone }: { children?: ReactNode; tone?: QuickfireIconProps["tone"] }) {
  return (
    <span className="qf-pill" data-tone={tone}>
      {children}
    </span>
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
  return (
    <details
      className="qf-disclosure"
      data-tone={tone}
      data-testid={testId}
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary aria-label={label} onMouseDown={holdFocus}>
        <span className="qf-disclosure-mark" aria-hidden="true" />
        {summary}
      </summary>
      <div className="qf-disclosure-body">{children}</div>
    </details>
  );
}

/**
 * Diagrams are the shared kit's (`@workspace/ui/diagram`) — the same renderer
 * the chat panel uses, lazily loaded so mermaid's ~1.5MB never enters the
 * shell's startup path. Mobile has no DOM to give it and shows the source.
 */
const Diagram = lazy(() =>
  import("@workspace/ui/diagram").then((module) => ({ default: module.MermaidDiagram }))
);

/**
 * Highlight when we can name the language and the grammar is registered.
 *
 * Never `highlightAuto`: it is expensive per block, and a wrong guess colours a
 * shell transcript as if it were Ruby, which reads worse than no colour at all.
 */
function highlighted(text: string, language: string | null | undefined): string | null {
  if (!language) return null;
  try {
    if (!hljs.getLanguage(language)) return null;
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

function Code({ text, language, caption }: QuickfireCodeProps) {
  const [copied, setCopied] = useState(false);
  const markup = useMemo(() => highlighted(text, language), [text, language]);
  if (language === "mermaid") {
    return (
      <Suspense
        fallback={
          <div className="qf-code">
            <div className="qf-code-bar">
              <span className="qf-code-caption">Loading diagram…</span>
            </div>
            <pre>{text}</pre>
          </div>
        }
      >
        <Diagram code={text} />
      </Suspense>
    );
  }
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="qf-code" data-language={language ?? undefined}>
      <div className="qf-code-bar">
        <span className="qf-code-caption">{caption ?? language ?? ""}</span>
        <button
          type="button"
          className="qf-code-copy"
          aria-label={copied ? "Copied" : "Copy this block"}
          onMouseDown={holdFocus}
          onClick={copy}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      {markup === null ? (
        <pre>{text}</pre>
      ) : (
        // hljs escapes its input; the markup it returns is token spans only.
        <pre dangerouslySetInnerHTML={{ __html: markup }} />
      )}
    </div>
  );
}

function Image({ src, alt }: QuickfireImageProps) {
  return <img className="qf-image" src={src} alt={alt} loading="lazy" />;
}

/** A picture a tool produced — a screenshot of the panel, most of the time. */
function Figure({ src, alt, caption }: QuickfireFigureProps) {
  return (
    <figure className="qf-figure">
      <img src={src} alt={alt} loading="lazy" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function Caret() {
  return <span className="qf-caret" aria-hidden="true" />;
}

/**
 * Build the skin for one surface.
 *
 * `openLink` is a parameter rather than a `window.open` because this document is
 * a transparent `WebContentsView` with no window-open handler of its own: left
 * to itself a link click produces a bare Electron window, not a browser panel.
 * The chrome owns opening, as it owns every other side effect here.
 */
export function createDomSkin(options: { openLink: (href: string) => void }): QuickfireSkin {
  return {
    Box,
    Text,
    Pressable,
    Icon,
    Spinner,
    Divider,
    Break,
    Pill,
    Disclosure,
    Code,
    Image,
    Figure,
    Caret,
    openUrl: options.openLink,
    copy: (text) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
  };
}
