import { useAtomValue } from "jotai";
import { websiteConnectionsAtom } from "../state/shellClientAtom";

export function usePanelTrust(
  panelId?: string | null,
  source?: string,
  kind?: string,
) {
  const connections = useAtomValue(websiteConnectionsAtom);
  const browser = kind === "browser" || source?.startsWith("browser:") === true;
  const connected = panelId
    ? connections.get(panelId)?.connected === true
    : false;
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
    tint: browser
      ? connected
        ? "rgba(0, 180, 200, 0.09)"
        : "rgba(70, 130, 220, 0.05)"
      : undefined,
  };
}
