import { gatewayMethods } from "@vibestudio/service-schemas/gateway";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { RpcClient } from "@vibestudio/rpc";
import { unitIconTarget } from "@vibestudio/shared/panel/assetPathPolicy";

/** Icon bytes come from this immutable workspace session, never chrome's document origin. */
export function createWorkspaceIcons(rpc: Pick<RpcClient, "stream">) {
  const pending = new Map<string, Promise<string>>();
  const cancellation = new AbortController();
  const gateway = createTypedServiceClient("gateway", gatewayMethods, (service, method, args) =>
    rpc.stream("main", `${service}.${method}`, args, { signal: cancellation.signal })
  );
  return {
    load(source: string, icon: string, version?: string, state?: string): Promise<string> {
      if (cancellation.signal.aborted) return Promise.reject(new Error("Workspace icons closed"));
      const path = `/${unitIconTarget(source, icon, version, state)}`;
      const existing = pending.get(path);
      if (existing) return existing;
      const result = gateway
        .fetch({ path, method: "GET" })
        .then(async (response) => {
          if (cancellation.signal.aborted) {
            await response.body?.cancel();
            throw new Error("Workspace icons closed");
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Workspace icon unavailable (${response.status})`);
          }
          // The same captured image may be presented in the RPC-less native overlay.
          // Data URLs cross renderer/storage partitions; blob URLs do not reliably do so.
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Workspace icon has no body");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 1024 * 1024) throw new Error("Workspace icon exceeds 1 MiB");
              chunks.push(value);
            }
          } catch (error) {
            await reader.cancel();
            throw error;
          } finally {
            reader.releaseLock();
          }
          if (cancellation.signal.aborted) throw new Error("Workspace icons closed");
          const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
          if (!mime?.startsWith("image/")) throw new Error("Workspace icon is not an image");
          let binary = "";
          for (const chunk of chunks) {
            for (const byte of chunk) binary += String.fromCharCode(byte);
          }
          return `data:${mime};base64,${btoa(binary)}`;
        })
        .catch((error) => {
          pending.delete(path);
          throw error;
        })
        .finally(() => {
          // A live source path can change while this workspace session stays open.
          if (!version && !state) pending.delete(path);
        });
      pending.set(path, result);
      return result;
    },
    close() {
      cancellation.abort();
      pending.clear();
    }
  };
}

export type WorkspaceIcons = ReturnType<typeof createWorkspaceIcons>;
