import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, describe, expect, it, vi } from "vitest";
import SetupHub from "./SetupHub";
import type { SetupCapabilitySnapshot } from "./snapshot";
import "@radix-ui/themes/styles.css";
import "@workspace/agentic-chat/styles.css";

afterEach(cleanup);

const observedAt = new Date().toISOString();
const snapshots: SetupCapabilitySnapshot[] = [
  {
    id: "connection.google-workspace",
    state: "not-configured",
    summary: "Google OAuth needs setup before an account can connect.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "setup",
    observedAt,
  },
  {
    id: "connection.github",
    state: "not-configured",
    summary: "No GitHub account is connected.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "setup",
    observedAt,
  },
  {
    id: "connection.device",
    state: "connected",
    summary: "This device is paired.",
    scope: "device",
    tier: "host-topology",
    attention: "none",
    nextAction: "change",
    observedAt,
  },
];

function NarrowInlineUi({ children }: { children: React.ReactNode }) {
  return (
    <Theme>
      <div className="agentic-chat-root" style={{ width: 320 }}>
        <div className="message-row message-row-agent message-row-inline-ui">
          <div className="inline-ui-frame">
            <div className="inline-ui-content" data-testid="inline-ui-content">
              {children}
            </div>
          </div>
        </div>
      </div>
    </Theme>
  );
}

describe("SetupHub responsiveness", () => {
  it("keeps the onboarding overview inside a phone-width inline card", () => {
    render(
      <NarrowInlineUi>
        <SetupHub
          scope={{
            onboardingSetupOverview: { catalog: [], snapshot: snapshots },
          }}
          chat={{ send: vi.fn() }}
        />
      </NarrowInlineUi>,
    );

    const content = screen.getByTestId("inline-ui-content");
    const bounds = content.getBoundingClientRect();
    const overflowers = [content, ...content.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => ({
        className: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));

    expect(overflowers).toEqual([]);
    for (const button of content.querySelectorAll("button")) {
      const buttonBounds = button.getBoundingClientRect();
      expect(buttonBounds.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(buttonBounds.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  });
});
