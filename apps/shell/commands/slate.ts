/**
 * The desktop half of the built-in command slate (spec §3.2).
 *
 * What each command *is* — id, title, match terms, section, icon, arguments,
 * availability, surfaces — lives in `@workspace/quickfire-core`
 * (`buildSlateDefinitions`), because `apps/mobile` offers the same slate and the
 * parity rule in `../SKILL.md` is explicit that the two clients share canonical
 * rules rather than renderers. What each command *does* lives here: every entry
 * below is the same call the retired `AppCommandPalette` or the native menus
 * already made, and none of them would mean anything on a phone.
 *
 * The `quickfire.*` commands drive the real `quickfire` service: they bind,
 * clear, and promote the conversation attached to the focused panel slot.
 */
import type { CommandSpec } from "@workspace/omnibox-core";
import { browserUrlFromEntry } from "@workspace/omnibox-core";
import {
  buildSlateDefinitions,
  HISTORY_SCOPE_TOKEN,
  SLATE_ACCENTS,
} from "@workspace/quickfire-core";
import type { ThemeConfig } from "@vibestudio/shared/theme";
import { createPanelShareUrl } from "@vibestudio/shared/panelLocation";
import { app, hostCommands, notification, panel, quickfire, workspace } from "../shell/client";
import type { QuickfireSessionSummary } from "@workspace/quickfire-core/service";
import type { QuickfireMode } from "../overlay/quickfireSurfaceModel";

/**
 * Chrome-local request for the approval card's attention.
 *
 * `focus-approval-card` is a main→renderer shell event, so a command running in
 * this document cannot emit it. `ConsentApprovalBar` listens for this window
 * event as well, which keeps the two entry points on one code path instead of
 * duplicating the focus logic here.
 */
export const FOCUS_APPROVAL_REQUEST_EVENT = "vibestudio:focus-approval-card";

/** What running a command asks the overlay to do next. */
export interface CommandOutcome {
  /** Close the overlay (navigation, or anything that moves focus). */
  close?: boolean;
  /** Switch the overlay into another mode instead of closing (`quickfire.ask`). */
  mode?: QuickfireMode;
  /** Seed the input after a mode switch. */
  query?: string;
  /** Human-facing note; surfaced as a notification. */
  message?: string;
}

export interface SlateDeps {
  setThemeMode: (mode: "system" | "light" | "dark") => void;
  setThemeConfig: (patch: Partial<ThemeConfig>) => void;
  openWorkspaceChooser: () => void;
  navigateToId: (panelId: string) => void;
  setAddressBarVisible: (visible: boolean) => void;
  /** Live list of workspaces for the `workspace` argument's picker. */
  workspaceNames: () => string[];
  /**
   * Render the slots that currently hold a quickfire conversation as a picker
   * group. The owner holds the rows because activating one both moves focus and
   * reopens the overlay — neither of which a command can express as an outcome.
   */
  showQuickfireConversations: (rows: QuickfireSessionSummary[]) => void;
}

export type SlateRun = (
  args: Record<string, string>,
  deps: SlateDeps
) => Promise<CommandOutcome> | CommandOutcome;

export interface SlateCommand extends CommandSpec {
  run: SlateRun;
}

/**
 * One desktop implementation per command id. Keyed rather than inlined so a
 * definition that gains a mobile surface, or a mobile-only command, is a purely
 * additive change on either side.
 */
