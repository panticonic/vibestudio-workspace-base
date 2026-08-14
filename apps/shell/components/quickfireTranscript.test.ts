import { describe, expect, it } from "vitest";
import { createInitialChannelViewState, type ChannelViewState } from "@workspace/agentic-protocol";
import { hasOpenTurn, projectTranscript, TRANSCRIPT_LIMIT } from "./quickfireTranscript";

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
    retracted?: boolean;
    handle?: string;
  }>,
  extras: {
    turns?: Array<{ turnId: string; status: "open" | "waiting" | "closed" }>;
    invocations?: Array<{ id: string; name: string; turnId: string; status?: string }>;
  } = {}
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
      blocks: [{ type: "text", content: message.text }],
      status: message.status ?? "completed",
      seq: message.seq,
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
      actor: { kind: "agent", id: "agent-1" },
    };
  }
  return state as unknown as ChannelViewState;
}

describe("projectTranscript", () => {
  it("orders by seq and attributes this device's own messages to 'you'", () => {
    const state = stateWith([
      { id: "m2", seq: 2, actorId: "agent-1", kind: "agent", text: "because it clamps", handle: "quickfire" },
      { id: "m1", seq: 1, actorId: "shell-1", text: "why is the chart cut off?" },
    ]);
    expect(projectTranscript(state, "shell-1")).toEqual([
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
      }))
    );
    const transcript = projectTranscript(state, "shell-1");
    expect(transcript).toHaveLength(TRANSCRIPT_LIMIT);
    expect(transcript[0]?.id).toBe(`m${15}`);
    expect(transcript.at(-1)?.id).toBe(`m${TRANSCRIPT_LIMIT + 14}`);
  });

  it("marks a streaming message so the surface can render the live delta", () => {
    const state = stateWith([
      { id: "m1", seq: 1, actorId: "agent-1", kind: "agent", text: "the cont", status: "streaming" },
    ]);
    expect(projectTranscript(state, "shell-1")[0]).toMatchObject({ streaming: true });
  });

  it("drops retracted messages and flags failed ones", () => {
    const state = stateWith([
      { id: "m1", seq: 1, actorId: "shell-1", text: "oops", retracted: true },
      { id: "m2", seq: 2, actorId: "agent-1", kind: "agent", text: "no model", status: "failed" },
    ]);
    const transcript = projectTranscript(state, "shell-1");
    expect(transcript.map((message) => message.id)).toEqual(["m2"]);
    expect(transcript[0]).toMatchObject({ error: true });
  });

  it("renders one chip per distinct tool used in the message's turn", () => {
    const state = stateWith(
      [{ id: "m1", seq: 1, actorId: "agent-1", kind: "agent", text: "looked", turnId: "t1" }],
      {
        invocations: [
          { id: "i1", name: "panel_describe", turnId: "t1" },
          { id: "i2", name: "panel_describe", turnId: "t1" },
          { id: "i3", name: "say", turnId: "t2" },
        ],
      }
    );
    // Two calls are two pills. Deduping by name hid repeated work — and, with
    // no state carried, hid failures behind an identical-looking chip.
    expect(projectTranscript(state, "shell-1")[0]?.toolChips).toEqual([
      { name: "panel_describe", state: "done" },
      { name: "panel_describe", state: "done" },
    ]);
  });

  it("distinguishes work in flight from work that ended badly", () => {
    const state = stateWith(
      [{ id: "m1", seq: 1, actorId: "agent-1", kind: "agent", text: "looking", turnId: "t1" }],
      {
        invocations: [
          { id: "i1", name: "panel_console", turnId: "t1", status: "running" },
          { id: "i2", name: "panel_eval", turnId: "t1", status: "failed" },
          { id: "i3", name: "panel_screenshot", turnId: "t1", status: "completed" },
        ],
      }
    );
    expect(projectTranscript(state, "shell-1")[0]?.toolChips).toEqual([
      { name: "panel_console", state: "running" },
      { name: "panel_eval", state: "failed" },
      { name: "panel_screenshot", state: "done" },
    ]);
  });
});

describe("hasOpenTurn", () => {
  it("counts waiting turns as busy so stop stays offered", () => {
    expect(hasOpenTurn(stateWith([], { turns: [{ turnId: "t1", status: "waiting" }] }))).toBe(true);
    expect(hasOpenTurn(stateWith([], { turns: [{ turnId: "t1", status: "open" }] }))).toBe(true);
    expect(hasOpenTurn(stateWith([], { turns: [{ turnId: "t1", status: "closed" }] }))).toBe(false);
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
      projectTranscript(state, "shell-1", { order: "newest-first" }).map((m) => m.text)
    ).toEqual(["third", "second", "first"]);
    // Same messages either way: order decides which end is read, never which
    // messages survive truncation.
    expect(
      projectTranscript(state, "shell-1", { order: "oldest-first" }).map((m) => m.text)
    ).toEqual(["first", "second", "third"]);
  });

  it("keeps the newest N when truncating, whichever end it reads from", () => {
    const state = stateWith(
      Array.from({ length: TRANSCRIPT_LIMIT + 3 }, (_, index) => ({
        id: `m${index}`,
        seq: index + 1,
        actorId: "shell-1",
        text: `m${index}`,
      }))
    );
    const newestFirst = projectTranscript(state, "shell-1", { order: "newest-first" });
    expect(newestFirst).toHaveLength(TRANSCRIPT_LIMIT);
    expect(newestFirst[0]?.text).toBe(`m${TRANSCRIPT_LIMIT + 2}`);
    expect(newestFirst.at(-1)?.text).toBe("m3");
  });
});
