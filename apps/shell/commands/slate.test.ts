import { describe, expect, it, vi } from "vitest";
import {
  buildSlate,
  reportCommandFailure,
  runContributedCommand,
  type SlateDeps,
} from "./slate";
import type { ShellWorkspaceClient } from "../shell/workspaceClient";

// Command implementations must be usable with an explicitly owned client,
// without initializing or borrowing the startup System transport.
vi.mock("../shell/client", () => {
  throw new Error("Command slate imported the startup client");
});

function owner() {
  const panel = {
    getFocusedPanelId: vi.fn(async () => "same-panel-id"),
    createAboutPanel: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
  };
  const quickfire = { clear: vi.fn(async () => ({ cleared: true })) };
  const hostCommands = { run: vi.fn(async () => {}) };
  const notification = { show: vi.fn(async () => {}) };
  const client = {
    panel,
    quickfire,
    hostCommands,
    notification,
  } as unknown as ShellWorkspaceClient;
  const deps = { client, workspaceNames: () => [] } as unknown as SlateDeps;
  const commands = buildSlate(deps);
  return {
    client,
    panel,
    quickfire,
    hostCommands,
    notification,
    run: (id: string) =>
      commands.find((command) => command.id === id)!.run({}, deps),
  };
}

describe("workspace-owned command slate", () => {
  it("creates panels and runs Quickfire against the invoking workspace", async () => {
    const personal = owner();
    const system = owner();
    await personal.run("panel.new");
    await personal.run("quickfire.clear");
    expect(personal.panel.createAboutPanel).toHaveBeenCalledWith("new");
    expect(personal.quickfire.clear).toHaveBeenCalledWith("same-panel-id");
    expect(system.panel.createAboutPanel).not.toHaveBeenCalled();
    expect(system.quickfire.clear).not.toHaveBeenCalled();
  });

  it("retains the invocation owner while a focused-panel read is pending", async () => {
    const personal = owner();
    const shared = owner();
    let resolve!: (id: string) => void;
    personal.panel.getFocusedPanelId.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = personal.run("panel.close");
    await shared.run("panel.close");
    resolve("personal-panel");
    await pending;
    expect(personal.panel.archive).toHaveBeenCalledExactlyOnceWith(
      "personal-panel",
    );
    expect(shared.panel.archive).toHaveBeenCalledExactlyOnceWith(
      "same-panel-id",
    );
  });

  it("keeps contributed commands and failure notifications with their owner", async () => {
    const personal = owner();
    const system = owner();
    await runContributedCommand(personal.client, "same-panel-id", "inspect");
    reportCommandFailure(personal.client, new Error("Unavailable"));
    expect(personal.hostCommands.run).toHaveBeenCalledWith(
      "same-panel-id",
      "inspect",
    );
    expect(personal.notification.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unavailable" }),
    );
    expect(system.hostCommands.run).not.toHaveBeenCalled();
    expect(system.notification.show).not.toHaveBeenCalled();
  });
});
