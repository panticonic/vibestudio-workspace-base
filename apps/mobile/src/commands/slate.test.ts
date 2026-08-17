import { commandAvailability, reduceArgSession, startArgSession } from "@workspace/omnibox-core";
import type { ArgSession, SurfaceContext } from "@workspace/omnibox-core";
import { buildMobileSlate, type MobileSlateDeps } from "./slate";

function deps(overrides: Partial<MobileSlateDeps> = {}): MobileSlateDeps {
  return {
    activePanelId: "panel:tree/root/0",
    panels: {
      createAboutPanel: jest.fn(async (page: string) => ({ id: `about-${page}`, title: page })),
      createRootPanel: jest.fn(async () => ({ id: "root-1", title: "root" })),
      createChildPanel: jest.fn(async () => ({ id: "child-1", title: "child" })),
      createBrowserUrlPanel: jest.fn(async () => ({ id: "browser-1", title: "browser" })),
      observe: jest.fn(async () => ({ source: "panels/sales", contextId: "ctx-1" })),
      getBrowserAddressOptions: jest.fn(async (query: string) => ({
        query,
        suggestions: [],
      })),
    },
    quickfire: {
      clear: jest.fn(async () => ({ cleared: true })),
      promote: jest.fn(async () => ({ channelId: "channel-1" })),
      list: jest.fn(async () => []),
    },
    performPanelCommand: jest.fn(),
    navigateToPanel: jest.fn(),
    setThemePreference: jest.fn(),
    copyText: jest.fn(),
    openChatPanelForChannel: jest.fn(async () => {}),
    openWorkspaceSettings: jest.fn(),
    showQuickfireConversations: jest.fn(),
    ...overrides,
  };
}

const mobileContext: SurfaceContext = {
  platform: "mobile",
  openPanels: {
    entries: [
      { id: "panel:tree/root/1", title: "Import wizard", source: "panels/import" },
      { id: "panel:tree/root/2", title: "Sales dashboard", source: "panels/sales" },
    ],
  },
  focusedPanel: { panelId: "panel:tree/root/0", title: "Sales", addressable: true },
};

