import { trackedRuntimeLeaseWasLost } from "./runtimeLeaseRepair";
import {
  asPanelEntityId,
  type PanelEntityId,
} from "@vibestudio/shared/panel/ids";
import type {
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseVersion,
} from "@vibestudio/shared/panel/panelLease";

export interface RetainedRuntimeOwner {
  readonly runtimeEntityId: PanelEntityId;
  connectionId: string;
  acquired: boolean;
  version: RuntimeLeaseVersion | null;
  readonly pending: Set<Promise<PanelRuntimeAcquireResult>>;
  readonly observed: Map<
    string,
    { runtimeEntityId: PanelEntityId; connectionId: string }
  >;
  readonly priorRetirement: (() => Promise<void>) | undefined;
}

/** A lease belongs to a retained view/runtime, not to a timed bootstrap attempt. */
export class RetainedRuntimeLeases {
  private readonly owners = new Map<string, RetainedRuntimeOwner>();
  private readonly retirements = new Map<string, () => Promise<void>>();

  constructor(
    private readonly deps: {
      createConnectionId(): string;
      acquire(
        panelId: string,
        runtimeEntityId: PanelEntityId,
        connectionId: string,
        mode: "acquire" | "takeOver",
      ): Promise<PanelRuntimeAcquireResult>;
      release(
        runtimeEntityId: PanelEntityId,
        connectionId: string,
      ): Promise<unknown>;
      changed(panelId: string): void;
      failed(error: unknown): void;
    },
  ) {}

  get(panelId: string): RetainedRuntimeOwner | undefined {
    const owner = this.owners.get(panelId);
    return owner?.acquired ? owner : undefined;
  }

  retained(panelId: string): RetainedRuntimeOwner | undefined {
    return this.owners.get(panelId);
  }

  keys(): IterableIterator<string> {
    return this.owners.keys();
  }

  retain(
    panelId: string,
    runtimeEntityId: PanelEntityId,
  ): RetainedRuntimeOwner {
    const previous = this.owners.get(panelId);
    if (previous?.runtimeEntityId === runtimeEntityId) return previous;
    if (previous) void this.retire(panelId);
    const connectionId = this.deps.createConnectionId();
    const owner: RetainedRuntimeOwner = {
      runtimeEntityId,
      connectionId,
      acquired: false,
      version: null,
      pending: new Set(),
      observed: new Map([[connectionId, { runtimeEntityId, connectionId }]]),
      priorRetirement: this.retirements.get(runtimeEntityId),
    };
    this.owners.set(panelId, owner);
    return owner;
  }

  async acquire(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    mode: "acquire" | "takeOver",
  ): Promise<PanelRuntimeAcquireResult> {
    const owner = this.owners.get(panelId);
    if (!owner || owner.runtimeEntityId !== runtimeEntityId)
      throw new Error("Panel runtime is no longer retained");
    // Only actual view retirement is a barrier. Concurrent bootstrap retries of
    // the same retained view share its route and never queue behind one another.
    await owner.priorRetirement?.();
    if (this.owners.get(panelId) !== owner)
      throw new Error("Panel runtime is no longer retained");
    const pending = (async () => {
      const result = await this.deps.acquire(
        panelId,
        runtimeEntityId,
        owner.connectionId,
        mode,
      );
      if (result.acquired) {
        if (
          String(result.lease.slotId) !== panelId ||
          result.lease.runtimeEntityId !== runtimeEntityId
        ) {
          throw new Error(
            "Acquired lease belongs to a different panel runtime",
          );
        }
        owner.observed.set(result.lease.connectionId, {
          runtimeEntityId,
          connectionId: result.lease.connectionId,
        });
      }
      if (this.owners.get(panelId) !== owner)
        throw new Error("Panel runtime ownership ended during acquisition");
      if (!this.acceptVersion(panelId, owner, result.version)) {
        throw new Error("Panel runtime route changed during acquisition");
      }
      if (result.acquired) this.publish(panelId, owner, result.lease);
      else this.clear(panelId, owner, result.version);
      return result;
    })();
    owner.pending.add(pending);
    try {
      return await pending;
    } finally {
      owner.pending.delete(pending);
    }
  }

