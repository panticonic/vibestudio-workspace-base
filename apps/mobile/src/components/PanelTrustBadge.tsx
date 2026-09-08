import { Text } from "react-native";
import { useAtomValue } from "jotai";
import { websiteConnectionsAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { type, radius, spacing } from "../design/tokens";

export function PanelTrustBadge({ panelId, source, kind, showWorkspace = false }: {
  panelId: string; source?: string; kind?: string; showWorkspace?: boolean;
}) {
  const connections = useAtomValue(websiteConnectionsAtom);
  const colors = useAtomValue(themeColorsAtom);
  const browser = kind === "browser" || source?.startsWith("browser:") === true;
  if (!browser && !showWorkspace) return null;
  const connected = connections.get(panelId)?.connected === true;
  const label = browser ? connected ? "Connected web" : "Web" : "Workspace";
  const explanation = browser ? connected
    ? "Website connected to this workspace. Additional resources require permission."
    : "External website with no workspace connection."
    : "Panel installed in this workspace.";
  return <Text accessibilityLabel={explanation}
    testID={`panel-trust-${panelId}`}
    style={[type.micro, { flexShrink: 0, borderRadius: radius.sm,
      paddingHorizontal: spacing.xs,
      color: browser ? connected ? colors.info : colors.warning : colors.textSecondary,
      backgroundColor: browser ? connected ? colors.infoSoft : colors.warningSoft : colors.surfaceSunken,
    }]}>{label}</Text>;
}
