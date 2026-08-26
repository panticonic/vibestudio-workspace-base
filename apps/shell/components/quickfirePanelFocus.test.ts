import { describe, expect, it, vi } from "vitest";

import { acquireFocusedPanelIdAfterRestore } from "./quickfirePanelFocus";

describe("quickfire panel focus coordination", () => {
  it("does not read panel context until an in-flight focus restoration settles", async () => {
    let finishRestore!: () => void;
    const pendingRestore = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const restore = { current: pendingRestore as Promise<void> | null };
    const getFocusedPanelId = vi.fn(async () => "panel-1");

    const acquisition = acquireFocusedPanelIdAfterRestore(
      restore,
      getFocusedPanelId,
    );
    await Promise.resolve();
    expect(getFocusedPanelId).not.toHaveBeenCalled();

    finishRestore();
    await expect(acquisition).resolves.toBe("panel-1");
    expect(getFocusedPanelId).toHaveBeenCalledOnce();
    expect(restore.current).toBeNull();
  });
});
