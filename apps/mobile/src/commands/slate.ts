/**
 * The mobile half of the built-in command slate (quickfire-overlay-spec §3.2,
 * §7.1).
 *
 * The definitions — ids, titles, match terms, sections, arguments, availability
 * and surface flags — come from `@workspace/quickfire-core`, shared verbatim
 * with `apps/shell/commands/slate.ts`. Only the implementations live here,
 * because a phone reaches the workspace through `ShellClient`, not through
 * Electron main, and several actions have genuinely different native
 * equivalents (a panel "reload" is a WebView reload; "copy link" is the system
 * clipboard).
 *
 * Commands whose `surfaces` omit `"mobile"` never reach this file: the engine
 * hides them from a `platform: "mobile"` context, and `buildMobileSlate`
 * filters them out so a missing implementation is a build-time error rather
 * than a dead row.
 */
import type { CommandSpec } from "@workspace/omnibox-core";
import { browserUrlFromEntry } from "@workspace/omnibox-core";
import { buildSlateDefinitions, HISTORY_SCOPE_TOKEN } from "@workspace/quickfire-core";
import type { QuickfireMode } from "@workspace/quickfire-core";
import type { BrowserAddressOptions } from "@vibestudio/shared/panelChrome";
import { createPanelShareUrl } from "@vibestudio/shared/panelLocation";
import type { PanelCommandId } from "@vibestudio/shared/panelCommands";
import type { QuickfireSessionSummary } from "@vibestudio/service-schemas/quickfire";

/** What running a command asks the command sheet to do next. */
export interface MobileCommandOutcome {
  /** Dismiss the sheet (navigation, or anything that moves the user). */
  close?: boolean;
  /** Hand off to the quickfire sheet, optionally with a prefilled draft. */
  quickfire?: { prompt?: string };
  /** Stay open, but in another scope with the input reseeded (`nav.history`). */
  scope?: { mode: QuickfireMode; query?: string };
  /** Human-facing note; surfaced as a toast. */
  message?: string;
  /** Toast tone for `message`. Defaults to a neutral note. */
  tone?: "success" | "warning" | "danger";
}

/**
 * The narrow slice of `ShellClient` the slate needs. Structural on purpose:
 * every command is then testable without standing up a transport.
 */
export interface MobileSlatePanels {
  createAboutPanel(page: string): Promise<{ id: string; title: string }>;
  createRootPanel(
    source: string,
    options?: { focus?: boolean; stateArgs?: Record<string, unknown> }
  ): Promise<{ id: string; title: string }>;
  createChildPanel(
    parentId: string,
    source: string,
    options?: { focus?: boolean; stateArgs?: Record<string, unknown> }
  ): Promise<{ id: string; title: string }>;
  createBrowserUrlPanel(
    parentId: string | null,
    url: string,
    options?: { focus?: boolean }
  ): Promise<{ id: string; title: string }>;
  observe(panelId: string): Promise<{ source: string; contextId: string | null }>;
  /**
   * Ranked browser history / bookmarks / open-page rows for the omnibox.
   * Same call the address field in `AppBar` already makes, so the command
   * sheet's "Recent pages" group and the address bar cannot disagree.
   */
  getBrowserAddressOptions(query: string): Promise<BrowserAddressOptions>;
}

export interface MobileSlateQuickfire {
  clear(slotId: string): Promise<{ cleared: boolean; archived: number }>;
  promote(slotId: string): Promise<{ channelId: string } | null>;
  list(): Promise<QuickfireSessionSummary[]>;
}

export interface MobileSlateDeps {
  /** The panel the sheet is acting on — mobile's focused slot. */
  activePanelId: string | null;
  panels: MobileSlatePanels;
  quickfire: MobileSlateQuickfire;
  /**
   * The app's existing native command switch (`MainScreen.performPanelCommand`).
   * Reload, back/forward, pin and duplicate already have correct mobile
   * behavior there — routing through it keeps one implementation per action
   * instead of a palette-only second one that drifts.
   */
  performPanelCommand: (command: PanelCommandId, panelId?: string) => void;
  /** Make a panel the visible one (mobile's equivalent of focusing a pane). */
  navigateToPanel: (panelId: string) => void;
  setThemePreference: (mode: "system" | "light" | "dark") => void;
  copyText: (text: string) => void;
  /**
   * Open (or focus) the chat panel for a promoted conversation — the same
   * dedupe-aware path the quickfire sheet's ⧉ uses, so the slate command and
   * the sheet place one panel, never two.
   */
  openChatPanelForChannel: (channelId: string) => Promise<void>;
  /** Workspace switching is a native re-route + bundle reload; it lives in Settings. */
  openWorkspaceSettings: () => void;
  showQuickfireConversations: (rows: QuickfireSessionSummary[]) => void;
}

export type MobileSlateRun = (
  args: Record<string, string>,
  deps: MobileSlateDeps
) => Promise<MobileCommandOutcome> | MobileCommandOutcome;

export interface MobileSlateCommand extends CommandSpec {
  run: MobileSlateRun;
}

