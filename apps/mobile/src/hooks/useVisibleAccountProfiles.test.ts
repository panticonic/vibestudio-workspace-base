import { startVisibleAccountProfileRefresh } from "./useVisibleAccountProfiles";

describe("startVisibleAccountProfileRefresh", () => {
  it("refreshes immediately and periodically until the visible lifecycle ends", async () => {
    const resolveAccountProfiles = jest.fn(async () => ({
      alice: { userId: "alice", handle: "alice", displayName: "Alice" },
    }));
    const apply = jest.fn<void, [Map<string, { displayName?: string }>]>();
    // Assigned from inside the scheduler callback, which control-flow
    // analysis cannot see, so the annotation has to carry the call signature.
    const captured: { tick: (() => void) | null } = { tick: null };
    const scheduler = {
      setInterval: jest.fn((callback: () => void, _delayMs: number) => {
        captured.tick = callback;
        return 7 as unknown as ReturnType<typeof setInterval>;
      }),
      clearInterval: jest.fn(),
    };

    const stop = startVisibleAccountProfileRefresh(
      { resolveAccountProfiles },
      ["alice"],
      apply,
      scheduler
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveAccountProfiles).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0].get("alice")?.displayName).toBe("Alice");
    expect(scheduler.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);

    captured.tick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveAccountProfiles).toHaveBeenCalledTimes(2);

    stop();
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("does not apply a refresh that finishes after the drawer closes", async () => {
    // Assigned inside the promise executor, which control-flow analysis cannot
    // see, so the capture has to survive narrowing.
    const captured: { finish: ((profiles: Record<string, never>) => void) | null } = {
      finish: null,
    };
    const resolveAccountProfiles = jest.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          captured.finish = resolve;
        })
    );
    const apply = jest.fn<void, [Map<string, { displayName?: string }>]>();
    const scheduler = {
      setInterval: jest.fn(() => 7 as unknown as ReturnType<typeof setInterval>),
      clearInterval: jest.fn(),
    };

    const stop = startVisibleAccountProfileRefresh(
      { resolveAccountProfiles },
      [],
      apply,
      scheduler
    );
    stop();
    captured.finish?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
  });
});
