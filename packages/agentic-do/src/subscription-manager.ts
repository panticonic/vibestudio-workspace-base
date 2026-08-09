/**
 * Durable channel relationships owned by an agent vessel.
 *
 * Membership is data, not a response resource. Every operation is a finite
 * RPC to the channel; activation restart has nothing to reopen or recover.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelSubscriptionConfig } from "@workspace/agentic-core";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { ChannelReplayEnvelope } from "@workspace/pubsub";
import type { DOIdentity } from "./identity.js";
import type { ChannelClient } from "./channel-client.js";

export interface RecoveredChannelSubscription {
  channelId: string;
  config?: unknown;
  envelope?: ChannelReplayEnvelope;
}

interface StoredSubscription {
  channelId: string;
  contextId: string;
  revision: number;
  participantId: string;
  config?: unknown;
}

export class SubscriptionManager {
  constructor(
    private sql: SqlStorage,
    private channelFactory: (channelId: string) => ChannelClient,
    private identity: DOIdentity
  ) {}

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        channel_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        subscribed_at INTEGER NOT NULL,
        config TEXT,
        participant_id TEXT NOT NULL
      )
    `);
  }

  createTables(): void {
    SubscriptionManager.createTables(this.sql);
  }

  private buildParticipantId(): string {
    const ref = this.identity.ref;
    return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
  }

  async subscribe(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    descriptor: ParticipantDescriptor;
    replay?: boolean;
  }): Promise<{
    ok: boolean;
    participantId: string;
    channelConfig?: Record<string, unknown>;
    envelope?: ChannelReplayEnvelope;
  }> {
    const participantId = this.buildParticipantId();
    const current = this.getStored(opts.channelId);
    const revision = current?.revision ?? 1;
    const metadata: Record<string, unknown> = {
      name: opts.descriptor.name,
      type: opts.descriptor.type,
      handle: opts.descriptor.handle,
      ...opts.descriptor.metadata,
      ...(opts.descriptor.methods?.length ? { methods: opts.descriptor.methods } : {}),
    };
    const config = opts.config && typeof opts.config === "object" ? opts.config : null;
    const result = await this.channelFactory(opts.channelId).join({
      participantId,
      revision,
      contextId: opts.contextId,
      metadata,
      delivery: "all",
      endpoint: { kind: "entity", entityId: participantId },
      applicationConfig: config === null ? null : { version: 1, value: config },
      replay: opts.replay !== false,
    });

    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, revision, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      opts.channelId,
      opts.contextId,
      revision,
      Date.now(),
      config === null ? null : JSON.stringify(config),
      participantId
    );
    return result;
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    const stored = this.getStored(channelId);
    if (!stored) return;
    await this.channelFactory(channelId).leave(stored.participantId, stored.revision + 1);
  }

  getParticipantId(channelId: string): string | null {
    return this.getStored(channelId)?.participantId ?? null;
  }

  getContextId(channelId: string): string {
    const stored = this.getStored(channelId);
    if (!stored) throw new Error(`No subscription for channel ${channelId}`);
    return stored.contextId;
  }

  getConfig(channelId: string): ChannelSubscriptionConfig | null {
    const stored = this.getStored(channelId);
    const parsed = stored?.config;
    return parsed && typeof parsed === "object" ? (parsed as ChannelSubscriptionConfig) : null;
  }

  patchConfig(channelId: string, patch: Record<string, unknown>): ChannelSubscriptionConfig {
    const current = this.getConfig(channelId) ?? {};
    if (!this.getParticipantId(channelId)) throw new Error(`No subscription for channel ${channelId}`);
    const next: Record<string, unknown> = { ...current, ...patch };
    this.sql.exec(`UPDATE subscriptions SET config = ? WHERE channel_id = ?`, JSON.stringify(next), channelId);
    return next as ChannelSubscriptionConfig;
  }

  listAll(): Array<{ channelId: string; participantId: string | null }> {
    return this.listStored().map(({ channelId, participantId }) => ({ channelId, participantId }));
  }

  listStored(): StoredSubscription[] {
    return this.sql
      .exec(`SELECT channel_id, context_id, revision, config, participant_id FROM subscriptions ORDER BY channel_id`)
      .toArray()
      .map((row) => ({
        channelId: String(row["channel_id"]),
        contextId: String(row["context_id"]),
        revision: Number(row["revision"]),
        participantId: String(row["participant_id"]),
        ...(typeof row["config"] === "string" ? { config: JSON.parse(String(row["config"])) as unknown } : {}),
      }));
  }

  deleteSubscription(channelId: string): void {
    this.sql.exec(`DELETE FROM subscriptions WHERE channel_id = ?`, channelId);
  }

  count(): number {
    const row = this.sql.exec(`SELECT COUNT(*) AS cnt FROM subscriptions`).toArray()[0];
    return Number(row?.["cnt"] ?? 0);
  }

  listChannelIds(): string[] {
    return this.listStored().map(({ channelId }) => channelId);
  }

  rename(oldChannelId: string, newChannelId: string, newContextId: string): void {
    if (!newContextId) throw new Error("SubscriptionManager.rename requires newContextId");
    this.sql.exec(
      `UPDATE subscriptions SET channel_id = ?, context_id = ?, participant_id = ? WHERE channel_id = ?`,
      newChannelId,
      newContextId,
      this.buildParticipantId(),
      oldChannelId
    );
  }

  private getStored(channelId: string): StoredSubscription | null {
    const row = this.sql
      .exec(`SELECT channel_id, context_id, revision, config, participant_id FROM subscriptions WHERE channel_id = ?`, channelId)
      .toArray()[0];
    if (!row) return null;
    return {
      channelId: String(row["channel_id"]),
      contextId: String(row["context_id"]),
      revision: Number(row["revision"]),
      participantId: String(row["participant_id"]),
      ...(typeof row["config"] === "string" ? { config: JSON.parse(String(row["config"])) as unknown } : {}),
    };
  }
}
