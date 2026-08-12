import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { PhoneProvisioningDO } from "./index.js";

describe("PhoneProvisioningDO", () => {
  it("selects the desktop transport and rewrites provider identity", async () => {
    const { instance, callAs } = await createTestDO(PhoneProvisioningDO, {
      WORKER_SOURCE: "workers/phone-provisioning",
      WORKER_CLASS_NAME: "PhoneProvisioningDO",
      __objectKey: "workspace-phone-provisioning",
    });
    const rpcCall = vi.fn(async (_target: string, method: string): Promise<unknown> => {
      if (method === "connectedClientTransport.list") {
        return [
          {
            clientId: "shell:desktop",
            label: "My desktop",
            platform: "desktop",
            runtimeKind: "shell",
          },
          {
            clientId: "shell:mobile",
            label: "Phone",
            platform: "mobile",
            runtimeKind: "shell",
          },
        ];
      }
      return [
        {
          providerId: "local",
          label: "Native provider",
          hostPlatform: "linux",
          platforms: ["android"],
          sourcePlatforms: ["android"],
          appVersion: "1.0.0",
        },
      ];
    });
    Object.defineProperty(instance, "rpc", { value: { call: rpcCall }, configurable: true });

    await expect(
      callAs({ callerId: "panel:alice", callerKind: "panel", userId: "alice" }, "providers")
    ).resolves.toEqual([
      expect.objectContaining({ providerId: "shell:desktop", label: "My desktop" }),
    ]);
    expect(rpcCall).toHaveBeenLastCalledWith("main", "connectedClientTransport.invoke", [
      {
        clientId: "shell:desktop",
        method: "desktopPhoneProvider.providers",
        args: [],
      },
    ]);
  });
});
