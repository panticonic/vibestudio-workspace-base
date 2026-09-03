/**
 * Central icon registry. Import exact public icon modules so Metro does not
 * traverse the full Lucide catalog, while retaining the native-host fallback.
 */

import type { ComponentType } from "react";
import { Text } from "react-native";

declare const require: (id: string) => unknown;

export type IconProps = { size?: number; color?: string; strokeWidth?: number };
export type IconComponent = ComponentType<IconProps>;
type IconModule = Record<string, IconComponent | undefined>;

function requiredIcon(value: unknown): IconComponent {
  const imported = value as { default?: IconComponent } | IconComponent;
  return (
    typeof imported === "function" ? imported : imported.default
  ) as IconComponent;
}

let lucideIcons: IconModule = {};
try {
  lucideIcons = {
    Archive: requiredIcon(require("lucide-react-native/icons/archive")),
    ArrowLeft: requiredIcon(require("lucide-react-native/icons/arrow-left")),
    ArrowRight: requiredIcon(require("lucide-react-native/icons/arrow-right")),
    Bell: requiredIcon(require("lucide-react-native/icons/bell")),
    Bookmark: requiredIcon(require("lucide-react-native/icons/bookmark")),
    Brain: requiredIcon(require("lucide-react-native/icons/brain")),
    Check: requiredIcon(require("lucide-react-native/icons/check")),
    CheckCircle2: requiredIcon(
      require("lucide-react-native/icons/circle-check"),
    ),
    XCircle: requiredIcon(require("lucide-react-native/icons/circle-x")),
    ChevronDown: requiredIcon(
      require("lucide-react-native/icons/chevron-down"),
    ),
    ChevronLeft: requiredIcon(
      require("lucide-react-native/icons/chevron-left"),
    ),
    ChevronRight: requiredIcon(
      require("lucide-react-native/icons/chevron-right"),
    ),
    Clock3: requiredIcon(require("lucide-react-native/icons/clock-3")),
    Command: requiredIcon(require("lucide-react-native/icons/command")),
    Copy: requiredIcon(require("lucide-react-native/icons/copy")),
    CopyPlus: requiredIcon(require("lucide-react-native/icons/copy-plus")),
    Globe2: requiredIcon(require("lucide-react-native/icons/earth")),
    MoreHorizontal: requiredIcon(require("lucide-react-native/icons/ellipsis")),
    ExternalLink: requiredIcon(
      require("lucide-react-native/icons/external-link"),
    ),
    Gavel: requiredIcon(require("lucide-react-native/icons/gavel")),
    Globe: requiredIcon(require("lucide-react-native/icons/globe")),
    Info: requiredIcon(require("lucide-react-native/icons/info")),
    LayoutGrid: requiredIcon(require("lucide-react-native/icons/layout-grid")),
    LayoutPanelTop: requiredIcon(
      require("lucide-react-native/icons/layout-panel-top"),
    ),
    LayoutTemplate: requiredIcon(
      require("lucide-react-native/icons/layout-template"),
    ),
    Link2: requiredIcon(require("lucide-react-native/icons/link-2")),
    Lock: requiredIcon(require("lucide-react-native/icons/lock")),
    Menu: requiredIcon(require("lucide-react-native/icons/menu")),
    MessageCircle: requiredIcon(
      require("lucide-react-native/icons/message-circle"),
    ),
    Moon: requiredIcon(require("lucide-react-native/icons/moon")),
    PanelTop: requiredIcon(require("lucide-react-native/icons/panel-top")),
    Paperclip: requiredIcon(require("lucide-react-native/icons/paperclip")),
    Pin: requiredIcon(require("lucide-react-native/icons/pin")),
    PinOff: requiredIcon(require("lucide-react-native/icons/pin-off")),
    Plus: requiredIcon(require("lucide-react-native/icons/plus")),
    Power: requiredIcon(require("lucide-react-native/icons/power")),
    RefreshCw: requiredIcon(require("lucide-react-native/icons/refresh-cw")),
    RotateCcw: requiredIcon(require("lucide-react-native/icons/rotate-ccw")),
    Search: requiredIcon(require("lucide-react-native/icons/search")),
    SendHorizontal: requiredIcon(
      require("lucide-react-native/icons/send-horizontal"),
    ),
    Settings: requiredIcon(require("lucide-react-native/icons/settings")),
    Settings2: requiredIcon(require("lucide-react-native/icons/settings-2")),
    Share2: requiredIcon(require("lucide-react-native/icons/share-2")),
    Smartphone: requiredIcon(require("lucide-react-native/icons/smartphone")),
    Sparkles: requiredIcon(require("lucide-react-native/icons/sparkles")),
    Square: requiredIcon(require("lucide-react-native/icons/square")),
    Sun: requiredIcon(require("lucide-react-native/icons/sun")),
    TriangleAlert: requiredIcon(
      require("lucide-react-native/icons/triangle-alert"),
    ),
    Unplug: requiredIcon(require("lucide-react-native/icons/unplug")),
    User: requiredIcon(require("lucide-react-native/icons/user")),
    Wifi: requiredIcon(require("lucide-react-native/icons/wifi")),
    WifiOff: requiredIcon(require("lucide-react-native/icons/wifi-off")),
    Workflow: requiredIcon(require("lucide-react-native/icons/workflow")),
    Wrench: requiredIcon(require("lucide-react-native/icons/wrench")),
    X: requiredIcon(require("lucide-react-native/icons/x")),
  };
} catch {
  lucideIcons = {};
}