  /** Each observation covers this runtime, not unrelated workspace leases. */
  acceptVersion(
    panelId: string,
    owner: RetainedRuntimeOwner | undefined,
    version: RuntimeLeaseVersion,
  ): boolean {
    if (!owner || this.owners.get(panelId) !== owner) return false;
    if (
      owner.version?.epoch === version.epoch &&
      version.counter < owner.version.counter
    )
      return false;
    owner.version = version;
    return true;
  }

  handleEvent(
    event: PanelRuntimeLeaseChangedEvent,
    clientSessionId: string,
  ): void {
    const panelId = String(event.slotId);
    const owner = this.owners.get(panelId);
    // Even a release of a not-yet-adopted connection is a newer authoritative
    // observation. A delayed acquire must not bring that connection back.
    if (
      !owner ||
      owner.runtimeEntityId !== event.runtimeEntityId ||
      !this.acceptVersion(panelId, owner, event.version)
    )
      return;
    if (event.next?.clientSessionId === clientSessionId)
      this.observe(event.next, event.version);
    else if (
      trackedRuntimeLeaseWasLost({ tracked: owner, event, clientSessionId })
    )
      this.clear(panelId, owner, event.version);
  }

  /** Events confirm existing ownership; they never resurrect an evicted view. */
  observe(lease: PanelRuntimeLease, version: RuntimeLeaseVersion): void {
    const panelId = String(lease.slotId);
    const owner = this.owners.get(panelId);
    if (
      !owner ||
      owner.runtimeEntityId !== lease.runtimeEntityId ||
      !this.acceptVersion(panelId, owner, version)
    )
      return;
    if (owner.connectionId === lease.connectionId)
      this.publish(panelId, owner, lease);
  }

  clear(
    panelId: string,
    owner: RetainedRuntimeOwner | undefined,
    version: RuntimeLeaseVersion,
  ): void {
    if (!this.acceptVersion(panelId, owner, version) || !owner?.acquired)
      return;
    owner.acquired = false;
    this.deps.changed(panelId);
  }

  private publish(
    panelId: string,
    owner: RetainedRuntimeOwner,
    lease: PanelRuntimeLease,
  ): void {
    const changed =
      !owner.acquired || owner.connectionId !== lease.connectionId;
    owner.connectionId = lease.connectionId;
    owner.acquired = true;
    owner.observed.set(lease.connectionId, {
      runtimeEntityId: asPanelEntityId(String(lease.runtimeEntityId)),
      connectionId: lease.connectionId,
    });
    if (changed) {
      this.deps.changed(panelId);
    }
  }

  retire(panelId: string, expected = this.owners.get(panelId)): Promise<void> {
    if (!expected || this.owners.get(panelId) !== expected)
      return Promise.resolve();
    this.owners.delete(panelId);
    if (expected.acquired) this.deps.changed(panelId);
    const pending = [...expected.pending];
    let running: Promise<void> | undefined;
    const finishRetirement = (): Promise<void> => {
      if (running) return running;
      running = (async () => {
        await expected.priorRetirement?.();
        // A late acknowledgment belongs to this retired view. Finish exact
        // cleanup before a reopened view can adopt the same server route.
        await Promise.allSettled(pending);
        for (const [connectionId, lease] of expected.observed) {
          await this.deps.release(lease.runtimeEntityId, lease.connectionId);
          expected.observed.delete(connectionId);
        }
        if (
          this.retirements.get(expected.runtimeEntityId) === finishRetirement
        ) {
          this.retirements.delete(expected.runtimeEntityId);
        }
      })().finally(() => {
        running = undefined;
      });
      return running;
    };
    this.retirements.set(expected.runtimeEntityId, finishRetirement);
    const retirement = finishRetirement();
    // Keep failed exact cleanup available for the next retention/recovery call.
    void retirement.catch(this.deps.failed);
    return retirement;
  }
}
