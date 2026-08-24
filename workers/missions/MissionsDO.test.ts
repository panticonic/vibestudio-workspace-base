import { describe, expect, it, vi } from "vitest";
import { DURABLE_OBJECT_FRAMEWORK_RPC_METHODS } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { executionSessionNonceFor } from "@vibestudio/rpc/internal";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionOperationPolicyReference,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/shared/authority/mission";
import { missionPrincipal } from "@vibestudio/shared/authority/mission";
import { MissionsDO } from "./MissionsDO.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

class IdempotentLaunchMissionsDO extends MissionsDO {
  protected override get rpcIdempotencyKey(): string | null {
    return "agent-launch-request";
  }
}

class IdentityMissionsDO extends MissionsDO {
  identityForTest() {
    return {
      source: this.env["WORKER_SOURCE"],
      className: this.env["WORKER_CLASS_NAME"],
      objectKey: this.env["__objectKey"],
    };
  }
}

function agentCharter(summary = "Prepare a daily summary"): MissionCharter {
  return {
    summary,
    execution: {
      kind: "agent",
      image: {
        source: "workers/summary",
        ref: `state:${HASH_B}`,
        effectiveVersion: HASH_A,
        className: "SummaryAgent",
        objectKey: "daily",
      },
      action: { kind: "prompt", text: "Prepare a daily summary" },
      conversation: { mode: "fresh" },
      operations: [],
    },
    trigger: { kind: "manual" },
  };
}

function methodCharter(): MissionCharter {
  return {
    summary: "Check whether the rollout is complete",
    execution: {
      kind: "method",
      image: {
        source: "workers/rollout",
        ref: `state:${HASH_C}`,
        effectiveVersion: HASH_B,
        className: "RolloutWorker",
        objectKey: "primary",
      },
      method: "check",
      args: [{ deployment: "production" }],
      operations: [],
    },
    trigger: { kind: "manual" },
  };
}

function policy(digest = HASH_C): MissionOperationPolicyReference {
  return {
    schemaVersion: 1,
    digest,
    artifactRef: `policy:${digest}`,
    compilerVersion: "test-compiler",
    catalogDigest: HASH_A,
  };
}

const alice = {
  callerId: "panel:alice",
  callerKind: "panel" as const,
  userId: "alice",
};
const bob = {
  callerId: "panel:bob",
  callerKind: "panel" as const,
  userId: "bob",
};

async function createMissions<T extends typeof MissionsDO>(
  ctor: T = MissionsDO as T,
) {
  const result = await createTestDO(ctor, {
    WORKER_SOURCE: "workers/missions",
    WORKER_CLASS_NAME: "MissionsDO",
    __objectKey: "workspace-missions",
  });
  let policyDigest = HASH_C;
  const calls: Array<{
    target: string;
    method: string;
    args: unknown[];
    options?: unknown;
  }> = [];
  const rpcCall = vi.fn(
    async (
      target: string,
      method: string,
      args: unknown[] = [],
      options?: unknown,
    ): Promise<unknown> => {
      calls.push({ target, method, args, options });
      if (target === "main" && method === "authority.compileOperationPolicy")
        return policy(policyDigest);
      if (target === "main" && method === "authority.acquireForTarget")
        return { requestIds: [], grantIds: ["grant:mission"], denialIds: [] };
      if (target === "main" && method === "authority.retireTarget")
        return { cancelledRequestCount: 0, revokedGrantCount: 1 };
      if (target === "main" && method.startsWith("workspace-state.alarm"))
        return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    },
  );
  const noop = vi.fn();
  Object.defineProperty(result.instance, "rpc", {
    value: {
      call: rpcCall,
      expose: noop,
      exposeAll: noop,
      exposeStreaming: noop,
      stream: noop,
      streamReadable: noop,
      emit: noop,
      on: noop,
      peer: noop,
      status: noop,
      ready: noop,
      onStatusChange: noop,
    },
    configurable: true,
  });
  return {
    ...result,
    calls,
    rpcCall,
    setPolicyDigest(value: string) {
      policyDigest = value;
    },
  };
}

