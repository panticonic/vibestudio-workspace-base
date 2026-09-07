import type { Panel } from "@vibestudio/shared/types";
import { materializeMobilePanel } from "./panelMaterializer";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type {
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
} from "@vibestudio/shared/panel/panelLease";
import { RetainedRuntimeLeases } from "./retainedRuntimeLeases";

const version = (counter: number) => ({ epoch: "test", counter });
const PANEL = String(asPanelSlotId("panel:tree/a"));
const A = asPanelEntityId("panel:nav-a");
const B = asPanelEntityId("panel:nav-b");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function lease(
  runtimeEntityId = A,
  connectionId = "connection-1",
): PanelRuntimeLease {
  return {
    slotId: asPanelSlotId(PANEL),
    runtimeEntityId,
    connectionId,
    clientSessionId: "device",
    hostConnectionId: "device",
    holderLabel: "Mobile",
    platform: "mobile",
    supportsCdp: false,
    loadOnLeaseAssignment: false,
    acquiredAt: 0,
  };
}
function harness() {
  let id = 0;
  const calls: Array<{
    runtimeEntityId: typeof A;
    connectionId: string;
    reply: ReturnType<typeof deferred<PanelRuntimeAcquireResult>>;
  }> = [];
  const release = jest.fn(
    async (_runtime: typeof A, _connection: string): Promise<void> => undefined,
  );
  const changed = jest.fn();
  const failed = jest.fn();
  const owners = new RetainedRuntimeLeases({
    createConnectionId: () => `connection-${++id}`,
    acquire: async (_panel, runtimeEntityId, connectionId) => {
      const reply = deferred<PanelRuntimeAcquireResult>();
      calls.push({ runtimeEntityId, connectionId, reply });
      return reply.promise;
    },
    release,
    changed,
    failed,
  });
  return { owners, calls, release, changed, failed };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("keeps the retained connection through timed-out bootstrap retries and reverse response order", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const abandonedBootstrap = new AbortController();
  const panel: Panel = {
    id: PANEL,
    title: "Browser",
    runtimeEntityId: A,
    children: [],
    snapshot: {
      source: "browser:https://example.com",
      contextId: "ctx-a",
      options: {},
    },
    artifacts: { buildState: "ready" },
  };
  const first = materializeMobilePanel({
    panelId: PANEL,
    panel,
    signal: abandonedBootstrap.signal,
    hostConfig: {
      protocol: "https",
      host: "example.com",
      port: "443",
      basePath: "/",
    },
    getPanelInit: async () => ({ entityId: A }),
    acquireLease: (panelId, runtimeEntityId) =>
      h.owners.acquire(panelId, runtimeEntityId, "acquire"),
    takeOverLease: (panelId, runtimeEntityId) =>
      h.owners.acquire(panelId, runtimeEntityId, "takeOver"),
    leaseMode: "acquire",
  });
  const firstRejected = expect(first).rejects.toThrow(
    "materialization canceled",
  );
  await tick();
  abandonedBootstrap.abort();
  const retry = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  expect(h.calls.map((call) => call.connectionId)).toEqual([
    "connection-1",
    "connection-1",
  ]);
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await retry;
  const publishedOwner = h.owners.get(PANEL);
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await firstRejected;
  expect(h.owners.get(PANEL)).toBe(publishedOwner);
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.release).not.toHaveBeenCalled();
});

it("releases a late acquisition after eviction without publishing or resurrecting it from events", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const pending = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(pending).rejects.toThrow("ownership ended");
  await tick();
  const retired = h.owners.retire(PANEL);
  h.owners.observe(lease(), version(1));
  expect(h.owners.get(PANEL)).toBeUndefined();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "canonical-existing"),
  });
  await rejected;
  await retired;
  expect(h.release.mock.calls).toEqual([
    [A, "connection-1"],
    [A, "canonical-existing"],
  ]);
  expect(h.changed).not.toHaveBeenCalled();
});

