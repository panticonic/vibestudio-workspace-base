/**
 * `notify` — the one messaging primitive (plan §4.1/§4.3).
 *
 * These exercise the tool through a real worker so the seams that matter stay
 * covered: what lands on the channel, what the audience selectors say, how an
 * unresolvable addressee fails, and that a `run:` addressee goes through the
 * supervision path rather than the channel audience.
 */
import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentTool } from "@workspace/harness";
import type {
  ParticipantRef,
  ResolveAddresseeContext,
} from "@workspace/agentic-protocol";
import { SystemAgentWorker } from "../../../workers/system-agent/system-agent-worker.js";

interface RecordedSend {
  participantId: string;
  messageId: string;
  content: string;
  opts: Record<string, unknown>;
  channelId?: string;
}

function agentRef(handle: string): ParticipantRef {
  return {
    kind: "agent",
    id: `do:${handle}`,
    participantId: `do:${handle}`,
    metadata: { handle },
  };
}

const ROSTER: ParticipantRef[] = [
  agentRef("scribe"),
  agentRef("explorer"),
  {
    kind: "user",
    id: "user:gabriel",
    participantId: "user:gabriel",
    metadata: { handle: "gabriel" },
  },
];

class TestNotifyWorker extends SystemAgentWorker {
  readonly sends: RecordedSend[] = [];
  readonly steers: Array<{
    toolCallId: string;
    runId: string;
    message: string;
  }> = [];
  readonly gadCalls: Array<{ method: string; args: unknown[] }> = [];
  readonly gadResults: Record<string, unknown> = {};
  readonly events: Array<{
    channelId: string;
    kind: string;
    event: Record<string, unknown>;
  }> = [];
  readonly closedChannels = new Set<string>();
  readonly pushes: Array<{ userId: string; request: Record<string, unknown> }> =
    [];
  readonly memberships: Array<{ channelId: string; userId: string }> = [];
  users: ResolveAddresseeContext["users"] = [];
  directory: ResolveAddresseeContext["directory"] = [];
  ownerUserId: string | undefined = undefined;
  inboundHops = 0;
  runs: ResolveAddresseeContext["runs"] = [];
  failGad = false;
  parent: ResolveAddresseeContext["parent"] = undefined;

  /** The system agent deliberately advertises only `eval` and `notify`, so the
   *  discovery surface is reached directly rather than through its roster. */
  discoveryTool(name: string): AgentTool {
    const found = this.createDiscoveryTools("ch-home").find(
      (entry) => entry.name === name,
    );
    if (!found) throw new Error(`${name} tool missing`);
    return found;
  }

  async notifyTool(): Promise<AgentTool> {
    const tools = await this.getLoopTools("ch-home");
    const tool = tools.find((entry) => entry.name === "notify");
    if (!tool) throw new Error("notify tool missing");
    return tool;
  }

  protected override async addresseeContext(
    _channelId: string,
  ): Promise<ResolveAddresseeContext> {
    return {
      channelId: "ch-home",
      roster: ROSTER,
      ...(this.parent ? { parent: this.parent } : {}),
      runs: this.runs,
      directory: this.directory,
      users: this.users,
      ...(this.ownerUserId ? { ownerUserId: this.ownerUserId } : {}),
    };
  }

  protected override async pushUserInbox(
    userId: string,
    request: Record<string, unknown>,
  ): Promise<number> {
    this.pushes.push({ userId, request });
    return 1;
  }

  protected override subagentIdentity(): never | null {
    return this.parent
      ? ({ parentParticipantId: this.parent.participantId } as never)
      : null;
  }

  protected override async sendToSubagent(
    toolCallId: string,
    runId: string,
    message: string,
  ): Promise<never> {
    this.steers.push({ toolCallId, runId, message });
    return {
      content: [{ type: "text", text: `sent to subagent ${runId}` }],
      details: { runId },
    } as never;
  }

  protected override inboundAgentHops(_channelId: string): number {
    return this.inboundHops;
  }

