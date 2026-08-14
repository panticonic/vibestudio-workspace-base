import { collectMobileOpenPanels, type OpenPanelTreeSource } from "./openPanelIndex";

type Node = {
  slotId: string;
  title: string;
  parentSlotId: string | null;
  ownerUserId: string | null;
  source?: string;
  icon?: string;
  childCount: number;
};

function sourceFor(
  roots: Record<string, Node[]>,
  children: Record<string, Node[]> = {}
): OpenPanelTreeSource {
  return {
    getRootGroups: () => ({
      groups: Object.keys(roots).map((owner) => ({
        ownerUserId: owner === "null" ? null : owner,
      })),
    }),
    getGroup: (group) =>
      group.kind === "roots"
        ? { nodes: (roots[group.ownerUserId ?? "null"] ?? []) as never }
        : { nodes: (children[group.parentSlotId] ?? []) as never },
  };
}

const node = (overrides: Partial<Node> & Pick<Node, "slotId" | "title">): Node => ({
  parentSlotId: null,
  ownerUserId: "user-1",
  childCount: 0,
  ...overrides,
});

describe("mobile open-panel index", () => {
  it("walks roots and their loaded children, naming the parent as the location", () => {
    const entries = collectMobileOpenPanels(
      sourceFor(
        {
          "user-1": [
            node({ slotId: "a", title: "Sales", source: "panels/sales", childCount: 1 }),
          ],
        },
        {
          a: [node({ slotId: "a1", title: "Q3 sheet", source: "panels/sheet", parentSlotId: "a" })],
        }
      )
    );
    expect(entries).toEqual([
      { id: "a", title: "Sales", source: "panels/sales" },
      { id: "a1", title: "Q3 sheet", source: "panels/sheet", location: "Sales" },
    ]);
  });

  it("offers only what the cache has actually loaded", () => {
    // `childCount` says there is a child; the cache has not paged it in, so the
    // sheet lists the parent alone instead of inventing a row.
    const entries = collectMobileOpenPanels(
      sourceFor({ "user-1": [node({ slotId: "a", title: "Sales", childCount: 3 })] })
    );
    expect(entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("covers every owner group and never repeats a slot", () => {
    const entries = collectMobileOpenPanels(
      sourceFor({
        "user-1": [node({ slotId: "a", title: "Mine" })],
        "user-2": [node({ slotId: "b", title: "Theirs", ownerUserId: "user-2" })],
      })
    );
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("stops at the bound so a huge workspace cannot stall opening the sheet", () => {
    const roots = Array.from({ length: 10 }, (_unused, index) =>
      node({ slotId: `n${index}`, title: `Panel ${index}` })
    );
    expect(collectMobileOpenPanels(sourceFor({ "user-1": roots }), 4)).toHaveLength(4);
  });
});
