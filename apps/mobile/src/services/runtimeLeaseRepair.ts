import type { PanelRuntimeLease, RuntimeLeaseSnapshot } from "@vibestudio/shared/panel/panelLease";

export interface TrackedRuntimeLeaseReconciliation {
  /** Leases the server records as ours — adopt them as the tracked route. */
  readonly ours: PanelRuntimeLease[];
  /** Slots whose runtime moved to another client — stop presenting them. */
  readonly lost: string[];
  /**
   * Slots this device is still presenting that the server records no lease for
   * at all — re-acquire the route rather than dropping it.
   */
  readonly orphaned: string[];
}

/**
 * Classify the routes this device is presenting against the server's lease table.
 *
 * An absent lease and a lease held by someone else are different facts, and
 * collapsing them strands the panel. A workspace that restarted comes back with
 * an empty lease table while every mounted WebView is still on screen and still
 * expecting its route; treating that absence as "this panel moved away" clears
 * the tracked route, and because nothing re-materializes an already-current
 * WebView, the panel can never open a session again. Only a lease recorded for a
 * *different* client is evidence that we lost the panel.
 */
export function reconcileTrackedRuntimeLeases(input: {
  snapshot: RuntimeLeaseSnapshot;
  trackedSlotIds: Iterable<string>;
  clientSessionId: string;
}): TrackedRuntimeLeaseReconciliation {
  const ours: PanelRuntimeLease[] = [];
  const ourSlots = new Set<string>();
  const otherSlots = new Set<string>();
  for (const lease of input.snapshot.leases) {
    const slotId = String(lease.slotId);
    if (lease.clientSessionId === input.clientSessionId) {
      ours.push(lease);
      ourSlots.add(slotId);
    } else {
      otherSlots.add(slotId);
    }
  }
  const lost: string[] = [];
  const orphaned: string[] = [];
  for (const slotId of input.trackedSlotIds) {
    if (ourSlots.has(slotId)) continue;
    // A slot can appear under both this device and another client while a
    // runtime replacement is mid-flight (the leases are keyed by runtime entity,
    // not by slot). Our own lease wins above; only an exclusively foreign slot
    // counts as lost.
    if (otherSlots.has(slotId)) lost.push(slotId);
    else orphaned.push(slotId);
  }
  return { ours, lost, orphaned };
}
