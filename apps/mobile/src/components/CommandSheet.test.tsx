import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { CommandSheet } from "./CommandSheet";
import { commandSheetAtom, quickfireSheetAtom } from "../state/commandSheetAtoms";
import type { MobileSlateDeps } from "../commands/slate";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return {
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    SafeAreaView: View,
  };
});

function slateDeps(overrides: Partial<MobileSlateDeps> = {}): MobileSlateDeps {
  return {
    activePanelId: "panel:tree/root/0",
    panels: {
      createAboutPanel: jest.fn(async () => ({ id: "about", title: "about" })),
      createRootPanel: jest.fn(async () => ({ id: "root", title: "root" })),
      createChildPanel: jest.fn(async () => ({ id: "child", title: "child" })),
      createBrowserUrlPanel: jest.fn(async () => ({ id: "browser", title: "browser" })),
      observe: jest.fn(async () => ({ source: "panels/sales", contextId: "ctx" })),
      getBrowserAddressOptions: jest.fn(async (query: string) => ({
        query,
        suggestions: [],
      })),
    },
    quickfire: {
      clear: jest.fn(async () => ({ cleared: true, archived: 1 })),
      promote: jest.fn(async () => ({ channelId: "channel" })),
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

function renderSheet(options?: {
  store?: ReturnType<typeof createStore>;
  deps?: MobileSlateDeps;
}) {
  const store = options?.store ?? createStore();
  const deps = options?.deps ?? slateDeps();
  const utils = render(
    <Provider store={store}>
      <CommandSheet
        slateDeps={deps}
        focusedPanel={{
          panelId: "panel:tree/root/0",
          title: "Sales",
          addressable: true,
          canGoBack: true,
        }}
        openPanels={[
          { id: "panel:tree/root/1", title: "Import wizard", source: "panels/import" },
        ]}
        contributedCommands={[]}
        runContributedCommand={jest.fn(() => true)}
      />
    </Provider>
  );
  return { ...utils, store, deps };
}

describe("CommandSheet", () => {
  it("renders nothing until something asks for it", () => {
    const { queryByTestId } = renderSheet();
    expect(queryByTestId("command-sheet")).toBeNull();
  });

  it("opens in the requested scope and lists matching commands", async () => {
    const store = createStore();
    const { queryByTestId, getByTestId } = renderSheet({ store });
    act(() => store.set(commandSheetAtom, { mode: "all" }));
    await waitFor(() => expect(queryByTestId("command-sheet")).not.toBeNull());
    fireEvent.changeText(getByTestId("command-sheet-input"), "reload");
    await waitFor(() => expect(queryByTestId("command-row-command:panel.reload")).not.toBeNull());
  });

  it("runs a command with no arguments and dismisses", async () => {
    const store = createStore();
    const deps = slateDeps();
    const { getByTestId } = renderSheet({ store, deps });
    act(() => store.set(commandSheetAtom, { mode: "commands" }));
    fireEvent.changeText(getByTestId("command-sheet-input"), ">close panel");
    await waitFor(() => getByTestId("command-row-command:panel.close"));
    fireEvent.press(getByTestId("command-row-command:panel.close"));
    expect(deps.performPanelCommand).toHaveBeenCalledWith("archive", "panel:tree/root/0");
  });

  it("prompts for an argument instead of executing, then runs with the chosen option", async () => {
    const store = createStore();
    const deps = slateDeps();
    const { getByTestId, queryByTestId } = renderSheet({ store, deps });
    act(() => store.set(commandSheetAtom, { mode: "commands" }));
    fireEvent.changeText(getByTestId("command-sheet-input"), ">theme");
    await waitFor(() => getByTestId("command-row-command:view.theme"));

    fireEvent.press(getByTestId("command-row-command:view.theme"));
    // The command did not run — it opened an argument session offering its enum.
    expect(deps.setThemePreference).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId("command-row-option:mode:dark")).not.toBeNull());

    fireEvent.press(getByTestId("command-row-option:mode:dark"));
    expect(deps.setThemePreference).toHaveBeenCalledWith("dark");
  });

  it("goes to an open panel from the go-to scope", async () => {
    const store = createStore();
    const deps = slateDeps();
    const { getByTestId } = renderSheet({ store, deps });
    act(() => store.set(commandSheetAtom, { mode: "goto" }));
    await waitFor(() => getByTestId("command-row-panel:panel:tree/root/1"));
    fireEvent.press(getByTestId("command-row-panel:panel:tree/root/1"));
    expect(deps.navigateToPanel).toHaveBeenCalledWith("panel:tree/root/1");
    await waitFor(() => expect(store.get(commandSheetAtom)).toBeNull());
  });

  it("hands the quickfire scope off to the quickfire sheet, bound to the active panel", async () => {
    const store = createStore();
    const { getByTestId } = renderSheet({ store });
    act(() => store.set(commandSheetAtom, { mode: "all" }));
    await waitFor(() => getByTestId("command-sheet-input"));
    fireEvent.changeText(getByTestId("command-sheet-input"), "/why is this slow");
    await waitFor(() =>
      expect(store.get(quickfireSheetAtom)).toEqual({
        slotId: "panel:tree/root/0",
        draft: "why is this slow",
      })
    );
    await waitFor(() => expect(store.get(commandSheetAtom)).toBeNull());
  });

  it("offers ranked recent pages in the go-to scope and opens the one tapped", async () => {
    const store = createStore();
    const deps = slateDeps({
      panels: {
        ...slateDeps().panels,
        getBrowserAddressOptions: jest.fn(async (query: string) => ({
          query,
          suggestions: [
            {
              url: "https://example.com/docs",
              title: "Example Docs",
              visitCount: 20,
              lastVisit: 200,
              source: "history" as const,
            },
            // Search engines are an address-bar affordance, not a destination.
            {
              url: "https://search.test/?q=%s",
              title: "Search Test",
              source: "search-engine" as const,
              searchTemplate: "https://search.test/?q=%s",
            },
          ],
        })),
      },
    });
    const { getByTestId, queryByTestId } = renderSheet({ store, deps });
    act(() => store.set(commandSheetAtom, { mode: "goto" }));
    fireEvent.changeText(getByTestId("command-sheet-input"), "@example");
    await waitFor(() =>
      expect(queryByTestId("command-row-history:https://example.com/docs")).not.toBeNull()
    );
    expect(queryByTestId("command-row-history:https://search.test/?q=%s")).toBeNull();

    fireEvent.press(getByTestId("command-row-history:https://example.com/docs"));
    expect(deps.panels.createBrowserUrlPanel).toHaveBeenCalledWith(
      null,
      "https://example.com/docs",
      { focus: true }
    );
  });

  it("re-scopes to recent pages when the history command runs, instead of navigating", async () => {
    const store = createStore();
    const deps = slateDeps();
    const { getByTestId } = renderSheet({ store, deps });
    act(() => store.set(commandSheetAtom, { mode: "commands" }));
    fireEvent.changeText(getByTestId("command-sheet-input"), ">history");
    await waitFor(() => getByTestId("command-row-command:nav.history"));
    fireEvent.press(getByTestId("command-row-command:nav.history"));
    // The sheet stays up, now narrowed to history by a visible token.
    await waitFor(() =>
      expect(getByTestId("command-sheet-input").props.value).toBe("@history: ")
    );
    expect(store.get(commandSheetAtom)).not.toBeNull();
  });

  it("never offers a command this surface cannot perform", async () => {
    const store = createStore();
    const { getByTestId, queryByTestId } = renderSheet({ store });
    act(() => store.set(commandSheetAtom, { mode: "commands" }));
    fireEvent.changeText(getByTestId("command-sheet-input"), ">devtools");
    await waitFor(() => getByTestId("command-sheet-input"));
    expect(queryByTestId("command-row-command:debug.devtools")).toBeNull();
    expect(queryByTestId("command-row-command:debug.shell-devtools")).toBeNull();
  });
});
