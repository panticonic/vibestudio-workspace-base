// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@vibestudio/shared/workspaceConnection";

import { WorkspaceConnectionOverlay } from "./WorkspaceConnectionOverlay";

const overlay = vi.hoisted(() => ({ useShellOverlay: vi.fn() }));
vi.mock("../shell/useShellOverlay", () => ({
  useShellOverlay: overlay.useShellOverlay,
}));

describe("WorkspaceConnectionOverlay", () => {
  let listener: ((state: WorkspaceConnectionState) => void) | null;
  const state = (
    phase: WorkspaceConnectionState["phase"],
    extra: Partial<WorkspaceConnectionState> = {}
  ): WorkspaceConnectionState => ({
    version: 1,
    phase,
    mode: "remote",
    since: 1,
    ...extra,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    listener = null;
    overlay.useShellOverlay.mockReset();
    Object.assign(globalThis, {
      __vibestudioWorkspaceConnection: {
        getCurrent: vi.fn(async () => state("online")),
        onChange: vi.fn((next: (value: WorkspaceConnectionState) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        }),
      },
    });
  });

  afterEach(() => {
    delete (globalThis as { __vibestudioWorkspaceConnection?: unknown })
      .__vibestudioWorkspaceConnection;
    vi.useRealTimers();
  });

  it("delays a transient outage, then owns the shell overlay until recovery", async () => {
    const onOpenSettings = vi.fn();
    render(<WorkspaceConnectionOverlay onOpenSettings={onOpenSettings} />);
    await act(async () => Promise.resolve());

    act(() =>
      listener?.(state("reconnecting", { attempt: 3, nextRetryInMs: 1_500 }))
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => vi.advanceTimersByTime(349));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    expect(
      screen.getByRole("alertdialog", { name: "Workspace server unavailable" })
    ).toBeTruthy();
    expect(screen.getByText("Reconnect attempt 3 in 2s")).toBeTruthy();
    expect(overlay.useShellOverlay).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Connection settings" })
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();

    act(() => listener?.(state("online")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(overlay.useShellOverlay).toHaveBeenLastCalledWith(false);
  });

  it("shows a terminal session end immediately", async () => {
    render(<WorkspaceConnectionOverlay onOpenSettings={vi.fn()} />);
    await act(async () => Promise.resolve());
    act(() => listener?.(state("ended")));

    expect(
      screen.getByRole("alertdialog", { name: "Connection ended" })
    ).toBeTruthy();
  });
});
