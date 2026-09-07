import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
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
            protocolVersion: 1,
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
            protocolVersion: 1,
            hostGeneration: workspaceId,
            shellGeneration: "shell",
            desiredRevision: desired.revision,
            observationRevision: desired.revision,
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
    selfId: workspaceId,
  } as unknown as RpcClient;
  return { rpc, client: createShellWorkspaceClient(rpc, { workspaceId, nativePresentation: createNativePanelPresentation(rpc) }), call };
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
    let snapshots = host.call.mock.calls.filter(([, method]) => method === "view.applyNativePanelSurfaces");
    const second = snapshots.at(-1)?.[2][0] as NativePanelDesiredSnapshot;
    expect(second.surfaces).toHaveLength(2);
    expect(new Set(second.surfaces.map((surface) => surface.surfaceId)).size).toBe(2);
    expect(second.surfaces.map((surface) => surface.materialization.workspaceId)).toEqual(["personal", "project"]);
    await personal.clearNativePanelSlot({ nativeSlotId: slot.nativeSlotId, bindingId: slot.bindingId });
    snapshots = host.call.mock.calls.filter(([, method]) => method === "view.applyNativePanelSurfaces");
    expect(snapshots.at(-1)?.[2][0]).toMatchObject({ revision: 3, surfaces: [{ materialization: { workspaceId: "project", runtimeEntityId: "panel-1" } }] });
  });

});
