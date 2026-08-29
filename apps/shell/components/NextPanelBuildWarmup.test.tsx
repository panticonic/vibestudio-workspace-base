// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextPanelBuildWarmup } from "./NextPanelBuildWarmup";

const mocks = vi.hoisted(() => ({
  warmPanel: vi.fn(),
  getFocusedPanelId: vi.fn(),
  getLocalPresentation: vi.fn(),
  directListener: null as ((value: unknown) => void) | null,
  connectionListener: null as ((value: { status: string }) => void) | null,
}));

vi.mock("../shell/client", () => ({
  buildUnits: { warmPanel: mocks.warmPanel },
  panel: {
    getFocusedPanelId: mocks.getFocusedPanelId,
    getLocalPresentation: mocks.getLocalPresentation,
  },
}));
vi.mock("../shell/hooks/PanelTreeContext", () => ({
  usePanelTree: () => ({ initialized: true }),
}));
vi.mock("../shell/useDirectShellEvent", () => ({
  useDirectShellEvent: (_event: string, listener: (value: unknown) => void) => {
    mocks.directListener = listener;
  },
}));
vi.mock("../shell/useShellEvent", () => ({
  useShellEvent: (_event: string, listener: (value: { status: string }) => void) => {
    mocks.connectionListener = listener;
  },
}));

describe("NextPanelBuildWarmup", () => {
  let idleCallback: (() => void) | null;
  let cancelIdleCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    idleCallback = null;
    cancelIdleCallback = vi.fn();
    mocks.warmPanel.mockReset().mockResolvedValue(undefined);
    mocks.getFocusedPanelId.mockReset().mockResolvedValue("panel:initial");
    mocks.getLocalPresentation.mockReset().mockResolvedValue({
      revision: 1,
      presentation: { state: "loading", slotId: "panel:initial" },
    });
    mocks.directListener = null;
    mocks.connectionListener = null;
    Object.assign(window, {
      requestIdleCallback: vi.fn((callback: () => void) => {
        idleCallback = callback;
        return 41;
      }),
      cancelIdleCallback,
    });
  });

  it("does not warm during first-panel load and starts only at post-ready idle", async () => {
    render(<NextPanelBuildWarmup />);
    await waitFor(() => expect(mocks.getLocalPresentation).toHaveBeenCalled());
    expect(mocks.warmPanel).not.toHaveBeenCalled();
    expect(window.requestIdleCallback).not.toHaveBeenCalled();

    act(() => {
      mocks.directListener?.({
        revision: 2,
        presentation: { state: "ready", slotId: "panel:initial" },
      });
    });
    expect(window.requestIdleCallback).toHaveBeenCalledOnce();
    expect(mocks.warmPanel).not.toHaveBeenCalled();

    await act(async () => idleCallback?.());
    expect(mocks.warmPanel).toHaveBeenCalledOnce();
    expect(mocks.warmPanel).toHaveBeenCalledWith("about/new");
  });

  it("cancels pending speculative work when the server leaves connected", async () => {
    mocks.getLocalPresentation.mockResolvedValue({
      revision: 2,
      presentation: { state: "ready", slotId: "panel:initial" },
    });
    render(<NextPanelBuildWarmup />);
    await waitFor(() => expect(window.requestIdleCallback).toHaveBeenCalledOnce());

    act(() => mocks.connectionListener?.({ status: "connecting" }));
    expect(cancelIdleCallback).toHaveBeenCalledWith(41);
    expect(mocks.warmPanel).not.toHaveBeenCalled();
  });
});
