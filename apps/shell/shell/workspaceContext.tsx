import type { createStore } from "jotai";
import { createContext, useContext } from "react";
import * as systemClient from "./client";
import type { ShellWorkspaceClient } from "./workspaceClient";

/** The default is the immutable System presentation owner, never the focused workspace. */
export const ShellWorkspaceClientContext =
  createContext<ShellWorkspaceClient>(systemClient);
export const useShellWorkspaceClient = () =>
  useContext(ShellWorkspaceClientContext);
export const WorkspaceVisibilityContext = createContext(true);
export const useWorkspaceVisible = () => useContext(WorkspaceVisibilityContext);

export const WorkspaceNavigationHostContext = createContext<{
  element: HTMLElement | null;
  scrollElement: HTMLElement | null;
  titleBarHost: HTMLElement | null;
  notificationHost: HTMLElement | null;
  setNotificationHost(element: HTMLElement | null): void;
  workspaceId: string;
  privateRole?: "personal" | "system";
  workspaceLabel: string;
  workspaceNames: Readonly<Record<string, string>>;
  sidebarVisible: boolean;
  toggleSidebar(): void;
  focus(): void;
} | null>(null);
export const useWorkspaceNavigationHost = () =>
  useContext(WorkspaceNavigationHostContext);

export const WorkspaceDesktopHostContext = createContext<{
  openWorkspace(workspaceId: string): Promise<void>;
  inspectWorkspaceFolder?(): Promise<import("@vibestudio/service-schemas/templates").TemplateInspection | null>;
} | null>(null);
export const useWorkspaceDesktopHost = () => {
  const host = useContext(WorkspaceDesktopHostContext);
  if (!host) throw new Error("Workspace desktop owner is unavailable");
  return host;
};

export const ShellPresentationStoreContext = createContext<ReturnType<
  typeof createStore
> | null>(null);
