import type { RpcClient } from "@vibestudio/rpc";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { viewMethods } from "@vibestudio/service-schemas/view";
import type { NativePanelSlotBounds } from "./workspaceClient";
type DesiredNativePanelSlot = {
  nativeSlotId: string;
  bindingId: string;
  panelId: string;
  workspaceId: string;
  bounds: NativePanelSlotBounds;
  focused: boolean;
};
/** One compositor session owned by the System app; workspaces supply immutable placements. */
export function createNativePanelPresentation(rpc: RpcClient) {
  const viewClient = createTypedServiceClient(
    "view",
    viewMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args),
  );
  const desiredNativePanelSlots = new Map<string, DesiredNativePanelSlot>();
  let desiredNativePanelSlotRevision = 0;
  let nativePanelSyncTail = Promise.resolve();
  let nativePanelAdapterHandshake: {
    hostGeneration: string;
    shellGeneration: string;
  };
  let nativePanelAdapterConnection: Promise<void> | null = null;
  const connectNativePanelAdapter = () => {
    nativePanelAdapterConnection ??= viewClient
      .connectNativePanelAdapter({
        sealedLaunchIdentity: "@workspace-apps/shell",
        supportedProtocolVersions: [1],
      })
      .then((result) => {
        if (!result.accepted)
          throw new Error(`Panel host rejected shell: ${result.reason}`);
        nativePanelAdapterHandshake = result.handshake;
        desiredNativePanelSlotRevision = 0;
      });
    return nativePanelAdapterConnection;
  };
  const syncDesiredNativePanelSlots = () => {
    const apply = async () => {
      await connectNativePanelAdapter();
      const revision = ++desiredNativePanelSlotRevision;
      const result = await viewClient.applyNativePanelSurfaces({
        protocolVersion: 1,
        hostGeneration: nativePanelAdapterHandshake.hostGeneration,
        shellGeneration: nativePanelAdapterHandshake.shellGeneration,
        revision,
        surfaces: [...desiredNativePanelSlots.values()].map((slot) => ({
          surfaceId: slot.nativeSlotId,
          materialization: {
            workspaceId: slot.workspaceId,
            runtimeEntityId: slot.panelId,
            leaseConnectionId: slot.bindingId,
          },
          visible: true,
          focused: slot.focused,
          bounds: slot.bounds,
        })),
      });
      if (!result.accepted)
        throw new Error(
          `Native panel adapter rejected desired state: ${result.reason}`,
        );
      return result.observation;
    };
    const current = nativePanelSyncTail.then(apply, apply);
    nativePanelSyncTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  return {
    connectNativePanelAdapter,
    forWorkspace(workspaceId: string | Promise<string>) {
      return {
        bindNativePanelSlot: async (request: {
          nativeSlotId: string;
          bindingId: string;
          panelId: string;
          bounds: NativePanelSlotBounds;
          focused?: boolean;
        }) => {
          const ownerWorkspaceId = await workspaceId;
          const surfaceId = JSON.stringify([
            ownerWorkspaceId,
            request.nativeSlotId,
          ]);
          desiredNativePanelSlots.set(surfaceId, {
            nativeSlotId: surfaceId,
            workspaceId: ownerWorkspaceId,
            bindingId: request.bindingId,
            panelId: request.panelId,
            bounds: request.bounds,
            focused: request.focused === true,
          });
          const observed = await syncDesiredNativePanelSlots();
          return observed.surfaces.some(
            (surface) => surface.surfaceId === surfaceId,
          )
            ? { status: "bound" as const }
            : {
                status: "missing" as const,
                reason: `native adapter did not observe ${request.nativeSlotId}`,
              };
        },
        updateNativePanelSlot: async (request: {
          nativeSlotId: string;
          bindingId: string;
          bounds?: NativePanelSlotBounds;
          focused?: boolean;
        }) => {
          const surfaceId = JSON.stringify([
            await workspaceId,
            request.nativeSlotId,
          ]);
          const current = desiredNativePanelSlots.get(surfaceId);
          if (!current || current.bindingId !== request.bindingId) {
            return {
              status: "missing" as const,
              reason: `unknown native panel slot: ${request.nativeSlotId}`,
            };
          }
          desiredNativePanelSlots.set(surfaceId, {
            ...current,
            ...(request.bounds ? { bounds: request.bounds } : {}),
            ...(typeof request.focused === "boolean"
              ? { focused: request.focused }
              : {}),
          });
          const observed = await syncDesiredNativePanelSlots();
          return observed.surfaces.some(
            (surface) => surface.surfaceId === surfaceId,
          )
            ? { status: "updated" as const }
            : {
                status: "missing" as const,
                reason: `native adapter did not observe ${request.nativeSlotId}`,
              };
        },
        clearNativePanelSlot: async (request: {
          nativeSlotId: string;
          bindingId: string;
        }) => {
          const surfaceId = JSON.stringify([
            await workspaceId,
            request.nativeSlotId,
          ]);
          const current = desiredNativePanelSlots.get(surfaceId);
          if (current?.bindingId === request.bindingId) {
            desiredNativePanelSlots.delete(surfaceId);
            await syncDesiredNativePanelSlots();
          }
        },
      };
    },
  };
}
export type NativePanelPresentation = ReturnType<
  typeof createNativePanelPresentation
>;
