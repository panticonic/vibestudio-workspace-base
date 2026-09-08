import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { observeWebsiteConnections, type WebsiteConnectionEntry } from "@vibestudio/shell-core/websiteConnections";
import { useShellWorkspaceClient } from "../workspaceContext";

const Connections = createContext<ReadonlyMap<string, WebsiteConnectionEntry>>(new Map());
/** Connection state comes from authenticated host events, never page titles or favicons. */
export function WebsiteConnectionsProvider({ children }: { children: ReactNode }) {
  const client = useShellWorkspaceClient();
  const [snapshot, setSnapshot] = useState({ owner: client, entries: new Map<string, WebsiteConnectionEntry>() as ReadonlyMap<string, WebsiteConnectionEntry> });
  useEffect(() => observeWebsiteConnections({
    list: () => client.websiteConnections.list(),
    listen: changed => client.events.on("website:connection-changed", changed),
    subscribe: () => client.events.subscribe("website:connection-changed"),
    unsubscribe: () => client.events.unsubscribe("website:connection-changed"),
    changed: entries => setSnapshot({ owner: client, entries }),
    error: error => console.warn("[WebsiteConnections] Failed to read workspace connection state", error),
  }), [client]);
  return <Connections.Provider value={snapshot.owner === client ? snapshot.entries : new Map()}>{children}</Connections.Provider>;
}
export function useWebsiteConnected(slotId: string): boolean {
  return useContext(Connections).get(slotId)?.connected === true;
}