const DESKTOP_RUNS: Record<string, SlateRun> = {
  // ---- Panel ---------------------------------------------------------------
  "panel.new": async ({ source }) => {
    if (source) await panel.createPanel(source);
    else await panel.createAboutPanel("new");
    return { close: true };
  },
  "panel.close": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.archive(id);
    return { close: true };
  },
  "panel.focus": ({ panel: panelId }, deps) => {
    if (panelId) deps.navigateToId(panelId);
    return { close: true };
  },
  "panel.pin": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.togglePin(id);
    return { message: "Panel pinned" };
  },
  "panel.unpin": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.togglePin(id);
    return { message: "Panel unpinned" };
  },
  "panel.reload": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.reload(id);
    return { message: "Panel reloaded" };
  },
  "panel.duplicate": async () => {
    const id = await panel.getFocusedPanelId();
    if (!id) return {};
    const observation = await panel.observe(id);
    await panel.createPanel(observation.source, { isRoot: false, focus: true });
    return { close: true };
  },
  "panel.copy-link": async () => {
    const id = await panel.getFocusedPanelId();
    if (!id) return {};
    const observation = await panel.observe(id);
    // The raw source is not a link. Build the canonical share URL, which
    // survives being pasted somewhere outside this device.
    await navigator.clipboard.writeText(
      createPanelShareUrl({
        source: observation.source,
        ...(observation.contextId ? { contextId: observation.contextId } : {}),
      })
    );
    return { message: "Panel link copied" };
  },

  // ---- Navigate ------------------------------------------------------------
  "nav.back": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.navigateHistory(id, -1);
    return { close: true };
  },
  "nav.forward": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.navigateHistory(id, 1);
    return { close: true };
  },
  "nav.open-url": async ({ url }) => {
    const resolved = url ? browserUrlFromEntry(url) : null;
    if (!resolved) return { message: "That doesn't look like a web address." };
    await panel.createBrowser(resolved, { focus: true });
    return { close: true };
  },
  // Not a navigation: it re-enters the palette in the `@` scope, narrowed to
  // recent pages by the visible `history:` token (§1.2 sub-scope).
  "nav.history": () => ({ mode: "goto", query: `${HISTORY_SCOPE_TOKEN} ` }),
  "nav.address": (_args, deps) => {
    deps.setAddressBarVisible(true);
    return { close: true };
  },

  // ---- Quickfire -----------------------------------------------------------
  // The only quickfire command that does not touch the service: it switches the
  // overlay into `/` mode, where the compose shell takes over.
  "quickfire.ask": ({ prompt }) => ({
    mode: "quickfire",
    ...(prompt ? { query: prompt } : {}),
  }),
  // Clearing detaches the mapping and queues the channel for archival; a
  // promoted conversation is detached without archival because the chat panel
  // owns it now (§1.4). Both decisions live server-side.
  "quickfire.clear": async () => {
    const id = await panel.getFocusedPanelId();
    if (!id) return {};
    const result = await quickfire.clear(id);
    return {
      message: result.cleared
        ? "Panel conversation cleared"
        : "This panel has no conversation to clear",
    };
  },
  // Promotion is a view change, not a copy: the chat panel attaches to the same
  // durable channel, and ownership of its lifetime transfers with it.
  "quickfire.promote": async () => {
    const id = await panel.getFocusedPanelId();
    if (!id) return {};
    const promoted = await quickfire.promote(id);
    if (!promoted) return { message: "This panel has no conversation to open" };
    await panel.createChild(id, "panels/chat", {
      stateArgs: { channelName: promoted.channelId },
      focus: true,
    });
    return { close: true };
  },
  "quickfire.list": async (_args, deps) => {
    const rows = await quickfire.list();
    if (rows.length === 0) return { message: "No panel has a command agent conversation yet" };
    deps.showQuickfireConversations(rows);
    return {};
  },
  "agent.new-chat": async ({ prompt }) => {
    await panel.createPanel("panels/chat", {
      focus: true,
      ...(prompt ? { stateArgs: { initialPrompt: prompt } } : {}),
    });
    return { close: true };
  },

  // ---- Debug ---------------------------------------------------------------
  "debug.devtools": async () => {
    const id = await panel.getFocusedPanelId();
    if (id) await panel.openDevTools(id);
    return { close: true };
  },
  "debug.shell-devtools": async () => {
    await app.openDevTools();
    return { close: true };
  },

  // ---- Appearance & Layout -------------------------------------------------
  "view.theme": ({ mode }, deps) => {
    if (mode === "system" || mode === "light" || mode === "dark") deps.setThemeMode(mode);
    return { message: `Theme: ${mode}` };
  },
  "view.accent": ({ accent }, deps) => {
    // The engine already validated the value against these options; find it
    // again so the accent stays a real `ThemeAccentColor` rather than a cast.
    const accentColor = SLATE_ACCENTS.find((option) => option === accent);
    if (accentColor) deps.setThemeConfig({ accentColor });
    return { message: `Accent: ${accent}` };
  },

  // ---- Workspace -----------------------------------------------------------
  "workspace.switch": async ({ workspace: name }, deps) => {
    if (!name) {
      deps.openWorkspaceChooser();
      return { close: true };
    }
    await workspace.select(name);
    return { close: true };
  },
  "workspace.permissions": async () => {
    await panel.createAboutPanel("permissions");
    return { close: true };
  },
  "workspace.downloads": async () => {
    await panel.createAboutPanel("downloads");
    return { close: true };
  },
  "workspace.about": async () => {
    await panel.createAboutPanel("about");
    return { close: true };
  },

  // ---- Approvals & Safety --------------------------------------------------
  "authority.focus-approval": () => {
    window.dispatchEvent(new CustomEvent(FOCUS_APPROVAL_REQUEST_EVENT));
    return { close: true };
  },

  // ---- Application ---------------------------------------------------------
  "app.shortcuts": async () => {
    await panel.createAboutPanel("keyboard-shortcuts");
    return { close: true };
  },
  "app.reload-shell": () => {
    window.location.reload();
    return { close: true };
  },
  "app.check-updates": async () => {
    const pending = await app.listPendingUpdates();
    return {
      message: pending.length
        ? `${pending.length} update${pending.length === 1 ? "" : "s"} ready to apply`
        : "Everything is up to date",
    };
  },
};

/**
 * The slate. `deps` are the chrome-owned handles a command cannot reach through
 * the RPC client (theme atoms, the workspace chooser dialog, layout navigation).
 */
export function buildSlate(deps: SlateDeps): SlateCommand[] {
  return buildSlateDefinitions({ workspaceNames: deps.workspaceNames })
    .filter((spec) => spec.surfaces.includes("desktop"))
    .map((spec) => {
      const run = DESKTOP_RUNS[spec.id];
      // A definition the desktop advertises but cannot perform would be a dead
      // row; fail at build time instead of at the user's Enter.
      if (!run) throw new Error(`Desktop slate has no implementation for "${spec.id}"`);
      return { ...spec, run };
    });
}

/** Run a contributed panel command over the existing attributed event channel. */
export async function runContributedCommand(
  panelId: string,
  commandId: string
): Promise<CommandOutcome> {
  await hostCommands.run(panelId, commandId);
  return { close: true };
}

/** Report a failed command the same way the retired palette did. */
export function reportCommandFailure(error: unknown): void {
  void notification.show({
    type: "error",
    title: "Command failed",
    message: error instanceof Error ? error.message : String(error),
    ttl: 0,
  });
}
