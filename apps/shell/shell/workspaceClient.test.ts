import { describe, expect, it, vi } from "vitest";
import {
  RpcBoundaryError,
  type RpcClient,
  type RpcConnectionStatus,
} from "@vibestudio/rpc";
import type { NativePanelDesiredSnapshot } from "@vibestudio/service-schemas/view";
import { createNativePanelPresentation } from "./nativePanelPresentation";
import { createShellWorkspaceClient } from "./workspaceClient";

function nativeSession(workspaceId: string) {
  const call = vi.fn(
    async (_target: string, method: string, args: unknown[]) => {
      if (method === "view.connectNativePanelAdapter")
        return {
          accepted: true,
          handshake: {
            protocolVersion: 2,
            hostGeneration: workspaceId,
            shellGeneration: "shell",
            sealedLaunchIdentity: "@workspace-apps/shell",
          },
        };
      if (method === "view.applyNativePanelSurfaces") {
        const desired = args[0] as NativePanelDesiredSnapshot;
        return {
          accepted: true,
          observation: {
            protocolVersion: 2,
            hostGeneration: workspaceId,
            shellGeneration: "shell",
            desiredRevision: desired.revision,
            observationRevision: desired.revision,
            focusedWorkspaceId: desired.focusedWorkspaceId,
            surfaces: desired.surfaces.map((surface) => ({
              ...surface,
              nativeSurfaceId: workspaceId + ":" + surface.surfaceId,
            })),
          },
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  );
  const rpc = {
    call,
    on: vi.fn(() => () => {}),
    onStatusChange: vi.fn(() => () => {}),
    selfId: workspaceId,
  } as unknown as RpcClient;
  return {
    rpc,
    client: createShellWorkspaceClient(rpc, {
      hubRpc: rpc,
      workspaceId,
      nativePresentation: createNativePanelPresentation(rpc),
    }),
    call,
  };
}
const slot = {
  nativeSlotId: "pane-1",
  bindingId: "lease-1",
  panelId: "panel-1",
  bounds: { x: 0, y: 0, width: 400, height: 300 },
  focused: true,
};
describe("workspace-owned shell clients", () => {
  it("keeps identically named native panel slots and revisions separate", async () => {
    const personal = nativeSession("personal");
    const project = nativeSession("project");
    expect(await personal.client.view.bindNativePanelSlot(slot)).toEqual({
      status: "bound",
    });
    expect(
      await project.client.view.updateNativePanelSlot({
        nativeSlotId: slot.nativeSlotId,
        bindingId: slot.bindingId,
      }),
    ).toEqual({
      status: "missing",
      reason: "unknown native panel slot: pane-1",
    });
    await project.client.view.bindNativePanelSlot({
      ...slot,
      panelId: "project-panel",
    });
    await personal.client.view.clearNativePanelSlot({
      nativeSlotId: slot.nativeSlotId,
      bindingId: slot.bindingId,
    });
    const projectCalls = project.call.mock.calls.filter(
      ([, method]) => method === "view.applyNativePanelSurfaces",
    );
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0]?.[2][0]).toMatchObject({
      hostGeneration: "project",
      revision: 1,
      surfaces: [{ materialization: { runtimeEntityId: "project-panel" } }],
    });
    const personalCalls = personal.call.mock.calls.filter(
      ([, method]) => method === "view.applyNativePanelSurfaces",
    );
    expect(personalCalls[1]?.[2][0]).toMatchObject({
      hostGeneration: "personal",
      revision: 2,
      surfaces: [],
    });
  });
  it("retains the original client in a captured handler after another workspace is created", async () => {
    const personal = nativeSession("personal");
    const captured = () => personal.client.view.bindNativePanelSlot(slot);
    const project = nativeSession("project");
    await captured();
    expect(personal.call).toHaveBeenCalled();
    expect(project.call).not.toHaveBeenCalled();
  });
  it("converges one shared native compositor without colliding equal local panel slots", async () => {
    const host = nativeSession("system");
    const native = createNativePanelPresentation(host.rpc);
    const personal = native.forWorkspace("personal");
    const project = native.forWorkspace("project");
    await personal.bindNativePanelSlot(slot);
    await project.bindNativePanelSlot(slot);
    let snapshots = host.call.mock.calls.filter(
      ([, method]) => method === "view.applyNativePanelSurfaces",
    );
    const second = snapshots.at(-1)?.[2][0] as NativePanelDesiredSnapshot;
    expect(second.surfaces).toHaveLength(2);
    expect(
      new Set(second.surfaces.map((surface) => surface.surfaceId)).size,
    ).toBe(2);
    expect(
      second.surfaces.map((surface) => surface.materialization.workspaceId),
    ).toEqual(["personal", "project"]);
    await personal.clearNativePanelSlot({
      nativeSlotId: slot.nativeSlotId,
      bindingId: slot.bindingId,
    });
    snapshots = host.call.mock.calls.filter(
      ([, method]) => method === "view.applyNativePanelSurfaces",
    );
    expect(snapshots.at(-1)?.[2][0]).toMatchObject({
      revision: 3,
      surfaces: [
        {
          materialization: {
            workspaceId: "project",
            runtimeEntityId: "panel-1",
          },
        },
      ],
    });
  });
});

describe("native desired-state recovery", () => {
  it("reasserts the latest placements and clears after a connection loss", async () => {
    let changed!: (status: RpcConnectionStatus) => void;
    let offline = false;
    const applied: NativePanelDesiredSnapshot[] = [];
    const call = vi.fn(
      async (_target: string, method: string, args: unknown[]) => {
        if (offline)
          throw new RpcBoundaryError("offline", "transport", "CONNECTION_LOST");
        if (method === "view.connectNativePanelAdapter")
          return {
            accepted: true,
            handshake: {
              protocolVersion: 2,
              hostGeneration: "host",
              shellGeneration: "shell",
              sealedLaunchIdentity: "@workspace-apps/shell",
            },
          };
        const desired = args[0] as NativePanelDesiredSnapshot;
        applied.push(desired);
        return {
          accepted: true,
          observation: {
            protocolVersion: 2,
            hostGeneration: "host",
            shellGeneration: "shell",
            desiredRevision: desired.revision,
            observationRevision: desired.revision,
            focusedWorkspaceId: desired.focusedWorkspaceId,
            surfaces: desired.surfaces.map((surface) => ({
              ...surface,
              nativeSurfaceId: surface.surfaceId,
            })),
          },
        };
      },
    );
    const stop = vi.fn();
    const native = createNativePanelPresentation({
      call,
      onStatusChange: (listener: (status: RpcConnectionStatus) => void) => {
        changed = listener;
        return stop;
      },
    } as unknown as RpcClient);
    const personal = native.forWorkspace("personal");
    const system = native.forWorkspace("system");
    await personal.bindNativePanelSlot(slot);
    await system.bindNativePanelSlot(slot);
    await native.setFocusedWorkspace("system");
    offline = true;
    changed("connecting");
    await expect(
      personal.updateNativePanelSlot({
        ...slot,
        bounds: { ...slot.bounds, width: 620 },
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await expect(system.clearNativePanelSlot(slot)).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    });
    await expect(
      native.setFocusedWorkspace("empty-workspace"),
    ).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    const before = applied.length;
    offline = false;
    changed("connected");
    await vi.waitFor(() => expect(applied).toHaveLength(before + 1));
    expect(applied.at(-1)?.focusedWorkspaceId).toBe("empty-workspace");
    expect(applied.at(-1)?.surfaces).toHaveLength(1);
    expect(applied.at(-1)?.surfaces[0]).toMatchObject({
      materialization: { workspaceId: "personal" },
      bounds: { width: 620 },
    });
    native.close();
    changed("connected");
    expect(stop).toHaveBeenCalledOnce();
    expect(applied).toHaveLength(before + 1);
  });

  it("reports only the latest desired sync failure and clears it after focus-only recovery", async () => {
    let changed!: (status: RpcConnectionStatus) => void;
    let offline = false;
    const applied: NativePanelDesiredSnapshot[] = [];
    const call = vi.fn(
      async (_target: string, method: string, args: unknown[]) => {
        if (method === "view.connectNativePanelAdapter")
          return {
            accepted: true,
            handshake: {
              protocolVersion: 2,
              hostGeneration: "host",
              shellGeneration: "shell",
              sealedLaunchIdentity: "@workspace-apps/shell",
            },
          };
        if (offline)
          throw new RpcBoundaryError("offline", "transport", "CONNECTION_LOST");
        const desired = args[0] as NativePanelDesiredSnapshot;
        applied.push(desired);
        return {
          accepted: true,
          observation: {
            protocolVersion: 2,
            hostGeneration: "host",
            shellGeneration: "shell",
            desiredRevision: desired.revision,
            observationRevision: desired.revision,
            focusedWorkspaceId: desired.focusedWorkspaceId,
            surfaces: [],
          },
        };
      },
    );
    const native = createNativePanelPresentation({
      call,
      onStatusChange: (listener: (status: RpcConnectionStatus) => void) => {
        changed = listener;
        return () => undefined;
      },
    } as unknown as RpcClient);
    const snapshots: Array<{ error: string | null }> = [];
    native.subscribe(() => snapshots.push(native.getSnapshot()));

    offline = true;
    changed("connecting");
    await expect(native.setFocusedWorkspace("personal")).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    });
    expect(native.getSnapshot()).toEqual({ error: "offline" });

    offline = false;
    changed("connected");
    await vi.waitFor(() =>
      expect(native.getSnapshot()).toEqual({ error: null }),
    );
    expect(applied.at(-1)?.focusedWorkspaceId).toBe("personal");
    expect(applied.at(-1)?.surfaces).toEqual([]);
    expect(snapshots).toEqual([{ error: "offline" }, { error: null }]);
  });

  it("does not publish an older failed focus after a newer focus is queued", async () => {
    let rejectFirst!: (error: Error) => void;
    let applyCount = 0;
    const call = vi.fn(
      async (_target: string, method: string, args: unknown[]) => {
        if (method === "view.connectNativePanelAdapter")
          return {
            accepted: true,
            handshake: {
              protocolVersion: 2,
              hostGeneration: "host",
              shellGeneration: "shell",
              sealedLaunchIdentity: "@workspace-apps/shell",
            },
          };
        const desired = args[0] as NativePanelDesiredSnapshot;
        applyCount += 1;
        if (applyCount === 1)
          await new Promise<never>((_resolve, reject) => {
            rejectFirst = reject;
          });
        return {
          accepted: true,
          observation: {
            protocolVersion: 2,
            hostGeneration: "host",
            shellGeneration: "shell",
            desiredRevision: desired.revision,
            observationRevision: desired.revision,
            focusedWorkspaceId: desired.focusedWorkspaceId,
            surfaces: [],
          },
        };
      },
    );
    const native = createNativePanelPresentation({
      call,
      onStatusChange: () => () => undefined,
    } as unknown as RpcClient);
    const listener = vi.fn();
    native.subscribe(listener);
    const oldFocus = native.setFocusedWorkspace("personal");
    await vi.waitFor(() => expect(applyCount).toBe(1));
    const latestFocus = native.setFocusedWorkspace("system");
    const oldFocusRejected =
      expect(oldFocus).rejects.toThrow("old focus failed");
    rejectFirst(new Error("old focus failed"));

    await oldFocusRejected;
    await expect(latestFocus).resolves.toMatchObject({
      focusedWorkspaceId: "system",
    });
    expect(native.getSnapshot()).toEqual({ error: null });
    expect(listener).not.toHaveBeenCalled();
  });
});
