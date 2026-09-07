// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePanelLayout } from "./usePanelLayout";
import { ShellWorkspaceClientContext } from "../shell/workspaceContext";
import type { ShellWorkspaceClient } from "../shell/workspaceClient";

vi.mock("../shell/client", () => ({}));
vi.mock("../shell/hooks/PanelTreeContext", () => {
  const root = { id: "shared-panel-id", snapshot: { source: "about/new" } };
  const panelMap = new Map([[root.id, root]]);
  const parentMap = new Map();
  return {
    usePanelTree: () => ({ panelMap, parentMap, initialized: true, refreshing: false }),
    useRootPanels: () => ({ panels: [root], loading: false }),
  };
});

function owner(workspaceId: string) {
  const client = {
    workspace: { getActive: vi.fn(async () => workspaceId) },
    panel: {
      getPanelLayout: vi.fn(async () => null),
      getFocusedPanelId: vi.fn(async () => null),
      setFocusedPanelId: vi.fn(async () => {}),
      savePanelLayout: vi.fn(async () => {}),
    },
  };
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <ShellWorkspaceClientContext.Provider value={client as unknown as ShellWorkspaceClient}>
        {children}
      </ShellWorkspaceClientContext.Provider>
    ),
  };
}

describe("workspace-owned panel layout", () => {
  it("restores, focuses and saves identical panel IDs through their captured workspace owners", async () => {
    const personal = owner("personal");
    const system = owner("system");
    const a = renderHook(() => usePanelLayout(1024, 600), { wrapper: personal.wrapper });
    const b = renderHook(() => usePanelLayout(1024, 600), { wrapper: system.wrapper });
    try {
      await waitFor(() => {
        expect(a.result.current.restored).toBe(true);
        expect(b.result.current.restored).toBe(true);
      });
      for (const { client } of [personal, system]) {
        expect(client.panel.getPanelLayout).toHaveBeenCalledTimes(1);
        expect(client.panel.setFocusedPanelId).toHaveBeenCalledWith("shared-panel-id");
      }
      act(() => a.result.current.dispatch({ type: "resize-columns", columnFrs: [2] }));
      await waitFor(() =>
        expect(personal.client.panel.savePanelLayout).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceId: "personal" })
        )
      );
      expect(system.client.panel.savePanelLayout).not.toHaveBeenCalled();
    } finally {
      a.unmount();
      b.unmount();
    }
  });
});