  protected override async callGad<T>(
    method: string,
    ...args: unknown[]
  ): Promise<T> {
    this.gadCalls.push({ method, args });
    if (this.failGad && method === "putUserNotification")
      throw new Error("gad unavailable");
    if (method in this.gadResults) return this.gadResults[method] as T;
    if (method === "listAgentDirectory") return { entries: [] } as T;
    return {} as T;
  }

  protected override createChannelClient(channelId: string): never {
    const sends = this.sends;
    const events = this.events;
    const closed = this.closedChannels;
    const memberships = this.memberships;
    return {
      send: async (
        participantId: string,
        messageId: string,
        content: string,
        opts: Record<string, unknown>,
      ) => {
        if (closed.has(channelId)) {
          throw Object.assign(new Error("locked membership"), {
            code: "ClosedChannel",
          });
        }
        sends.push({ participantId, messageId, content, opts, channelId });
      },
      publishAgenticEvent: async (
        _participantId: string,
        event: { kind: string },
      ) => {
        events.push({ channelId, kind: event.kind, event });
        return {};
      },
      addMember: async (userId: string) => {
        memberships.push({ channelId, userId });
        return { alreadyMember: false };
      },
    } as never;
  }
}

async function worker(): Promise<TestNotifyWorker> {
  const { instance } = await createTestDO(TestNotifyWorker);
  const created = instance as TestNotifyWorker;
  const subscriptions = created["subscriptions"] as unknown as Record<
    string,
    unknown
  >;
  subscriptions["getParticipantId"] = () => "do:self";
  subscriptions["getConfig"] = () => ({});
  return created;
}

