import { describe, expect, it, vi } from "vitest";
import { DURABLE_OBJECT_FRAMEWORK_RPC_METHODS } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionCharter,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/shared/authority/mission";
import type { ReviewedExecutionClosureBody } from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { MissionsDO } from "./MissionsDO.js";

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

const charter = (): MissionCharter => ({
  summary: "Prepare a daily summary",
  harness: { unit: "workers/summary", ev: "a".repeat(64), ref: `state:${"b".repeat(64)}` },
  execution: {
    kind: "agent",
    target: {
      source: "workers/summary",
      className: "SummaryAgent",
      objectKey: "daily",
    },
    action: { kind: "prompt", text: "Prepare a daily summary" },
    conversation: { mode: "fresh" },
    toolExposure: {
      services: ["docs.read"],
      userlandServices: [],
      workspaceServiceDiscovery: "bound",
      evalNetwork: "none",
      declaredOrigins: [],
    },
    declaredLineageClasses: ["none"],
  },
  trigger: { kind: "manual" },
});

const methodCharter = (resultLimit?: number): MissionCharter => ({
  summary: "Check whether the rollout is complete",
  harness: { unit: "workers/rollout", ev: "d".repeat(64), ref: `state:${"e".repeat(64)}` },
  execution: {
    kind: "method",
    target: {
      source: "workers/rollout",
      className: "RolloutWorker",
      objectKey: "primary",
    },
    method: "check",
    args: [],
  },
  trigger: {
    kind: "cron",
    expression: "5 5 * * THU",
    timezone: "America/New_York",
    ...(resultLimit === undefined ? {} : { maxRuns: resultLimit }),
  },
});

