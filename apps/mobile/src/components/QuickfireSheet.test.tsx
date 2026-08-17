import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { QuickfireSheet } from "./QuickfireSheet";
import { quickfireSheetAtom } from "../state/commandSheetAtoms";
import type { QuickfireSessionFacts, QuickfireTransport } from "@workspace/quickfire-core/session";

jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return {
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    SafeAreaView: View
  };
});

const fresh: QuickfireSessionFacts = {
  channelId: "channel-1",
  contextId: "ctx-1",
  state: "fresh",
  messageCount: null,
  lastActivityAt: null
};

function channelClient() {
  return {
    clientId: "user:me",
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => {})
      })
    }),
    ready: () => Promise.resolve(),
    close: jest.fn(async () => undefined),
    send: jest.fn(async () => undefined),
    callMethod: jest.fn(() => ({ result: Promise.resolve() }))
  };
}

function transportFor(
  session: QuickfireSessionFacts = fresh,
  overrides: Partial<QuickfireTransport> = {}
) {
  const client = channelClient();
  const transport = {
    sessionFor: jest.fn(async () => session),
    clear: jest.fn(async () => ({ cleared: true, archived: 1 })),
    promote: jest.fn(async () => ({ ...session, state: "promoted" as const })),
    connectToChannel: jest.fn(() => client as never),
    ...overrides
  } as unknown as QuickfireTransport;
  return { transport, client };
}

function renderSheet(transport: QuickfireTransport, openChatPanel = jest.fn(async () => {})) {
  const store = createStore();
  const utils = render(
    <Provider store={store}>
      <QuickfireSheet
        transport={transport}
        panelTitle="Sales dashboard"
        openChatPanel={openChatPanel}
      />
    </Provider>
  );
  return { ...utils, store, openChatPanel };
}

describe("QuickfireSheet", () => {
  it("binds no conversation until it is opened over a slot", () => {
    const { transport } = transportFor();
    const { queryByTestId } = renderSheet(transport);
    expect(queryByTestId("quickfire-sheet")).toBeNull();
    expect(transport.sessionFor).not.toHaveBeenCalled();
  });

  it("opening over a slot is the gesture that binds the conversation", async () => {
    const { transport } = transportFor();
    const { store, queryByTestId } = renderSheet(transport);
    act(() => store.set(quickfireSheetAtom, { slotId: "panel:tree/root/0" }));
    await waitFor(() =>
      expect(transport.sessionFor).toHaveBeenCalledWith("panel:tree/root/0", {
        fresh: false
      })
    );
    expect(queryByTestId("quickfire-sheet")).not.toBeNull();
  });

  it("sends a draft handed over from the command sheet", async () => {
    const { transport, client } = transportFor();
    const { store, getByTestId } = renderSheet(transport);
    act(() =>
      store.set(quickfireSheetAtom, {
        slotId: "slot",
        draft: "why is the chart cut off?"
      })
    );
    await waitFor(() => getByTestId("quickfire-compose"));
    expect(getByTestId("quickfire-compose").props.value).toBe("why is the chart cut off?");
    await act(async () => {
      fireEvent(getByTestId("quickfire-compose"), "submitEditing");
    });
    await waitFor(() =>
      expect(client.send).toHaveBeenCalledWith("why is the chart cut off?", {
        mentions: ["quickfire"]
      })
    );
  });

  it("shows live agent activity as soon as a message is sent", async () => {
    const { transport } = transportFor();
    const { store, getByTestId, findByText } = renderSheet(transport);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    const compose = await waitFor(() => getByTestId("quickfire-compose"));

    fireEvent.changeText(compose, "what is the channel id?");
    await act(async () => {
      fireEvent(compose, "submitEditing");
    });

    expect(await findByText("Starting…")).toBeTruthy();
  });

  it("clears and binds a fresh conversation on the first press", async () => {
    const { transport } = transportFor();
    const { store, getByLabelText } = renderSheet(transport);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    await waitFor(() => getByLabelText("Clear conversation"));

    await act(async () => {
      fireEvent.press(getByLabelText("Clear conversation"));
    });
    expect(transport.clear).toHaveBeenCalledWith("slot");
    expect(transport.sessionFor).toHaveBeenLastCalledWith("slot", { fresh: true });
  });

  it("shows the resume chip for a conversation that already existed", async () => {
    const { transport } = transportFor({
      ...fresh,
      state: "resumed",
      messageCount: 3,
      lastActivityAt: Date.now() - 2 * 60 * 60 * 1000
    });
    const { store, findByTestId } = renderSheet(transport);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    const chip = await findByTestId("quickfire-resume-chip");
    expect(chip).toBeTruthy();
  });

  it("offers the promoted branch instead of a compose row, and no channel is joined", async () => {
    const { transport } = transportFor({ ...fresh, state: "promoted" });
    const openChatPanel = jest.fn(async () => {});
    const { store, queryByTestId, getByLabelText } = renderSheet(transport, openChatPanel);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    await waitFor(() => getByLabelText("Continued in chat panel"));
    expect(queryByTestId("quickfire-compose")).toBeNull();
    expect(transport.connectToChannel).not.toHaveBeenCalled();
    getByLabelText("Start a new conversation here");
    await act(async () => {
      fireEvent.press(getByLabelText("Continued in chat panel"));
    });
    expect(openChatPanel).toHaveBeenCalledWith("channel-1");
  });

  it("promotion opens the chat panel on the same channel", async () => {
    const { transport } = transportFor();
    const openChatPanel = jest.fn(async () => {});
    const { store, getByLabelText } = renderSheet(transport, openChatPanel);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    await waitFor(() => getByLabelText("Open conversation as chat panel"));
    await act(async () => {
      fireEvent.press(getByLabelText("Open conversation as chat panel"));
    });
    expect(transport.promote).toHaveBeenCalledWith("slot");
    await waitFor(() => expect(openChatPanel).toHaveBeenCalledWith("channel-1"));
  });

  it("dismissing is a view change: it leaves the channel but never clears", async () => {
    const { transport, client } = transportFor();
    const { store, getByTestId } = renderSheet(transport);
    act(() => store.set(quickfireSheetAtom, { slotId: "slot" }));
    await waitFor(() => getByTestId("quickfire-sheet"));
    await act(async () => {
      fireEvent.press(getByTestId("quickfire-backdrop"));
    });
    await waitFor(() => expect(store.get(quickfireSheetAtom)).toBeNull());
    expect(client.close).toHaveBeenCalled();
    expect(transport.clear).not.toHaveBeenCalled();
  });
});