describe("mobile slate", () => {
  it("offers exactly the shared definitions flagged for this surface", () => {
    const slate = buildMobileSlate();
    for (const command of slate) expect(command.surfaces).toContain("mobile");
    const ids = slate.map((command) => command.id);
    expect(ids).toContain("panel.reload");
    expect(ids).toContain("quickfire.promote");
    // Desktop-only commands never reach the phone, so a mobile row can never be
    // one the app has no way to perform.
    expect(ids).not.toContain("debug.shell-devtools");
    expect(ids).not.toContain("nav.address");
    expect(ids).not.toContain("view.accent");
  });

  it("gives every offered command an implementation", () => {
    for (const command of buildMobileSlate()) {
      expect(typeof command.run).toBe("function");
    }
  });

  it("routes panel actions through the app's existing native command switch", async () => {
    const slate = buildMobileSlate();
    const slateDeps = deps();
    await slate.find((command) => command.id === "panel.reload")!.run({}, slateDeps);
    expect(slateDeps.performPanelCommand).toHaveBeenCalledWith("reload-panel", "panel:tree/root/0");

    await slate.find((command) => command.id === "panel.close")!.run({}, slateDeps);
    expect(slateDeps.performPanelCommand).toHaveBeenCalledWith("archive", "panel:tree/root/0");
  });

  it("round-trips a prompted enum argument into the run", async () => {
    const theme = buildMobileSlate().find((command) => command.id === "view.theme")!;
    const opened = startArgSession(theme, { restoreQuery: ">theme" });
    expect(opened.kind).toBe("session");
    const session = (opened as { session: ArgSession }).session;

    // A value the enum does not offer never reaches the run.
    const rejected = reduceArgSession(session, { type: "enter", value: "chartreuse" });
    expect(rejected.kind).toBe("session");
    expect((rejected as { session: ArgSession }).session.error).toMatch(/must be one of/u);

    const accepted = reduceArgSession(session, { type: "enter", value: "dark" });
    expect(accepted.kind).toBe("execute");
    const args = (accepted as { args: Record<string, string> }).args;
    const slateDeps = deps();
    const outcome = await theme.run(args, slateDeps);
    expect(slateDeps.setThemePreference).toHaveBeenCalledWith("dark");
    expect(outcome.message).toBe("Theme: dark");
  });

  it("round-trips an inline URL argument and opens a browser panel", async () => {
    const openUrl = buildMobileSlate().find((command) => command.id === "nav.open-url")!;
    const opened = startArgSession(openUrl, { prefilled: { url: "example.com" } });
    expect(opened.kind).toBe("execute");
    const slateDeps = deps();
    const outcome = await openUrl.run(
      (opened as { args: Record<string, string> }).args,
      slateDeps
    );
    expect(slateDeps.panels.createBrowserUrlPanel).toHaveBeenCalledWith(
      null,
      "https://example.com/",
      { focus: true }
    );
    expect(outcome.close).toBe(true);
  });

  it("suggests open panels for the panel argument and navigates to the choice", async () => {
    const focus = buildMobileSlate().find((command) => command.id === "panel.focus")!;
    const suggestions = focus.args?.[0]?.suggest?.("import", mobileContext);
    expect(suggestions).toEqual([
      { value: "panel:tree/root/1", label: "Import wizard", meta: "panels/import" },
    ]);
    const slateDeps = deps();
    await focus.run({ panel: "panel:tree/root/1" }, slateDeps);
    expect(slateDeps.navigateToPanel).toHaveBeenCalledWith("panel:tree/root/1");
  });

  it("hands quickfire.ask off to the quickfire sheet rather than running inline", async () => {
    const ask = buildMobileSlate().find((command) => command.id === "quickfire.ask")!;
    expect(await ask.run({ prompt: "why is this slow" }, deps())).toEqual({
      close: true,
      quickfire: { prompt: "why is this slow" },
    });
  });

  it("promotes into a chat panel attached to the same channel", async () => {
    const promote = buildMobileSlate().find((command) => command.id === "quickfire.promote")!;
    const slateDeps = deps();
    await promote.run({}, slateDeps);
    expect(slateDeps.quickfire.promote).toHaveBeenCalledWith("panel:tree/root/0");
    expect(slateDeps.openChatPanelForChannel).toHaveBeenCalledWith("channel-1");
    expect(slateDeps.panels.createChildPanel).not.toHaveBeenCalled();
  });

  it("says so when a panel has no conversation to promote", async () => {
    const promote = buildMobileSlate().find((command) => command.id === "quickfire.promote")!;
    const slateDeps = deps({
      quickfire: {
        clear: jest.fn(async () => ({ cleared: false })),
        promote: jest.fn(async () => null),
        list: jest.fn(async () => []),
      },
    });
    const outcome = await promote.run({}, slateDeps);
    expect(outcome.message).toBe("This panel has no conversation to open");
    expect(slateDeps.panels.createChildPanel).not.toHaveBeenCalled();
  });

  it("copies the canonical share link, not the raw source", async () => {
    const copy = buildMobileSlate().find((command) => command.id === "panel.copy-link")!;
    const slateDeps = deps();
    await copy.run({}, slateDeps);
    const copied = (slateDeps.copyText as jest.Mock).mock.calls[0]![0] as string;
    expect(copied).toContain("vibestudio.app/panel");
    expect(copied).toContain(encodeURIComponent("panels/sales"));
    expect(copied).toContain("ctx-1");
  });

  it("takes workspace switching to Settings instead of performing it inline", async () => {
    const command = buildMobileSlate().find((entry) => entry.id === "workspace.switch")!;
    const slateDeps = deps();
    const outcome = await command.run({ workspace: "beta" }, slateDeps);
    expect(slateDeps.openWorkspaceSettings).toHaveBeenCalled();
    expect(outcome.close).toBe(true);
  });

  it("hides panel-scoped commands when nothing is focused", () => {
    const slate = buildMobileSlate();
    const noPanel: SurfaceContext = { platform: "mobile", openPanels: { entries: [] } };
    const reload = slate.find((command) => command.id === "panel.reload")!;
    expect(commandAvailability(reload, noPanel)).toBe("hidden");
    expect(commandAvailability(reload, mobileContext)).toBe(true);
  });
});
