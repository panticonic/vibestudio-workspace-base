import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadPinnedPanelIds, savePinnedPanelIds } from "./pinnedPanels";

// Override the global no-op AsyncStorage mock (jest.setup.ts) with the official
// in-memory mock so load/save actually round-trips.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("pinnedPanels store", () => {
  it("round-trips pinned ids across save/load", async () => {
    await savePinnedPanelIds("account-a", "ws1", [
      "panel:tree/a",
      "panel:tree/b",
    ]);
    const loaded = await loadPinnedPanelIds("account-a", "ws1");
    expect(loaded).toEqual(["panel:tree/a", "panel:tree/b"]);
  });

  it("scopes pins per workspace", async () => {
    await savePinnedPanelIds("account-a", "ws1", ["panel:tree/a"]);
    await savePinnedPanelIds("account-a", "ws2", ["panel:tree/z"]);
    expect(await loadPinnedPanelIds("account-a", "ws1")).toEqual([
      "panel:tree/a",
    ]);
    expect(await loadPinnedPanelIds("account-a", "ws2")).toEqual([
      "panel:tree/z",
    ]);
  });

  it("does not inherit another account's pins in a shared workspace", async () => {
    await savePinnedPanelIds("account-a", "shared", ["private-panel"]);
    expect(await loadPinnedPanelIds("account-b", "shared")).toEqual([]);
  });

  it("returns [] for an unknown workspace", async () => {
    expect(await loadPinnedPanelIds("account-a", "missing")).toEqual([]);
  });

  it("ignores malformed persisted data", async () => {
    await AsyncStorage.setItem(
      "vibestudio:account:account-a:workspace:wsX:pinned-panels",
      "{not json",
    );
    expect(await loadPinnedPanelIds("account-a", "wsX")).toEqual([]);
  });
});
