import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import type { RpcChannelMessage } from "@workspace/pubsub";
import type { AgenticEvent } from "@workspace/agentic-protocol";
import type { ChannelRelationshipPayload } from "./types.js";

export const CHANNEL_DELIVERY_PROJECTION_VERSION = 1;
export const CHANNEL_RELATIONSHIP_EVENT_TYPES = new Set([
  "channel.subscription.opened",
  "channel.subscription.revised",
  "channel.subscription.ended",
]);

type DeliveryInterest = "all" | "addressed" | "none";

interface RelationshipRow {
  participantId: string;
  revision: number;
  delivery: DeliveryInterest;
  endpointEntityId: string | null;
}

export class ChannelDeliveryProjection {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(callback: () => T) => T,
    private readonly channelId: string
  ) {}

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_relationships (
        participant_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        delivery TEXT NOT NULL CHECK (delivery IN ('all', 'addressed', 'none')),
        endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('entity', 'session')),
        endpoint_entity_id TEXT,
        metadata_json TEXT NOT NULL,
        application_config_json TEXT,
        opened_sequence INTEGER NOT NULL,
        CHECK (
          (endpoint_kind = 'entity' AND endpoint_entity_id IS NOT NULL) OR
          (endpoint_kind = 'session' AND endpoint_entity_id IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_mailbox (
        delivery_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        participant_id TEXT NOT NULL,
        endpoint_entity_id TEXT NOT NULL,
        subscription_revision INTEGER NOT NULL,
        envelope_json TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready'
          CHECK (state IN (
            'ready', 'leased', 'retrying',
            'terminal-completed', 'terminal-departed',
            'terminal-retired', 'terminal-integrity'
          )),
        claim_generation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        terminal_outcome_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_event_recipient
        ON channel_delivery_mailbox(event_id, participant_id, subscription_revision);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_claim
        ON channel_delivery_mailbox(state, next_attempt_at, participant_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_lane
        ON channel_delivery_mailbox(participant_id, event_sequence, state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS channel_delivery_projection_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_version INTEGER NOT NULL,
        log_sequence INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO channel_delivery_projection_cursor
        (singleton, projection_version, log_sequence) VALUES (1, ${CHANNEL_DELIVERY_PROJECTION_VERSION}, 0);
    `);
  }

  cursor(): number {
    const row = this.sql
      .exec(`SELECT projection_version, log_sequence FROM channel_delivery_projection_cursor WHERE singleton = 1`)
      .toArray()[0];
    if (!row || Number(row["projection_version"]) !== CHANNEL_DELIVERY_PROJECTION_VERSION) {
      throw new Error("Channel delivery projection version mismatch");
    }
    return Number(row["log_sequence"]);
  }

  relationship(participantId: string): RelationshipRow | null {
    const row = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_entity_id
           FROM channel_relationships WHERE participant_id = ?`,
        participantId
      )
      .toArray()[0];
    if (!row) return null;
    return {
      participantId: String(row["participant_id"]),
      revision: Number(row["revision"]),
      delivery: String(row["delivery"]) as DeliveryInterest,
      endpointEntityId:
        typeof row["endpoint_entity_id"] === "string" ? row["endpoint_entity_id"] : null,
    };
  }

  fold(event: ChannelEvent): { inserted: number; relationshipChanged: boolean } {
    const current = this.cursor();
    if (event.id <= current) return { inserted: 0, relationshipChanged: false };
    if (event.id !== current + 1) {
      throw new Error(`Channel delivery projection gap: expected ${current + 1}, received ${event.id}`);
    }
    return this.transaction(() => {
      let inserted = 0;
      let relationshipChanged = false;
      if (CHANNEL_RELATIONSHIP_EVENT_TYPES.has(event.type)) {
        this.foldRelationship(event);
        relationshipChanged = true;
      } else {
        inserted = this.deriveEvent(event);
      }
      this.sql.exec(
        `UPDATE channel_delivery_projection_cursor SET log_sequence = ? WHERE singleton = 1`,
        event.id
      );
      return { inserted, relationshipChanged };
    });
  }

  private foldRelationship(event: ChannelEvent): void {
    const payload = this.requireRelationshipPayload(event.payload);
    const current = this.relationship(payload.participantId);
    if (event.type === "channel.subscription.ended") {
      if (!current || payload.revision !== current.revision + 1) {
        throw new Error(`Invalid ended relationship revision for ${payload.participantId}`);
      }
      this.sql.exec(`DELETE FROM channel_relationships WHERE participant_id = ?`, payload.participantId);
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-departed', claimed_by = NULL
          WHERE participant_id = ? AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId
      );
      return;
    }
    if (!payload.delivery || !payload.endpoint || !payload.metadata) {
      throw new Error(`${event.type} is missing relationship fields`);
    }
    const expected = current ? current.revision + 1 : 1;
    if (payload.revision !== expected) {
      throw new Error(`Invalid relationship revision for ${payload.participantId}: expected ${expected}`);
    }
    const endpointEntityId = payload.endpoint.kind === "entity" ? payload.endpoint.entityId : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO channel_relationships (
         participant_id, revision, delivery, endpoint_kind, endpoint_entity_id,
         metadata_json, application_config_json, opened_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      payload.participantId,
      payload.revision,
      payload.delivery,
      payload.endpoint.kind,
      endpointEntityId,
      JSON.stringify(payload.metadata),
      payload.applicationConfig === undefined ? null : JSON.stringify(payload.applicationConfig),
      event.id
    );
  }

  private deriveEvent(event: ChannelEvent): number {
    const envelope: RpcChannelMessage = { kind: "log", phase: "live", event };
    const envelopeJson = JSON.stringify(envelope);
    const now = Date.now();
    let inserted = 0;
    const relationships = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_entity_id
           FROM channel_relationships
          WHERE endpoint_kind = 'entity' AND delivery != 'none'
          ORDER BY participant_id`
      )
      .toArray();
    for (const row of relationships) {
      const participantId = String(row["participant_id"]);
      if (participantId === event.senderId) continue;
      const delivery = String(row["delivery"]) as DeliveryInterest;
      if (delivery === "addressed" && !this.addresses(event, participantId)) continue;
      const revision = Number(row["revision"]);
      const endpointEntityId = String(row["endpoint_entity_id"]);
      const deliveryId = sha256HexSyncText(
        canonicalJson([this.channelId, event.messageId, participantId, revision])
      );
      const result = this.sql.exec(
        `INSERT OR IGNORE INTO channel_delivery_mailbox (
           delivery_id, channel_id, event_id, event_sequence, participant_id,
           endpoint_entity_id, subscription_revision, envelope_json,
           projection_version, state, claim_generation, attempts,
           next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, 0, ?, ?)
         RETURNING delivery_id`,
        deliveryId,
        this.channelId,
        event.messageId,
        event.id,
        participantId,
        endpointEntityId,
        revision,
        envelopeJson,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        now,
        now
      );
      inserted += result.toArray().length;
    }
    return inserted;
  }

  private addresses(event: ChannelEvent, participantId: string): boolean {
    if (event.type !== "agentic.trajectory.v1" || !event.payload || typeof event.payload !== "object") {
      return false;
    }
    const agentic = event.payload as AgenticEvent;
    const payload = (agentic as { payload?: { mentions?: unknown; to?: unknown } }).payload;
    if (Array.isArray(payload?.mentions) && payload.mentions.includes(participantId)) return true;
    if (!Array.isArray(payload?.to)) return false;
    return payload.to.some((target) => {
      if (!target || typeof target !== "object") return false;
      const value = target as { kind?: unknown; participantId?: unknown };
      return value.kind === "all" || value.participantId === participantId;
    });
  }

  private requireRelationshipPayload(value: unknown): ChannelRelationshipPayload {
    if (!value || typeof value !== "object") throw new Error("Invalid channel relationship payload");
    const payload = value as ChannelRelationshipPayload;
    if (!payload.participantId || !Number.isSafeInteger(payload.revision) || payload.revision < 1) {
      throw new Error("Invalid channel relationship identity");
    }
    return payload;
  }
}
