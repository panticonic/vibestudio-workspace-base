import { BrowserPrivacyPresentationState } from "./browserPrivacyPresentation";

describe("BrowserPrivacyPresentationState", () => {
  it("delivers an open received before the trusted shell screen subscribes", async () => {
    const state = new BrowserPrivacyPresentationState();
    const listener = jest.fn();

    const presented = state.accept("inspect");
    state.subscribe(listener);

    expect(listener).toHaveBeenCalledWith("inspect");
    await expect(presented).resolves.toBeUndefined();
  });

  it("delivers later opens to the active trusted shell presentation", async () => {
    const state = new BrowserPrivacyPresentationState();
    const listener = jest.fn();
    const unsubscribe = state.subscribe(listener);

    const presented = state.accept("formFill");
    unsubscribe();
    const pending = state.accept("debug");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("formFill");
    await expect(presented).resolves.toBeUndefined();
    state.subscribe(jest.fn());
    await expect(pending).resolves.toBeUndefined();
  });

  it("acknowledges a second open while the manager is already visible", async () => {
    const state = new BrowserPrivacyPresentationState();
    const listener = jest.fn();
    state.subscribe(listener);

    await expect(state.accept("credentials")).resolves.toBeUndefined();
    await expect(state.accept("debug")).resolves.toBeUndefined();

    expect(listener).toHaveBeenNthCalledWith(1, "credentials");
    expect(listener).toHaveBeenNthCalledWith(2, "debug");
  });

  it("rejects the desktop-only export section instead of silently opening another view", async () => {
    const state = new BrowserPrivacyPresentationState();
    await expect(state.accept("export")).rejects.toThrow(
      "Protected browser-data export is available in the Vibestudio desktop app."
    );
  });
});
