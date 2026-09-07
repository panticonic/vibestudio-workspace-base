import { createContext, useContext } from "react";
import type { WorkspaceIcons } from "./workspaceIcons";

/** Pure presentation dependency: native overlay documents have no RPC client. */
export const WorkspaceIconsContext = createContext<Pick<WorkspaceIcons, "load"> | null>(null);
export const useWorkspaceIcons = () => useContext(WorkspaceIconsContext);
