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
});
