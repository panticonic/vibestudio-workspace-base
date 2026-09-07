import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { Provider } from "jotai";
import type { ColorSchemeName } from "react-native";
import type {
  MobileWorkspaceDirectory,
  MobileWorkspaceSession,
} from "../services/workspaceDirectory";
import { colorSchemeAtom } from "./themeAtoms";

export const WorkspaceVisibilityContext = createContext(true);
export const useWorkspaceVisible = () => useContext(WorkspaceVisibilityContext);
export const WorkspaceDirectoryContext =
  createContext<MobileWorkspaceDirectory | null>(null);
export const useWorkspaceDirectory = () =>
  useContext(WorkspaceDirectoryContext);

export function WorkspaceScope({
  session,
  visible,
  scheme,
  children,
}: {
  session: MobileWorkspaceSession;
  visible: boolean;
  scheme: ColorSchemeName;
  children: ReactNode;
}) {
  useLayoutEffect(
    () => session.store.set(colorSchemeAtom, scheme),
    [scheme, session],
  );
  return (
    <WorkspaceVisibilityContext.Provider value={visible}>
      <Provider store={session.store}>{children}</Provider>
    </WorkspaceVisibilityContext.Provider>
  );
}