/** One mobile implementation per command id offered on this surface. */
const MOBILE_RUNS: Record<string, MobileSlateRun> = {
  // ---- Panel ---------------------------------------------------------------
  "panel.new": async ({ source }, deps) => {
    if (source) await deps.panels.createRootPanel(source, { focus: true });
    else await deps.panels.createAboutPanel("new");
    return { close: true };
  },
  "panel.close": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("archive", deps.activePanelId);
    return { close: true };
  },
  "panel.focus": ({ panel: panelId }, deps) => {
    if (panelId) deps.navigateToPanel(panelId);
    return { close: true };
  },
  "panel.pin": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("toggle-pin", deps.activePanelId);
    return { message: "Panel pinned", tone: "success" };
  },
  "panel.unpin": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("toggle-pin", deps.activePanelId);
    return { message: "Panel unpinned", tone: "success" };
  },
  "panel.reload": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("reload-panel", deps.activePanelId);
    return { message: "Panel reloaded", tone: "success" };
  },
  "panel.duplicate": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("duplicate", deps.activePanelId);
    return { close: true };
  },
  "panel.copy-link": async (_args, deps) => {
    const panelId = deps.activePanelId;
    if (!panelId) return {};
    const observation = await deps.panels.observe(panelId);
    // The raw source is not a link. Build the canonical share URL, which
    // survives being pasted somewhere outside this device.
    deps.copyText(
      createPanelShareUrl({
        source: observation.source,
        ...(observation.contextId ? { contextId: observation.contextId } : {}),
      })
    );
    return { message: "Panel link copied", tone: "success" };
  },

  // ---- Navigate ------------------------------------------------------------
  "nav.back": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("back", deps.activePanelId);
    return { close: true };
  },
  "nav.forward": (_args, deps) => {
    if (deps.activePanelId) deps.performPanelCommand("forward", deps.activePanelId);
    return { close: true };
  },
  "nav.open-url": async ({ url }, deps) => {
    const resolved = url ? browserUrlFromEntry(url) : null;
    if (!resolved) {
      return { message: "That doesn't look like a web address.", tone: "warning" };
    }
    await deps.panels.createBrowserUrlPanel(null, resolved, { focus: true });
    return { close: true };
  },

  // Not a navigation: it re-scopes the sheet to `@` narrowed to recent pages
  // by the visible `history:` token (§1.2 sub-scope).
  "nav.history": () => ({ scope: { mode: "goto", query: `${HISTORY_SCOPE_TOKEN} ` } }),

  // ---- Quickfire -----------------------------------------------------------
  // Desktop switches the one overlay into `/` mode; mobile hands off to the
  // full-height quickfire sheet, which is the same conversation either way.
  "quickfire.ask": ({ prompt }) => ({
    close: true,
    quickfire: prompt ? { prompt } : {},
  }),
  // Clearing detaches the mapping and queues the channel for archival; a
  // promoted conversation is detached without archival because the chat panel
  // owns it now (§1.4). Both decisions live server-side.
  "quickfire.clear": async (_args, deps) => {
    const panelId = deps.activePanelId;
    if (!panelId) return {};
    const result = await deps.quickfire.clear(panelId);
    return {
      message: result.cleared
        ? "Panel conversation cleared"
        : "This panel has no conversation to clear",
      ...(result.cleared ? { tone: "success" as const } : {}),
    };
  },
  // Promotion is a view change, not a copy: the chat panel attaches to the same
  // durable channel, and ownership of its lifetime transfers with it.
  "quickfire.promote": async (_args, deps) => {
    const panelId = deps.activePanelId;
    if (!panelId) return {};
    const promoted = await deps.quickfire.promote(panelId);
    if (!promoted) {
      return { message: "This panel has no conversation to open", tone: "warning" };
    }
    await deps.openChatPanelForChannel(promoted.channelId);
    return { close: true };
  },
  "quickfire.list": async (_args, deps) => {
    const rows = await deps.quickfire.list();
    if (rows.length === 0) {
      return { message: "No panel has a command agent conversation yet" };
    }
    deps.showQuickfireConversations(rows);
    return {};
  },
  "agent.new-chat": async ({ prompt }, deps) => {
    await deps.panels.createRootPanel("panels/chat", {
      focus: true,
      ...(prompt ? { stateArgs: { initialPrompt: prompt } } : {}),
    });
    return { close: true };
  },

  // ---- Appearance & Layout -------------------------------------------------
  "view.theme": ({ mode }, deps) => {
    if (mode === "system" || mode === "light" || mode === "dark") {
      deps.setThemePreference(mode);
    }
    return { message: `Theme: ${mode}`, tone: "success" };
  },

  // ---- Workspace -----------------------------------------------------------
  // Any provided name is deliberately ignored: switching workspaces on mobile
  // re-routes the device credential and reloads the native bundle, so the
  // command takes the user to the surface that explains and confirms that
  // rather than performing it from a search field.
  "workspace.switch": (_args, deps) => {
    deps.openWorkspaceSettings();
    return { close: true };
  },
  "workspace.permissions": async (_args, deps) => {
    await deps.panels.createAboutPanel("permissions");
    return { close: true };
  },
  "workspace.downloads": async (_args, deps) => {
    await deps.panels.createAboutPanel("downloads");
    return { close: true };
  },
  "workspace.about": async (_args, deps) => {
    await deps.panels.createAboutPanel("about");
    return { close: true };
  },

  // ---- Application ---------------------------------------------------------
  "app.shortcuts": async (_args, deps) => {
    await deps.panels.createAboutPanel("keyboard-shortcuts");
    return { close: true };
  },
};

/**
 * The mobile slate: shared definitions filtered to this surface, each bound to
 * its native implementation.
 *
 * `workspaceNames` is empty on purpose — the workspace argument's picker exists
 * for the desktop chooser, and mobile's `workspace.switch` routes to Settings
 * instead of taking a name (see the run above).
 */
export function buildMobileSlate(): MobileSlateCommand[] {
  return buildSlateDefinitions({ workspaceNames: () => [] })
    .filter((spec) => spec.surfaces.includes("mobile"))
    .map((spec) => {
      const run = MOBILE_RUNS[spec.id];
      // A definition mobile advertises but cannot perform would be a dead row.
      if (!run) throw new Error(`Mobile slate has no implementation for "${spec.id}"`);
      return { ...spec, run };
    });
}
