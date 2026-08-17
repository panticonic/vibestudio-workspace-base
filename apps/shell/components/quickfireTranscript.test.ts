import { describe, expect, it } from "vitest";
import {
  createInitialChannelViewState,
  type ChannelViewState,
} from "@workspace/agentic-protocol";
import {
  hasOpenTurn,
  projectTranscript,
  TRANSCRIPT_LIMIT,
} from "./quickfireTranscript";

/**
 * The projected maps are keyed by branded ids. The fixtures below build plain
 * records deliberately — the projection only reads structure, and branding the
 * fixtures would test the brand rather than the behavior.
 */
type Mutable = {
  messages: Record<string, unknown>;
  turns: Record<string, unknown>;
  invocations: Record<string, unknown>;
};

function stateWith(
  messages: Array<{
    id: string;
    seq: number;
    actorId: string;
    kind?: "user" | "agent";
    text: string;
    status?: "started" | "streaming" | "completed" | "failed";
    turnId?: string;
    blocks?: Array<{ type: "text" | "thinking"; content: string }>;
    retracted?: boolean;
    handle?: string;
  }>,
  extras: {
    turns?: Array<{ turnId: string; status: "open" | "waiting" | "closed" }>;
    invocations?: Array<{
      id: string;
      name: string;
      turnId: string;
      status?: string;
      request?: unknown;
      result?: unknown;
      progress?: Array<{ at: string; message?: string }>;
      failure?: unknown;
    }>;
  } = {},
): ChannelViewState {
  const state = createInitialChannelViewState() as unknown as Mutable;
  for (const message of messages) {
    state.messages[message.id] = {
      messageId: message.id,
      actor: {
        kind: message.kind ?? "user",
        id: message.actorId,
        participantId: message.actorId,
        ...(message.handle ? { displayName: message.handle } : {}),
      },
      role: message.kind === "agent" ? "assistant" : "user",
      blocks: message.blocks ?? [{ type: "text", content: message.text }],
      status: message.status ?? "completed",
      seq: message.seq,
      startedAt: new Date((message.seq + 1) * 1000).toISOString(),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.retracted ? { retracted: true } : {}),
    };
  }
  for (const turn of extras.turns ?? []) {
    state.turns[turn.turnId] = {
      turnId: turn.turnId,
      actor: { kind: "agent", id: "agent-1" },
      status: turn.status,
      openedAt: "2026-08-14T00:00:00.000Z",
    };
  }
  for (const invocation of extras.invocations ?? []) {
    state.invocations[invocation.id] = {
      invocationId: invocation.id,
      name: invocation.name,
      turnId: invocation.turnId,
      status: invocation.status ?? "completed",
      outputs: [],
      progress: invocation.progress ?? [],
      ...(invocation.request === undefined
        ? {}
        : { request: invocation.request }),
      ...(invocation.result === undefined ? {} : { result: invocation.result }),
      ...(invocation.failure === undefined
        ? {}
        : { failure: invocation.failure }),
      actor: { kind: "agent", id: "agent-1" },
    };
  }
  return state as unknown as ChannelViewState;
}

