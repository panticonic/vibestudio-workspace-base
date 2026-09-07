import { describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@vibestudio/shared/workspaceConnection";
import { createNativeConnectionState } from "./nativeConnectionState";

const state = (
  phase: WorkspaceConnectionState["phase"],
): WorkspaceConnectionState => ({
  version: 1,
  phase,
  mode: "remote",
  since: 1,
});

describe("native connection availability", () => {
  it("awaits the initial host fact without treating startup as an outage", async () => {
    let initial!: (value: WorkspaceConnectionState) => void;
    const connection = createNativeConnectionState({
      getCurrent: () =>
        new Promise((resolve) => {
          initial = resolve;
        }),
      onChange: () => () => {},
    });
    const ready = connection.ready();
    initial(state("online"));
    await expect(ready).resolves.toBeUndefined();
    connection.close();
  });
  it("keeps a newer outage when the initial snapshot arrives late", async () => {
    let initial!: (value: WorkspaceConnectionState) => void;
    let changed!: (value: WorkspaceConnectionState) => void;
    const stop = vi.fn();
    const connection = createNativeConnectionState({
      getCurrent: () =>
        new Promise((resolve) => {
          initial = resolve;
        }),
      onChange: (listener) => {
        changed = listener;
        return stop;
      },
    });
    const observed = vi.fn();
    connection.onStatusChange(observed);
    changed(state("reconnecting"));
    initial(state("online"));
    await Promise.resolve();
    expect(connection.status()).toBe("connecting");
    await expect(connection.ready()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    changed(state("online"));
    expect(observed).toHaveBeenCalledExactlyOnceWith("connected");
    await connection.ready();
    connection.close();
    expect(stop).toHaveBeenCalledOnce();
    changed(state("online"));
    expect(connection.status()).toBe("disconnected");
  });
});