describe("notify", () => {
  it("addresses the whole channel when `to` is omitted", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-1", { content: "build is green" } as never);

    expect(instance.sends).toHaveLength(1);
    const [send] = instance.sends;
    // The dedup id stays derived from the tool call, so a redrive re-sends the
    // same message rather than a second one.
    expect(send?.messageId).toBe("say:call-1");
    expect(send?.opts["to"]).toBeUndefined();
    // The wire saliency is frozen at "say" (D3): the tool renamed, the field did not.
    expect(send?.opts["saliency"]).toBe("say");
    expect(send?.opts["metadata"]).toEqual({ notify: { alert: "none" } });
  });

  it("carries an explicit @handle as the channel audience", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-2", {
      content: "over to you",
      to: ["@scribe"],
    } as never);

    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "do:scribe" },
    ]);
  });

  it("unions several addressees into one envelope rather than sending twice", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-3", {
      content: "both of you",
      to: ["@scribe", "participant:do:explorer", "@scribe"],
    } as never);

    expect(instance.sends).toHaveLength(1);
    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "do:scribe" },
      { kind: "participant", participantId: "do:explorer" },
    ]);
  });

  it("defaults to the inbox rung when a person is addressed, and never above it", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-4", {
      content: "your call",
      to: ["user:gabriel"],
    } as never);
    expect(instance.sends[0]?.opts["metadata"]).toEqual({
      notify: { alert: "inbox" },
    });

    await tool.execute("call-5", {
      content: "wake up",
      to: ["user:gabriel"],
      alert: "interrupt",
      title: "Deploy blocked",
    } as never);
    expect(instance.sends[1]?.opts["metadata"]).toEqual({
      notify: { alert: "interrupt", title: "Deploy blocked" },
    });
  });

  it("fails closed on an unknown handle, with suggestions, and sends nothing", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await expect(
      tool.execute("call-6", { content: "hello", to: ["@scrib"] } as never),
    ).rejects.toMatchObject({
      code: "unknown-handle",
      errorData: { suggestions: ["@scribe"] },
    });
    expect(instance.sends).toHaveLength(0);
  });

  it("rejects an alert rung outside the ladder", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await expect(
      tool.execute("call-7", { content: "hi", alert: "urgent" } as never),
    ).rejects.toThrow(/none, inbox, interrupt/);
  });

  it("routes a run: addressee through supervision, not the channel audience", async () => {
    const instance = await worker();
    instance.runs = [
      {
        runId: "run-abcdef",
        taskChannelId: "ch-task",
        participantId: "do:child",
      },
    ];
    const tool = await instance.notifyTool();
    await tool.execute("call-8", {
      content: "use the staging fixture instead",
      to: ["run:run-abc"],
    } as never);

    expect(instance.sends).toHaveLength(0);
    expect(instance.steers).toEqual([
      {
        toolCallId: "call-8",
        runId: "run-abcdef",
        message: "use the staging fixture instead",
      },
    ]);
  });

  it("gives each addressed run its own dedup id", async () => {
    const instance = await worker();
    instance.runs = [
      { runId: "run-a", taskChannelId: "ch-a" },
      { runId: "run-b", taskChannelId: "ch-b" },
    ];
    const tool = await instance.notifyTool();
    await tool.execute("call-9", {
      content: "stand down",
      to: ["run:run-a", "run:run-b"],
    } as never);

    expect(instance.steers.map((entry) => entry.toolCallId)).toEqual([
      "call-9:run-a",
      "call-9:run-b",
    ]);
  });

  it("keeps a subagent's unaddressed notify pointed at its supervisor", async () => {
    const instance = await worker();
    instance.parent = { participantId: "do:boss" };
    const tool = await instance.notifyTool();
    await tool.execute("call-10", { content: "milestone reached" } as never);

    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "do:boss" },
    ]);
  });

  it("writes one durable inbox entry per addressed person, keyed for redrive", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-esc", {
      content: "The nightly build is red.\nHere is what broke.",
      to: ["user:gabriel"],
    } as never);

    const put = instance.gadCalls.filter(
      (entry) => entry.method === "putUserNotification",
    );
    expect(put).toHaveLength(1);
    expect(put[0]?.args[0]).toMatchObject({
      id: "agent.message:say:call-esc:gabriel",
      userId: "gabriel",
      kind: "agent.message",
      // The headline defaults to the first line, not the whole body.
      title: "The nightly build is red.",
      data: {
        channelId: "ch-home",
        messageId: "say:call-esc",
        senderParticipantId: "do:self",
        rung: "inbox",
      },
    });
  });

  it("addresses `owner` as a person, and refuses when there is no unambiguous one", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    // A channel with no single owning person must not have one guessed for it:
    // picking the first human is exactly the "told the wrong person" failure.
    await expect(
      tool.execute("call-noowner", { content: "done", to: ["owner"] } as never),
    ).rejects.toMatchObject({ code: "no-owner" });

    instance.ownerUserId = "gabriel";
    await tool.execute("call-owner", {
      content: "done",
      to: ["owner"],
    } as never);
    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "user:gabriel" },
    ]);
    expect(instance.sends[0]?.opts["metadata"]).toEqual({
      notify: { alert: "inbox" },
    });
  });

  it("raises an explicit rung to the channel's people when nobody is addressed", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-done", {
      content: "Restructure finished.",
      alert: "inbox",
    } as never);
    // gabriel is the one person on the roster; agents are never escalated to.
    const put = instance.gadCalls.filter(
      (entry) => entry.method === "putUserNotification",
    );
    expect(
      put.map((entry) => (entry.args[0] as { userId: string }).userId),
    ).toEqual(["gabriel"]);
    // Without a rung, an untargeted notify stays a plain channel message.
    await tool.execute("call-quiet2", { content: "still working" } as never);
    expect(
      instance.gadCalls.filter(
        (entry) => entry.method === "putUserNotification",
      ),
    ).toHaveLength(1);
  });

  it("does not escalate an agent-to-agent notify", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-quiet", {
      content: "over to you",
      to: ["@scribe"],
    } as never);
    expect(
      instance.gadCalls.filter(
        (entry) => entry.method === "putUserNotification",
      ),
    ).toEqual([]);
  });

  it("keeps the canonical message but fails the requested notification effect", async () => {
    const instance = await worker();
    instance.failGad = true;
    const tool = await instance.notifyTool();
    await expect(
      tool.execute("call-fail", {
        content: "heads up",
        to: ["user:gabriel"],
      } as never),
    ).rejects.toThrow("gad unavailable");
    // The prior channel write remains the canonical conversational copy and
    // makes an idempotent retry possible; it does not turn the alert into a
    // successful tool invocation.
    expect(instance.sends).toHaveLength(1);
  });

  it("pushes the inbox entry to the person's devices, high priority only at interrupt", async () => {
    const instance = await worker();
    const tool = await instance.notifyTool();
    await tool.execute("call-push", {
      content: "Report ready",
      to: ["user:gabriel"],
    } as never);
    await tool.execute("call-push2", {
      content: "Deploy is blocked",
      to: ["user:gabriel"],
      alert: "interrupt",
    } as never);

    expect(instance.pushes).toEqual([
      {
        userId: "gabriel",
        request: expect.objectContaining({
          notificationId: "agent.message:say:call-push:gabriel",
          kind: "agent.message",
          title: "Report ready",
          priority: "normal",
          channelId: "ch-home",
          messageId: "say:call-push",
        }),
      },
      {
        userId: "gabriel",
        request: expect.objectContaining({
          notificationId: "agent.message:say:call-push2:gabriel",
          priority: "high",
        }),
      },
    ]);
  });

  it("reaches a workspace member who is not on the channel: membership, audience, inbox", async () => {
    const instance = await worker();
    instance.users = [{ userId: "sam", handle: "sam", displayName: "Sam" }];
    const tool = await instance.notifyTool();
    // By handle — the workspace member list is the fallback roster — and by id.
    await tool.execute("call-off", {
      content: "Sam, your turn",
      to: ["@sam"],
    } as never);

    expect(instance.memberships).toEqual([
      { channelId: "ch-home", userId: "sam" },
    ]);
    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "user:sam" },
    ]);
    const put = instance.gadCalls.filter(
      (entry) => entry.method === "putUserNotification",
    );
    expect(put[0]?.args[0]).toMatchObject({
      userId: "sam",
      data: { channelId: "ch-home" },
    });
    expect(instance.pushes[0]?.userId).toBe("sam");

    await expect(
      tool.execute("call-off2", {
        content: "hi",
        to: ["user:nobody"],
      } as never),
    ).rejects.toMatchObject({ code: "unknown-user" });
  });

  it("delivers to a foreign channel as a guest envelope, recording both sides", async () => {
    const instance = await worker();
    instance.directory = [
      {
        instanceId: "gmail@ch-mail",
        handle: "gmail",
        channelId: "ch-mail",
        participantId: "do:gmail",
      },
    ];
    instance.inboundHops = 2;
    const tool = await instance.notifyTool();
    await tool.execute("call-x", {
      content: "Can you extract the newsletter senders?",
      to: ["agent:gmail@ch-mail"],
    } as never);

    // One canonical copy: the utterance lands in the TARGET channel only.
    expect(instance.sends).toHaveLength(1);
    const [send] = instance.sends;
    expect(send?.channelId).toBe("ch-mail");
    expect(send?.messageId).toBe("say:call-x:ch-mail");
    expect(send?.opts["to"]).toEqual([
      { kind: "participant", participantId: "do:gmail" },
    ]);
    // The hop count crosses the boundary explicitly, or the cap silently widens.
    expect(send?.opts["agentHops"]).toBe(3);
    // The origin also names the authoring context (here the tool call: no
    // bound-channel copy exists), so the recipient's "from #channel" link lands.
    expect(
      (send?.opts["senderMetadata"] as Record<string, unknown>)["origin"],
    ).toEqual({
      channelId: "ch-home",
      participantId: "do:self",
      envelopeId: "call-x",
    });

    // The target learns who the guest is and where the utterance was authored;
    // the sender's own channel records a reference, never a relayed transcript.
    expect(
      instance.events.map((entry) => `${entry.channelId}:${entry.kind}`),
    ).toEqual([
      "ch-mail:external.participant_observed",
      "ch-mail:external.envelope_observed",
      "ch-home:external.envelope_published",
    ]);
  });

  it("reports a locked channel as closed rather than as an unknown addressee", async () => {
    const instance = await worker();
    instance.closedChannels.add("ch-sealed");
    const tool = await instance.notifyTool();
    // An agent that cannot tell "closed" from "unknown" retries forever.
    await expect(
      tool.execute("call-y", {
        content: "let me in",
        to: ["channel:ch-sealed"],
      } as never),
    ).rejects.toMatchObject({ code: "ClosedChannel" });
  });

  it("sends one envelope per target channel, not one per addressee", async () => {
    const instance = await worker();
    instance.directory = [
      {
        instanceId: "a@ch-1",
        handle: "a",
        channelId: "ch-1",
        participantId: "do:a",
      },
      {
        instanceId: "b@ch-1",
        handle: "b",
        channelId: "ch-1",
        participantId: "do:b",
      },
      {
        instanceId: "c@ch-2",
        handle: "c",
        channelId: "ch-2",
        participantId: "do:c",
      },
    ];
    const tool = await instance.notifyTool();
    await tool.execute("call-z", {
      content: "status please",
      to: ["agent:a@ch-1", "agent:b@ch-1", "agent:c@ch-2"],
    } as never);

    // An envelope belongs to exactly one log, so the fan-out is per channel.
    expect(instance.sends.map((entry) => entry.channelId)).toEqual([
      "ch-1",
      "ch-2",
    ]);
    expect(instance.sends[0]?.opts["to"]).toEqual([
      { kind: "participant", participantId: "do:a" },
      { kind: "participant", participantId: "do:b" },
    ]);
  });
});