async function missions() {
  const result = await createTestDO(MissionsDO, {
    WORKER_SOURCE: "workers/missions",
    WORKER_CLASS_NAME: "MissionsDO",
    __objectKey: "workspace-missions",
  });
  Object.defineProperty(result.instance, "rpc", {
    value: {
      call: vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "reviewedClosure.activate") return undefined;
        if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      }),
    },
    configurable: true,
  });
  return result;
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
    const { instance } = await missions();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method)
    );
    expect(productMethods.sort()).toEqual(Object.keys(missionsMethods).sort());
  });

  it("owns launched definitions per authenticated user and records a revision digest", async () => {
    const { callAs } = await missions();
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
    const created = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });

    expect(created).toMatchObject({
      name: "Daily summary",
      state: "active",
      revision: 1,
      owner: { userId: "alice", deviceId: "panel:alice" },
    });
    expect(created.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(callAs(bob, "get", created.missionId)).rejects.toThrow(/Unknown automation/);
    await expect(callAs<MissionRecord[]>(alice, "list")).resolves.toEqual([
      expect.objectContaining({ missionId: created.missionId }),
    ]);
  });

  it("returns the same running definition when an agent launch transport is retried", async () => {
    const { instance, callAs, sql } = await createTestDO(IdempotentLaunchMissionsDO, {
      WORKER_SOURCE: "vibestudio/internal",
      WORKER_CLASS_NAME: "MissionsDO",
      __objectKey: "workspace",
    });
    Object.defineProperty(instance, "rpc", {
      value: {
        call: vi.fn(async (target: string, method: string) => {
          if (target === "main" && method === "reviewedClosure.activate") return undefined;
          if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
          throw new Error(`Unexpected RPC ${target}.${method}`);
        }),
      },
      configurable: true,
    });
    const caller = {
      callerId: "do:agent",
      callerKind: "do" as const,
      userId: "alice",
    };
    const input = {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    };

    const first = await callAs<MissionRecord>(caller, "launch", input);
    const retried = await callAs<MissionRecord>(caller, "launch", input);

    expect(retried.missionId).toBe(first.missionId);
    expect(sql.exec(`SELECT COUNT(*) AS count FROM missions`).one()).toEqual({
      count: 1,
    });
    expect(sql.exec(`SELECT mission_id FROM mission_proposals`).one()).toEqual({
      mission_id: first.missionId,
    });
  });

  it("does not persist a running definition when closure installation fails", async () => {
    const { instance, callAs, sql } = await missions();
    Object.defineProperty(instance, "rpc", {
      value: {
        call: vi.fn(async (target: string, method: string) => {
          if (target === "main" && method === "reviewedClosure.activate") {
            throw new Error("closure registry unavailable");
          }
          throw new Error(`Unexpected RPC ${target}.${method}`);
        }),
      },
      configurable: true,
    });

    await expect(
      callAs(
        { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
        "launch",
        {
          name: "Daily summary",
          charter: charter(),
          permissions: [],
        }
      )
    ).rejects.toThrow("closure registry unavailable");
    expect(sql.exec(`SELECT COUNT(*) AS count FROM missions`).one()).toEqual({ count: 0 });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM mission_proposals`).one()).toEqual({ count: 0 });
  });

  it("installs an edited revision immediately and keeps it active", async () => {
    const { instance, callAs } = await missions();
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method === "reviewedClosure.activate") return undefined;
      if (target === "main" && method === "reviewedClosure.suspend") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });
    const editedCharter = charter();
    editedCharter.summary = "Prepare a focused daily summary";
    const edited = await callAs<MissionRecord>(alice, "edit", launched.missionId, {
      name: "Focused daily summary",
      charter: editedCharter,
    });

    expect(edited).toMatchObject({
      missionId: launched.missionId,
      name: "Focused daily summary",
      revision: 2,
      state: "active",
      charter: { summary: "Prepare a focused daily summary" },
    });
    expect(edited.revisionDigest).not.toBe(launched.revisionDigest);
    const closureCalls = rpcCall.mock.calls.filter(
      ([target, method]) => target === "main" && String(method).startsWith("reviewedClosure.")
    );
    expect(closureCalls.map(([, method]) => method)).toEqual([
      "reviewedClosure.activate",
      "reviewedClosure.suspend",
      "reviewedClosure.activate",
    ]);
    const launchedClosureDigest = String(
      (closureCalls[0]![2] as Array<{ closureDigest: string }>)[0]!.closureDigest
    );
    expect(closureCalls[1]![2]).toEqual([
      `mission:${launched.missionId}@${launchedClosureDigest}`,
    ]);
    await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toEqual(edited);
  });

  it("keeps the installed revision when replacement closure installation fails", async () => {
    const { instance, callAs } = await missions();
    let activationCount = 0;
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method === "reviewedClosure.suspend") return undefined;
      if (target === "main" && method === "reviewedClosure.activate") {
        activationCount += 1;
        if (activationCount === 2) throw new Error("replacement install failed");
        return undefined;
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });

    await expect(
      callAs(alice, "edit", launched.missionId, { name: "Replacement summary" })
    ).rejects.toThrow("replacement install failed");
    await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toEqual(
      launched
    );
    expect(
      rpcCall.mock.calls
        .filter(
          ([target, method]) =>
            target === "main" && String(method).startsWith("reviewedClosure.")
        )
        .map(([, method]) => method)
    ).toEqual([
      "reviewedClosure.activate",
      "reviewedClosure.suspend",
      "reviewedClosure.activate",
      "reviewedClosure.suspend",
      "reviewedClosure.activate",
    ]);
  });

  it("pauses an active automation when the host reports denied run authority", async () => {
    const { instance, callAs } = await missions();
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method === "reviewedClosure.activate") return undefined;
      if (target === "main" && method === "reviewedClosure.suspend") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const launched = await callAs<MissionRecord>(
      { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
      "launch",
      {
        name: "Rollout watcher",
        charter: methodCharter(),
        permissions: [],
      }
    );
    const launchedClosureDigest = String(
      (
        rpcCall.mock.calls.find(([, method]) => method === "reviewedClosure.activate")![2] as Array<{
          closureDigest: string;
        }>
      )[0]!.closureDigest
    );

    const paused = await callAs<MissionRecord>(
      { callerId: "main", callerKind: "server" },
      "pauseForAuthorityDenial",
      {
        missionId: launched.missionId,
        capability: "docs.read",
        resource: { kind: "prefix", prefix: "docs/" },
        tier: "gated",
      }
    );

    expect(paused).toMatchObject({ missionId: launched.missionId, state: "paused" });
    expect(paused.nextRunAt).toBeUndefined();
    expect(rpcCall).toHaveBeenCalledWith("main", "reviewedClosure.suspend", [
      `mission:${launched.missionId}@${launchedClosureDigest}`,
    ]);
  });

  it("compiles automatic harness grants and declared gated action authority", async () => {
    const { instance, callAs } = await missions();
    const created = await callAs<MissionRecord>(
      { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
      "launch",
      {
        name: "Daily summary",
        charter: charter(),
        permissions: [
          {
            capability: "docs.read",
            resource: { kind: "prefix", prefix: "docs/" },
            tier: "gated",
          },
        ],
      }
    );
    const compiled = (
      instance as unknown as {
        compileClosure(record: MissionRecord): {
          body: ReviewedExecutionClosureBody;
        };
      }
    ).compileClosure(created);

    expect(compiled.body.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "workspace-service:channel", tier: "gated" }),
        expect.objectContaining({ capability: "workspace-service:gad.workspace", tier: "gated" }),
        expect.objectContaining({ capability: "workspace-service:workspace.state", tier: "gated" }),
        expect.objectContaining({ capability: "docs.read", tier: "gated" }),
      ])
    );
    expect(compiled.body.grantDependencies).toEqual([]);
  });

  it("rejects authority that cannot become a standing automation grant", async () => {
    const { callAs } = await missions();
    await expect(
      callAs<MissionRecord>(
        { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
        "launch",
        {
          name: "Unsafe cleanup",
          charter: charter(),
          permissions: [
            {
              capability: "workspace.storage.delete",
              resource: { kind: "exact", key: "workspace" },
              tier: "critical",
            },
          ],
        }
      )
    ).rejects.toThrow(/cannot be installed as standing automation authority/);
  });

  it("returns one bounded supervision overview and cursor-pages older runs", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const created = await callAs<MissionRecord>(alice, "launch", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });
    const sql = (
      instance as unknown as {
        sql: { exec(query: string, ...bindings: unknown[]): unknown };
      }
    ).sql;
    const now = Date.now();
    for (let index = 0; index < 8; index += 1) {
      const status = index === 0 ? "running" : index === 1 ? "failed" : "succeeded";
      sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,started_at,run_number,finished_at,final_message,error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        `run-${index}`,
        created.missionId,
        "b".repeat(64),
        created.revision,
        index % 2 === 0 ? "scheduled" : "manual",
        status,
        now - index * 1_000,
        index + 1,
        status === "running" ? null : now - index * 1_000 + 250,
        status === "succeeded" ? `result ${index}` : null,
        status === "failed" ? "provider unavailable" : null
      );
    }

    const overview = await callAs<{
      stats: {
        total: number;
        active: number;
        running: number;
        failedLast24Hours: number;
        completed: number;
      };
      items: Array<{
        automation: MissionRecord;
        recentRuns: Array<{ runId: string }>;
        totalRuns: number;
        activeRuns: number;
        failedRunsSince: number;
      }>;
      attention: Array<{
        missionId: string;
        run: { runId: string; error?: string };
      }>;
    }>(alice, "overview", {});
    expect(overview.stats).toEqual({
      total: 1,
      active: 1,
      running: 1,
      failedLast24Hours: 1,
      completed: 0,
    });
    expect(overview.items).toEqual([
      expect.objectContaining({
        automation: expect.objectContaining({ missionId: created.missionId }),
        totalRuns: 8,
        activeRuns: 1,
        failedRunsSince: 1,
        recentRuns: expect.arrayContaining([expect.objectContaining({ runId: "run-0" })]),
      }),
    ]);
    expect(overview.items[0]?.recentRuns).toHaveLength(5);
    expect(overview.attention).toEqual([
      expect.objectContaining({
        missionId: created.missionId,
        run: expect.objectContaining({
          runId: "run-1",
          error: "provider unavailable",
        }),
      }),
    ]);
    await expect(callAs(alice, "getRun", "run-1")).resolves.toMatchObject({
      runId: "run-1",
      missionId: created.missionId,
      status: "failed",
      error: "provider unavailable",
    });
    await expect(callAs(alice, "getRun", "missing-run")).resolves.toBeNull();

    const first = await callAs<{
      items: Array<{ runId: string; startedAt: number }>;
      nextCursor?: { startedAt: number; runId: string };
    }>(alice, "listRuns", created.missionId, { limit: 3 });
    expect(first.items.map((run) => run.runId)).toEqual(["run-0", "run-1", "run-2"]);
    expect(first.nextCursor).toEqual({
      startedAt: first.items[2]?.startedAt,
      runId: "run-2",
    });
    const second = await callAs<{ items: Array<{ runId: string }> }>(
      alice,
      "listRuns",
      created.missionId,
      { limit: 3, cursor: first.nextCursor }
    );
    expect(second.items.map((run) => run.runId)).toEqual(["run-3", "run-4", "run-5"]);
  });

  it("pages and filters definitions on the server while keeping global counts", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const records = await Promise.all(
      ["Archive cleanup", "Billing digest", "Customer briefing", "Dependency review"].map((name) =>
        callAs<MissionRecord>(alice, "launch", {
          name,
          charter: { ...charter(), summary: `${name} summary` },
          permissions: [],
        })
      )
    );
    const sql = (
      instance as unknown as {
        sql: { exec(query: string, ...bindings: unknown[]): unknown };
      }
    ).sql;
    records.forEach((record, index) => {
      sql.exec(
        "UPDATE missions SET updated_at=?,state=? WHERE mission_id=?",
        10_000 + index,
        index === 2 ? "paused" : "active",
        record.missionId
      );
    });

    const first = await callAs<{
      stats: { total: number; active: number };
      items: Array<{ automation: MissionRecord }>;
      nextCursor?: { updatedAt: number; missionId: string };
    }>(alice, "overview", { limit: 2 });
    expect(first.stats).toMatchObject({ total: 4, active: 3 });
    expect(first.items.map((item) => item.automation.name)).toEqual([
      "Dependency review",
      "Customer briefing",
    ]);
    expect(first.nextCursor).toEqual({
      updatedAt: 10_002,
      missionId: records[2]!.missionId,
    });

    const second = await callAs<{
      items: Array<{ automation: MissionRecord }>;
      nextCursor?: unknown;
    }>(alice, "overview", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.automation.name)).toEqual([
      "Billing digest",
      "Archive cleanup",
    ]);
    expect(second.nextCursor).toBeUndefined();

    const active = await callAs<{
      items: Array<{ automation: MissionRecord }>;
    }>(alice, "overview", { filter: "active" });
    expect(active.items.map((item) => item.automation.name)).not.toContain("Customer briefing");

    const search = await callAs<{
      items: Array<{ automation: MissionRecord }>;
    }>(alice, "overview", { query: "BILLING" });
    expect(search.items.map((item) => item.automation.name)).toEqual(["Billing digest"]);

    const deepLinked = await callAs<{
      stats: { total: number };
      items: Array<{ automation: MissionRecord }>;
    }>(alice, "overview", { missionId: records[0]!.missionId });
    expect(deepLinked.stats.total).toBe(4);
    expect(deepLinked.items.map((item) => item.automation.name)).toEqual(["Archive cleanup"]);
  });

  it("runs calendar automations to natural completion and preserves editable history", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method === "reviewedClosure.activate") return undefined;
      if (target === "main" && method === "reviewedClosure.suspend") return undefined;
      if (target === "main" && method === "reviewedClosure.bindSession") return undefined;
      if (target === "main" && method === "reviewedClosure.finishSession") return undefined;
      if (target === "main" && method === "notification.showToUser") return "notif-run-started";
      if (target === "main" && method === "runtime.createEntity") {
        return {
          id: "rollout-worker",
          targetId: "do:rollout",
          contextId: undefined,
        };
      }
      if (target === "do:rollout" && method === "check") {
        return {
          protocol: "automation-completion.v1",
          response: "The rollout reached 100% and passed its health checks.",
        };
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const active = await callAs<MissionRecord>(alice, "launch", {
      name: "Rollout watcher",
      charter: methodCharter(10),
      permissions: [],
    });
    expect(active).toMatchObject({
      state: "active",
      runCount: 0,
      charter: {
        trigger: {
          kind: "cron",
          expression: "5 5 * * THU",
          timezone: "America/New_York",
          maxRuns: 10,
        },
      },
    });
    expect(active.nextRunAt).toBeGreaterThan(Date.now());

    const run = await callAs<MissionRunRecord>(alice, "runNow", active.missionId);
    expect(run).toMatchObject({
      revision: 1,
      runNumber: 1,
      status: "succeeded",
      completionResponse: "The rollout reached 100% and passed its health checks.",
    });
    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.createEntity", [
      expect.objectContaining({
        execution: {
          surface: "code",
          source: "workers/rollout",
          ref: `state:${"e".repeat(64)}`,
        },
      }),
    ]);
    const bindOrder = rpcCall.mock.calls.findIndex(
      ([target, method]) => target === "main" && method === "reviewedClosure.bindSession"
    );
    const activationOrder = rpcCall.mock.calls.findIndex(
      ([target, method]) => target === "main" && method === "runtime.createEntity"
    );
    expect(bindOrder).toBeGreaterThanOrEqual(0);
    expect(activationOrder).toBeGreaterThan(bindOrder);
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "notification.showToUser",
      expect.anything()
    );
    const completed = await callAs<MissionRecord>(alice, "get", active.missionId);
    expect(completed).toMatchObject({
      state: "completed",
      runCount: 1,
      completionReason: "response",
      completionResponse: "The rollout reached 100% and passed its health checks.",
    });
    expect(completed.nextRunAt).toBeUndefined();

    const revised = await callAs<MissionRecord>(alice, "edit", active.missionId, {
      charter: methodCharter(3),
    });
    expect(revised).toMatchObject({
      state: "active",
      revision: 2,
      runCount: 1,
    });
    expect(revised.completedAt).toBeUndefined();
    expect(revised.completionReason).toBeUndefined();
    expect(revised.completionResponse).toBeUndefined();
  });

  it("does not substitute a transient start notice for the automation's result", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 12, 12);
      vi.setSystemTime(now);
      const { instance, callAs, sql } = await missions();
      const alice = {
        callerId: "panel:alice",
        callerKind: "panel" as const,
        userId: "alice",
      };
      const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
        if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
        if (target === "main" && method.startsWith("reviewedClosure.")) return undefined;
        if (target === "main" && method === "notification.showToUser") return "notif-scheduled";
        if (target === "main" && method === "runtime.createEntity") {
          return { id: "rollout-worker", targetId: "do:rollout" };
        }
        if (target === "do:rollout" && method === "check") return "Rollout remains healthy";
        throw new Error(`Unexpected RPC ${target}.${method}`);
      });
      Object.defineProperty(instance, "rpc", {
        value: { call: rpcCall },
        configurable: true,
      });
      const scheduled = methodCharter();
      scheduled.trigger = { kind: "schedule", everyMs: 60_000 };
      const launched = await callAs<MissionRecord>(alice, "launch", {
        name: "Minute watcher",
        charter: scheduled,
        permissions: [],
      });

      expect(rpcCall).not.toHaveBeenCalledWith(
        "main",
        "notification.showToUser",
        expect.anything()
      );
      vi.setSystemTime(now + 60_000);
      await instance.alarm();

      expect(
        rpcCall.mock.calls.filter(
          ([target, method]) => target === "main" && method === "notification.showToUser"
        )
      ).toHaveLength(0);
      await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toMatchObject({
        state: "active",
        runCount: 1,
      });

      sql.exec(
        `INSERT INTO mission_runs
         (run_id,mission_id,closure_digest,mission_revision,trigger_kind,status,started_at,run_number)
         VALUES ('already-running',?, ?,1,'scheduled','running',?,2)`,
        launched.missionId,
        "b".repeat(64),
        now + 90_000
      );
      sql.exec(
        "UPDATE missions SET next_run_at=? WHERE mission_id=?",
        now + 120_000,
        launched.missionId
      );
      vi.setSystemTime(now + 120_000);
      await instance.alarm();
      expect(
        rpcCall.mock.calls.filter(
          ([target, method]) => target === "main" && method === "notification.showToUser"
        )
      ).toHaveLength(0);
      await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toMatchObject({
        runCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses a schedule and surfaces an inspectable error when agent activation fails", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method.startsWith("reviewedClosure.")) return undefined;
      if (target === "main" && method === "runtime.createContext") {
        return { contextId: "ctx-failed-run" };
      }
      if (target === "main" && method === "runtime.createEntity") {
        const spec = (_args?.[0] ?? {}) as { className?: string };
        if (spec.className === "PubSubChannel") return { id: "channel", targetId: "channel" };
        throw new Error("source snapshot is unavailable");
      }
      if (target === "main" && method === "notification.showToUser") return "notif-failed";
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const scheduled = charter();
    scheduled.trigger = { kind: "schedule", everyMs: 60_000 };
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Minute watcher",
      charter: scheduled,
      permissions: [],
    });

    const run = await callAs<MissionRunRecord>(alice, "runNow", launched.missionId);

    expect(run).toMatchObject({ status: "failed", error: "source snapshot is unavailable" });
    const paused = await callAs<MissionRecord>(alice, "get", launched.missionId);
    expect(paused).toMatchObject({
      state: "paused",
      runCount: 1,
    });
    expect(paused.nextRunAt).toBeUndefined();
    const bindOrder = rpcCall.mock.calls.findIndex(
      ([target, method]) => target === "main" && method === "reviewedClosure.bindSession"
    );
    const channelActivationOrder = rpcCall.mock.calls.findIndex(
      ([target, method, args]) =>
        target === "main" &&
        method === "runtime.createEntity" &&
        ((args?.[0] as { className?: string } | undefined)?.className ?? "") === "PubSubChannel"
    );
    const activationOrder = rpcCall.mock.calls.findIndex(
      ([target, method, args]) =>
        target === "main" &&
        method === "runtime.createEntity" &&
        ((args?.[0] as { className?: string } | undefined)?.className ?? "") !== "PubSubChannel"
    );
    expect(bindOrder).toBeGreaterThanOrEqual(0);
    expect(channelActivationOrder).toBeGreaterThan(bindOrder);
    expect(activationOrder).toBeGreaterThan(bindOrder);
    expect(rpcCall).toHaveBeenCalledWith("main", "reviewedClosure.finishSession", [
      { sessionId: expect.stringMatching(/^automation-/u) },
    ]);
    expect(rpcCall).toHaveBeenCalledWith("main", "notification.showToUser", [
      "alice",
      expect.objectContaining({
        type: "error",
        title: "Minute watcher paused",
        message: "The automation could not start its agent: source snapshot is unavailable",
        actions: [
          expect.objectContaining({
            id: "view-automation",
            command: expect.objectContaining({
              type: "panel.open",
              source: "about/automations",
              stateArgs: { missionId: launched.missionId },
            }),
          }),
        ],
      }),
    ]);
  });

  it("continues with the exact installed channel and context without allocating a second conversation", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const rpcCall = vi.fn(async (target: string, method: string, args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method.startsWith("reviewedClosure.")) return undefined;
      if (target === "main" && method === "runtime.createEntity") {
        const spec = args?.[0] as { contextId?: string; agentChannelId?: string };
        expect(spec).toMatchObject({
          contextId: "ctx-existing",
          agentChannelId: "channel-existing",
        });
        return { id: "existing-agent", targetId: "do:existing-agent", contextId: "ctx-existing" };
      }
      if (target === "do:existing-agent" && method === "runAutomationTurn") return undefined;
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const continuing = charter();
    if (continuing.execution.kind !== "agent") throw new Error("Expected agent charter");
    continuing.execution.conversation = {
      mode: "continue",
      channelId: "channel-existing",
      contextId: "ctx-existing",
    };
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Conversation follow-up",
      charter: continuing,
      permissions: [],
    });

    const run = await callAs<MissionRunRecord>(alice, "runNow", launched.missionId);

    expect(run).toMatchObject({
      status: "running",
      channelId: "channel-existing",
      contextId: "ctx-existing",
      executorId: "do:existing-agent",
    });
    expect(rpcCall.mock.calls.some(([, method]) => method === "runtime.createContext")).toBe(false);
    expect(rpcCall.mock.calls.some(([, method]) => method === "subscribeChannel")).toBe(false);
    expect(rpcCall).toHaveBeenCalledWith("do:existing-agent", "runAutomationTurn", [
      expect.objectContaining({ channelId: "channel-existing" }),
    ]);
  });

  it("completes after the configured maximum even when the terminal run fails", async () => {
    const { instance, callAs } = await missions();
    const alice = {
      callerId: "panel:alice",
      callerKind: "panel" as const,
      userId: "alice",
    };
    const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
      if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
      if (target === "main" && method.startsWith("reviewedClosure.")) return undefined;
      if (target === "main" && method === "notification.showToUser") return "notif-run-started";
      if (target === "main" && method === "runtime.createEntity") {
        return { id: "rollout-worker", targetId: "do:rollout" };
      }
      if (target === "do:rollout" && method === "check") throw new Error("health check failed");
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });
    const launched = await callAs<MissionRecord>(alice, "launch", {
      name: "Bounded rollout watcher",
      charter: methodCharter(1),
      permissions: [],
    });
    const run = await callAs<MissionRunRecord>(alice, "runNow", launched.missionId);

    expect(run).toMatchObject({
      status: "failed",
      runNumber: 1,
      error: "health check failed",
    });
    await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toMatchObject({
      state: "completed",
      runCount: 1,
      completionReason: "max-runs",
    });
  });

  it("ends at the reviewed until boundary without starting another run", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 7, 12, 12);
      vi.setSystemTime(now);
      const { instance, callAs } = await missions();
      const alice = {
        callerId: "panel:alice",
        callerKind: "panel" as const,
        userId: "alice",
      };
      const rpcCall = vi.fn(async (target: string, method: string, _args?: unknown[]) => {
        if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
        if (
          target === "main" &&
          (method === "reviewedClosure.activate" || method === "reviewedClosure.suspend")
        )
          return undefined;
        throw new Error(`Unexpected RPC ${target}.${method}`);
      });
      Object.defineProperty(instance, "rpc", {
        value: { call: rpcCall },
        configurable: true,
      });
      const scheduled = charter();
      scheduled.trigger = {
        kind: "schedule",
        everyMs: 60_000,
        untilAt: now + 90_000,
      };
      const launched = await callAs<MissionRecord>(alice, "launch", {
        name: "Short-lived watcher",
        charter: scheduled,
        permissions: [],
      });

      vi.setSystemTime(now + 90_000);
      await instance.alarm();

      await expect(callAs<MissionRecord>(alice, "get", launched.missionId)).resolves.toMatchObject({
        state: "completed",
        runCount: 0,
        completedAt: now + 90_000,
        completionReason: "until",
      });
      expect(rpcCall).not.toHaveBeenCalledWith(
        expect.anything(),
        "runtime.createEntity",
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
