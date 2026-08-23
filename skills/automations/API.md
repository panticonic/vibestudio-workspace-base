# Automations API

Resolve protocol `vibestudio.missions.v1` with `workers.resolveService(...)`,
then call the returned Durable Object target with `rpc.call(targetId, method,
args)`. The service is context-aware and user-scoped.

Agent-authored definitions use the native `launch_automation(input)` tool. The receiver atomically fills the current
agent's exact source, class, object key, installed effective version, and—when
continuing—the current channel/context. It then calls `launch` with a
transport idempotency key and, before returning, publishes one typed
`automation.instituted` event as the owning agent in the current channel. This
is the documented launch path because it supplies trusted channel provenance
without making guest code discover or assert runtime identity. Direct service
calls remain the lower-level lifecycle contract for method jobs and non-chat
integrations.

This service owns the complete automation lifecycle: definition installation,
schedule delivery, non-overlapping execution, durable run history,
terminal summaries and errors, and agent-conversation identity. Callers must
not create a second timer, queue, conversation loop, or run ledger around it.

## Agent-owned launch

```ts
type AgentAutomationLaunch = {
  name: string;
  summary: string;
  action:
    | { kind: "prompt"; text: string }
    | {
        kind: "eval";
        code: string;
        syntax?: "javascript" | "typescript" | "jsx" | "tsx";
        timeoutMs?: number;
        reset?: boolean;
      };
  trigger: MissionTrigger;
  conversation?: { mode: "fresh" | "continue" }; // default fresh
  toolExposure?: MissionToolExposure; // default: bound, no services/network
  declaredLineageClasses?: Array<
    "none" | "web" | "email" | "channel-external" | "external"
  >; // default ["none"]
  permissions?: MissionPermission[]; // default []
  standingRestrictions?: MissionStandingRestriction[];
};

type MissionPermission = {
  capability: string;
  resource:
    | { kind: "exact"; key: string }
    | { kind: "prefix"; prefix: string }
    | { kind: "origin"; origin: string }
    | { kind: "domain"; domain: string }
    | { kind: "network"; value: "*" };
  tier: "gated";
};
```

Call the `launch_automation` tool directly. Do not wrap it in eval or precede it with
`agent.describe()`, `build.getEffectiveVersion`, or `workers.resolveService`.
Those calls are unnecessary and make one launch depend on several mutable
observations. The installed vessel supplies one coherent target/version
snapshot at the receiver boundary. The tool returns only after the active
mission and its idempotent running pill are durable.

Before launch, walk every operation reachable from the action:

1. Add the exact host method to `toolExposure.services`, or add the exact
   reviewed binding to `toolExposure.userlandServices`.
2. Read that operation's authority metadata. Open operations need no
   permission. For a gated operation whose grant scopes include `mission`, add
   its exact capability and least resource scope to `permissions`.
3. Do not put critical or non-mission-grantable authority in `permissions`;
   launch rejects it because it cannot truthfully become standing authority.

Exposure and authority are independent attenuation terms: neither substitutes
for the other. The platform adds the sealed agent/channel/workspace harness
exposure and grants automatically. At runtime, installed standing grants are
used first. If the author missed a grant—or the operation can only be approved
per invocation—the ordinary approval flow presents a durable approval and
parks the run until the user decides. The fallback is recovery, not the normal
authoring strategy.

`conversation: { mode: "continue" }` means this exact conversation; the binding
fills its channel and context. The input intentionally cannot target a different
agent. Use the canonical lower-level Missions service when a method on
another target is the behavior you actually want.

## Canonical charter (lower-level Missions API)

```ts
type Charter = {
  summary: string;
  harness: {
    unit: string;
    ev: string; // exact 64-hex compiled effective version
    ref: `state:${string}`; // immutable source snapshot used to recreate the target
  };
  execution:
    | {
        kind: "method";
        target: { source: string; className: string; objectKey: string };
        method: string;
        args: unknown[];
      }
    | {
        kind: "agent";
        target: { source: string; className: string; objectKey: string };
        action:
          | { kind: "prompt"; text: string }
          | {
              kind: "eval";
              code: string;
              syntax?: "javascript" | "typescript" | "jsx" | "tsx";
              timeoutMs?: number;
              reset?: boolean;
            };
        conversation:
          | { mode: "fresh" }
          | { mode: "continue"; channelId: string; contextId: string };
        toolExposure: {
          services: string[];
          userlandServices: Array<{
            name: string;
            provider: string;
            providerEv: string;
            upgradePolicy: "pinned" | "follow-head";
          }>;
          workspaceServiceDiscovery: "bound" | "live-declarations";
          evalNetwork: "none" | "declared-origins" | "unrestricted";
          declaredOrigins: string[];
        };
        declaredLineageClasses: Array<
          "none" | "web" | "email" | "channel-external" | "external"
        >;
      };
  trigger:
    | { kind: "manual" }
    | {
        kind: "schedule";
        everyMs: number;
        anchorAt?: number;
        jitterMs?: number;
        untilAt?: number;
        maxRuns?: number;
      }
    | {
        kind: "cron";
        expression: string; // five-field Vixie cron
        timezone: string; // canonical IANA timezone
        untilAt?: number;
        maxRuns?: number;
      };
};
```

