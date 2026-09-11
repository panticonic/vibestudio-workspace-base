/**
 * Keyboard Shortcuts Page - Shell panel showing available keyboard shortcuts.
 *
 * Every chord here comes from `@vibestudio/shared/desktopKeymap`, the table the
 * menu registers from. This page used to keep its own copy "mirroring" the
 * menu, and it drifted exactly as a second copy does: it advertised Alt+← for
 * Back, which nothing bound, and Ctrl+Y for Redo, which the menu had spent on
 * History. A page that documents shortcuts has to be unable to be wrong about
 * them.
 */
import { Flex, Text, Kbd, Separator } from "@radix-ui/themes";
import { Fragment } from "react";
import { KeyboardIcon } from "@radix-ui/react-icons";
import { AboutThemeRoot, AboutPage, Section } from "@workspace/about-shared/ui";
import {
  desktopKeyPlatform,
  desktopShortcutTokens,
  type DesktopBindingId,
} from "@vibestudio/shared/desktopKeymap";

const PLATFORM = desktopKeyPlatform(
  typeof navigator === "undefined" ? "" : (navigator.platform ?? ""),
);
const IS_MAC = PLATFORM === "mac";

interface Shortcut {
  description: string;
  /** The binding this row documents, or explicit keys for a platform role. */
  binding?: DesktopBindingId;
  /** Keys for the handful of rows Electron owns through menu roles. */
  keys?: { mac: string[]; other?: string[] };
  /** Restrict the shortcut to one platform. */
  platform?: "mac" | "other";
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const SYMBOL_TO_TEXT: Record<string, string> = {
  "⌘": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Ctrl",
};

function keysFor(shortcut: Shortcut): string[] {
  if (shortcut.binding) return desktopShortcutTokens(shortcut.binding, PLATFORM);
  const keys = shortcut.keys ?? { mac: [] };
  if (IS_MAC) return keys.mac;
  return keys.other ?? keys.mac.map((key) => SYMBOL_TO_TEXT[key] ?? key);
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "General",
    shortcuts: [
      { description: "New panel / launcher", binding: "newPanel" },
      { description: "Command (palette and Quickfire agent)", binding: "commandPalette" },
      { description: "Focus pending approval", binding: "focusApproval" },
      { description: "Switch workspace", binding: "switchWorkspace" },
      { description: "Close current panel", binding: "closePanel" },
      { description: "Keyboard shortcuts", binding: "keyboardShortcuts" },
      { description: "Quit application", keys: { mac: ["⌘", "Q"] } },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { description: "Back", binding: "back" },
      { description: "Forward", binding: "forward" },
      { description: "Reload panel", binding: "reload" },
      { description: "Force reload view", binding: "forceReload" },
      { description: "Stop loading", binding: "stop" },
      { description: "Focus address", binding: "focusAddress" },
      { description: "Find in page", binding: "findInPage" },
      { description: "Find next", binding: "findNext" },
      { description: "Find previous", binding: "findPrevious" },
      { description: "Bookmarks", binding: "bookmarks" },
      { description: "History", binding: "history" },
    ],
  },
  {
    title: "View",
    shortcuts: [
      { description: "Zoom in", binding: "zoomIn" },
      { description: "Zoom out", binding: "zoomOut" },
      { description: "Reset zoom", binding: "resetZoom" },
      { description: "Toggle fullscreen", binding: "toggleFullScreen" },
      { description: "Minimize window", keys: { mac: ["⌘", "M"] }, platform: "mac" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { description: "Undo", keys: { mac: ["⌘", "Z"] } },
      { description: "Redo", keys: { mac: ["⇧", "⌘", "Z"], other: ["Ctrl", "Shift", "Z"] } },
      { description: "Cut", keys: { mac: ["⌘", "X"] } },
      { description: "Copy", keys: { mac: ["⌘", "C"] } },
      { description: "Paste", keys: { mac: ["⌘", "V"] } },
      { description: "Select all", keys: { mac: ["⌘", "A"] } },
    ],
  },
  {
    title: "Developer",
    shortcuts: [
      { description: "Toggle panel DevTools", binding: "panelDevTools" },
      { description: "Toggle app DevTools", binding: "appDevTools" },
    ],
  },
];

function ShortcutKeys({ shortcut }: { shortcut: Shortcut }) {
  const keys = keysFor(shortcut);
  if (IS_MAC) {
    // macOS convention: render the chord as one compact group, e.g. ⇧⌘O
    return <Kbd size="3">{keys.join("")}</Kbd>;
  }
  return (
    <Flex align="center" gap="1">
      {keys.map((key, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Text size="1" color="gray">
              +
            </Text>
          )}
          <Kbd size="2">{key}</Kbd>
        </Fragment>
      ))}
    </Flex>
  );
}

function KeyboardShortcutsPage() {
  const currentPlatform = IS_MAC ? "mac" : "other";
  return (
    <AboutPage
      icon={<KeyboardIcon width={20} height={20} />}
      title="Keyboard Shortcuts"
      maxWidth={640}
    >
      {shortcutGroups.map((group) => {
        const visible = group.shortcuts.filter(
          (s) => !s.platform || s.platform === currentPlatform
        );
        if (visible.length === 0) return null;
        return (
          <Section key={group.title} title={group.title}>
            <Flex direction="column">
              {visible.map((shortcut, index) => (
                <Fragment key={shortcut.description}>
                  {index > 0 && <Separator size="4" my="2" />}
                  <Flex align="center" justify="between" gap="3">
                    <Text size="2">{shortcut.description}</Text>
                    <ShortcutKeys shortcut={shortcut} />
                  </Flex>
                </Fragment>
              ))}
            </Flex>
          </Section>
        );
      })}
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <KeyboardShortcutsPage />
    </AboutThemeRoot>
  );
}
