// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AboutPanelRoot from "./index";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  onFocus: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  panel: { onFocus: mocks.onFocus },
  rpc: { call: mocks.call },
}));

// The real AboutThemeRoot renders a Radix `Theme`, which is what supplies the
// tooltip/portal providers this screen relies on. The mock keeps that and drops
// only the panel-runtime theme plumbing.
vi.mock("../../packages/about-shared/ui", () => ({
  AboutThemeRoot: ({ children }: { children: ReactNode }) => <Theme>{children}</Theme>,
  AboutPage: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <main>
      {actions}
      {children}
    </main>
  ),
  Section: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

let focus: () => void;
let blockRefresh = false;

/**
 * Radix tabs activate on pointer-down, not on a bare synthetic click, so drive
 * them the way a pointer does.
 */
async function selectTab(name: RegExp): Promise<void> {
  const tab = screen.getByRole("tab", { name });
  await act(async () => {
    fireEvent.mouseDown(tab);
  });
}

const HOUR = 60 * 60 * 1000;

function pendingRequest(overrides: Record<string, unknown> = {}) {
  return {
    acquisitionId: "acq-1",
    capability: "external.open",
    action: "Open a website",
    resource: "https://example.com",
    domain: "web",
    verb: "act",
    tier: "critical",
    requestedAt: Date.now() - HOUR,
    requesterLabel: "Assistant",
    agentBindingId: "do:workers/agent-worker:assistant@ctx",
    ...overrides,
  };
}

function savedGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant-1",
    kind: "capability",
    callerLabel: "about/news",
    scopeLabel: "Remembered for this version",
    capability: "Open a website",
    resource: "example.com",
    repoPath: "about/news",
    grantedAt: Date.now() - 3 * HOUR,
    why: "You chose lasting access after this panel requested the action.",
    origin: "Added with News",
    approvedBy: "You",
    duration: "Until this exact installed version changes or you revoke it",
    revokeEffect: "The next matching action asks again.",
    ...overrides,
  };
}

type Responses = {
  grants?: unknown[];
  profiles?: unknown[];
  units?: unknown[];
  governance?: unknown[];
  pending?: unknown[];
  safety?: Record<string, unknown>;
};

function stubResponses(responses: Responses = {}) {
  mocks.call.mockReset().mockImplementation((target: string, method: string) => {
    if (blockRefresh && target === "main") return new Promise(() => {});
    switch (method) {
      case "permissions.list":
        return Promise.resolve(responses.grants ?? []);
      case "permissions.listAgentProfiles":
        return Promise.resolve(responses.profiles ?? []);
      case "permissions.listPendingRequests":
        return Promise.resolve(responses.pending ?? []);
      case "build.listUnits":
        return Promise.resolve(responses.units ?? []);
      case "governance.list":
        return Promise.resolve(responses.governance ?? []);
      case "permissions.safetyStatus":
        return Promise.resolve(
          responses.safety ?? {
            workspaceLocked: false,
            activeAgentCount: 0,
            pendingAcquisitionCount: 0,
          }
        );
      default:
        return Promise.resolve([]);
    }
  });
}

