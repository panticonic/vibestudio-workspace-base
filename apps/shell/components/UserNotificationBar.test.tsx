// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellUserNotification } from "../shell/client";

const shellClient = vi.hoisted(() => ({
  list: vi.fn(),
  openChannel: vi.fn(),
  acknowledge: vi.fn(),
  describeConversation: vi.fn(),
}));
const toastClient = vi.hoisted(() => ({
  show: vi.fn(),
  reportAction: vi.fn(),
  dismiss: vi.fn(),
}));
const watchedEventHandlers = vi.hoisted(
  () => new Map<string, (payload: Record<string, unknown>) => void>()
);
const directEventHandlers = vi.hoisted(
  () => new Map<string, (payload: Record<string, unknown>) => void>()
);

vi.mock("../shell/client", () => ({
  userNotifications: shellClient,
  notification: toastClient,
  events: { on: () => () => undefined, subscribe: async () => undefined, unsubscribe: async () => undefined },
}));
vi.mock("../shell/useShellEvent", () => ({
  useShellEvent: (event: string, callback: (payload: Record<string, unknown>) => void) => {
    watchedEventHandlers.set(event, callback);
  },
}));
vi.mock("../shell/useDirectShellEvent", () => ({
  useDirectShellEvent: (event: string, callback: (payload: Record<string, unknown>) => void) => {
    directEventHandlers.set(event, callback);
  },
}));
vi.mock("@radix-ui/themes", () => ({
  Badge: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <span title={title}>{children}</span>
  ),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Flex: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <span>Loading</span>,
  Text: ({
    children,
    truncate: _truncate,
    color: _color,
    weight: _weight,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & {
    truncate?: boolean;
    color?: string;
    weight?: string;
  }) => <span {...props}>{children}</span>,
}));
vi.mock("@radix-ui/react-icons", () => ({
  ChatBubbleIcon: () => <span />,
  Cross2Icon: () => <span />,
  InfoCircledIcon: () => <span />,
  ReloadIcon: () => <span />,
}));

import { UserNotificationBar } from "./UserNotificationBar";

function channelNotification(
  channelId: string,
  patch: Partial<ShellUserNotification> = {}
): ShellUserNotification {
  return {
    id: `channel.invite:${channelId}`,
    userId: "usr_bob",
    kind: "channel.invite",
    title: "Channel invitation",
    createdAt: 10,
    revision: 1,
    channelInvite: {
      channelId,
      channelTitle: `Conversation ${channelId}`,
      userId: "usr_bob",
      memberId: "user:usr_bob",
      handle: "bob",
      addedBy: "user:usr_alice",
      addedAt: 10,
      inviter: {
        userId: "usr_alice",
        handle: "alice",
        displayName: "Alice",
        role: "member",
      },
    },
    ...patch,
  };
}


function agentMessageNotification(
  patch: Partial<ShellUserNotification> = {}
): ShellUserNotification {
  return {
    id: "agent.message:say:call-1:usr_bob",
    userId: "usr_bob",
    kind: "agent.message",
    title: "The nightly build is red.",
    message: "The nightly build is red.\nHere is what broke.",
    createdAt: 20,
    revision: 1,
    agentMessage: {
      channelId: "ch-build",
      messageId: "say:call-1",
      senderParticipantId: "do:builder",
      senderHandle: "builder",
      rung: "inbox",
    },
    ...patch,
  };
}

