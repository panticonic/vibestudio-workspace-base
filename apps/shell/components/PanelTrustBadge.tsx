import { Badge, Tooltip } from "@radix-ui/themes";
import { useWebsiteConnected } from "../shell/hooks/WebsiteConnections";

/** Trusted chrome label kept independent of website-controlled titles and icons. */
export function PanelTrustBadge({ panelId, source, showWorkspace = false }: {
  panelId: string; source?: string; showWorkspace?: boolean;
}) {
  const connected = useWebsiteConnected(panelId);
  const browser = source?.startsWith("browser:") === true;
  if (!browser && !showWorkspace) return null;
  const label = browser ? connected ? "Connected web" : "Web" : "Workspace";
  const explanation = browser
    ? connected ? "This website is connected to this workspace. Each additional resource still needs its own permission."
      : "This is an external website with no workspace connection."
    : "This panel runs code installed in this workspace.";
  return <Tooltip content={explanation}><Badge size="1" color={browser ? connected ? "cyan" : "amber" : "gray"}
    variant="soft" aria-label={explanation} data-panel-trust={browser ? connected ? "connected-website" : "website" : "workspace"}
    style={{ flexShrink: 0 }}>{label}</Badge></Tooltip>;
}