describe("Permissions", () => {
  beforeEach(() => {
    blockRefresh = false;
    mocks.onFocus.mockReset().mockImplementation((callback: () => void) => {
      focus = callback;
      return () => {};
    });
    stubResponses();
  });

  it("publishes an empty primary snapshot without waiting for a focus refresh", async () => {
    render(<AboutPanelRoot />);

    expect(screen.getByLabelText("Loading permissions")).toBeTruthy();
    expect(await screen.findByLabelText("Permission view")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Loading permissions")).toBeNull());

    blockRefresh = true;
    act(() => focus());

    expect(screen.queryByLabelText("Loading permissions")).toBeNull();
    expect(screen.getByLabelText("Permission view")).toBeTruthy();
  });

  it("names who locked agent authority and when, not just that it is locked", async () => {
    stubResponses({
      safety: {
        workspaceLocked: true,
        activeAgentCount: 2,
        pendingAcquisitionCount: 1,
        lockedAt: Date.now() - 2 * HOUR,
        lockedBy: "You",
      },
    });
    render(<AboutPanelRoot />);

    expect(await screen.findByText("Agent authority is locked")).toBeTruthy();
    expect(screen.getByText("Locked by You")).toBeTruthy();
    expect(screen.getByText("2 hours ago")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unlock agent authority/ })).toBeTruthy();
  });

  it("shows what the waiting count counts", async () => {
    stubResponses({
      pending: [pendingRequest()],
      safety: {
        workspaceLocked: false,
        activeAgentCount: 1,
        pendingAcquisitionCount: 1,
      },
    });
    render(<AboutPanelRoot />);

    expect(await screen.findByText("Open a website")).toBeTruthy();
    expect(screen.getByText("https://example.com")).toBeTruthy();
    expect(screen.getByText("Assistant")).toBeTruthy();
    // A critical request is one that keeps asking, and the row says so.
    expect(screen.getByText("Asks every time")).toBeTruthy();
  });

  it("reports an all-clear rather than an empty list when nothing needs attention", async () => {
    render(<AboutPanelRoot />);

    expect(await screen.findByText("All clear")).toBeTruthy();
  });

  it("keeps a grant's reasoning behind a disclosure and its decision on the row", async () => {
    stubResponses({ grants: [savedGrant()] });
    const { container } = render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");

    // Radix Tabs only mounts the selected panel, so drive the tab as a user would.
    await selectTab(/Saved/);

    const row = await screen.findByText("Open a website");
    expect(row).toBeTruthy();
    expect(screen.queryByText(/You chose lasting access/)).toBeNull();

    const disclosure = [...container.querySelectorAll("button[aria-expanded]")].find((button) =>
      button.textContent?.includes("Open a website")
    ) as HTMLButtonElement | undefined;
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(disclosure as HTMLButtonElement);
    });

    expect(screen.getByText(/You chose lasting access/)).toBeTruthy();
    // §7.7: the origin line is what distinguishes an install-time choice from
    // one the person answered a prompt for.
    expect(screen.getByText("Added with News")).toBeTruthy();
  });

  it("groups saved permissions by who holds them", async () => {
    stubResponses({
      grants: [
        savedGrant(),
        savedGrant({ id: "grant-2", capability: "Send a message" }),
        savedGrant({ id: "grant-3", callerLabel: "about/mail", capability: "Read your files" }),
      ],
    });
    render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");
    await selectTab(/Saved/);

    const heading = await screen.findByText("about/news");
    expect(heading).toBeTruthy();
    expect(screen.getByText("2 lasting permissions")).toBeTruthy();
    expect(screen.getByText("1 lasting permission")).toBeTruthy();
  });

  it("filters across a tab's rows", async () => {
    stubResponses({
      grants: [
        savedGrant(),
        savedGrant({ id: "grant-3", callerLabel: "about/mail", capability: "Read your files" }),
      ],
    });
    render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");
    await selectTab(/Saved/);

    const filter = (await screen.findByLabelText("Filter permissions")) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(filter, "mail");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitFor(() => expect(screen.queryByText("about/news")).toBeNull());
    expect(screen.getByText("about/mail")).toBeTruthy();
  });

  it("reads membership events alongside approvals in one timeline", async () => {
    stubResponses({
      governance: [
        {
          approvalId: "a1",
          approvalKind: "capability",
          decision: "always",
          granted: true,
          resolvedAt: Date.now() - HOUR,
          resolvedBy: { handle: "gabriel" },
          resolvedVia: "mobile-notification",
          requestedBy: { callerId: "about/news" },
          resource: { value: "https://example.com" },
          grantScopeStored: "version",
        },
        {
          kind: "membership",
          op: "add-member",
          actor: { userId: "u1", handle: "gabriel" },
          target: { userId: "u2", handle: "sam" },
          at: Date.now() - 2 * HOUR,
        },
      ],
    });
    render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");
    await selectTab(/Activity/);

    expect(await screen.findByText("Allowed")).toBeTruthy();
    expect(screen.getByText("from a phone notification")).toBeTruthy();
    expect(screen.getByText("saved for version")).toBeTruthy();
    // Membership records used to be filtered out of the query entirely.
    expect(screen.getByText("Membership")).toBeTruthy();
    expect(screen.getByText(/added/)).toBeTruthy();
  });

  it("asks before doing anything destructive", async () => {
    stubResponses({ grants: [savedGrant()] });
    render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");
    await selectTab(/Saved/);

    const revoke = await screen.findByRole("button", { name: /Revoke/ });
    act(() => revoke.click());

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Revoke this permission?")).toBeTruthy();
    expect(within(dialog).getByText("The next matching action asks again.")).toBeTruthy();
    // Nothing has been revoked yet: the confirmation is the action.
    expect(mocks.call).not.toHaveBeenCalledWith("main", "permissions.revoke", expect.anything());

    act(() => within(dialog).getByRole("button", { name: "Revoke" }).click());
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith("main", "permissions.revoke", [
        { kind: "capability", id: "grant-1" },
      ])
    );
  });

  it("reads both approvals and membership events from governance", async () => {
    render(<AboutPanelRoot />);
    await screen.findByLabelText("Permission view");

    expect(mocks.call).toHaveBeenCalledWith("main", "governance.list", [{ limit: 200 }]);
  });
});