describe("UserNotificationBar", () => {
  beforeEach(() => {
    watchedEventHandlers.clear();
    directEventHandlers.clear();
    shellClient.list.mockReset().mockResolvedValue([]);
    shellClient.openChannel.mockReset().mockResolvedValue({ id: "panel-chat" });
    shellClient.acknowledge.mockReset().mockResolvedValue(true);
    shellClient.describeConversation
      .mockReset()
      .mockResolvedValue({ contextId: "ctx-build", title: "Build channel" });
    toastClient.show.mockReset().mockResolvedValue("toast-1");
  });

  it("renders a channel invitation from the generic inbox", async () => {
    shellClient.list.mockResolvedValue([channelNotification("one"), channelNotification("two")]);
    render(<UserNotificationBar />);

    expect(await screen.findByText("Conversation one")).toBeTruthy();
    expect(screen.getByText(/invited by Alice/)).toBeTruthy();
    expect(screen.getByTitle("2 pending notifications").textContent).toBe("+1");
  });

  it("refreshes from targeted account events without installing a timer poll", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    render(<UserNotificationBar />);
    expect(setInterval).not.toHaveBeenCalled();
    setInterval.mockRestore();
    await waitFor(() => expect(shellClient.list).toHaveBeenCalledTimes(1));
    shellClient.list.mockResolvedValue([channelNotification("live")]);

    directEventHandlers.get("user-notifications-changed")?.({ changedAt: 20 });

    expect(await screen.findByText("Conversation live")).toBeTruthy();
    expect(watchedEventHandlers.has("user-notifications-changed")).toBe(false);
  });

  it("opens a channel before acknowledging its generic notification", async () => {
    const order: string[] = [];
    shellClient.list.mockResolvedValue([channelNotification("one")]);
    shellClient.openChannel.mockImplementation(async () => {
      order.push("open");
      return { id: "panel-chat" };
    });
    shellClient.acknowledge.mockImplementation(async () => {
      order.push("acknowledge");
      return true;
    });
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Join" }));

    await waitFor(() => expect(screen.queryByText("Conversation one")).toBeNull());
    expect(order).toEqual(["open", "acknowledge"]);
    expect(shellClient.acknowledge).toHaveBeenCalledWith("channel.invite:one");
  });

  it("renders and dismisses notification kinds unknown to the shell", async () => {
    shellClient.list.mockResolvedValue([
      {
        id: "build:done",
        userId: "usr_bob",
        kind: "build.completed",
        title: "Build complete",
        message: "The release build is ready.",
        createdAt: 10,
        revision: 1,
      },
    ]);
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Build complete" }));

    await waitFor(() => expect(screen.queryByText("Build complete")).toBeNull());
    expect(shellClient.acknowledge).toHaveBeenCalledWith("build:done");
  });

  it("shows the actual snapshot error instead of masking it", async () => {
    shellClient.list.mockRejectedValue(new Error("account subject missing"));
    render(<UserNotificationBar />);

    expect(await screen.findByText(/account subject missing/)).toBeTruthy();
  });

  it("renders an escalated agent message with its sender", async () => {
    shellClient.list.mockResolvedValue([agentMessageNotification()]);
    render(<UserNotificationBar />);

    expect(await screen.findByText("The nightly build is red.")).toBeTruthy();
    expect(screen.getByText(/from @builder/)).toBeTruthy();
    expect(screen.getByText("Message")).toBeTruthy();
  });

  it("opens the notified message in its channel, then acknowledges it", async () => {
    const order: string[] = [];
    shellClient.list.mockResolvedValue([agentMessageNotification()]);
    shellClient.openChannel.mockImplementation(async () => {
      order.push("open");
      return { id: "panel-chat" };
    });
    shellClient.acknowledge.mockImplementation(async () => {
      order.push("acknowledge");
      return true;
    });
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByText("Open"));

    await waitFor(() => expect(order).toEqual(["open", "acknowledge"]));
    // The envelope the sender escalated is the one the panel is asked to show.
    expect(shellClient.openChannel).toHaveBeenCalledWith("ch-build", {
      focusMessageId: "say:call-1",
    });
  });

  it("groups several messages from one agent into one row with a count", async () => {
    shellClient.list.mockResolvedValue([
      agentMessageNotification(),
      agentMessageNotification({
        id: "agent.message:say:call-2:usr_bob",
        title: "Fixed it.",
        createdAt: 30,
        agentMessage: {
          channelId: "ch-build",
          messageId: "say:call-2",
          senderParticipantId: "do:builder",
          senderHandle: "builder",
          rung: "inbox",
        },
      }),
    ]);
    render(<UserNotificationBar />);

    // Newest first, and the group count instead of a second interruption.
    expect(await screen.findByText("Fixed it.")).toBeTruthy();
    expect(screen.getByTitle("2 messages from this agent").textContent).toBe("×2");
  });

  it("replies in place through the conversation surface, then acknowledges", async () => {
    shellClient.list.mockResolvedValue([agentMessageNotification()]);
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));

    await waitFor(() =>
      expect(shellClient.acknowledge).toHaveBeenCalledWith("agent.message:say:call-1:usr_bob")
    );
    expect(shellClient.describeConversation).toHaveBeenCalledWith("ch-build");
    // The full panel is NOT opened for an in-place reply.
    expect(shellClient.openChannel).not.toHaveBeenCalled();
  });

  it("mirrors a newly arriving interrupt as a toast, never one already there on load", async () => {
    shellClient.list.mockResolvedValue([
      agentMessageNotification({
        id: "agent.message:say:call-0:usr_bob",
        agentMessage: {
          channelId: "ch-build",
          messageId: "say:call-0",
          senderParticipantId: "do:builder",
          rung: "interrupt",
        },
      }),
    ]);
    render(<UserNotificationBar />);
    await waitFor(() => expect(shellClient.list).toHaveBeenCalledTimes(1));
    await screen.findByText("The nightly build is red.");
    expect(toastClient.show).not.toHaveBeenCalled();

    shellClient.list.mockResolvedValue([
      agentMessageNotification({
        id: "agent.message:say:call-9:usr_bob",
        title: "Deploy blocked",
        agentMessage: {
          channelId: "ch-build",
          messageId: "say:call-9",
          senderParticipantId: "do:builder",
          rung: "interrupt",
        },
      }),
    ]);
    directEventHandlers.get("user-notifications-changed")?.({ changedAt: 30 });
    await waitFor(() => expect(toastClient.show).toHaveBeenCalledTimes(1));
    expect(toastClient.show.mock.calls[0]?.[0]).toMatchObject({ title: "Deploy blocked" });
  });

  it("keeps the entry when opening fails, so a person never loses the message", async () => {
    shellClient.list.mockResolvedValue([agentMessageNotification()]);
    shellClient.openChannel.mockRejectedValue(new Error("panel host is down"));
    render(<UserNotificationBar />);

    fireEvent.click(await screen.findByText("Open"));

    await waitFor(() => expect(screen.getByText(/panel host is down/)).toBeTruthy());
    expect(shellClient.acknowledge).not.toHaveBeenCalled();
  });
});
