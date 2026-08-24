import {
  DurableObjectBase,
  schemaRpc,
  type DurableObjectContext,
} from "@workspace/runtime/worker/kernel";
import { withExecutionAdmission } from "@vibestudio/rpc/internal";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type {
  MissionAuthorityProjection,
  MissionCharter,
  MissionCompletionReason,
  MissionExecution,
  MissionOperationPolicyReference,
  MissionRecord,
  MissionRunFailure,
  MissionRunOutcome,
  MissionRunPhase,
  MissionRunRecord,
  MissionState,
} from "@vibestudio/shared/authority/mission";
import {
  missionCompletionResponse,
  missionExecutionImageDigest,
  missionNextRunAt,
  missionPrincipal,
  missionRevisionDigest,
  validateMissionCharter,
} from "@vibestudio/shared/authority/mission";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";
const MAX_RUN_TEXT = 24_000;
const OVERVIEW_RUN_LIMIT = 5;
const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const ATTENTION_LIMIT = 8;
const DEFAULT_OVERVIEW_LIMIT = 30;

type OverviewFilter = "all" | "attention" | "active" | "paused" | "completed";
interface OverviewCursor {
  updatedAt: number;
  missionId: string;
}

interface MissionRow {
  mission_id: string;
  name: string;
  revision: number;
  charter_json: string;
  operation_policy_json: string;
  owner_user_id: string;
  owner_device_id: string | null;
  state: MissionState;
  revision_digest: string;
  authority_json: string;
  seeded: number;
  schedule_origin_at: number | null;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
  activated_at: number;
  run_count: number;
  completed_at: number | null;
  completion_reason: MissionCompletionReason | null;
  completion_response: string | null;
}

interface RunRow {
  run_id: string;
  mission_id: string;
  mission_subject: `mission:${string}@${string}`;
  mission_revision: number;
  trigger_kind: "manual" | "scheduled";
  phase: MissionRunPhase;
  outcome: MissionRunOutcome | null;
  started_at: number;
  run_number: number | null;
  finished_at: number | null;
  authority_session_id: string | null;
  acquisition_id: string | null;
  channel_id: string | null;
  context_id: string | null;
  executor_id: string | null;
  final_message: string | null;
  completion_response: string | null;
  failure_json: string | null;
}

interface AdmissionResult {
  authoritySessionId: string;
  nonce: string;
}

