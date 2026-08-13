import { describe, expect, it, vi } from "vitest";
import { createWorkspacePresentationClient } from "./workspacePresentation.js";

describe("workspace presentation composition", () => {
  it("derives product title, kind, icon, ref, and placement from raw host topology", async () => {
    const call = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:presentation" };
      }
      if (target === "main" && method === "workspace-state.panelTree.page") {
        return {
          revision: 7,
          group: { kind: "roots", ownerUserId: "user-1" },
          nodes: [
            {
              slotId: "panel:browser",
              parentSlotId: null,
              ownerUserId: "user-1",
              createdAt: 1,
              childCount: 0,
              source: "panels/browser",
              options: JSON.stringify({
                ref: "release",
                placement: { disposition: "side", preferredWidth: 420 },
              }),
            },
          ],
          nextCursor: null,
        };
      }
      if (target === "main" && method === "build.getPanelMetadata") {
        return { icon: "🌐" };
      }
      if (target === "do:presentation" && method === "titlesForSlots") {
        return { "panel:browser": "Example" };
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });

    const client = createWorkspacePresentationClient({ call } as never);
    await expect(
      client.page({
        group: { kind: "roots", ownerUserId: "user-1" },
        limit: 10,
      }),
    ).resolves.toEqual({
      revision: 7,
      group: { kind: "roots", ownerUserId: "user-1" },
      nodes: [
        {
          slotId: "panel:browser",
          parentSlotId: null,
          ownerUserId: "user-1",
          createdAt: 1,
          childCount: 0,
          source: "panels/browser",
          title: "Example",
          icon: "🌐",
          kind: "workspace",
          ref: "release",
          placement: { disposition: "side", preferredWidth: 420 },
        },
      ],
      nextCursor: null,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a non-object payload", "[]"],
    ["an invalid ref", JSON.stringify({ ref: 7 })],
    [
      "an invalid placement",
      JSON.stringify({ placement: { disposition: "beside" } }),
    ],
  ])(
    "rejects %s instead of dropping invalid presentation state",
    async (_label, options) => {
      const call = vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "do:presentation" };
        }
        if (target === "main" && method === "workspace-state.panelTree.page") {
          return {
            revision: 1,
            group: { kind: "roots", ownerUserId: "user-1" },
            nodes: [
              {
                slotId: "panel:invalid",
                parentSlotId: null,
                ownerUserId: "user-1",
                createdAt: 1,
                childCount: 0,
                source: "panels/example",
                options,
              },
            ],
            nextCursor: null,
          };
        }
        if (target === "main" && method === "build.getPanelMetadata")
          return null;
        if (target === "do:presentation" && method === "titlesForSlots")
          return {};
        throw new Error(`Unexpected RPC ${target}.${method}`);
      });

      const client = createWorkspacePresentationClient({ call } as never);
      await expect(
        client.page({
          group: { kind: "roots", ownerUserId: "user-1" },
          limit: 10,
        }),
      ).rejects.toThrow(/Workspace panel options/u);
    },
  );

  it("keeps topology usable after an icon metadata failure and observes a later icon edit", async () => {
    let metadataRead = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const call = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:presentation" };
      }
      if (target === "main" && method === "workspace-state.panelTree.page") {
        return {
          revision: metadataRead + 1,
          group: { kind: "roots", ownerUserId: "user-1" },
          nodes: [
            {
              slotId: "panel:chat",
              parentSlotId: null,
              ownerUserId: "user-1",
              createdAt: 1,
              childCount: 0,
              source: "panels/chat",
            },
          ],
          nextCursor: null,
        };
      }
      if (target === "main" && method === "build.getPanelMetadata") {
        metadataRead += 1;
        if (metadataRead === 1) throw new Error("build is restarting");
        return { icon: "./assets/edited-icon.svg" };
      }
      if (target === "do:presentation" && method === "titlesForSlots") {
        return { "panel:chat": "Agentic Chat" };
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const client = createWorkspacePresentationClient({ call } as never);
    const input = {
      group: { kind: "roots" as const, ownerUserId: "user-1" },
      limit: 10,
    };

    await expect(client.page(input)).resolves.toMatchObject({
      nodes: [{ slotId: "panel:chat", title: "Agentic Chat" }],
    });
    await expect(client.page(input)).resolves.toMatchObject({
      nodes: [
        {
          slotId: "panel:chat",
          title: "Agentic Chat",
          icon: "./assets/edited-icon.svg",
        },
      ],
    });

    expect(metadataRead).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("deduplicates icon metadata reads only within one bounded page", async () => {
    const call = vi.fn(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:presentation" };
      }
      if (target === "main" && method === "workspace-state.panelTree.page") {
        return {
          revision: 1,
          group: { kind: "roots", ownerUserId: "user-1" },
          nodes: ["one", "two"].map((suffix) => ({
            slotId: `panel:${suffix}`,
            parentSlotId: null,
            ownerUserId: "user-1",
            createdAt: 1,
            childCount: 0,
            source: "panels/chat",
          })),
          nextCursor: null,
        };
      }
      if (target === "main" && method === "build.getPanelMetadata") {
        return { icon: "./assets/icon.svg" };
      }
      if (target === "do:presentation" && method === "titlesForSlots") {
        return {};
      }
      throw new Error(`Unexpected RPC ${target}.${method}`);
    });
    const client = createWorkspacePresentationClient({ call } as never);

    await client.page({
      group: { kind: "roots", ownerUserId: "user-1" },
      limit: 10,
    });

    expect(
      call.mock.calls.filter(
        ([target, method]) =>
          target === "main" && method === "build.getPanelMetadata",
      ),
    ).toHaveLength(1);
  });

  it("repairs a host-created slot in the Base presentation owner before reading it", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const call = vi.fn(
      async (target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: "do:presentation" };
        }
        if (target === "main" && method === "workspace-state.panelTree.page") {
          return {
            revision: 1,
            group: { kind: "roots", ownerUserId: "user-1" },
            nodes: [
              {
                slotId: "panel:chat",
                parentSlotId: null,
                ownerUserId: "user-1",
                createdAt: 1,
                childCount: 0,
                source: "panels/chat",
                runtimeEntityId: "panel:nav-chat",
              },
            ],
            nextCursor: null,
          };
        }
        if (target === "main" && method === "build.getPanelMetadata") {
          return { title: "Agentic Chat", icon: "./assets/icon.svg" };
        }
        if (target === "do:presentation") {
          calls.push({ method, args });
          if (method === "indexPanel") return "panel:nav-chat";
          if (method === "titlesForSlots")
            return { "panel:chat": "Agentic Chat" };
        }
        throw new Error(`Unexpected RPC ${target}.${method}`);
      },
    );

    const client = createWorkspacePresentationClient({ call } as never);
    await expect(
      client.page({
        group: { kind: "roots", ownerUserId: "user-1" },
        limit: 10,
      }),
    ).resolves.toMatchObject({
      nodes: [{ title: "Agentic Chat", icon: "./assets/icon.svg" }],
    });
    expect(calls).toEqual([
      {
        method: "indexPanel",
        args: [
          {
            id: "panel:chat",
            title: "Agentic Chat",
            path: "panels/chat",
            source: "panels/chat",
          },
          "panel:nav-chat",
        ],
      },
      { method: "titlesForSlots", args: [["panel:chat"]] },
    ]);
  });
});
