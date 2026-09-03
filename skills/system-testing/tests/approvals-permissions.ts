import type { HeadlessSession } from "@workspace/agentic-session";
import type {
  TestCase,
  TestExecutionResult,
  TestOrchestrationContext
} from "../types.js";
import { completedScenarioEvidence, invocationReturnValue } from "./_scenario-evidence.js";
import { savedPermissionGrantSchema } from "@vibestudio/service-schemas/permissions";
const PERMISSION_LIST_CALL =
  /\bservices\.permissions\.list\s*\(\s*\)|\brpc\.call\s*\(\s*["']main["']\s*,\s*["']permissions\.list["']\s*,\s*\[\s*\]\s*\)/u;
const PERMISSION_PROFILE_CALL =
  /\brpc\.call\s*\(\s*["']main["']\s*,\s*["']permissions\.listAgentProfiles["']\s*,\s*\[\s*\]\s*\)/u;
const PERMISSION_MUTATION_CALL =
  /\bservices\.permissions\.(?:revoke|updateAgentProfile|setWorkspaceAuthorityLock)\s*\(|\brpc\.call\s*\(\s*["']main["']\s*,\s*["']permissions\.(?:revoke|updateAgentProfile|setWorkspaceAuthorityLock)["']/u;

function validatePermissionList(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (
    base.evidence.calls.some((call) => {
      const code = String(call.arguments?.["code"] ?? "");
      return call.name === "eval" && PERMISSION_MUTATION_CALL.test(code);
    })
  ) {
    return {
      passed: false,
      reason: "The permission inventory task invoked a mutating permission API",
    };
  }
  const listed = base.evidence.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      PERMISSION_LIST_CALL.test(code)
    );
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  return returned.present &&
    Array.isArray(returned.value) &&
    returned.value.every((grant) => savedPermissionGrantSchema.safeParse(grant).success)
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "The read-only permission listing returned an invalid grant inventory",
      };
}

function successfulEvalCalls(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return null;
  return base.evidence.calls.filter(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true
  );
}

function isPermissionReadTaskRule(value: unknown): value is { id: string } {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule["id"] === "string" &&
    rule["capability"] === "permissions.read" &&
    typeof rule["action"] === "string" &&
    typeof rule["resource"] === "string" &&
    typeof rule["decidedAt"] === "number"
  );
}

function validateChatTaskGrantReuse(result: TestExecutionResult) {
  const calls = successfulEvalCalls(result);
  if (!calls) {
    return {
      passed: false,
      reason: "The two-turn session did not complete"
    };
  }
  const permissionReads = calls.filter((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return PERMISSION_LIST_CALL.test(code) || PERMISSION_PROFILE_CALL.test(code);
  });
  const evidence = result.diagnostics?.["chatTaskRuleReuse"];
  const snapshots =
    evidence && typeof evidence === "object"
      ? (evidence as Record<string, unknown>)
      : null;
  const first = snapshots?.["afterFirstTurn"];
  const second = snapshots?.["afterSecondTurn"];
  const firstRules = Array.isArray(first) ? first.filter(isPermissionReadTaskRule) : [];
  const secondRules = Array.isArray(second) ? second.filter(isPermissionReadTaskRule) : [];
  return permissionReads.length >= 2 &&
    firstRules.length === 1 &&
    secondRules.length === 1 &&
    firstRules[0]!.id === secondRules[0]!.id
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason:
          "The two agent turns did not perform two protected permission reads backed by one final permissions.read task rule"
      };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function orchestrateChatTaskGrantReuse(
  context: TestOrchestrationContext
): Promise<TestExecutionResult> {
  const startedAt = Date.now();
  const session: HeadlessSession = await context.runner.spawn(undefined);
  let error: string | undefined;
  let afterFirstTurn: Awaited<ReturnType<typeof context.runner.inspectChatTaskRules>> = [];
  let afterSecondTurn: Awaited<ReturnType<typeof context.runner.inspectChatTaskRules>> = [];
  try {
    await context.sendAndWait(
      session,
      "List the workspace permissions currently granted here and summarize them. Do not change them.",
      "initial permission inventory"
    );
    const firstSnapshot = session.snapshot();
    if (!firstSnapshot.agentContextId || !firstSnapshot.channelId) {
      throw new Error("The headless chat did not expose its task coordinates after the first turn");
    }
    afterFirstTurn = await context.runner.inspectChatTaskRules({
      contextId: firstSnapshot.agentContextId,
      channelId: firstSnapshot.channelId
    });
    await context.sendAndWait(
      session,
      "List those workspace permissions again in this same conversation and tell me whether anything changed. Do not change them.",
      "follow-up permission inventory"
    );
    const secondSnapshot = session.snapshot();
    if (!secondSnapshot.agentContextId || !secondSnapshot.channelId) {
      throw new Error("The headless chat did not expose its task coordinates after the second turn");
    }
    afterSecondTurn = await context.runner.inspectChatTaskRules({
      contextId: secondSnapshot.agentContextId,
      channelId: secondSnapshot.channelId
    });
  } catch (cause) {
    error = formatError(cause);
  }
  const execution: TestExecutionResult = {
    messages: [...session.messages],
    duration: Date.now() - startedAt,
    snapshot: session.snapshot(),
    diagnostics: { chatTaskRuleReuse: { afterFirstTurn, afterSecondTurn } },
    ...(error ? { error } : {})
  };
  try {
    await session.close();
  } catch (cause) {
    execution.cleanupErrors = [`close: ${formatError(cause)}`];
  }
  return execution;
}

export const approvalPermissionTests: TestCase[] = [
  {
    name: "permissions-list",
    description: "Inspect the canonical capability grant inventory without changing it",
    category: "approvals-permissions",
    prompt: "List the workspace permissions currently granted here. Do not change them.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "list-permissions",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
    },
    validate: validatePermissionList,
  },
  {
    name: "chat-task-permission-reuse",
    description: "A follow-up turn reuses the same chat-bound task permission",
    category: "approvals-permissions",
    prompt: "Harness-orchestrated two-turn chat permission reuse check.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "chat-task-permissions-read",
          capability: { kind: "exact", key: "permissions.read" },
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "task"
        }
      ]
    },
    orchestrate: orchestrateChatTaskGrantReuse,
    validation: "agent-evidence",
    validate: validateChatTaskGrantReuse
  }
];