export class MissionsDO extends DurableObjectBase {
  static override schemaVersion = 1;
  static override rpcMethods = missionsMethods;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE missions (
      mission_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      charter_json TEXT NOT NULL,
      operation_policy_json TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      owner_device_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active','paused','completed','retired')),
      revision_digest TEXT NOT NULL,
      authority_json TEXT NOT NULL,
      seeded INTEGER NOT NULL CHECK (seeded IN (0,1)),
      schedule_origin_at INTEGER,
      next_run_at INTEGER,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activated_at INTEGER NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
      completed_at INTEGER,
      completion_reason TEXT CHECK (completion_reason IS NULL OR completion_reason IN ('until','max-runs','response')),
      completion_response TEXT
    )`);
    this.sql.exec(`CREATE TABLE mission_revisions (
      mission_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL, PRIMARY KEY (mission_id, revision)
    )`);
    this.sql.exec(`CREATE TABLE mission_runs (
      run_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      mission_subject TEXT NOT NULL,
      mission_revision INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','scheduled')),
      phase TEXT NOT NULL CHECK (phase IN ('admitted','execution-admitting','context-preparing','executor-preparing','dispatching','executing','waiting-authority','terminal')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','skipped','interrupted','cancelled')),
      started_at INTEGER NOT NULL,
      run_number INTEGER,
      finished_at INTEGER,
      authority_session_id TEXT,
      acquisition_id TEXT,
      channel_id TEXT,
      context_id TEXT,
      executor_id TEXT,
      final_message TEXT,
      completion_response TEXT,
      failure_json TEXT
    )`);
    this.sql.exec(`CREATE TABLE mission_launches (
      owner_user_id TEXT NOT NULL,
      launch_key TEXT NOT NULL,
      mission_id TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('preparing','active','failed')),
      created_at INTEGER NOT NULL,
      error TEXT,
      PRIMARY KEY (owner_user_id, launch_key)
    )`);
    this.sql.exec(`CREATE TABLE mission_effects (
      effect_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('retire-authority')),
      subject TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT
    )`);
    this.sql.exec(
      "CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX mission_runs_nonterminal ON mission_runs(phase, started_at)",
    );
  }

  protected override requiredTables(): readonly string[] {
    return [
      "missions",
      "mission_revisions",
      "mission_runs",
      "mission_launches",
      "mission_effects",
    ];
  }

  protected override schemaIndexDefinitions(): readonly string[] {
    return [
      "CREATE INDEX mission_runs_by_mission ON mission_runs(mission_id, started_at DESC)",
      "CREATE INDEX mission_runs_nonterminal ON mission_runs(phase, started_at)",
    ];
  }

  protected override nextAlarmAfterRequest(): { wakeAt: number } | undefined {
    const next = this.nextWakeAt();
    return next === null ? undefined : { wakeAt: next };
  }

  override async alarm(): Promise<{ wakeAt: number } | null> {
    await super.alarm();
    await this.reconcileEffects(false);
    await this.resumeRuns();
    const now = Date.now();
    const due = this.sql
      .exec(
        `SELECT mission_id FROM missions WHERE state='active' AND (
        (next_run_at IS NOT NULL AND next_run_at<=?) OR
        (json_extract(charter_json,'$.trigger.untilAt') IS NOT NULL AND
         CAST(json_extract(charter_json,'$.trigger.untilAt') AS INTEGER)<=?)
      ) ORDER BY COALESCE(next_run_at,CAST(json_extract(charter_json,'$.trigger.untilAt') AS INTEGER)),mission_id`,
        now,
        now
      )
      .toArray();
    for (const row of due) {
      const mission = this.requireMission(String(row["mission_id"]), true);
      await this.ensureAuthority(mission);
      const completion = this.completionBeforeRun(mission, now);
      if (completion) {
        if (!this.hasActiveRun(mission.missionId))
          this.markCompleted(mission.missionId, completion, now);
        continue;
      }
      if (mission.nextRunAt !== undefined && mission.nextRunAt <= now)
        await this.startExecution(mission, "scheduled");
    }
    const next = this.nextWakeAt();
    return next === null ? null : { wakeAt: next };
  }

  @schemaRpc()
  overview(options: {
    limit?: number;
    cursor?: OverviewCursor;
    filter?: OverviewFilter;
    query?: string;
    missionId?: string;
  }) {
    const userId = this.requireUser();
    const generatedAt = Date.now();
    const limit = options.limit ?? DEFAULT_OVERVIEW_LIMIT;
    const cutoff = generatedAt - ATTENTION_WINDOW_MS;
    const conditions = ["(seeded=1 OR owner_user_id=?)"];
    const bindings: unknown[] = [userId];
    if (options.missionId) {
      conditions.push("mission_id=?");
      bindings.push(options.missionId);
    }
    const query = options.query?.trim().toLocaleLowerCase();
    if (query) {
      conditions.push(
        "(instr(lower(name),?)>0 OR instr(lower(json_extract(charter_json,'$.summary')),?)>0)"
      );
      bindings.push(query, query);
    }
    if (options.filter === "active") conditions.push("state='active'");
    if (options.filter === "paused") conditions.push("state='paused'");
    if (options.filter === "completed") conditions.push("state='completed'");
    if (options.filter === "attention") {
      conditions.push(
        "EXISTS (SELECT 1 FROM mission_runs r WHERE r.mission_id=missions.mission_id AND r.outcome='failed' AND r.started_at>=?)",
      );
      bindings.push(cutoff);
    }
    if (options.cursor) {
      conditions.push("(updated_at<? OR (updated_at=? AND mission_id<?))");
      bindings.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.missionId);
    }
    const rows = this.sql
      .exec(
        `SELECT * FROM missions WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC,mission_id DESC LIMIT ?`,
        ...bindings,
        limit + 1
      )
      .toArray() as unknown as MissionRow[];
    const page = rows.slice(0, limit);
    const items = page.map((row) => {
      const recent = this.sql
        .exec(
          "SELECT * FROM mission_runs WHERE mission_id=? ORDER BY started_at DESC,run_id DESC LIMIT ?",
          row.mission_id,
          OVERVIEW_RUN_LIMIT,
        )
        .toArray() as unknown as RunRow[];
      const counts = this.sql
        .exec(
          `SELECT COUNT(*) AS total,
        SUM(CASE WHEN phase!='terminal' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN outcome='failed' AND started_at>=? THEN 1 ELSE 0 END) AS failed
        FROM mission_runs WHERE mission_id=?`,
          cutoff,
          row.mission_id,
        )
        .one();
      return {
        automation: this.rowToMission(row),
        recentRuns: recent.map((run) => this.rowToRun(run)),
        totalRuns: Number(counts["total"] ?? 0),
        activeRuns: Number(counts["active"] ?? 0),
        failedRunsSince: Number(counts["failed"] ?? 0),
      };
    });
    const definitionStats = this.sql
      .exec(
        `SELECT COUNT(*) AS total,SUM(state='active') AS active,SUM(state='completed') AS completed FROM missions WHERE seeded=1 OR owner_user_id=?`,
        userId,
      )
      .one();
    const runStats = this.sql
      .exec(
        `SELECT SUM(r.phase!='terminal') AS running,SUM(r.outcome='failed' AND r.started_at>=?) AS failed FROM mission_runs r JOIN missions m ON m.mission_id=r.mission_id WHERE m.seeded=1 OR m.owner_user_id=?`,
        cutoff,
        userId
      )
      .one();
    const attention = this.sql
      .exec(
        `SELECT r.*,m.name AS mission_name FROM mission_runs r JOIN missions m ON m.mission_id=r.mission_id WHERE r.outcome='failed' AND r.started_at>=? AND (m.seeded=1 OR m.owner_user_id=?) ORDER BY r.started_at DESC LIMIT ?`,
        cutoff,
        userId,
        ATTENTION_LIMIT
      )
      .toArray()
      .map((row) => ({
        missionId: String(row["mission_id"]),
        missionName: String(row["mission_name"]),
        run: this.rowToRun(row as unknown as RunRow),
      }));
    return {
      generatedAt,
      stats: {
        total: Number(definitionStats["total"] ?? 0),
        active: Number(definitionStats["active"] ?? 0),
        running: Number(runStats["running"] ?? 0),
        failedLast24Hours: Number(runStats["failed"] ?? 0),
        completed: Number(definitionStats["completed"] ?? 0),
      },
      items,
      ...(rows.length > limit
        ? {
            nextCursor: {
              updatedAt: page.at(-1)!.updated_at,
              missionId: page.at(-1)!.mission_id,
            },
          }
        : {}),
      attention,
    };
  }

  @schemaRpc()
  list(): MissionRecord[] {
    const userId = this.requireUser();
    return (
      this.sql
        .exec(
          "SELECT * FROM missions WHERE seeded=1 OR owner_user_id=? ORDER BY updated_at DESC",
          userId,
        )
        .toArray() as unknown as MissionRow[]
    ).map((row) => this.rowToMission(row));
  }

  @schemaRpc()
  get(missionId: string): MissionRecord | null {
    const row = this.getRow(missionId);
    if (!row) return null;
    this.requireVisible(row);
    return this.rowToMission(row);
  }

  @schemaRpc()
  listRuns(
    missionId: string,
    options: { limit?: number; cursor?: { startedAt: number; runId: string } },
  ) {
    this.requireMission(missionId);
    const limit = options.limit ?? 20;
    const rows = (options.cursor
      ? this.sql.exec(
          "SELECT * FROM mission_runs WHERE mission_id=? AND (started_at<? OR (started_at=? AND run_id<?)) ORDER BY started_at DESC,run_id DESC LIMIT ?",
          missionId,
          options.cursor.startedAt,
          options.cursor.startedAt,
          options.cursor.runId,
          limit + 1
        )
      : this.sql.exec(
          "SELECT * FROM mission_runs WHERE mission_id=? ORDER BY started_at DESC,run_id DESC LIMIT ?",
          missionId,
          limit + 1
        )
    ).toArray() as unknown as RunRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.rowToRun(row)),
      ...(rows.length > limit && last
        ? { nextCursor: { startedAt: last.started_at, runId: last.run_id } }
        : {}),
    };
  }

  @schemaRpc()
  getRun(runId: string): MissionRunRecord | null {
    const row = this.getRunRow(runId);
    if (!row) return null;
    this.requireMission(row.mission_id);
    return this.rowToRun(row);
  }

  @schemaRpc()
  async launch(input: {
    name: string;
    charter: MissionCharter;
  }): Promise<MissionRecord> {
    validateMissionCharter(input.charter);
    const caller = this.requireOwnerCaller();
    const launchKey =
      this.rpcIdempotencyKey ?? this.rpcRequestId ?? crypto.randomUUID();
    const prior = this.sql
      .exec(
        "SELECT mission_id,state,intent_json FROM mission_launches WHERE owner_user_id=? AND launch_key=?",
        caller.userId,
        launchKey,
      )
      .toArray()[0];
    let missionId: string;
    if (prior) {
      if (String(prior["intent_json"]) !== canonicalJson(input))
        throw denied(
          "Launch idempotency key was reused for a different automation",
        );
      const existing = this.getRow(String(prior["mission_id"]));
      if (existing) {
        const mission = this.rowToMission(existing);
        await this.ensureAuthority(mission);
        return this.requireMission(mission.missionId);
      }
      missionId = String(prior["mission_id"]);
      this.sql.exec(
        "UPDATE mission_launches SET state='preparing',error=NULL WHERE owner_user_id=? AND launch_key=?",
        caller.userId,
        launchKey,
      );
    } else {
      missionId = `msn_${crypto.randomUUID().replaceAll("-", "")}`;
      this.sql.exec(
        "INSERT INTO mission_launches (owner_user_id,launch_key,mission_id,intent_json,state,created_at) VALUES (?,?,?,?, 'preparing',?)",
        caller.userId,
        launchKey,
        missionId,
        canonicalJson(input),
        Date.now(),
      );
    }
    const now = Date.now();
    try {
      const operationPolicy = await this.compilePolicy(input.charter);
      const revisionDigest = missionRevisionDigest(
        input.charter,
        operationPolicy.digest,
      );
      const authority: MissionAuthorityProjection = {
        requestIds: [],
        grantIds: [],
        denialIds: [],
      };
      const origin = scheduleOrigin(input.charter, now);
      const nextRunAt = initialNextRunAt(input.charter, now, origin);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          `INSERT INTO missions
          (mission_id,name,revision,charter_json,operation_policy_json,owner_user_id,owner_device_id,state,revision_digest,authority_json,seeded,schedule_origin_at,next_run_at,last_run_at,created_at,updated_at,activated_at,run_count)
          VALUES (?,?,1,?,?,?,?, 'active',?,?,0,?,?,NULL,?,?,?,0)`,
          missionId,
          input.name,
          canonicalJson(input.charter),
          canonicalJson(operationPolicy),
          caller.userId,
          caller.callerId,
          revisionDigest,
          canonicalJson(authority),
          origin,
          nextRunAt,
          now,
          now,
          now
        );
        this.sql.exec(
          "UPDATE mission_launches SET state='active' WHERE owner_user_id=? AND launch_key=?",
          caller.userId,
          launchKey,
        );
      });
      const mission = this.requireMission(missionId);
      await this.ensureAuthority(mission);
      return this.requireMission(missionId);
    } catch (error) {
      this.sql.exec(
        "UPDATE mission_launches SET state='failed',error=? WHERE owner_user_id=? AND launch_key=?",
        describeError(error),
        caller.userId,
        launchKey,
      );
      throw error;
    }
  }

  @schemaRpc()
  async edit(
    missionId: string,
    input: { name?: string; charter?: MissionCharter },
  ): Promise<MissionRecord> {
    const current = this.requireMission(missionId);
    const caller = this.requireOwnerCaller();
    if (current.owner.userId !== caller.userId)
      throw denied("Automation belongs to another user");
    if (current.state === "retired")
      throw denied("Retired automations cannot be edited");
    if (current.seeded)
      return this.launch({
        name: input.name ?? `${current.name} (custom)`,
        charter: input.charter ?? current.charter,
      });
    const charter = input.charter ?? current.charter;
    validateMissionCharter(charter);
    const policy = input.charter
      ? await this.compilePolicy(charter)
      : current.operationPolicy;
    const digest = missionRevisionDigest(charter, policy.digest);
    await this.interruptRuns(current, "Automation revision was replaced");
    const now = Date.now();
    const origin = scheduleOrigin(charter, now);
    const next = initialNextRunAt(charter, now, origin);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO mission_revisions (mission_id,revision,record_json,recorded_at) VALUES (?,?,?,?)",
        missionId,
        current.revision,
        canonicalJson(current),
        now,
      );
      this.sql.exec(
        `UPDATE missions SET name=?,revision=?,charter_json=?,operation_policy_json=?,state='active',revision_digest=?,authority_json=?,schedule_origin_at=?,next_run_at=?,updated_at=?,activated_at=?,completed_at=NULL,completion_reason=NULL,completion_response=NULL WHERE mission_id=?`,
        input.name ?? current.name,
        current.revision + 1,
        canonicalJson(charter),
        canonicalJson(policy),
        digest,
        canonicalJson({ requestIds: [], grantIds: [], denialIds: [] }),
        origin,
        next,
        now,
        now,
        missionId,
      );
      this.enqueueRetirement(
        missionPrincipal(current.missionId, current.revisionDigest),
        now,
      );
    });
    await this.ensureAuthority(this.requireMission(missionId));
    await this.reconcileEffects(true);
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async runNow(missionId: string): Promise<MissionRunRecord> {
    const mission = this.requireMission(missionId);
    this.requireActive(mission);
    await this.ensureAuthority(mission);
    return this.startExecution(mission, "manual");
  }

  @schemaRpc()
  pause(missionId: string): MissionRecord {
    const mission = this.requireMission(missionId);
    this.requireActive(mission);
    this.sql.exec(
      "UPDATE missions SET state='paused',next_run_at=NULL,updated_at=? WHERE mission_id=?",
      Date.now(),
      missionId
    );
    return this.requireMission(missionId);
  }

  @schemaRpc()
  resume(missionId: string): MissionRecord {
    const mission = this.requireMission(missionId);
    if (mission.state !== "paused")
      throw denied("Only paused automations can resume");
    const now = Date.now();
    const completion = this.completionBeforeRun(mission, now);
    if (completion) this.markCompleted(missionId, completion, now);
    else {
      const row = this.getRow(missionId)!;
      const origin =
        row.schedule_origin_at ?? scheduleOrigin(mission.charter, now);
      this.sql.exec(
        "UPDATE missions SET state='active',schedule_origin_at=?,next_run_at=?,updated_at=? WHERE mission_id=?",
        origin,
        initialNextRunAt(mission.charter, now, origin),
        now,
        missionId,
      );
    }
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async retire(missionId: string): Promise<MissionRecord> {
    const mission = this.requireMission(missionId);
    await this.interruptRuns(mission, "Automation was retired");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE missions SET state='retired',next_run_at=NULL,updated_at=? WHERE mission_id=?",
        now,
        missionId,
      );
      this.enqueueRetirement(
        missionPrincipal(mission.missionId, mission.revisionDigest),
        now,
      );
    });
    await this.reconcileEffects(true);
    return this.requireMission(missionId);
  }

  @schemaRpc()
  async finishRun(input: {
    runId: string;
    outcome: "succeeded" | "failed" | "interrupted" | "cancelled";
    finalMessage?: string;
    completionResponse?: string;
    failure?: MissionRunFailure;
  }): Promise<void> {
    const row = this.getRunRow(input.runId);
    if (!row) throw notFound(`Unknown automation run ${input.runId}`);
    if (row.phase === "terminal") return;
    if (!row.executor_id || this.rpcCallerId !== row.executor_id)
      throw denied("Only the admitted automation executor can finish this run");
    await this.closeAdmission(row);
    this.terminalizeRun(row, input.outcome, {
      finalMessage: input.finalMessage,
      completionResponse: input.completionResponse,
      failure: input.failure,
    });
  }

  private async compilePolicy(
    charter: MissionCharter,
  ): Promise<MissionOperationPolicyReference> {
    const result = await this.rpc.call<MissionOperationPolicyReference>(
      "main",
      "authority.compileOperationPolicy",
      [
        {
          executionImageDigest: missionExecutionImageDigest(
            charter.execution.image,
          ),
          operations: charter.execution.operations.map((operation) => ({
            service: operation.service,
            method: operation.method,
            ...(operation.args ? { args: [...operation.args] } : {}),
            use: operation.use,
          })),
        },
      ],
      {
        idempotencyKey: `automation:policy:${missionExecutionImageDigest(charter.execution.image)}:${canonicalJson(charter.execution.operations)}`,
      },
    );
    return result;
  }

  private async ensureAuthority(mission: MissionRecord): Promise<void> {
    const subject = missionPrincipal(mission.missionId, mission.revisionDigest);
    const projection = await this.acquireAuthority(
      subject,
      mission.operationPolicy.digest,
    );
    this.sql.exec(
      "UPDATE missions SET authority_json=?,updated_at=? WHERE mission_id=? AND revision_digest=?",
      canonicalJson(projection),
      Date.now(),
      mission.missionId,
      mission.revisionDigest,
    );
  }

  private acquireAuthority(
    subject: `mission:${string}@${string}`,
    operationPolicyDigest: string,
  ): Promise<MissionAuthorityProjection> {
    return this.rpc.call<MissionAuthorityProjection>(
      "main",
      "authority.acquireForTarget",
      [{ targetSubject: subject, operationPolicyDigest }],
      { idempotencyKey: `automation:authority:${subject}` },
    );
  }

  private async retireAuthority(
    subject: `mission:${string}@${string}`,
  ): Promise<void> {
    await this.rpc.call(
      "main",
      "authority.retireTarget",
      [{ targetSubject: subject }],
      { idempotencyKey: `automation:retire-authority:${subject}` },
    );
  }

  private enqueueRetirement(
    subject: `mission:${string}@${string}`,
    now: number,
  ): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO mission_effects (effect_id,kind,subject,next_attempt_at) VALUES (?,'retire-authority',?,?)",
      `retire:${subject}`,
      subject,
      now,
    );
  }

  private async reconcileEffects(throwOnFailure: boolean): Promise<void> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        "SELECT effect_id,subject,attempts FROM mission_effects WHERE next_attempt_at<=? ORDER BY next_attempt_at,effect_id",
        now,
      )
      .toArray();
    for (const row of rows) {
      try {
        await this.retireAuthority(
          String(row["subject"]) as `mission:${string}@${string}`,
        );
        this.sql.exec(
          "DELETE FROM mission_effects WHERE effect_id=?",
          String(row["effect_id"]),
        );
      } catch (error) {
        const attempts = Number(row["attempts"]) + 1;
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
        this.sql.exec(
          "UPDATE mission_effects SET attempts=?,next_attempt_at=?,last_error=? WHERE effect_id=?",
          attempts,
          now + delay,
          describeError(error),
          String(row["effect_id"]),
        );
        if (throwOnFailure) throw error;
      }
    }
  }

  private async interruptRuns(
    mission: MissionRecord,
    message: string,
  ): Promise<void> {
    const rows = this.sql
      .exec(
        "SELECT * FROM mission_runs WHERE mission_id=? AND phase!='terminal' ORDER BY started_at,run_id",
        mission.missionId,
      )
      .toArray() as unknown as RunRow[];
    for (const row of rows) {
      await this.closeAdmission(row);
      this.terminalizeRun(this.requireRunRow(row.run_id), "interrupted", {
        failure: failure("EMISSIONENDED", row.phase, message, "none"),
      });
    }
  }

  private async startExecution(
    mission: MissionRecord,
    trigger: "manual" | "scheduled"
  ): Promise<MissionRunRecord> {
    const now = Date.now();
    const completion = this.completionBeforeRun(mission, now);
    if (completion) {
      this.markCompleted(mission.missionId, completion, now);
      throw denied(`Automation has completed (${completion.reason})`);
    }
    this.requireActive(mission);
    const active = this.activeRunRow(mission.missionId);
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    const subject = missionPrincipal(mission.missionId, mission.revisionDigest);
    if (active) {
      this.sql.exec(
        `INSERT INTO mission_runs (run_id,mission_id,mission_subject,mission_revision,trigger_kind,phase,outcome,started_at,finished_at,failure_json) VALUES (?,?,?,?,?,'terminal','skipped',?,?,?)`,
        runId,
        mission.missionId,
        subject,
        mission.revision,
        trigger,
        now,
        now,
        canonicalJson(
          failure(
            "ERUNACTIVE",
            "admission",
            `Previous run ${active.run_id} is still active`,
            "automatic",
          ),
        ),
      );
      if (trigger === "scheduled") this.advanceSchedule(mission, now, mission.runCount);
      return this.requireRun(runId);
    }
    const runNumber = mission.runCount + 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO mission_runs (run_id,mission_id,mission_subject,mission_revision,trigger_kind,phase,started_at,run_number) VALUES (?,?,?,?,?,'admitted',?,?)`,
        runId,
        mission.missionId,
        subject,
        mission.revision,
        trigger,
        now,
        runNumber
      );
      this.sql.exec(
        "UPDATE missions SET last_run_at=?,updated_at=?,run_count=? WHERE mission_id=?",
        now,
        now,
        runNumber,
        mission.missionId
      );
      if (trigger === "scheduled") this.advanceSchedule(mission, now, runNumber);
    });
    await this.advanceRun(runId);
    return this.requireRun(runId);
  }

  private async resumeRuns(): Promise<void> {
    const rows = this.sql
      .exec(
        "SELECT run_id FROM mission_runs WHERE phase!='terminal' ORDER BY started_at,run_id",
      )
      .toArray();
    for (const row of rows) await this.advanceRun(String(row["run_id"]));
  }

  private async advanceRun(runId: string): Promise<void> {
    try {
      let row = this.getRunRow(runId);
      if (
        !row ||
        row.phase === "terminal" ||
        row.phase === "executing" ||
        row.phase === "waiting-authority"
      )
        return;
      const mission = this.requireMission(row.mission_id, true);
      if (
        row.mission_subject !==
          missionPrincipal(mission.missionId, mission.revisionDigest) ||
        mission.state === "retired"
      ) {
        this.terminalizeRun(row, "interrupted", {
          failure: failure(
            "EREVISION",
            row.phase,
            "Automation revision changed before dispatch",
            "none",
          ),
        });
        return;
      }
      const execution = mission.charter.execution;
      if (row.phase === "admitted") {
        this.setPhase(runId, "context-preparing");
        row = this.requireRunRow(runId);
      }
      if (row.phase === "context-preparing") {
        let contextId = row.context_id;
        let channelId = row.channel_id;
        if (execution.kind === "agent") {
          if (execution.conversation.mode === "continue") {
            contextId = execution.conversation.contextId;
            channelId = execution.conversation.channelId;
          } else {
            channelId = `automation-${mission.missionId}-${runId}`;
            const created = await this.rpc.call<{ contextId: string }>(
              "main",
              "runtime.createContext",
              [{}],
              { idempotencyKey: `${runId}:context` },
            );
            contextId = created.contextId;
            await this.activateChannel(channelId, contextId, runId);
          }
        } else contextId = `automation-method:${mission.missionId}`;
        this.sql.exec(
          "UPDATE mission_runs SET phase='executor-preparing',context_id=?,channel_id=? WHERE run_id=? AND phase='context-preparing'",
          contextId,
          channelId,
          runId,
        );
        row = this.requireRunRow(runId);
      }
      if (row.phase === "executor-preparing") {
        const target = await this.activateTarget(
          execution,
          runId,
          row.context_id ?? undefined,
          row.channel_id ?? undefined,
        );
        if (
          execution.kind === "agent" &&
          execution.conversation.mode === "fresh"
        ) {
          await this.rpc.call(
            target.targetId,
            "subscribeChannel",
            [
              {
                channelId: row.channel_id,
                contextId: row.context_id,
                replay: false,
                delivery: "all",
              },
            ],
            { idempotencyKey: `${runId}:subscribe` },
          );
        }
        this.sql.exec(
          "UPDATE mission_runs SET phase='execution-admitting',executor_id=? WHERE run_id=? AND phase='executor-preparing'",
          target.targetId,
          runId,
        );
        row = this.requireRunRow(runId);
      }
      if (row.phase === "execution-admitting") {
        const admission = await this.admit(mission, row);
        this.sql.exec(
          "UPDATE mission_runs SET phase='dispatching',authority_session_id=? WHERE run_id=? AND phase='execution-admitting'",
          admission.authoritySessionId,
          runId,
        );
        row = this.requireRunRow(runId);
      }
      if (row.phase === "dispatching") {
        const admission = await this.admit(mission, row);
        if (execution.kind === "method")
          await this.dispatchMethod(mission, row, admission);
        else await this.dispatchAgent(mission, row, admission);
      }
    } catch (error) {
      const row = this.getRunRow(runId);
      if (!row || row.phase === "terminal") return;
      await this.closeAdmission(row).catch(() => undefined);
      this.terminalizeRun(row, "failed", {
        failure: failure(
          errorCode(error),
          row.phase,
          describeError(error),
          retryFor(error),
        ),
      });
      await this.notifyFailure(
        this.requireMission(row.mission_id, true),
        describeError(error),
      );
    }
  }

  private async admit(
    mission: MissionRecord,
    row: RunRow,
  ): Promise<AdmissionResult> {
    if (!row.executor_id || !row.context_id)
      throw new Error("Automation executor is not prepared");
    const execution = mission.charter.execution;
    return this.rpc.call<AdmissionResult>(
      "main",
      "authority.admitExecution",
      [
        {
          admissionKey: `${row.mission_subject}:${row.run_id}:${execution.kind}`,
          contextId: row.context_id,
          taskRef: row.run_id,
          mission: {
            subject: row.mission_subject,
            missionId: mission.missionId,
            revision: mission.revision,
            revisionDigest: mission.revisionDigest,
          },
          executionImage: {
            source: execution.image.source,
            ref: execution.image.ref,
            effectiveVersion: execution.image.effectiveVersion,
            className: execution.image.className,
          },
          operationPolicyDigest: mission.operationPolicy.digest,
          executor:
            execution.kind === "agent"
              ? {
                  kind: "agent-turn",
                  runtimeId: row.executor_id,
                  entityId: row.executor_id,
                  channelId: row.channel_id!,
                  turnId: row.run_id,
                }
              : {
                  kind: "method",
                  runtimeId: row.executor_id,
                  invocationId: row.run_id,
                  service: execution.image.source,
                  method: execution.method,
                },
        },
      ],
      { idempotencyKey: `${row.run_id}:admit` },
    );
  }

  private async dispatchMethod(
    mission: MissionRecord,
    row: RunRow,
    admission: AdmissionResult,
  ): Promise<void> {
    const execution = mission.charter.execution;
    if (execution.kind !== "method" || !row.executor_id)
      throw new Error("Expected prepared method executor");
    this.setPhase(row.run_id, "executing");
    try {
      const result = await withExecutionAdmission(
        this.rpc,
        admission.nonce,
      ).call(row.executor_id, execution.method, [...execution.args], {
        idempotencyKey: `${row.run_id}:dispatch`,
      });
      const completion = missionCompletionResponse(result);
      await this.closeAdmission(this.requireRunRow(row.run_id));
      this.terminalizeRun(this.requireRunRow(row.run_id), "succeeded", {
        finalMessage: completion?.response ?? resultSummary(result),
        completionResponse: completion?.response,
      });
    } catch (error) {
      await this.closeAdmission(this.requireRunRow(row.run_id)).catch(
        () => undefined,
      );
      this.terminalizeRun(this.requireRunRow(row.run_id), "failed", {
        failure: failure(
          errorCode(error),
          "executing",
          describeError(error),
          retryFor(error),
        ),
      });
    }
  }

  private async dispatchAgent(
    mission: MissionRecord,
    row: RunRow,
    admission: AdmissionResult,
  ): Promise<void> {
    const execution = mission.charter.execution;
    if (execution.kind !== "agent" || !row.executor_id || !row.channel_id)
      throw new Error("Expected prepared agent executor");
    const activity = {
      ...automationActivity(mission, this.rowToRun(row)),
      authoritySessionNonce: admission.nonce,
    };
    this.setPhase(row.run_id, "executing");
    const admittedRpc = withExecutionAdmission(this.rpc, admission.nonce);
    if (execution.action.kind === "prompt")
      await admittedRpc.call(
        row.executor_id,
        "runAutomationTurn",
        [
          {
            channelId: row.channel_id,
            prompt: execution.action.text,
            automation: activity,
          },
        ],
        { idempotencyKey: `${row.run_id}:dispatch` },
      );
    else
      await admittedRpc.call(
        row.executor_id,
        "runAutomationEval",
        [
          {
            channelId: row.channel_id,
            automation: activity,
            eval: {
              code: execution.action.code,
              ...(execution.action.syntax
                ? { syntax: execution.action.syntax }
                : {}),
              ...(execution.action.timeoutMs
                ? { timeoutMs: execution.action.timeoutMs }
                : {}),
              ...(execution.action.reset ? { reset: true } : {}),
            },
          },
        ],
        { idempotencyKey: `${row.run_id}:dispatch` },
      );
  }

  private async activateTarget(
    execution: MissionExecution,
    runId: string,
    contextId?: string,
    channelId?: string,
  ): Promise<{ targetId: string }> {
    const objectKey =
      execution.kind === "agent" && execution.conversation.mode === "fresh"
        ? `${execution.image.objectKey}-${runId}`
        : execution.image.objectKey;
    const value = await this.rpc.call<{
      targetId?: string;
      contextId?: string;
    }>(
      "main",
      "runtime.createEntity",
      [
        {
          kind: "do",
          execution: {
            surface: "code",
            source: execution.image.source,
            ref: execution.image.ref,
          },
          className: execution.image.className,
          key: objectKey,
          ...(contextId ? { contextId } : {}),
          ...(channelId ? { agentChannelId: channelId } : {}),
        },
      ],
      { idempotencyKey: `${runId}:target` },
    );
    if (!value?.targetId || (contextId && value.contextId !== contextId))
      throw new Error(
        "Automation target could not be activated in its exact context",
      );
    return { targetId: value.targetId };
  }

  private async activateChannel(
    channelId: string,
    contextId: string,
    runId: string,
  ): Promise<void> {
    await this.rpc.call(
      "main",
      "runtime.createEntity",
      [
        {
          kind: "do",
          execution: { surface: "code", source: CHANNEL_SOURCE },
          className: CHANNEL_CLASS,
          key: channelId,
          contextId,
        },
      ],
      { idempotencyKey: `${runId}:channel` },
    );
  }

  private async closeAdmission(row: RunRow): Promise<void> {
    if (!row.authority_session_id) return;
    await this.rpc.call(
      "main",
      "authority.finishExecution",
      [{ authoritySessionId: row.authority_session_id }],
      { idempotencyKey: `${row.run_id}:finish-admission` },
    );
  }

  private setPhase(runId: string, phase: MissionRunPhase): void {
    this.sql.exec(
      "UPDATE mission_runs SET phase=? WHERE run_id=? AND phase!='terminal'",
      phase,
      runId,
    );
  }

  private terminalizeRun(
    row: RunRow,
    outcome: MissionRunOutcome,
    input: {
      finalMessage?: string;
      completionResponse?: string;
      failure?: MissionRunFailure;
    },
  ): void {
    const now = Date.now();
    const mission = this.requireMission(row.mission_id, true);
    const completion =
      outcome === "succeeded" &&
      row.mission_revision === mission.revision &&
      (mission.state === "active" || mission.state === "paused")
        ? this.completionAfterRun(mission, now, input.completionResponse)
        : null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE mission_runs SET phase='terminal',outcome=?,finished_at=?,final_message=?,completion_response=?,failure_json=? WHERE run_id=? AND phase!='terminal'",
        outcome,
        now,
        bounded(input.finalMessage) ?? null,
        bounded(input.completionResponse) ?? null,
        input.failure ? canonicalJson(input.failure) : null,
        row.run_id,
      );
      if (completion) this.markCompleted(mission.missionId, completion, now);
    });
  }

  private advanceSchedule(mission: MissionRecord, now: number, runCount: number): void {
    const trigger = mission.charter.trigger;
    if (trigger.kind === "manual") return;
    const origin = this.getRow(mission.missionId)?.schedule_origin_at;
    const candidate =
      trigger.kind === "schedule"
        ? withJitter(missionNextRunAt(trigger, now, Number(origin)), trigger.jitterMs)
        : missionNextRunAt(trigger, now);
    const next =
      (trigger.maxRuns !== undefined && runCount >= trigger.maxRuns) ||
      (trigger.untilAt !== undefined && candidate >= trigger.untilAt)
        ? null
        : candidate;
    this.sql.exec(
      "UPDATE missions SET next_run_at=?,updated_at=? WHERE mission_id=?",
      next,
      now,
      mission.missionId
    );
  }

  private completionBeforeRun(
    mission: MissionRecord,
    now: number
  ): { reason: Exclude<MissionCompletionReason, "response"> } | null {
    const trigger = mission.charter.trigger;
    if (trigger.kind === "manual") return null;
    if (trigger.maxRuns !== undefined && mission.runCount >= trigger.maxRuns)
      return { reason: "max-runs" };
    if (trigger.untilAt !== undefined && now >= trigger.untilAt)
      return { reason: "until" };
    return null;
  }

  private completionAfterRun(
    mission: MissionRecord,
    now: number,
    response?: string
  ): { reason: MissionCompletionReason; response?: string } | null {
    const normalized = response?.trim();
    return normalized
      ? { reason: "response", response: normalized }
      : this.completionBeforeRun(mission, now);
  }

  private markCompleted(
    missionId: string,
    completion: { reason: MissionCompletionReason; response?: string },
    now: number
  ): void {
    this.sql.exec(
      "UPDATE missions SET state='completed',next_run_at=NULL,updated_at=?,completed_at=?,completion_reason=?,completion_response=? WHERE mission_id=? AND state IN ('active','paused')",
      now,
      now,
      completion.reason,
      bounded(completion.response) ?? null,
      missionId
    );
  }

  private nextWakeAt(): number | null {
    const wake = this.sql
      .exec(
        `SELECT MIN(wake_at) AS wake FROM (
      SELECT next_run_at AS wake_at FROM missions WHERE state='active' AND next_run_at IS NOT NULL
      UNION ALL SELECT started_at+60000 AS wake_at FROM mission_runs WHERE phase!='terminal'
      UNION ALL SELECT next_attempt_at AS wake_at FROM mission_effects
    )`,
      )
      .one()["wake"];
    return wake == null ? null : Number(wake);
  }

  private activeRunRow(missionId: string): RunRow | null {
    const row = this.sql
      .exec(
        "SELECT * FROM mission_runs WHERE mission_id=? AND phase!='terminal' LIMIT 1",
        missionId,
      )
      .toArray()[0];
    return row ? (row as unknown as RunRow) : null;
  }
  private hasActiveRun(missionId: string): boolean {
    return this.activeRunRow(missionId) !== null;
  }
  private getRow(missionId: string): MissionRow | null {
    const row = this.sql
      .exec("SELECT * FROM missions WHERE mission_id=?", missionId)
      .toArray()[0];
    return row ? (row as unknown as MissionRow) : null;
  }
  private getRunRow(runId: string): RunRow | null {
    const row = this.sql
      .exec("SELECT * FROM mission_runs WHERE run_id=?", runId)
      .toArray()[0];
    return row ? (row as unknown as RunRow) : null;
  }
  private requireRunRow(runId: string): RunRow {
    const row = this.getRunRow(runId);
    if (!row) throw notFound(`Unknown automation run ${runId}`);
    return row;
  }
  private requireRun(runId: string): MissionRunRecord {
    return this.rowToRun(this.requireRunRow(runId));
  }
  private requireMission(missionId: string, host = false): MissionRecord {
    const row = this.getRow(missionId);
    if (!row) throw notFound(`Unknown automation ${missionId}`);
    if (!host) this.requireVisible(row);
    return this.rowToMission(row);
  }
  private requireVisible(row: MissionRow): void {
    const user = this.requireUser();
    if (row.seeded !== 1 && row.owner_user_id !== user)
      throw notFound("Unknown automation");
  }
  private requireActive(mission: MissionRecord): void {
    if (mission.state !== "active") throw denied("Automation is not active");
  }

  private requireUser(): string {
    const authorization = this.authorization;
    const attributed =
      authorization?.actingUser ??
      authorization?.ownerChain.at(-1) ??
      [...(authorization?.initiatorChain ?? [])]
        .reverse()
        .find((principal) => principal.startsWith("user:"));
    const direct = this.caller?.userId;
    const user =
      direct && direct !== "system"
        ? direct
        : attributed?.startsWith("user:")
          ? attributed.slice(5)
          : direct;
    if (!user || user === "system")
      throw denied("Automation mutation requires user-attributed intent");
    return user;
  }

  private requireOwnerCaller(): { userId: string; callerId: string } {
    const caller = this.caller;
    const userId = this.requireUser();
    if (!caller)
      throw denied("Automation mutation requires an authenticated caller");
    return { userId, callerId: caller.callerId };
  }

  private rowToMission(row: MissionRow): MissionRecord {
    const charter = JSON.parse(row.charter_json) as MissionCharter;
    const operationPolicy = JSON.parse(
      row.operation_policy_json,
    ) as MissionOperationPolicyReference;
    const digest = missionRevisionDigest(charter, operationPolicy.digest);
    if (digest !== row.revision_digest)
      throw new Error(
        `Automation ${row.mission_id} has an invalid revision digest`,
      );
    return {
      schemaVersion: 2,
      missionId: row.mission_id,
      name: row.name,
      revision: Number(row.revision),
      charter,
      operationPolicy,
      owner: {
        userId: row.owner_user_id,
        ...(row.owner_device_id ? { deviceId: row.owner_device_id } : {}),
      },
      state: row.state,
      revisionDigest: digest,
      authority: JSON.parse(row.authority_json) as MissionAuthorityProjection,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      activatedAt: Number(row.activated_at),
      runCount: Number(row.run_count),
      ...(row.completed_at == null
        ? {}
        : { completedAt: Number(row.completed_at) }),
      ...(row.completion_reason
        ? { completionReason: row.completion_reason }
        : {}),
      ...(row.completion_response
        ? { completionResponse: row.completion_response }
        : {}),
      ...(row.seeded === 1 ? { seeded: true } : {}),
      ...(row.next_run_at == null
        ? {}
        : { nextRunAt: Number(row.next_run_at) }),
      ...(row.last_run_at == null
        ? {}
        : { lastRunAt: Number(row.last_run_at) }),
    };
  }

  private rowToRun(row: RunRow): MissionRunRecord {
    return {
      runId: row.run_id,
      missionId: row.mission_id,
      missionSubject: row.mission_subject,
      revision: Number(row.mission_revision),
      trigger: row.trigger_kind,
      phase: row.phase,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      startedAt: Number(row.started_at),
      ...(row.run_number == null ? {} : { runNumber: Number(row.run_number) }),
      ...(row.finished_at == null
        ? {}
        : { finishedAt: Number(row.finished_at) }),
      ...(row.authority_session_id
        ? { authoritySessionId: row.authority_session_id }
        : {}),
      ...(row.acquisition_id ? { acquisitionId: row.acquisition_id } : {}),
      ...(row.channel_id ? { channelId: row.channel_id } : {}),
      ...(row.context_id ? { contextId: row.context_id } : {}),
      ...(row.executor_id ? { executorId: row.executor_id } : {}),
      ...(row.final_message ? { finalMessage: row.final_message } : {}),
      ...(row.completion_response
        ? { completionResponse: row.completion_response }
        : {}),
      ...(row.failure_json
        ? { failure: JSON.parse(row.failure_json) as MissionRunFailure }
        : {}),
    };
  }

  private async notifyFailure(
    mission: MissionRecord,
    detail: string,
  ): Promise<void> {
    await this.rpc
      .call("main", "notification.showToUser", [
        mission.owner.userId,
        {
          type: "error",
          title: `${mission.name} failed`,
          message: detail.slice(0, 2_000),
          actions: [
            {
              id: "view-automation",
              label: "View automation",
              variant: "soft",
              command: {
                type: "panel.open",
                source: "about/automations",
                stateArgs: { missionId: mission.missionId },
              },
            },
          ],
        },
      ])
      .catch(() => undefined);
  }
}