The harness unit must equal the execution target source. The EV identifies the
compiled installed unit; the state ref independently identifies the immutable
source snapshot from which a future target is recreated. Neither hash is a
substitute for the other. Every behavior-bearing field participates in the
installed closure digest. `agent/eval` stores exact
inline EvalDO source in that closure and is the happy path for a small script
that should run as an existing agent/channel participant. It deliberately does
not accept a mutable context-file path or npm import map. Use ambient runtime
bindings and automatically resolved workspace APIs; move a multi-file or
dependency-heavy job into a reviewed method worker.

The eval action is model-free. AgentDO journals `message.completed` with the
tool call, `invocation.started`, the terminal eval result, and `turn.closed` in
the ordinary channel trajectory. EvalDO uses the ordinary prompt-capable
authority policy under the installed mission closure. Standing grants are
tried first; missing or non-standing authority creates the same durable
approval as an interactive eval, parks the run, and resumes it after the user
decides. Code may use ambient `chat` to publish typed/custom messages with the
agent's identity. The mission service remains the only schedule and run-ledger
owner.

Interval schedules are elapsed-time cadences with an optional alignment anchor
and jitter. Cron schedules are wall-clock cadences evaluated in the reviewed
IANA timezone, including daylight-saving transitions. Both accept `untilAt`
(no new run starts at or after the boundary) and `maxRuns` (total admitted runs;
failures count and overlap skips do not). The count survives revisions.

The shared chat-history inspector and Automations dashboard render calendar
schedules in plain language. Their editor round-trips common hourly, daily,
weekly, and monthly expressions through visual controls and preserves all other
valid expressions in an Advanced editor with validation and upcoming-run
previews. Both paths save the same canonical `cron` trigger.

A prompt tick can end its recurring goal by calling
`complete_automation({ response })`. Eval and method executions return the same
signal as data:

```ts
return {
  protocol: "automation-completion.v1",
  response: "All rollout targets are healthy; monitoring is complete.",
};
```

Ordinary successful results continue the schedule. The explicit completion
response transitions the definition to `completed`, is retained on the run and
definition, and wins over a count/time boundary reached on that same run.

## Methods

| Method     | Arguments                                               | Result                                                     | Use                                         |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `overview` | `{ limit?, cursor?, filter?, query? }`                  | paged definitions, global counts, recent runs and failures | supervision dashboards and quick inspection |
| `list`     | none                                                    | all visible definitions                                    | definition tooling                          |
| `get`      | `missionId`                                             | definition or `null`                                       | addressed inspection                        |
| `listRuns` | `missionId`, `{ limit?, cursor? }`                      | `{ items, nextCursor? }`                                   | paged historical ledger                     |
| `getRun`   | `runId`                                                 | exact run or `null`                                        | chat tick inspection                        |
| `launch`   | `{ name, charter, permissions, standingRestrictions? }` | active definition                                          | atomic creation and immediate scheduling    |
| `edit`     | `missionId`, changed fields                             | installed active revision                                  | behavior changes applied immediately        |
| `runNow`   | `missionId`                                             | new run record                                             | explicit manual execution                   |
| `pause`    | `missionId`                                             | paused definition                                          | stop future triggers                        |
| `resume`   | `missionId`                                             | active definition                                          | resume unchanged installed closure          |
| `retire`   | `missionId`                                             | retired definition                                         | permanent shutdown                          |

`overview` defaults to 30 definitions and accepts at most 50. Its `stats`
contains global `total`, `active`, `running`, `failedLast24Hours`, and
`completed` counts regardless of the page or filter.
Filters are `all`, `attention`, `active`, `paused`, and `completed`;
`query` searches names and
summaries on the server. Pass its exact `nextCursor` to fetch another page.

`listRuns` defaults to 20 and accepts at most 100. Pass the exact
`nextCursor` returned by the preceding page.

Ordinary agent sessions can discover and call `edit`, `runNow`, `pause`,
`resume`, and `retire` through the live service catalog, subject to their normal
gated/critical authority. `launch_automation` is the trusted self-targeting
creation path; there is no proposal or review transition.

## Run record

```ts
type Run = {
  runId: string;
  missionId: string;
  closureDigest: string;
  revision: number;
  trigger: "manual" | "scheduled";
  status: "starting" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: number;
  runNumber?: number; // absent only for visible overlap skips and old history
  finishedAt?: number;
  channelId?: string;
  contextId?: string;
  finalMessage?: string;
  completionResponse?: string;
  error?: string;
};
```

Agent runs close from the exact terminal turn. Method runs close after their RPC
returns or throws. Stored final messages and errors are bounded; full agent
detail remains in the linked conversation. `channelId` and `contextId` are the
canonical deep-link identity for that conversation; do not derive a link from
names or run order.

Mission records also include lifetime `runCount`, `activatedAt` after launch,
and—when naturally ended—`completedAt`, `completionReason`
(`until`, `max-runs`, or `response`), and optional `completionResponse`. Chat
turn metadata carries a bounded immutable tick snapshot—mission/run ids, run
number, name, revision, action, trigger, schedule, creation/activation times—so
collapsed history pills render without network reads. Opening a pill lazily
calls `get` and `getRun` for current controls and full bounded details.

Agent launch also writes a bounded immutable definition snapshot—mission id,
name, summary, revision, action, schedule, and creation time—to the originating
channel. Its institution pill therefore renders immediately and performs no
service read while collapsed. Opening it calls only `get`; no run exists yet.
The same shared inspector provides editing and runtime controls, and later
provides run-now, pause/stop, resume, completion, and historical tick details as
the definition changes state.