it("keeps the newer runtime and bridge when the old runtime completes late", async () => {
  const h = harness();
  const oldOwner = h.owners.retain(PANEL, A);
  const old = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(old).rejects.toThrow("ownership ended");
  await tick();
  h.owners.retain(PANEL, B);
  const newer = h.owners.acquire(PANEL, B, "acquire");
  await tick();
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(B, "connection-2"),
  });
  await newer;
  const newOwner = h.owners.get(PANEL);
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await rejected;
  await tick();
  h.owners.observe(lease(), version(1));
  h.owners.clear(PANEL, oldOwner, version(3)); // A delayed repair denial/error belongs to A.
  expect(h.owners.get(PANEL)).toBe(newOwner);
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.release.mock.calls).toEqual([[A, "connection-1"]]);
});

it("finishes exact retirement before reopening the same runtime", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const old = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(old).rejects.toThrow("ownership ended");
  await tick();
  const releasing = deferred<void>();
  h.release.mockImplementationOnce(() => releasing.promise);
  const retired = h.owners.retire(PANEL);
  h.owners.retain(PANEL, A);
  const reopened = h.owners.acquire(PANEL, A, "acquire");
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await rejected;
  await tick();
  expect(h.calls).toHaveLength(1);
  expect(h.release).toHaveBeenCalledWith(A, "connection-1");
  releasing.resolve();
  await retired;
  await tick();
  expect(h.calls[1]!.connectionId).toBe("connection-2");
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "connection-2"),
  });
  await reopened;
  h.owners.observe(lease(), version(1));
  expect(h.owners.get(PANEL)?.connectionId).toBe("connection-2");
});

it("retries unfinished exact cleanup after a transient release failure before reacquisition", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const first = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await first;
  h.release.mockRejectedValueOnce(new Error("Transport disconnected"));
  await expect(h.owners.retire(PANEL)).rejects.toThrow(
    "Transport disconnected",
  );
  h.owners.retain(PANEL, A);
  const reopened = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  expect(h.release.mock.calls).toEqual([
    [A, "connection-1"],
    [A, "connection-1"],
  ]);
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "connection-2"),
  });
  await reopened;
  expect(h.owners.get(PANEL)?.connectionId).toBe("connection-2");
});

it("adopts the coordinator's healthy same-client connection and reuses it on retry", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const first = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "existing-healthy"),
  });
  await first;
  const retry = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  expect(h.calls[1]!.connectionId).toBe("existing-healthy");
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "existing-healthy"),
  });
  await retry;
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.release).not.toHaveBeenCalled();
});

it("rejects a lease for another runtime without publishing or releasing the foreign route", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const pending = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(pending).rejects.toThrow("different panel runtime");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(B, "foreign"),
  });
  await rejected;
  await h.owners.retire(PANEL);
  expect(h.release.mock.calls).toEqual([[A, "connection-1"]]);
  expect(h.changed).not.toHaveBeenCalled();
});

it("does not let a late acquire of an existing healthy connection undo explicit takeover", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const old = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(old).rejects.toThrow("route changed");
  await tick();
  const takeover = h.owners.acquire(PANEL, A, "takeOver");
  await tick();
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(2),
    lease: lease(),
  });
  await takeover;
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "existing-healthy"),
  });
  await rejected;
  expect(h.owners.get(PANEL)?.connectionId).toBe("connection-1");
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.release).not.toHaveBeenCalled();
});

it("orders overlapping explicit route changes by the coordinator version, not response arrival", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const initial = h.owners.acquire(PANEL, A, "acquire");
  const firstTakeover = h.owners.acquire(PANEL, A, "takeOver");
  const rejected = expect(firstTakeover).rejects.toThrow("route changed");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(A, "existing-healthy"),
  });
  await initial;
  const secondTakeover = h.owners.acquire(PANEL, A, "takeOver");
  await tick();
  h.calls[2]!.reply.resolve({
    acquired: true,
    version: version(3),
    lease: lease(A, "existing-healthy"),
  });
  await secondTakeover;
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(2),
    lease: lease(),
  });
  await rejected;
  expect(h.owners.get(PANEL)?.connectionId).toBe("existing-healthy");
  expect(h.changed).toHaveBeenCalledTimes(1);
});

