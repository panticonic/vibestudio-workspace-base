import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@vibestudio/extension";
import { activate } from "./index.js";

describe("@workspace-extensions/mobile-debug", () => {
  it("delegates native effects to the host without reading workspace paths", async () => {
    const call = vi.fn(async () => ({ apkBytes: 3 }));
    const stream = vi.fn(async () => new Response("logs"));
    const healthy = vi.fn();
    const api = await activate({
      rpc: { call, stream },
      health: { healthy },
    } as unknown as ExtensionContext);

    await expect(
      api.buildAndroid({ architectures: ["arm64-v8a"] }),
    ).resolves.toEqual({ apkBytes: 3 });
    expect(call).toHaveBeenCalledWith("main", "mobileNative.buildAndroid", {
      architectures: ["arm64-v8a"],
    });
    expect(healthy).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Host mobile executor"),
      }),
    );
  });

  it("routes streaming methods over the RPC stream boundary", async () => {
    const response = new Response("device logs");
    const stream = vi.fn(async () => response);
    const api = await activate({
      rpc: { call: vi.fn(), stream },
      health: { healthy: vi.fn() },
    } as unknown as ExtensionContext);

    await expect(api.logcat({ device: "phone-1" })).resolves.toBe(response);
    expect(stream).toHaveBeenCalledWith("main", "mobileNative.logcat", [
      { device: "phone-1" },
    ]);
  });
});
