// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shell/client", () => ({
  app: {
    getInfo: vi.fn(async () => ({
      connectionMode: "remote",
      connectionStatus: "connected",
    })),
  },
  incomingPairLink: { onLink: vi.fn(() => () => undefined) },
  remoteCred: {
    getCurrent: vi.fn(async () => ({
      connected: true,
      configured: true,
      isActive: true,
      deviceId: "device-1",
      workspaceName: "home",
    })),
    pair: vi.fn(),
    reconnectNow: vi.fn(),
    clear: vi.fn(),
    relaunch: vi.fn(),
  },
}));
vi.mock("../shell/useShellOverlay", () => ({ useShellOverlay: vi.fn() }));
vi.mock("../shell/useShellEvent", () => ({ useShellEvent: vi.fn() }));
vi.mock("./PairedDevicesSection", () => ({ PairedDevicesSection: () => null }));
vi.mock("./AppUpdatesSection", () => ({ AppUpdatesSection: () => null }));
vi.mock("./AccountProfileSection", () => ({
  AccountProfileSection: () => null,
}));

const { ConnectionSettingsDialog } = await import("./ConnectionSettingsDialog");

describe("ConnectionSettingsDialog", () => {
  it("keeps replacement pairing out of the active connection's happy path", async () => {
    render(
      <Theme>
        <ConnectionSettingsDialog open onOpenChange={vi.fn()} />
      </Theme>,
    );

    expect(
      await screen.findByText(/Currently connected to home/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Pairing link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /different server/i }));

    expect(screen.getByLabelText("Pairing link")).toBeTruthy();
    expect(
      screen.getByText(/replaces this device's saved connection/i),
    ).toBeTruthy();
  });
});
