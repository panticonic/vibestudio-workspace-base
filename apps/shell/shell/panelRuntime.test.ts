import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPanelRuntime: vi.fn(() => ({ kind: "panel-runtime" })),
}));

vi.mock("@workspace/runtime/panel-runtime", () => ({
  createPanelRuntime: mocks.createPanelRuntime,
}));

import { createShellPanelRuntime } from "./panelRuntime.js";

describe("createShellPanelRuntime", () => {
  it("binds panel-handle focus to the native shell focus adapter", () => {
    const rpc = { call: vi.fn() };
    const focusPanel = vi.fn();

    const runtime = createShellPanelRuntime({ rpc, focusPanel } as never);

    expect(runtime).toEqual({ kind: "panel-runtime" });
    expect(mocks.createPanelRuntime).toHaveBeenCalledWith({ rpc, focusPanel });
  });
});
