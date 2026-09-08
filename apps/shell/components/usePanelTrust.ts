import { useWebsiteConnected } from "../shell/hooks/WebsiteConnections";

/** Host-owned trust state colors existing chrome without adding another label. */
export function usePanelTrust(panelId: string, source?: string) {
  const connected = useWebsiteConnected(panelId);
  const browser = source?.startsWith("browser:") === true;
  return {
    state: browser
      ? connected
        ? "connected-website"
        : "website"
      : "workspace",
    description: browser
      ? connected
        ? "Website connected to this workspace; additional resources require permission."
        : "External website with no workspace connection."
      : "Panel installed in this workspace.",
    backgroundImage: browser
      ? `linear-gradient(${connected ? "var(--cyan-a3)" : "var(--blue-a2)"}, ${connected ? "var(--cyan-a3)" : "var(--blue-a2)"})`
      : undefined,
  };
}