describe("projectTranscript", () => {
  it("orders by seq and attributes this device's own messages to 'you'", () => {
    const state = stateWith([
      {
        id: "m2",
        seq: 2,
        actorId: "agent-1",
        kind: "agent",
        text: "because it clamps",
        handle: "quickfire",
      },
      {
        id: "m1",
        seq: 1,
        actorId: "shell-1",
        text: "why is the chart cut off?",
      },
    ]);
    expect(projectTranscript(state, "shell-1").entries).toEqual([
      expect.objectContaining({
        id: "m1",
        author: "you",
        authorLabel: "you",
        text: "why is the chart cut off?",
      }),
      expect.objectContaining({
        id: "m2",
        author: "agent",
        authorLabel: "quickfire",
        text: "because it clamps",
      }),
    ]);
  });

  it("ships only the tail, so the overlay never carries a whole transcript", () => {
    const state = stateWith(
      Array.from({ length: TRANSCRIPT_LIMIT + 15 }, (_, index) => ({
        id: `m${index}`,
        seq: index,
        actorId: "shell-1",
        text: `message ${index}`,
      })),
    );
    const transcript = projectTranscript(state, "shell-1").entries;
    expect(transcript).toHaveLength(TRANSCRIPT_LIMIT);
    expect(transcript[0]?.id).toBe(`m${15}`);
    expect(transcript.at(-1)?.id).toBe(`m${TRANSCRIPT_LIMIT + 14}`);
  });

  it("marks a streaming message so the surface can render the live delta", () => {
    const state = stateWith([
      {
        id: "m1",
        seq: 1,
        actorId: "agent-1",
        kind: "agent",
        text: "the cont",
        status: "streaming",
      },
    ]);
    expect(projectTranscript(state, "shell-1").entries[0]).toMatchObject({
      streaming: true,
    });
  });

  it("shows activity immediately after send, before the durable turn exists", () => {
    expect(
      projectTranscript(stateWith([]), "shell-1", { awaitingResponse: true })
        .entries,
    ).toEqual([
      {
        kind: "activity",
        id: "activity:awaiting-response",
        state: "working",
        phase: "starting",
        label: "starting",
      },
    ]);
  });

  it("keeps a responding activity row beside the live text delta", () => {
    const state = stateWith(
      [
        {
          id: "m1",
          seq: 2,
          actorId: "agent-1",
          kind: "agent",
          text: "The channel id is",
          status: "streaming",
          turnId: "t1",
        },
      ],
      { turns: [{ turnId: "t1", status: "open" }] },
    );
    expect(projectTranscript(state, "shell-1").entries).toEqual([
      expect.objectContaining({ kind: "message", streaming: true }),
      expect.objectContaining({
        kind: "activity",
        phase: "responding",
        label: "responding",
      }),
    ]);
  });

  it("shows thinking and every tool call before an assistant message exists", () => {
    const thinking = stateWith(
      [
        {
          id: "m1",
          seq: 2,
          actorId: "agent-1",
          kind: "agent",
          text: "",
          status: "streaming",
          turnId: "t1",
          blocks: [{ type: "thinking", content: "Inspecting the panel" }],
        },
      ],
      { turns: [{ turnId: "t1", status: "open" }] },
    );
    expect(projectTranscript(thinking, "shell-1").entries.at(-1)).toMatchObject(
      {
        kind: "activity",
        phase: "thinking",
        label: "thinking",
      },
    );

    const usingTools = stateWith([], {
      turns: [{ turnId: "t1", status: "open" }],
      invocations: [
        { id: "i1", name: "panel_describe", turnId: "t1", status: "completed" },
        { id: "i2", name: "panel_screenshot", turnId: "t1", status: "running" },
      ],
    });
    expect(projectTranscript(usingTools, "shell-1").entries).toEqual([
      expect.objectContaining({
        kind: "activity",
        phase: "using-tools",
        label: "using tools",
        toolCalls: [
          { id: "i1", name: "panel_describe", state: "done" },
          { id: "i2", name: "panel_screenshot", state: "running" },
        ],
      }),
    ]);
  });

  it("renders a waiting turn as an explicit request for the user", () => {
    const state = stateWith([], {
      turns: [{ turnId: "t1", status: "waiting" }],
    });
    expect(projectTranscript(state, "shell-1").entries).toContainEqual(
      expect.objectContaining({
        kind: "activity",
        state: "waiting",
        phase: "waiting",
        label: "Waiting for input",
      }),
    );
  });

  it("drops retracted messages and flags failed ones", () => {
    const state = stateWith([
      { id: "m1", seq: 1, actorId: "shell-1", text: "oops", retracted: true },
      {
        id: "m2",
        seq: 2,
        actorId: "agent-1",
        kind: "agent",
        text: "no model",
        status: "failed",
      },
    ]);
    const transcript = projectTranscript(state, "shell-1").entries;
    expect(transcript.map((message) => message.id)).toEqual(["m2"]);
    expect(transcript[0]).toMatchObject({ error: true });
  });

  it("renders one chip per distinct tool used in the message's turn", () => {
    const state = stateWith(
      [
        {
          id: "m1",
          seq: 1,
          actorId: "agent-1",
          kind: "agent",
          text: "looked",
          turnId: "t1",
        },
      ],
      {
        invocations: [
          { id: "i1", name: "panel_describe", turnId: "t1" },
          { id: "i2", name: "panel_describe", turnId: "t1" },
          { id: "i3", name: "say", turnId: "t2" },
        ],
      },
    );
    // Two calls are two pills. Deduping by name hid repeated work — and, with
    // no state carried, hid failures behind an identical-looking chip.
    const [first] = projectTranscript(state, "shell-1").entries;
    expect(first?.kind).toBe("message");
    expect(first?.kind === "message" ? first.toolCalls : undefined).toEqual([
      { id: "i1", name: "panel_describe", state: "done" },
      { id: "i2", name: "panel_describe", state: "done" },
    ]);
  });

  it("distinguishes work in flight from work that ended badly", () => {
    const state = stateWith(
      [
        {
          id: "m1",
          seq: 1,
          actorId: "agent-1",
          kind: "agent",
          text: "looking",
          turnId: "t1",
        },
      ],
      {
        invocations: [
          { id: "i1", name: "panel_console", turnId: "t1", status: "running" },
          { id: "i2", name: "panel_eval", turnId: "t1", status: "failed" },
          {
            id: "i3",
            name: "panel_screenshot",
            turnId: "t1",
            status: "completed",
          },
        ],
      },
    );
    const [first] = projectTranscript(state, "shell-1").entries;
    expect(first?.kind).toBe("message");
    expect(first?.kind === "message" ? first.toolCalls : undefined).toEqual([
      { id: "i1", name: "panel_console", state: "running" },
      { id: "i2", name: "panel_eval", state: "failed" },
      { id: "i3", name: "panel_screenshot", state: "done" },
    ]);
  });

  it("keeps thinking distinct and exposes bounded invocation details", () => {
    const state = stateWith(
      [
        {
          id: "m1",
          seq: 1,
          actorId: "agent-1",
          kind: "agent",
          text: "",
          turnId: "t1",
          blocks: [{ type: "thinking", content: "Checking **the panel**" }],
        },
        {
          id: "m2",
          seq: 2,
          actorId: "agent-1",
          kind: "agent",
          text: "Done",
          turnId: "t1",
        },
      ],
      {
        invocations: [
          {
            id: "i1",
            name: "panel_eval",
            turnId: "t1",
            status: "failed",
            request: { expression: "document.title" },
            progress: [{ at: "now", message: "Evaluating" }],
            failure: { message: "Panel closed" },
          },
        ],
      },
    );
    expect(projectTranscript(state, "shell-1").entries).toEqual([
      expect.objectContaining({
        kind: "thinking",
        text: "Checking **the panel**",
      }),
      expect.objectContaining({
        kind: "message",
        toolCalls: [
          expect.objectContaining({
            id: "i1",
            input: expect.stringContaining("document.title"),
            progress: ["Evaluating"],
            failure: expect.stringContaining("Panel closed"),
          }),
        ],
      }),
    ]);
  });
});

