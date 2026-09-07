import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";
/** Private runtime names are stable routing keys, never primary display labels. */
export const workspaceLabel = (workspace: HubWorkspaceEntry): string =>
  workspace.privateRole === "personal" ? "Personal" : workspace.privateRole === "system" ? "System" : workspace.name;