describe("MissionsDO", () => {
  it("runs under its installed Base provider identity", async () => {
    const { instance } = await createTestDO(IdentityMissionsDO, {
      WORKER_SOURCE: "workers/missions",
      WORKER_CLASS_NAME: "MissionsDO",
      __objectKey: "workspace-missions",
    });
    expect(instance.identityForTest()).toEqual({
      source: "workers/missions",
      className: "MissionsDO",
      objectKey: "workspace-missions",
    });
  });

  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await createMissions();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(missionsMethods).sort());
  });

  it("launches immediately with host-compiled policy and user-bound durable authority", async () => {
    const { callAs, calls } = await createMissions();
    const created = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    expect(created).toMatchObject({
      schemaVersion: 2,
      name: "Daily summary",
      state: "active",
      revision: 1,
      owner: { userId: "alice", deviceId: "panel:alice" },
      operationPolicy: policy(),
      authority: { requestIds: [], grantIds: ["grant:mission"], denialIds: [] },
    });
    expect(created.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(calls.map(({ method }) => method)).toEqual([
      "authority.compileOperationPolicy",
      "authority.acquireForTarget",
    ]);
    expect(calls[1]?.args).toEqual([
      {
        targetSubject: missionPrincipal(
          created.missionId,
          created.revisionDigest,
        ),
        operationPolicyDigest: HASH_C,
      },
    ]);
    await expect(callAs(bob, "get", created.missionId)).rejects.toThrow(
      /Unknown automation/,
    );
  });

  it("deduplicates launch transport retries without duplicate definitions", async () => {
    const { callAs, sql } = await createMissions(IdempotentLaunchMissionsDO);
    const input = { name: "Daily summary", charter: agentCharter() };
    const first = await callAs<MissionRecord>(alice, "launch", input);
    const retry = await callAs<MissionRecord>(alice, "launch", input);
    expect(retry.missionId).toBe(first.missionId);
    expect(sql.exec("SELECT COUNT(*) AS count FROM missions").one()).toEqual({
      count: 1,
    });
    expect(
      sql.exec("SELECT COUNT(*) AS count FROM mission_launches").one(),
    ).toEqual({ count: 1 });
  });

  it("pause changes admission eligibility without discarding standing grants", async () => {
    const { callAs, calls } = await createMissions();
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    const acquiredBeforePause = calls.filter(
      ({ method }) => method === "authority.acquireForTarget",
    );
    const paused = await callAs<MissionRecord>(
      alice,
      "pause",
      launched.missionId,
    );
    const resumed = await callAs<MissionRecord>(
      alice,
      "resume",
      launched.missionId,
    );
    expect(paused.state).toBe("paused");
    expect(paused.authority).toEqual(launched.authority);
    expect(resumed.state).toBe("active");
    expect(resumed.authority).toEqual(launched.authority);
    expect(
      calls.filter(({ method }) => method === "authority.acquireForTarget"),
    ).toEqual(acquiredBeforePause);
    expect(
      calls.some(({ method }) => /revoke|retire|suspend/u.test(method)),
    ).toBe(false);
  });

  it("edits by creating a new immutable revision subject and policy", async () => {
    const harness = await createMissions();
    const launched = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: agentCharter(),
    });
    harness.setPolicyDigest(HASH_B);
    const edited = await harness.callAs<MissionRecord>(
      alice,
      "edit",
      launched.missionId,
      {
        name: "Focused summary",
        charter: agentCharter("Prepare a focused summary"),
      },
    );
    expect(edited).toMatchObject({
      missionId: launched.missionId,
      revision: 2,
      state: "active",
    });
    expect(edited.revisionDigest).not.toBe(launched.revisionDigest);
    expect(edited.operationPolicy.digest).toBe(HASH_B);
    expect(
      harness.calls
        .filter(({ method }) => method === "authority.acquireForTarget")
        .at(-1)?.args,
    ).toEqual([
      {
        targetSubject: missionPrincipal(
          edited.missionId,
          edited.revisionDigest,
        ),
        operationPolicyDigest: HASH_B,
      },
    ]);
    expect(
      harness.calls.find(({ method }) => method === "authority.retireTarget")
        ?.args,
    ).toEqual([
      {
        targetSubject: missionPrincipal(
          launched.missionId,
          launched.revisionDigest,
        ),
      },
    ]);
  });

  it("binds method dispatch to the admitted execution nonce and closes admission", async () => {
    const harness = await createMissions();
    harness.rpcCall.mockImplementation(
      async (target, method, args = [], options) => {
        harness.calls.push({ target, method, args, options });
        if (target === "main" && method === "authority.compileOperationPolicy")
          return policy();
        if (target === "main" && method === "authority.acquireForTarget")
          return { requestIds: [], grantIds: ["grant:mission"], denialIds: [] };
        if (target === "main" && method === "runtime.createEntity")
          return {
            targetId: "do:workers/rollout:RolloutWorker:primary",
            contextId: (args[0] as { contextId?: string })?.contextId,
          };
        if (target === "main" && method === "authority.admitExecution")
          return { authoritySessionId: "admission:one", nonce: "nonce:one" };
        if (target === "main" && method === "authority.finishExecution")
          return undefined;
        if (
          target === "do:workers/rollout:RolloutWorker:primary" &&
          method === "check"
        )
          return { ready: true };
        if (target === "main" && method.startsWith("workspace-state.alarm"))
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      },
    );
    const launched = await harness.callAs<MissionRecord>(alice, "launch", {
      name: "Rollout check",
      charter: methodCharter(),
    });
    const run = await harness.callAs<MissionRunRecord>(
      alice,
      "runNow",
      launched.missionId,
    );
    expect(run).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    const dispatch = harness.calls.find(
      ({ target, method }) =>
        target === "do:workers/rollout:RolloutWorker:primary" &&
        method === "check",
    );
    expect(dispatch?.options).toMatchObject({
      idempotencyKey: `${run.runId}:dispatch`,
    });
    expect(executionSessionNonceFor(dispatch?.options as never)).toBe(
      "nonce:one",
    );
    expect(
      harness.calls.some(
        ({ method }) => method === "authority.finishExecution",
      ),
    ).toBe(true);
  });
});
