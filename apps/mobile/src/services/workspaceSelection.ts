import type { MobileHubWorkspace } from "@vibestudio/mobile-iroh";
import type { MobileWorkspaceDirectory } from "./workspaceDirectory";

export interface MobileWorkspaceSelectionDependencies {
  listWorkspaces(): Promise<MobileHubWorkspace[]>;
  activateWorkspace(workspaceId: string): Promise<void>;
}

export function mobileWorkspaceSelectionDependencies(
  directory: MobileWorkspaceDirectory,
): MobileWorkspaceSelectionDependencies {
  return {
    listWorkspaces: async () => {
      await directory.refresh();
      return directory.entries;
    },
    activateWorkspace: (workspaceId) => directory.activate(workspaceId),
  };
}

export async function listMobileWorkspaces(
  dependencies: MobileWorkspaceSelectionDependencies,
): Promise<MobileHubWorkspace[]> {
  return dependencies.listWorkspaces();
}

/** Switching changes visible content; the account and existing sessions stay put. */
export async function selectMobileWorkspace(
  workspaceId: string,
  dependencies: MobileWorkspaceSelectionDependencies,
): Promise<void> {
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim())
    throw new Error("Choose a valid workspace.");
  await dependencies.activateWorkspace(workspaceId);
}