it("ignores a snapshot's foreign lease when that owner acquires while the snapshot is in flight", async () => {
  const h = harness();
  const owner = h.owners.retain(PANEL, A);
  const snapshot = deferred<void>();
  const reconcile = snapshot.promise.then(() =>
    h.owners.clear(PANEL, owner, version(0)),
  );
  const acquire = h.owners.acquire(PANEL, A, "acquire");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: lease(),
  });
  await acquire;
  snapshot.resolve();
  await reconcile;
  expect(h.owners.get(PANEL)).toBe(owner);
  expect(h.changed).toHaveBeenCalledTimes(1);
});

it.each(["acquire", "takeOver"] as const)(
  "does not revive a route from late %s after a newer loss observation",
  async (mode) => {
    const h = harness();
    h.owners.retain(PANEL, A);
    const first = h.owners.acquire(PANEL, A, "acquire");
    await tick();
    h.calls[0]!.reply.resolve({
      acquired: true,
      version: version(1),
      lease: lease(),
    });
    await first;
    const repair = h.owners.acquire(PANEL, A, mode);
    const rejected = expect(repair).rejects.toThrow("route changed");
    await tick();
    h.owners.clear(PANEL, h.owners.retained(PANEL), version(2));
    h.calls[1]!.reply.resolve({
      acquired: true,
      version: version(1),
      lease: lease(),
    });
    await rejected;
    expect(h.owners.get(PANEL)).toBeUndefined();
    expect(h.changed).toHaveBeenCalledTimes(2);
  },
);

it("does not let an older denial clear a newer successful takeover", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const denied = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(denied).rejects.toThrow("route changed");
  const takeover = h.owners.acquire(PANEL, A, "takeOver");
  await tick();
  h.calls[1]!.reply.resolve({
    acquired: true,
    version: version(2),
    lease: lease(),
  });
  await takeover;
  h.calls[0]!.reply.resolve({
    acquired: false,
    version: version(1),
    lease: { ...lease(A, "foreign"), clientSessionId: "other-device" },
  });
  await rejected;
  expect(h.owners.get(PANEL)?.connectionId).toBe("connection-1");
  expect(h.changed).toHaveBeenCalledTimes(1);
});

it("does not use another runtime's lease observation as a global response watermark", async () => {
  const h = harness();
  const otherPanel = String(asPanelSlotId("panel:tree/b"));
  h.owners.retain(PANEL, A);
  h.owners.retain(otherPanel, B);
  h.owners.observe(lease(), version(20));
  const second = h.owners.acquire(otherPanel, B, "acquire");
  await tick();
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(2),
    lease: { ...lease(B, "connection-2"), slotId: asPanelSlotId(otherPanel) },
  });
  await second;
  expect(h.owners.get(otherPanel)?.connectionId).toBe("connection-2");
  expect(h.owners.get(PANEL)?.connectionId).toBe("connection-1");
});

it("observes release of a canonical connection before its acquisition acknowledgment arrives", async () => {
  const h = harness();
  h.owners.retain(PANEL, A);
  const pending = h.owners.acquire(PANEL, A, "acquire");
  const rejected = expect(pending).rejects.toThrow("route changed");
  await tick();
  const canonical = lease(A, "existing-healthy");
  h.owners.handleEvent(
    {
      type: "panel:runtimeLeaseChanged",
      slotId: asPanelSlotId(PANEL),
      runtimeEntityId: A,
      version: version(1),
      previous: null,
      next: canonical,
      reason: "acquired",
    },
    "device",
  );
  h.owners.handleEvent(
    {
      type: "panel:runtimeLeaseChanged",
      slotId: asPanelSlotId(PANEL),
      runtimeEntityId: A,
      version: version(2),
      previous: canonical,
      next: null,
      reason: "released",
    },
    "device",
  );
  h.calls[0]!.reply.resolve({
    acquired: true,
    version: version(1),
    lease: canonical,
  });
  await rejected;
  expect(h.owners.get(PANEL)).toBeUndefined();
  expect(h.changed).not.toHaveBeenCalled();
});
