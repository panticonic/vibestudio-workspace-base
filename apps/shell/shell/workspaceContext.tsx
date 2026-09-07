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
  workspaceLabel: string;
  workspaceNames: Readonly<Record<string, string>>;
  sidebarVisible: boolean;
  toggleSidebar(): void;
  focus(): void;
} | null>(null);
export const useWorkspaceNavigationHost = () =>
  useContext(WorkspaceNavigationHostContext);

export const ShellPresentationStoreContext = createContext<ReturnType<
  typeof createStore
> | null>(null);
