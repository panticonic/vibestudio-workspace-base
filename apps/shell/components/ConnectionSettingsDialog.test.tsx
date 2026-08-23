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
vi.mock("./PairedDevicesSection", () => ({
  PairedDevicesSection: () => <div>Device access settings</div>,
}));
vi.mock("./AppUpdatesSection", () => ({
  AppUpdatesSection: () => <div>Workspace app settings</div>,
}));
vi.mock("./AccountProfileSection", () => ({
  AccountProfileSection: () => <div>Account profile settings</div>,
}));
vi.mock("./ThemeSettings", () => ({
  ThemeSettingsControls: () => <div>Appearance settings</div>,
}));
vi.mock("./HostTargetsSection", () => ({
  HostTargetsSection: () => <div>Host app settings</div>,
}));
vi.mock("./TemplatesSection", () => ({
  TemplatesSection: () => <div>Template settings</div>,
}));

const { ConnectionSettingsDialog } = await import("./ConnectionSettingsDialog");

describe("ConnectionSettingsDialog", () => {
  it("keeps replacement pairing out of the active connection's happy path", async () => {
    render(
      <Theme>
        <ConnectionSettingsDialog
          section="connection"
          onSectionChange={vi.fn()}
        />
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

  it("renders every addressable settings view independently", async () => {
    const onSectionChange = vi.fn();
    const renderDialog = (
      section:
        | "connection"
        | "devices"
        | "profile"
        | "appearance"
        | "apps"
        | "hosts"
        | "templates",
    ) => (
      <Theme>
        <ConnectionSettingsDialog
          section={section}
          onSectionChange={onSectionChange}
        />
      </Theme>
    );
    const { rerender } = render(renderDialog("connection"));

    expect(
      await screen.findByText(/Currently connected to home/i),
    ).toBeTruthy();
    expect(screen.queryByText("Device access settings")).toBeNull();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Devices" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(onSectionChange).toHaveBeenCalledWith("devices");
    rerender(renderDialog("devices"));
    expect(screen.getByText("Device access settings")).toBeTruthy();
    expect(screen.queryByText(/Currently connected to home/i)).toBeNull();

    rerender(renderDialog("profile"));
    expect(screen.getByText("Account profile settings")).toBeTruthy();
    rerender(renderDialog("appearance"));
    expect(screen.getByText("Appearance settings")).toBeTruthy();
    rerender(renderDialog("apps"));
    expect(screen.getByText("Workspace app settings")).toBeTruthy();
    rerender(renderDialog("hosts"));
    expect(screen.getByText("Host app settings")).toBeTruthy();
    rerender(renderDialog("templates"));
    expect(screen.getByText("Template settings")).toBeTruthy();
  });
});