function scheduleOrigin(charter: MissionCharter, now: number): number | null {
  return charter.trigger.kind === "schedule" ? (charter.trigger.anchorAt ?? now) : null;
}
function initialNextRunAt(
  charter: MissionCharter,
  now: number,
  origin: number | null
): number | null {
  if (charter.trigger.kind === "manual") return null;
  if (charter.trigger.kind === "cron") return missionNextRunAt(charter.trigger, now);
  if (origin == null) throw new Error("Interval automation requires a cadence origin");
  return withJitter(missionNextRunAt(charter.trigger, now, origin), charter.trigger.jitterMs);
}
function withJitter(value: number, jitterMs = 0): number {
  return value + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
}
function automationActivity(mission: MissionRecord, run: MissionRunRecord) {
  const trigger = mission.charter.trigger;
  return {
    missionId: mission.missionId,
    runId: run.runId,
    name: mission.name,
    revision: mission.revision,
    action:
      mission.charter.execution.kind === "agent"
        ? mission.charter.execution.action.kind
        : "method",
    trigger: run.trigger,
    startedAt: run.startedAt,
    createdAt: mission.createdAt,
    activatedAt: mission.activatedAt,
    ...(run.runNumber === undefined ? {} : { runNumber: run.runNumber }),
    schedule:
      trigger.kind === "schedule"
        ? {
            kind: "interval" as const,
            everyMs: trigger.everyMs,
            ...(trigger.anchorAt === undefined ? {} : { anchorAt: trigger.anchorAt }),
            ...(trigger.jitterMs === undefined ? {} : { jitterMs: trigger.jitterMs }),
            ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
            ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
          }
        : trigger.kind === "cron"
          ? {
              kind: "cron" as const,
              expression: trigger.expression,
              timezone: trigger.timezone,
              ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
              ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
            }
          : null,
  };
}
function failure(
  code: string,
  stage: string,
  message: string,
  retry: MissionRunFailure["retry"],
): MissionRunFailure {
  return { code, stage, message: bounded(message) ?? message, retry };
}
function retryFor(error: unknown): MissionRunFailure["retry"] {
  const code = errorCode(error);
  return code === "EACQUIRE" || code === "ETIMEDOUT" || code === "EUNAVAILABLE"
    ? "automatic"
    : "manual";
}
function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "ERUN")
    : "ERUN";
}
function resultSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return bounded(value);
  try {
    return bounded(canonicalJson(value));
  } catch {
    return bounded(String(value));
  }
}
function describeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_RUN_TEXT ? value : `${value.slice(0, MAX_RUN_TEXT)}\n…`;
}
function denied(message: string): Error {
  return Object.assign(new Error(message), { code: "EACCES" });
}
function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "ENOENT" });
}
