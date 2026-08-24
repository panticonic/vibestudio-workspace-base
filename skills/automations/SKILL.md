---
name: automations
description: Launch recurring or later work immediately, then inspect and control its exact behavior, authority, runs, conversations, results, and failures.
---

# Automations

Use this skill for work that should run later, repeatedly, on a calendar, or on demand without another chat turn. Read [API.md](API.md) before authoring or debugging an automation.

`vibestudio.missions.v1` is the only schedule and run-ledger owner. Do not add a second timer, worker cron, alarm loop, queue, or history store.

For work performed by the current agent, call `launch_automation` directly. A successful call creates an active automation immediately and publishes an inspectable automation pill in the current conversation. The pill is a controller, not an approval gate. It opens the same definition and run history shown in **Automations**.

## Choose the executor

- Use an agent `prompt` when a model should reason each run.
- Use agent `eval` for a small exact script that should run as the same agent and use its ordinary channel-bound EvalDO.
- Use a lower-level `method` charter for a reusable deterministic method on another exact Durable Object image.

Choose `conversation: { mode: "fresh" }` for isolated runs. Choose `continue` only when the current conversation’s accumulated context is part of the task; the tool binds the channel and context itself.

## Launch correctly

1. Resolve only user choices that materially alter the job: behavior, cadence and timezone, optional end condition, and fresh versus continuing conversation.
2. Enumerate every semantic service operation the action may perform. Declare each as `{ service, method, args?, use }`, where `use` is `action` or `conditional`. These are behavior declarations, not capability names or grants.
   Declare only external service calls made by the action. Scheduling, fresh-conversation creation, delivery of the eval result into that conversation, and the `automation-completion.v1` return are intrinsic mission behavior: do not invent `missions.finishRun`, `chat.publish`, or similar operations for them.
3. Call `launch_automation` once with the action, trigger, conversation mode, and operations. Do not wrap it in eval and do not discover the current agent’s build, class, object key, channel, or context first; the receiver seals those facts atomically.
4. Report the active automation’s name and cadence. Point to its pill for inspection or control; do not publish a second card or ask for a second launch approval.

Example:

```ts
({
  name: "Talk timer",
  summary: "Every minute, tell the owner that another minute has passed.",
  action: {
    kind: "prompt",
    text: "Notify the owner with the exact text: ⏱️ One minute has passed.",
  },
  trigger: { kind: "schedule", everyMs: 60_000 },
  conversation: { mode: "fresh" },
  operations: [
    {
      service: "notification",
      method: "showToUser",
      use: "action",
    },
  ],
});
```

For a small model-free project-status check, return the status text from eval; the run publishes that result in its conversation. Declare the status read itself:

```ts
({
  name: "Project pulse",
  summary: "Report project status every Thursday morning.",
  action: {
    kind: "eval",
    code: `
      import { vcs } from "@workspace/runtime";
      const status = await vcs.status();
      if (status.clean && status.mainRelation === "at") {
        return {
          protocol: "automation-completion.v1",
          response: "The project is clean and in sync.",
        };
      }
      return "Project pulse: " + status.mainRelation;
    `,
    syntax: "typescript",
  },
  trigger: {
    kind: "cron",
    expression: "5 5 * * THU",
    timezone: "America/New_York",
  },
  conversation: { mode: "fresh" },
  operations: [{ service: "vcs", method: "status", use: "action" }],
});
```

## Authority

The agent never authors capability rows. At launch, the host compiles declared operations against receiver-owned method contracts into an immutable, content-addressed operation policy. It derives the exact capability and resource for each operation and starts durable acquisition for every gated operation eligible for standing mission authority.

The authenticated user who requested launch is recorded as the owner of the revision subject `mission:<id>@<revisionDigest>`. Grants belong to that subject, not to a channel, transient eval runtime, or model-authored identity. Channel IDs are routing facts, never authority subjects; context IDs are conversation facts.

Pre-acquisition is the normal authoring path, but it is not a runtime restriction. If authority is absent when an admitted run reaches an operation, ordinary acquisition presents the exact approval, durably parks the invocation, and resumes after the decision. Critical or otherwise non-standing authority always uses that invocation-time path. In particular, do not force automation eval into `pregranted-only`.

Do not broaden operations to avoid an approval. A denial is evidence to preserve and explain, not a reason to retry through another caller or transport.

## Scheduling

Use `{ kind: "manual" }` for run-on-demand work.

Use an interval for elapsed cadence:

```ts
{
  kind: "schedule",
  everyMs: 3_600_000,
  anchorAt: Date.UTC(2026, 7, 12, 6, 0), // optional alignment
  jitterMs: 300_000,                    // optional
  untilAt: Date.UTC(2026, 8, 1),        // optional exclusive boundary
  maxRuns: 100,                         // optional admitted runs
}
```

Use cron for wall-clock cadence and always provide an IANA timezone:

```ts
{
  kind: "cron",
  expression: "5 5 * * THU",
  timezone: "America/New_York",
  maxRuns: 20,
}
```

The minimum cadence is one minute. `untilAt` prevents a run starting at or after the boundary. `maxRuns` counts admitted runs; overlap skips do not count. Calendar evaluation follows the declared timezone through daylight-saving transitions.

## Lifecycle and recovery

- `pause` stops new admission and preserves the revision’s standing grants.
- `resume` re-enables the same revision.
- `edit` creates a new immutable revision, policy, subject, and authority acquisition.
- `retire` permanently prevents new runs and retires revision authority after live executions close.
- A failure is recorded on the run; it does not silently pause the automation.

Runs use durable phases. On wake or restart, the mission owner resumes nonterminal phases before admitting newly due work. External effects use stable idempotency keys derived from the run and phase.

A prompt can complete its recurring goal with `complete_automation({ response })`. Eval or method code returns the equivalent protocol:

```ts
return {
  protocol: "automation-completion.v1",
  response: "The monitored rollout is healthy.",
};
```

When debugging, inspect the automation pill or **Automations** for the compiled policy reference, declared operations, pending/granted/denied authority, current run phase, executor, and structured failure. Do not infer authority from a channel ID or a successful prior run.
