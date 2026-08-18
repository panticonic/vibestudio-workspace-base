import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { provenanceQuestionTests } from "./provenance-questions.js";
import { assertSystemTestDeclaration } from "../prompt-contract.js";

interface ProvenanceStep {
  arguments?: Record<string, unknown>;
  text?: string;
  details?: Record<string, unknown>;
  status?: "complete" | "error";
  error?: string;
}

function execution(finalMessage: string, steps: readonly ProvenanceStep[]): TestExecutionResult {
  const messages = steps.map((step, index) => ({
    id: `call-${index}`,
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "invocation",
    content: JSON.stringify({
      id: `call-${index}`,
      name: "provenance",
      arguments: step.arguments ?? {},
      execution: {
        status: step.status ?? "complete",
        isError: step.status === "error",
        ...(step.error ? { error: step.error } : {}),
        result: {
          protocolContent: [{ type: "text", text: step.text ?? "" }],
          details: step.details ?? {},
        },
      },
    }),
  }));
  messages.push({
    id: "final",
    kind: "message",
    senderId: "agent",
    senderMetadata: { type: "agent" },
    complete: true,
    contentType: "text",
    content: finalMessage,
  } as (typeof messages)[number]);
  return { messages: messages as TestExecutionResult["messages"], duration: 1 };
}

const causeCase = provenanceQuestionTests.find(
  (test) => test.name === "provenance-recovers-the-originating-request"
)!;
const queryCase = provenanceQuestionTests.find(
  (test) => test.name === "provenance-answers-a-set-shaped-question"
)!;
const visibilityCase = provenanceQuestionTests.find(
  (test) => test.name === "provenance-holds-the-visibility-boundary"
)!;

const GOOD_CAUSE_BLOCK =
  'cause · work-unit @r2-b0c2\n  stated "keep it at 64 because the Pelagic relay drops any export payload above 512 KiB"\n  human statement · turn @r4-a4c9\ncontinue: pass any @ref back as target';

const GOOD_ANSWER =
  "It was set to 64 because the Pelagic relay drops export payloads above 512 KiB.";

