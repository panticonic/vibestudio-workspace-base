import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { Badge, Button, Flex, IconButton, Spinner, Text } from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Cross2Icon,
  InfoCircledIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import {
  userNotifications,
  type ShellChannelInvite,
  type ShellUserNotification,
} from "../shell/client";
import type { AgentMessageNotificationData } from "@vibestudio/shared/userNotifications";
import { SHELL_APPROVAL_PENDING_CHANGED_EVENT } from "@vibestudio/shell-core/approvalState";
import { events, notification as shellToast } from "../shell/client";
import { openConversationSurfaceAtom } from "../state/commandAgentAtoms";
import { useDirectShellEvent } from "../shell/useDirectShellEvent";
import { useShellEvent } from "../shell/useShellEvent";
import {
  pendingReviewNotice,
  type PendingReviewNotice,
} from "@vibestudio/shared/authority/reviewPending";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string | undefined): string {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

/**
 * Entries grouped by sending agent instance, newest first (messaging plan
 * §4.10.8): a background agent that reports twice before the person looks must
 * not read as two unrelated interruptions. Non-agent entries group by kind.
 */
export function groupNotifications(
  notifications: readonly ShellUserNotification[]
): Array<{ key: string; entries: ShellUserNotification[] }> {
  const groups = new Map<string, ShellUserNotification[]>();
  for (const entry of notifications) {
    const key = entry.agentMessage
      ? `agent:${entry.agentMessage.senderParticipantId}@${entry.agentMessage.channelId}`
      : `kind:${entry.kind}:${entry.id}`;
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups].map(([key, entries]) => ({
    key,
    entries: [...entries].sort((a, b) => b.createdAt - a.createdAt),
  }));
}

/**
 * Durable account inbox surface. State is loaded once, refreshed by targeted
 * account events, and reconciled after host reconnect. There is no timer poll.
 */
export function UserNotificationBar() {
  const [notifications, setNotifications] = useState<ShellUserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyNotificationId, setBusyNotificationId] = useState<string | null>(null);
  const [openedNotificationId, setOpenedNotificationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Not an error (U6). While a review covering this workspace's parts is open,
   * every gated call resolves to the same recoverable outcome naming it. Saying
   * `Notifications could not be loaded` and offering a Retry described a failure
   * that had not happened and an action that could not work.
   */
  const [awaitingReview, setAwaitingReview] = useState<PendingReviewNotice | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  /** History (acknowledged entries), loaded only when the person asks (§4.10.8). */
  const [history, setHistory] = useState<ShellUserNotification[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const requestVersion = useRef(0);
  const refreshFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const openConversationSurface = useSetAtom(openConversationSurfaceAtom);
  /**
   * `interrupt` mirrors (plan §4.10.9): a transient toast is issued by this
   * surface for entries that ARRIVE while it is mounted at that rung — never
   * for what was already there on load, and never as the record. The toast's
   * "Reply" action routes back through `toastTargets`.
   */
  const seenIds = useRef<Set<string> | null>(null);
  const toastTargets = useRef(new Map<string, ShellUserNotification>());

  const loadSnapshot = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await userNotifications.list();
      if (requestVersion.current !== version) return;
      const previouslySeen = seenIds.current;
      seenIds.current = new Set(next.map((entry) => entry.id));
      if (previouslySeen) {
        for (const entry of next) {
          if (previouslySeen.has(entry.id) || entry.agentMessage?.rung !== "interrupt") continue;
          void shellToast
            .show({
              type: "info",
              title: entry.title,
              message: firstLine(entry.message),
              ttl: 15_000,
              actions: [{ id: "reply", label: "Reply", variant: "solid" }],
            })
            .then((toastId) => toastTargets.current.set(toastId, entry))
            .catch(() => undefined);
        }
      }
      setNotifications(next);
      setError(null);
      setAwaitingReview(null);
    } catch (cause) {
      if (requestVersion.current !== version) return;
      const pending = pendingReviewNotice(cause);
      setAwaitingReview(pending);
      setError(pending ? null : errorMessage(cause));
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, []);

  /**
   * Events invalidate one logical inbox projection. Coalesce every invalidation
   * that arrives while its read is in flight, then perform at most one follow-up
   * read so a change racing the first snapshot cannot be missed. This keeps the
   * query owner single-flight without dropping freshness or making a caller's
   * cancellation own shared work.
   */
  const refresh = useCallback((): Promise<void> => {
    refreshAgain.current = true;
    if (refreshFlight.current) return refreshFlight.current;
    const flight = (async () => {
      while (refreshAgain.current) {
        refreshAgain.current = false;
        await loadSnapshot();
      }
    })().finally(() => {
      if (refreshFlight.current === flight) refreshFlight.current = null;
    });
    refreshFlight.current = flight;
    return flight;
  }, [loadSnapshot]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAgain.current = false;
      requestVersion.current += 1;
    };
  }, [refresh]);

  useDirectShellEvent(
    "user-notifications-changed",
    useCallback(() => void refresh(), [refresh])
  );

  // Finishing the review is what unblocks this, so the answer arrives on its
  // own and the line clears itself. Nothing to retry, nothing to dismiss.
  useEffect(() => {
    if (!awaitingReview) return;
    const off = events.on(SHELL_APPROVAL_PENDING_CHANGED_EVENT, () => void refresh());
    void events.subscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT);
    return () => {
      off();
      void events.unsubscribe(SHELL_APPROVAL_PENDING_CHANGED_EVENT);
    };
  }, [awaitingReview, refresh]);
  useShellEvent(
    "server-connection-changed",
    useCallback(
      ({ status }: { status: "connected" | "connecting" | "disconnected" }) => {
        if (status === "connected") void refresh();
      },
      [refresh]
    )
  );

  const toggleHistory = useCallback(async () => {
    if (history) {
      setHistory(null);
      return;
    }
    setHistoryBusy(true);
    try {
      const all = await userNotifications.list({ includeAcknowledged: true, limit: 50 });
      setHistory(all.filter((entry) => entry.acknowledgedAt !== undefined));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setHistoryBusy(false);
    }
  }, [history]);

  const removeLocal = useCallback((id: string) => {
    requestVersion.current += 1;
    setNotifications((current) => current.filter((notification) => notification.id !== id));
    setOpenedNotificationId((current) => (current === id ? null : current));
    setExpandedMessages((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setError(null);
  }, []);

  const dismiss = useCallback(
    async (notification: ShellUserNotification) => {
      setBusyNotificationId(notification.id);
      setError(null);
      try {
        // False means another device already acknowledged it; either way this
        // local snapshot is stale and should converge immediately.
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusyNotificationId(null);
      }
    },
    [removeLocal]
  );

  /**
   * Opening the message acknowledges it (plan §4.5.4): the entry retires on the
   * fact that the person actually looked, never on a prediction that they were
   * already looking. Acknowledgement stays second so a failed panel open cannot
   * consume the entry.
   */
  /**
   * An invite to the same channel is redundant once the person opens a message
   * from it (plan §4.6: the escalated entry doubles as the invite affordance),
   * so it is retired alongside — silently; it never surfaces as a second row.
   */
  const acknowledgeInvitesFor = useCallback(
    async (channelId: string) => {
      const invites = notifications.filter(
        (entry) => entry.channelInvite?.channelId === channelId
      );
      for (const invite of invites) {
        await userNotifications.acknowledge(invite.id).catch(() => undefined);
        removeLocal(invite.id);
      }
    },
    [notifications, removeLocal]
  );

  const openAgentMessage = useCallback(
    async (notification: ShellUserNotification, message: AgentMessageNotificationData) => {
      setBusyNotificationId(notification.id);
      setError(null);
      let opened = false;
      try {
        await userNotifications.openChannel(message.channelId, {
          focusMessageId: message.messageId,
        });
        opened = true;
        setOpenedNotificationId(notification.id);
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
        await acknowledgeInvitesFor(message.channelId);
      } catch (cause) {
        const detail = errorMessage(cause);
        setError(
          opened
            ? `Conversation opened, but the notification could not be cleared: ${detail}`
            : detail
        );
      } finally {
        setBusyNotificationId(null);
      }
    },
    [acknowledgeInvitesFor, removeLocal]
  );

  /**
   * Reply in place (plan §4.8): the quickfire surface bound to the notifying
   * agent's channel, landing on the escalated envelope. Opening it is reading
   * it, so the entry is acknowledged once the surface is requested.
   */
  const replyToAgentMessage = useCallback(
    async (notification: ShellUserNotification, message: AgentMessageNotificationData) => {
      setBusyNotificationId(notification.id);
      setError(null);
      let opened = false;
      try {
        const conversation = await userNotifications.describeConversation(message.channelId);
        openConversationSurface({
          channelId: message.channelId,
          contextId: conversation.contextId,
          focusMessageId: message.messageId,
          replyTo: {
            participantId: message.senderParticipantId,
            ...(message.senderHandle ? { handle: message.senderHandle } : {}),
          },
          ...(conversation.title ? { title: conversation.title } : {}),
        });
        opened = true;
        setOpenedNotificationId(notification.id);
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
        await acknowledgeInvitesFor(message.channelId);
      } catch (cause) {
        const detail = errorMessage(cause);
        setError(
          opened
            ? `Conversation opened, but the notification could not be cleared: ${detail}`
            : detail
        );
      } finally {
        setBusyNotificationId(null);
      }
    },
    [acknowledgeInvitesFor, openConversationSurface, removeLocal]
  );

  // The interrupt toast's "Reply" action (plan §4.10.9) lands here.
  const handleToastAction = useCallback(
    (payload: { id: string; actionId: string }) => {
      const target = toastTargets.current.get(payload.id);
      if (!target) return;
      toastTargets.current.delete(payload.id);
      if (payload.actionId !== "reply" || !target.agentMessage) return;
      void replyToAgentMessage(target, target.agentMessage);
    },
    [replyToAgentMessage]
  );
  useShellEvent("notification:action", handleToastAction);
  useDirectShellEvent("notification:action", handleToastAction);

  const joinChannel = useCallback(
    async (notification: ShellUserNotification, invite: ShellChannelInvite) => {
      setBusyNotificationId(notification.id);
      setError(null);
      let opened = false;
      try {
        await userNotifications.openChannel(invite.channelId);
        opened = true;
        setOpenedNotificationId(notification.id);
        await userNotifications.acknowledge(notification.id);
        removeLocal(notification.id);
      } catch (cause) {
        const message = errorMessage(cause);
        setError(
          opened
            ? `Conversation opened, but the notification could not be cleared: ${message}`
            : message
        );
      } finally {
        setBusyNotificationId(null);
      }
    },
    [removeLocal]
  );

  if (notifications.length === 0) {
    if (awaitingReview && !loading) {
      return (
        <Flex
          role="status"
          align="center"
          gap="2"
          px="3"
          py="1"
          style={{ minHeight: 30, borderBottom: "1px solid var(--gray-a5)" }}
        >
          <InfoCircledIcon />
          <Text size="1" color="gray" style={{ flex: 1 }}>
            {awaitingReview.message}
          </Text>
        </Flex>
      );
    }
    if (!error || loading) return null;
    return (
      <Flex
        role="status"
        align="center"
        gap="2"
        px="3"
        py="1"
        style={{
          minHeight: 30,
          background: "var(--amber-a3)",
          borderBottom: "1px solid var(--amber-a6)",
        }}
      >
        <Text size="1" color="amber" style={{ flex: 1 }} title={error}>
          Notifications could not be loaded: {error}
        </Text>
        <Button size="1" variant="ghost" color="amber" onClick={() => void refresh()}>
          <ReloadIcon /> Retry
        </Button>
      </Flex>
    );
  }

  const groups = groupNotifications(notifications);
  const notification = groups[0]!.entries[0]!;
  const groupSize = groups[0]!.entries.length;
  const invite = notification.channelInvite;
  const agentMessage = notification.agentMessage;
  const busy = busyNotificationId === notification.id;
  const opened = openedNotificationId === notification.id;
  const others = notifications.length - 1;

  const toggleMessage = (id: string) => {
    setExpandedMessages((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderSummary = (entry: ShellUserNotification) => {
    const entryInvite = entry.channelInvite;
    const entryMessage = entry.agentMessage;
    const messageExpanded = expandedMessages.has(entry.id);
    if (entryMessage && entry.message) {
      return (
        <button
          type="button"
          className="user-notification-message-summary"
          data-expanded={messageExpanded ? "true" : "false"}
          aria-expanded={messageExpanded}
          aria-label={
            messageExpanded
              ? `Collapse message from ${entry.title}`
              : `Show full message from ${entry.title}`
          }
          onClick={() => toggleMessage(entry.id)}
        >
          <span className="user-notification-message-copy">
            <Text weight="medium">{entry.title}</Text>
            {entryMessage.senderHandle ? (
              <Text color="gray"> · from @{entryMessage.senderHandle}</Text>
            ) : null}
            <Text color="gray">
              {messageExpanded ? ` · ${entry.message}` : ` · ${firstLine(entry.message)}`}
            </Text>
          </span>
          {messageExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </button>
      );
    }
    const inviter = entryInvite
      ? entryInvite.inviter
        ? entryInvite.inviter.displayName || `@${entryInvite.inviter.handle}`
        : entryInvite.addedBy.startsWith("user:")
          ? "a workspace member"
          : entryInvite.addedBy
      : null;
    return (
      <Text size="2" style={{ flex: "1 1 220px", minWidth: 0 }} truncate>
        <Text weight="medium">{entryInvite?.channelTitle ?? entry.title}</Text>
        {entryInvite ? <Text color="gray"> · invited by {inviter}</Text> : null}
        {entryMessage?.senderHandle ? (
          <Text color="gray"> · from @{entryMessage.senderHandle}</Text>
        ) : null}
        {!entryInvite && entry.message ? (
          <Text color="gray"> · {firstLine(entry.message)}</Text>
        ) : null}
      </Text>
    );
  };

  const renderRow = (entry: ShellUserNotification, options: { count?: number }) => {
    const rowInvite = entry.channelInvite;
    const rowMessage = entry.agentMessage;
    const rowBusy = busyNotificationId === entry.id;
    const rowOpened = openedNotificationId === entry.id;
    return (
      <Flex key={entry.id} align="center" gap="2" wrap="wrap" style={{ minHeight: 30 }}>
        {rowInvite || rowMessage ? <ChatBubbleIcon aria-hidden /> : <InfoCircledIcon aria-hidden />}
        {renderSummary(entry)}
        {options.count && options.count > 1 ? (
          <Badge color="gray" variant="soft" title={`${options.count} messages from this agent`}>
            ×{options.count}
          </Badge>
        ) : null}
        {rowInvite ? (
          <Button
            size="1"
            disabled={rowBusy || rowOpened}
            onClick={() => void joinChannel(entry, rowInvite)}
          >
            {rowBusy ? <Spinner size="1" /> : null}
            {rowOpened ? "Opened" : "Join"}
          </Button>
        ) : null}
        {rowMessage ? (
          <>
            <Button
              size="1"
              disabled={rowBusy || rowOpened}
              onClick={() => void replyToAgentMessage(entry, rowMessage)}
              title="Reply to this agent right here"
            >
              {rowBusy ? <Spinner size="1" /> : null}
              Reply
            </Button>
            <Button
              size="1"
              variant="soft"
              disabled={rowBusy || rowOpened}
              onClick={() => void openAgentMessage(entry, rowMessage)}
              title="Open the conversation in a chat panel"
            >
              {rowOpened ? "Opened" : "Open"}
            </Button>
          </>
        ) : null}
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={rowBusy}
          onClick={() => void dismiss(entry)}
          aria-label={
            rowInvite ? `Dismiss invitation to ${rowInvite.channelTitle}` : `Dismiss ${entry.title}`
          }
          title="Dismiss without opening"
        >
          <Cross2Icon />
        </IconButton>
      </Flex>
    );
  };

  return (
    <Flex
      role="region"
      aria-label="User notifications"
      aria-live="polite"
      direction="column"
      px="3"
      py="1"
      style={{
        minHeight: 34,
        background: "var(--accent-a3)",
        borderBottom: "1px solid var(--accent-a6)",
      }}
    >
      <Flex align="center" gap="2" wrap="wrap">
        {invite || agentMessage ? <ChatBubbleIcon aria-hidden /> : <InfoCircledIcon aria-hidden />}
        <Badge color="blue" variant="soft" radius="full">
          {invite ? "Invitation" : agentMessage ? "Message" : "Notification"}
        </Badge>
        {renderSummary(notification)}
        {groupSize > 1 ? (
          <Badge color="gray" variant="soft" title={`${groupSize} messages from this agent`}>
            ×{groupSize}
          </Badge>
        ) : null}
        <Button
          size="1"
          variant="ghost"
          color="gray"
          title={
            others > 0
              ? `${notifications.length} pending notifications`
              : "All notifications and history"
          }
          aria-label={others > 0 ? `${notifications.length} pending notifications` : "Notification history"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {others > 0 ? `+${others}` : "…"}
        </Button>
        {error ? (
          <Text size="1" color="red" title={error}>
            {error}
          </Text>
        ) : null}
        {invite ? (
          <Button
            size="1"
            disabled={busy || opened}
            onClick={() => void joinChannel(notification, invite)}
          >
            {busy ? <Spinner size="1" /> : null}
            {opened ? "Opened" : "Join"}
          </Button>
        ) : null}
        {agentMessage ? (
          <>
            <Button
              size="1"
              disabled={busy || opened}
              onClick={() => void replyToAgentMessage(notification, agentMessage)}
              title="Reply to this agent right here"
            >
              {busy ? <Spinner size="1" /> : null}
              Reply
            </Button>
            <Button
              size="1"
              variant="soft"
              disabled={busy || opened}
              onClick={() => void openAgentMessage(notification, agentMessage)}
              title="Open the conversation in a chat panel"
            >
              {opened ? "Opened" : "Open"}
            </Button>
          </>
        ) : null}
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={busy}
          onClick={() => void dismiss(notification)}
          aria-label={
            invite ? `Dismiss invitation to ${invite.channelTitle}` : `Dismiss ${notification.title}`
          }
          title="Dismiss without opening"
        >
          <Cross2Icon />
        </IconButton>
      </Flex>
      {expanded ? (
        <Flex
          direction="column"
          gap="1"
          pt="1"
          role="list"
          aria-label="All pending notifications"
          style={{ borderTop: "1px solid var(--accent-a5)" }}
        >
          {groups.map((group) =>
            renderRow(group.entries[0]!, { count: group.entries.length })
          )}
          <Flex align="center" gap="2" pt="1">
            <Button size="1" variant="ghost" color="gray" disabled={historyBusy} onClick={() => void toggleHistory()}>
              {historyBusy ? <Spinner size="1" /> : null}
              {history ? "Hide acknowledged" : "Show acknowledged"}
            </Button>
          </Flex>
          {history
            ? history.length === 0
              ? (
                <Text size="1" color="gray">
                  Nothing acknowledged yet.
                </Text>
              )
              : history.map((entry) => (
                <Flex key={entry.id} align="center" gap="2" style={{ opacity: 0.7 }}>
                  <Text size="1" color="gray" style={{ flex: 1, minWidth: 0 }} truncate>
                    {entry.channelInvite?.channelTitle ?? entry.title}
                    {entry.agentMessage?.senderHandle ? ` · from @${entry.agentMessage.senderHandle}` : ""}
                    {" · read"}
                  </Text>
                  {entry.agentMessage ? (
                    <Button
                      size="1"
                      variant="ghost"
                      color="gray"
                      onClick={() =>
                        void userNotifications
                          .openChannel(entry.agentMessage!.channelId, {
                            focusMessageId: entry.agentMessage!.messageId,
                          })
                          .catch((cause) => setError(errorMessage(cause)))
                      }
                    >
                      Open
                    </Button>
                  ) : null}
                </Flex>
              ))
            : null}
        </Flex>
      ) : null}
    </Flex>
  );
}