function fallbackIcon(glyph: string): IconComponent {
  return function FallbackIcon({ size = 18, color }: IconProps) {
    return (
      <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>
    );
  };
}

export function icon(name: string, glyph: string): IconComponent {
  return lucideIcons[name] ?? fallbackIcon(glyph);
}

// Navigation & chrome
export const ArrowLeft = icon("ArrowLeft", "‹");
export const ArrowRight = icon("ArrowRight", "›");
export const ChevronDown = icon("ChevronDown", "▾");
export const ChevronLeft = icon("ChevronLeft", "‹");
export const ChevronRight = icon("ChevronRight", "▸");
export const Menu = icon("Menu", "≡");
export const MoreHorizontal = icon("MoreHorizontal", "⋯");
export const Plus = icon("Plus", "+");
export const RefreshCw = icon("RefreshCw", "↻");
export const Search = icon("Search", "○");
export const Square = icon("Square", "■");
export const X = icon("X", "×");

// Panel kinds & suggestions
export const Bookmark = icon("Bookmark", "★");
export const Clock3 = icon("Clock3", "◷");
export const Globe = icon("Globe", "◎");
export const Globe2 = icon("Globe2", "◎");
export const LayoutGrid = icon("LayoutGrid", "▦");
export const LayoutPanelTop = icon("LayoutPanelTop", "▤");
export const Link2 = icon("Link2", "↗");
export const PanelTop = icon("PanelTop", "□");
export const Workflow = icon("Workflow", "◇");

// Actions
export const Archive = icon("Archive", "▣");
export const Command = icon("Command", "⌘");
export const Copy = icon("Copy", "⧉");
export const CopyPlus = icon("CopyPlus", "⧉+");
export const ExternalLink = icon("ExternalLink", "↗");
export const Lock = icon("Lock", "⚿");
export const Pin = icon("Pin", "⤓");
export const PinOff = icon("PinOff", "⤓");
export const Power = icon("Power", "⏻");
export const Settings = icon("Settings", "⚙");
export const Settings2 = icon("Settings2", "⚙");
export const Share2 = icon("Share2", "↥");
export const SendHorizontal = icon("SendHorizontal", "➤");
export const Sparkles = icon("Sparkles", "✦");
export const Wrench = icon("Wrench", "⚒");
export const Gavel = icon("Gavel", "⚖");
export const Brain = icon("Brain", "◌");
export const LayoutTemplate = icon("LayoutTemplate", "▤");
export const Paperclip = icon("Paperclip", "⁂");
export const RotateCcw = icon("RotateCcw", "⟲");
export const Unplug = icon("Unplug", "⏚");
export const User = icon("User", "◕");

// Status & feedback
// Lucide exports the former AlertTriangle icon as TriangleAlert.
export const AlertTriangle = icon("TriangleAlert", "!");
export const TriangleAlert = AlertTriangle;
export const Bell = icon("Bell", "◔");
export const CheckCircle2 = icon("CheckCircle2", "✓");
export const Check = icon("Check", "✓");
export const Info = icon("Info", "i");
export const MessageCircle = icon("MessageCircle", "◍");
export const Moon = icon("Moon", "☾");
export const Smartphone = icon("Smartphone", "▯");
export const Sun = icon("Sun", "☀");
export const Wifi = icon("Wifi", "≋");
export const WifiOff = icon("WifiOff", "≠");
export const XCircle = icon("XCircle", "×");