describe("discovery", () => {
  it("prints every addressee in the exact form the send tool accepts", async () => {
    const instance = await worker();
    instance.parent = { participantId: "do:boss" };
    instance.runs = [{ runId: "run-abc", taskChannelId: "ch-task" }];
    instance.directory = [
      {
        instanceId: "gmail@ch-mail",
        handle: "gmail",
        channelId: "ch-mail",
        participantId: "do:gmail",
      },
    ];
    const result = await instance
      .discoveryTool("list_addressees")
      .execute("call-1", {} as never);

    const refs = (result.details?.["addressees"] as Array<{ ref: string }>).map(
      (row) => row.ref,
    );
    // Discovery output IS send input: anything printed here must be pasteable.
    expect(refs).toEqual([
      "(omit `to`)",
      "@scribe",
      "@explorer",
      "@gabriel",
      "parent",
      "run:run-abc",
      "agent:gmail@ch-mail",
    ]);
  });

  it("omits agents in this channel from the elsewhere list", async () => {
    const instance = await worker();
    instance.directory = [
      {
        instanceId: "scribe@ch-home",
        handle: "scribe",
        channelId: "ch-home",
        participantId: "do:scribe",
      },
    ];
    const result = await instance
      .discoveryTool("list_addressees")
      .execute("call-2", {} as never);

    // The roster already named this participant; listing it twice under two
    // different refs would make the reader pick, and one of the picks is worse.
    const refs = (result.details?.["addressees"] as Array<{ ref: string }>).map(
      (row) => row.ref,
    );
    expect(refs.filter((ref) => ref.startsWith("agent:"))).toEqual([]);
  });

  it("returns discovered agents as pasteable refs, and says so when there are none", async () => {
    const instance = await worker();
    instance.gadResults["searchAgentDirectory"] = {
      summary: { rows: 1 },
      entries: [
        {
          ref: "agent:gmail@ch-mail",
          status: "idle",
          handle: "gmail",
          displayName: "Gmail",
          summary: "Triaged 12 threads; 2 need a reply.",
        },
      ],
    };
    const discover = instance.discoveryTool("discover_agents");
    const hit = await discover.execute("call-3", { query: "email" } as never);
    const text = hit.content
      ?.map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text).toContain("agent:gmail@ch-mail");
    // The overview is the instance's own latest utterance, not a transcript dump.
    expect(text).toContain("Triaged 12 threads");

    instance.gadResults["searchAgentDirectory"] = {
      summary: { rows: 0 },
      entries: [],
    };
    const miss = await discover.execute("call-4", {
      query: "nothing here",
    } as never);
    const missText = miss.content
      ?.map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    // An empty result must point somewhere, or the agent's next move is a guess.
    expect(missText).toContain("list_addressees");
  });

  it("refuses an empty discovery query rather than listing everything", async () => {
    const instance = await worker();
    const discover = instance.discoveryTool("discover_agents");
    await expect(
      discover.execute("call-5", { query: "   " } as never),
    ).rejects.toThrow(/non-empty query/iu);
  });
});