describe("provenance question scenarios", () => {
  it("forks ordinary phases while keeping deliberate local-history continuity explicit", async () => {
    const contexts: string[] = [];
    const session = () => ({
      messages: [],
      close: async () => undefined,
      snapshot: () => ({ messages: [], invocations: [], cleanupErrors: [] }),
    });
    const orchestration = {
      runner: {
        workspaceRepoName: "fixture",
        spawn: async ({ context }: { context: string }) => {
          contexts.push(context);
          return session();
        },
      },
      sendAndWait: async () => undefined,
    };

    await visibilityCase.orchestrate!(orchestration as never);
    expect(contexts).toEqual(["fork", "fork"]);

    contexts.length = 0;
    await causeCase.orchestrate!(orchestration as never);
    expect(contexts).toEqual(["task", "task"]);
  });

  it("declares user goals rather than call choreography", () => {
    for (const test of provenanceQuestionTests) {
      expect(() => assertSystemTestDeclaration(test)).not.toThrow();
      expect(test.validation).toBe("agent-evidence");
      // Most cases read a record the fixture seeded exactly; only the two whose
      // subject *is* a live trajectory or a second context still orchestrate.
      expect(test.workspaceRepoFixture ?? test.orchestrate).toBeDefined();
    }
  });

  it("accepts a recovered answer carried by a live, hygienic walk", () => {
    const result = causeCase.validate(
      execution(GOOD_ANSWER, [
        {
          arguments: { target: "src/export-batching.ts", walk: "cause" },
          text: GOOD_CAUSE_BLOCK,
          details: { walk: "cause", entryCount: 4 },
        },
      ])
    );
    expect(result).toEqual({ passed: true });
  });

  it("fails when the surface errored instead of answering or refusing", () => {
    const result = causeCase.validate(
      execution(GOOD_ANSWER, [
        {
          arguments: { target: "src/export-batching.ts", walk: "cause" },
          status: "error",
          error: '[vcs.walk] Invalid semantic VCS method "vcsWalk"',
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("failed rather than answered");
  });

  it("fails when every relational query is refused", () => {
    const result = queryCase.validate(
      execution("Four pieces of work: retry-policy, socket-policy, upload-policy, and cache-policy.", [
        {
          arguments: { query: "SELECT work_unit_id FROM prov_work_units" },
          details: { rowCount: 0, refused: "plan-unavailable" },
        },
        {
          arguments: { query: "SELECT change_id FROM prov_changes" },
          details: { rowCount: 0, refused: "plan-unavailable" },
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("indistinguishable from a dead one");
  });

  it("accepts a refusal as long as the surface also executed", () => {
    const result = queryCase.validate(
      execution("Four pieces of work: retry-policy, socket-policy, upload-policy, and cache-policy.", [
        {
          arguments: { query: "SELECT * FROM prov_changes, prov_work_units" },
          details: { rowCount: 0, refused: "unknown-relation" },
        },
        {
          arguments: { query: "SELECT work_unit_id FROM prov_work_units" },
          details: { rowCount: 3, refused: null },
        },
      ])
    );
    expect(result).toEqual({ passed: true });
  });

  it("fails when a rendered block spells a content-addressed identity", () => {
    const result = causeCase.validate(
      execution(GOOD_ANSWER, [
        {
          arguments: { target: "src/export-batching.ts", walk: "cause" },
          text: `cause · work-unit:${"9f3a".repeat(8)}\n  stated "512 KiB Pelagic relay"`,
          details: { walk: "cause", entryCount: 1 },
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("content-addressed identity");
  });

  it("fails when the answer never establishes the recovered constraint", () => {
    const result = causeCase.validate(
      execution("Someone changed that line a while ago.", [
        {
          arguments: { target: "src/export-batching.ts", walk: "cause" },
          text: GOOD_CAUSE_BLOCK,
          details: { walk: "cause", entryCount: 4 },
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("did not establish");
  });
});

describe("diagnosis, not just a verdict", () => {
  const flagship = provenanceQuestionTests.find(
    (test) => test.name === "provenance-recovers-an-unstated-constraint"
  )!;
  const rejectionBlock =
    'prov rejections · @r1-0000 · what was tried and rejected here\n' +
    '  counteractions (1)\n' +
    '    stated: "staging cut the link before the retry fired" · undone · edit src/retry-policy.ts · @r2-0000';

  it("blames the mechanism when the evidence never arrived", () => {
    const result = flagship.validate(
      execution("Looks fine, added a ten minute keepalive; nothing was dropped before.", [
        {
          arguments: { target: "src/retry-policy.ts", walk: "rejections" },
          text: "prov rejections · @r1-0000 · what was tried and rejected here\n  note · Nothing has been rejected at this coordinate in your visible basis.",
          details: { walk: "rejections", entryCount: 0 },
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("the mechanism failed before the agent's reasoning was tested");
  });

  it("blames the reasoning when the evidence did arrive and was ignored", () => {
    // This is the measured abduction gap: everything worked and the agent still
    // repeated the rejected work. The validator has to say so specifically,
    // otherwise the flagship reads as a broken surface every time it fails.
    const result = flagship.validate(
      execution("This project configures policy by constants, so a keepalive fits well here.", [
        {
          arguments: { target: "src/retry-policy.ts", walk: "rejections" },
          text: rejectionBlock,
          details: { walk: "rejections", entryCount: 1 },
        },
      ])
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("did not establish");
  });

  it("passes when the agent surfaces the conflict the evidence implies", () => {
    const result = flagship.validate(
      execution(
        "I would not do this here: holding one connection open for ten minutes is the same shape as the 300-second backoff that was reverted after staging dropped the link.",
        [
          {
            arguments: { target: "src/retry-policy.ts", walk: "rejections" },
            text: rejectionBlock,
            details: { walk: "rejections", entryCount: 1 },
          },
        ]
      )
    );
    expect(result).toEqual({ passed: true });
  });
});