describe("hasOpenTurn", () => {
  it("counts waiting turns as busy so stop stays offered", () => {
    expect(
      hasOpenTurn(
        stateWith([], { turns: [{ turnId: "t1", status: "waiting" }] }),
      ),
    ).toBe(true);
    expect(
      hasOpenTurn(stateWith([], { turns: [{ turnId: "t1", status: "open" }] })),
    ).toBe(true);
    expect(
      hasOpenTurn(
        stateWith([], { turns: [{ turnId: "t1", status: "closed" }] }),
      ),
    ).toBe(false);
    expect(hasOpenTurn(stateWith([]))).toBe(false);
  });
});

describe("transcript order", () => {
  it("reads newest-first for a surface whose input is at the top", () => {
    const state = stateWith([
      { id: "m1", seq: 1, actorId: "shell-1", text: "first" },
      { id: "m2", seq: 2, actorId: "agent-1", kind: "agent", text: "second" },
      { id: "m3", seq: 3, actorId: "shell-1", text: "third" },
    ]);
    expect(
      projectTranscript(state, "shell-1", { order: "newest-first" })
        .entries.filter((m) => m.kind === "message")
        .map((m) => m.text),
    ).toEqual(["third", "second", "first"]);
    // Same messages either way: order decides which end is read, never which
    // messages survive truncation.
    expect(
      projectTranscript(state, "shell-1", { order: "oldest-first" })
        .entries.filter((m) => m.kind === "message")
        .map((m) => m.text),
    ).toEqual(["first", "second", "third"]);
  });

  it("keeps the newest N when truncating, whichever end it reads from", () => {
    const state = stateWith(
      Array.from({ length: TRANSCRIPT_LIMIT + 3 }, (_, index) => ({
        id: `m${index}`,
        seq: index + 1,
        actorId: "shell-1",
        text: `m${index}`,
      })),
    );
    const newestFirst = projectTranscript(state, "shell-1", {
      order: "newest-first",
    }).entries;
    expect(newestFirst).toHaveLength(TRANSCRIPT_LIMIT);
    expect(newestFirst[0]).toMatchObject({
      kind: "message",
      text: `m${TRANSCRIPT_LIMIT + 2}`,
    });
    expect(newestFirst.at(-1)).toMatchObject({ kind: "message", text: "m3" });
  });
});

