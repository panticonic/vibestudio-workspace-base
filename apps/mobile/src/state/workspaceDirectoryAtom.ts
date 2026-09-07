import { atom } from "jotai";
import type { MobileWorkspaceDirectory } from "../services/workspaceDirectory";

/** Account scope only; workspace providers hold their own immutable ShellClient. */
export const workspaceDirectoryAtom = atom<MobileWorkspaceDirectory | null>(
  null,
);
