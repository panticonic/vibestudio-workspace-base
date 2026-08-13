import { describe, expect, it, vi } from "vitest";
import type { ExtensionContextLike } from "./context.js";
import { observeWorkspace } from "./workspace.js";

const runtime = "systemEpoch: 59\n";
const source = "systemEpoch: 59\ntemplates:\n  use: []\n";
const state =
  "version: 1\nroots: []\noverrides: {}\nnodes: []\nrepositories: {}\n";

function context(files: Readonly<Record<string, string | undefined>>): ExtensionContextLike {
  const call = vi.fn(async (_target: string, method: string, ...args: unknown[]) => {
    if (method === "runtime.createContext") return undefined;
    if (method === "vcs.status") return { mainEventId: "event-main" };
    if (method === "vcs.resolveRepository") return { repositoryId: "repo-meta" };
    if (method === "vcs.readFile") {
      const input = args[0] as { file: { path: string } };
      const text = files[input.file.path];
      return text === undefined ? null : { content: { kind: "text", text } };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  });
  return {
    workspace: {
      getInfo: async () => ({
        path: "/workspace",
        statePath: "/workspace-state",
        id: "workspace-1",
        name: "Workspace",
        config: { systemEpoch: 59 },
      }),
    },
    rpc: { call },
  } as unknown as ExtensionContextLike;
}

describe("template workspace observation", () => {
  it.each([
    ["templates.state.yml", { "vibestudio.yml": runtime, "templates/workspace.yml": source }],
    ["templates/workspace.yml", { "vibestudio.yml": runtime, "templates.state.yml": state }],
  ])("rejects current workspaces missing %s", async (missing, files) => {
    await expect(observeWorkspace(context(files))).rejects.toThrow(
      `Workspace is missing complete template state: ${missing}`
    );
  });
});
