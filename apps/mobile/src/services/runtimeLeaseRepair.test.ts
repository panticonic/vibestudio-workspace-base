import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelRuntimeLease, RuntimeLeaseSnapshot } from "@vibestudio/shared/panel/panelLease";
import {
  reconcileTrackedRuntimeLeases,
  trackedRuntimeLeaseWasLost,
} from "./runtimeLeaseRepair";

const DEVICE = "device-1";

const slot = (name: string) => asPanelSlotId(`panel:tree/${name}`);

function lease(overrides: { slot: string } & Partial<PanelRuntimeLease>): PanelRuntimeLease {
  const { slot: slotName, ...rest } = overrides;
  return {
    slotId: slot(slotName),
    runtimeEntityId: asPanelEntityId(`panel:nav-${slotName}`),
    clientSessionId: DEVICE,
    hostConnectionId: DEVICE,
    connectionId: `conn-${slotName}`,
    holderLabel: "Mobile",
    platform: "mobile",
    supportsCdp: false,
    loadOnLeaseAssignment: false,
    acquiredAt: 0,
    ...rest,
  };
}

function snapshot(leases: PanelRuntimeLease[]): RuntimeLeaseSnapshot {
  return { leases, version: { epoch: "epoch-1", counter: leases.length } };
}

describe("reconcileTrackedRuntimeLeases", () => {
  it("adopts the leases the server records for this device", () => {
    const ourLease = lease({ slot: "a" });
    const result = reconcileTrackedRuntimeLeases({
      snapshot: snapshot([ourLease]),
      trackedSlotIds: [slot("a")],
      clientSessionId: DEVICE,
    });
    expect(result.ours).toEqual([ourLease]);
    expect(result.lost).toEqual([]);
    expect(result.orphaned).toEqual([]);
  });

  it("orphans — not loses — tracked routes when a restarted server has no leases at all", () => {
    const result = reconcileTrackedRuntimeLeases({
      snapshot: snapshot([]),
      trackedSlotIds: [slot("a"), slot("b")],
      clientSessionId: DEVICE,
    });
    expect(result.orphaned).toEqual([slot("a"), slot("b")]);
    expect(result.lost).toEqual([]);
  });

  it("loses a tracked route whose runtime another client now holds", () => {
    const result = reconcileTrackedRuntimeLeases({
      snapshot: snapshot([lease({ slot: "a", clientSessionId: "other-device" })]),
      trackedSlotIds: [slot("a")],
      clientSessionId: DEVICE,
    });
    expect(result.lost).toEqual([slot("a")]);
    expect(result.orphaned).toEqual([]);
    expect(result.ours).toEqual([]);
  });

  it("keeps a slot that appears under both devices mid-replacement", () => {
    // Leases are keyed by runtime entity, so a slot can carry our lease for the
    // outgoing entity and a foreign lease for the incoming one at the same time.
    const ourLease = lease({ slot: "a", runtimeEntityId: asPanelEntityId("panel:nav-old") });
    const result = reconcileTrackedRuntimeLeases({
      snapshot: snapshot([
        ourLease,
        lease({
          slot: "a",
          runtimeEntityId: asPanelEntityId("panel:nav-new"),
          clientSessionId: "other-device",
        }),
      ]),
      trackedSlotIds: [slot("a")],
      clientSessionId: DEVICE,
    });
    expect(result.ours).toEqual([ourLease]);
    expect(result.lost).toEqual([]);
    expect(result.orphaned).toEqual([]);
  });

  it("ignores leases for slots this device is not presenting", () => {
    const result = reconcileTrackedRuntimeLeases({
      snapshot: snapshot([lease({ slot: "z", clientSessionId: "other-device" })]),
      trackedSlotIds: [],
      clientSessionId: DEVICE,
    });
    expect(result.lost).toEqual([]);
    expect(result.orphaned).toEqual([]);
  });
});

describe("trackedRuntimeLeaseWasLost", () => {
  const current = lease({ slot: "a", runtimeEntityId: asPanelEntityId("panel:nav-current") });

  it("ignores a late release for the slot's replaced runtime entity", () => {
    expect(
      trackedRuntimeLeaseWasLost({
        tracked: current,
        event: {
          runtimeEntityId: asPanelEntityId("panel:nav-replaced"),
          next: null,
        },
        clientSessionId: DEVICE,
      })
    ).toBe(false);
  });

  it("clears the tracked route when its current entity is released or taken over", () => {
    expect(
      trackedRuntimeLeaseWasLost({
        tracked: current,
        event: { runtimeEntityId: current.runtimeEntityId, next: null },
        clientSessionId: DEVICE,
      })
    ).toBe(true);
    expect(
      trackedRuntimeLeaseWasLost({
        tracked: current,
        event: {
          runtimeEntityId: current.runtimeEntityId,
          next: lease({
            slot: "a",
            runtimeEntityId: current.runtimeEntityId,
            clientSessionId: "other-device",
          }),
        },
        clientSessionId: DEVICE,
      })
    ).toBe(true);
  });

  it("keeps the tracked route when its current entity is renewed for this device", () => {
    expect(
      trackedRuntimeLeaseWasLost({
        tracked: current,
        event: { runtimeEntityId: current.runtimeEntityId, next: current },
        clientSessionId: DEVICE,
      })
    ).toBe(false);
  });
});
