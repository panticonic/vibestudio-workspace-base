import { describe, expect, it } from "vitest";

import { dropPreview, resolveDropTarget, type LayoutGeometry, type Rect } from "./dropGeometry";

// Two columns side by side; the right column is split into two panes.
//
//   0        600      607      1200
//   ┌─────────┐│┌────────────────┐  0
//   │  pane-a │││    pane-b      │
//   │         ││├────────────────┤  400
//   │         │││    pane-c      │
//   └─────────┘│└────────────────┘  800
const VIEWPORT: Rect = { x: 0, y: 0, width: 1200, height: 800 };

const GEOMETRY: LayoutGeometry = {
  viewport: VIEWPORT,
  columns: [
    { columnId: "col-a", rect: { x: 0, y: 0, width: 600, height: 800 } },
    { columnId: "col-b", rect: { x: 607, y: 0, width: 593, height: 800 } },
  ],
  panes: [
    {
      paneId: "pane-a",
      panelId: "A",
      columnId: "col-a",
      rect: { x: 0, y: 0, width: 600, height: 800 },
    },
    {
      paneId: "pane-b",
      panelId: "B",
      columnId: "col-b",
      rect: { x: 607, y: 0, width: 593, height: 396 },
    },
    {
      paneId: "pane-c",
      panelId: "C",
      columnId: "col-b",
      rect: { x: 607, y: 403, width: 593, height: 397 },
    },
  ],
};

describe("resolveDropTarget", () => {
  it("is nothing outside the layout", () => {
    expect(resolveDropTarget({ x: -20, y: 400 }, GEOMETRY)).toBeNull();
    expect(resolveDropTarget({ x: 400, y: 900 }, GEOMETRY)).toBeNull();
  });

  it("offers the first column when the layout is empty", () => {
    expect(
      resolveDropTarget({ x: 400, y: 400 }, { viewport: VIEWPORT, columns: [], panes: [] })
    ).toEqual({ kind: "new-column", afterColumnId: null });
  });

  it("reads the middle of a pane as taking that pane over", () => {
    expect(resolveDropTarget({ x: 300, y: 400 }, GEOMETRY)).toEqual({
      kind: "pane-center",
      paneId: "pane-a",
    });
  });

  it.each([
    ["left", { x: 8, y: 400 }],
    ["right", { x: 592, y: 400 }],
    ["top", { x: 300, y: 8 }],
    ["bottom", { x: 300, y: 792 }],
  ] as const)("reads the %s edge of a pane as a split", (edge, point) => {
    expect(resolveDropTarget(point, GEOMETRY)).toEqual({
      kind: "pane-edge",
      paneId: "pane-a",
      edge,
    });
  });

  it("resolves a corner to the nearer edge in proportional terms", () => {
    // 30px in from the left, 30px down: the vertical band is the tighter one on
    // a pane this shape, so the top edge wins.
    expect(resolveDropTarget({ x: 30, y: 12 }, GEOMETRY)).toEqual({
      kind: "pane-edge",
      paneId: "pane-a",
      edge: "top",
    });
  });

  it("reads the seam between two stacked panes as an insertion between them", () => {
    expect(resolveDropTarget({ x: 900, y: 400 }, GEOMETRY)).toEqual({
      kind: "pane-edge",
      paneId: "pane-b",
      edge: "bottom",
    });
  });

  it("reads a column divider as a new column at that seam", () => {
    expect(resolveDropTarget({ x: 603, y: 400 }, GEOMETRY)).toEqual({
      kind: "new-column",
      afterColumnId: "col-a",
    });
  });

  it("never returns two targets for one point", () => {
    // Every point in the viewport resolves to exactly one target, and the
    // target only changes at a boundary the user can see.
    const seen = new Set<string>();
    for (let x = 0; x <= VIEWPORT.width; x += 7) {
      for (let y = 0; y <= VIEWPORT.height; y += 11) {
        const target = resolveDropTarget({ x, y }, GEOMETRY);
        expect(target).not.toBeNull();
        seen.add(JSON.stringify(target));
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("dropPreview", () => {
  it("previews a centre drop as the whole pane", () => {
    expect(dropPreview({ kind: "pane-center", paneId: "pane-b" }, GEOMETRY)).toEqual({
      kind: "region",
      rect: { x: 607, y: 0, width: 593, height: 396 },
    });
  });

  it("previews a vertical split as half of the pane", () => {
    expect(dropPreview({ kind: "pane-edge", paneId: "pane-b", edge: "bottom" }, GEOMETRY)).toEqual({
      kind: "region",
      rect: { x: 607, y: 198, width: 593, height: 198 },
    });
  });

  it("previews a side split as half of the column, because that is what appears", () => {
    expect(dropPreview({ kind: "pane-edge", paneId: "pane-b", edge: "left" }, GEOMETRY)).toEqual({
      kind: "region",
      rect: { x: 607, y: 0, width: 296.5, height: 800 },
    });
  });

  it("previews a new column as a seam at that gutter", () => {
    const preview = dropPreview({ kind: "new-column", afterColumnId: "col-a" }, GEOMETRY);
    expect(preview?.kind).toBe("insertion");
    expect(preview?.rect.height).toBe(800);
    expect(preview?.rect.x).toBeCloseTo(597.5, 1);
  });

  it("keeps the leading seam inside the viewport", () => {
    const preview = dropPreview({ kind: "new-column", afterColumnId: null }, GEOMETRY);
    expect(preview?.rect.x).toBe(0);
  });
});