/**
 * What the compact venue is entitled to do is *abbreviate*. It is not entitled
 * to disagree with the channel about what happened, which is what dropping a
 * content type quietly amounts to.
 */
describe("nothing is elided", () => {
  it("announces an agent card it will not run, without dumping its payload", () => {
    const state = stateWith([]) as unknown as {
      customMessages: Record<string, unknown>;
    };
    state.customMessages["card-1"] = {
      messageId: "card-1",
      typeId: "revenue-chart",
      displayMode: "inline",
      initialState: { rows: [1, 2, 3] },
      updates: [],
      lastSeq: 4,
      startedAt: "2026-08-14T00:00:10.000Z",
    };

    const entries = projectTranscript(
      state as unknown as ChannelViewState,
      "shell-1",
    ).entries;
    expect(entries).toEqual([
      // No `at`: the merge does not carry a timestamp for card rows, and the
      // surface omits the field rather than inventing "just now".
      { kind: "rich", id: "custom:card-1", title: "Card · revenue-chart" },
    ]);
    // The serialized card state is not prose and never becomes the body.
    expect(JSON.stringify(entries)).not.toContain("rows");
  });

  it("carries a message's time, and a tool call's duration", () => {
    const state = stateWith(
      [
        {
          id: "m1",
          seq: 1,
          actorId: "agent-1",
          kind: "agent",
          text: "read it",
          turnId: "t1",
        },
      ],
      {
        invocations: [
          { id: "i1", name: "panel_console", turnId: "t1", status: "completed" },
        ],
      },
    );
    const invocation = (state as unknown as { invocations: Record<string, Record<string, unknown>> })
      .invocations["i1"]!;
    invocation["startedAt"] = "2026-08-14T00:00:00.000Z";
    invocation["completedAt"] = "2026-08-14T00:00:01.500Z";

    const [entry] = projectTranscript(state, "shell-1").entries;
    expect(entry).toMatchObject({
      kind: "message",
      at: Date.parse(new Date(2000).toISOString()),
      toolCalls: [expect.objectContaining({ name: "panel_console", durationMs: 1500 })],
    });
  });
});
