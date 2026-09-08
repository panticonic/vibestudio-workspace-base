/**
 * Shell client atom -- Jotai atom holding the active ShellClient instance.
 *
 * Set by LoginScreen after successful connection, read by MainScreen
 * and other components that need access to the PanelShell.
 */

import { atom } from "jotai";
import type { ShellClient } from "../services/shellClient";

/** The active ShellClient instance, or null if not connected */
export const shellClientAtom = atom<ShellClient | null>(null);

/** UI revision for durable tree invalidations and local presentation changes. */
export const panelTreeRevisionAtom = atom(0);

/** The owner prevents a previous workspace's connection labels surviving a switch. */
export const websiteConnectionSnapshotAtom = atom<{
  owner: ShellClient | null;
  entries: ReadonlyMap<string, import("@vibestudio/shell-core/websiteConnections").WebsiteConnectionEntry>;
}>({ owner: null, entries: new Map() });
export const websiteConnectionsAtom = atom(get => {
  const snapshot = get(websiteConnectionSnapshotAtom);
  return snapshot.owner === get(shellClientAtom) ? snapshot.entries : new Map();
});
