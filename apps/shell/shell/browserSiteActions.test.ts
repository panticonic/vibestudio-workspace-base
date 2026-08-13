import { describe, expect, it, vi } from "vitest";
import { createBrowserSiteActions } from "./browserSiteActions";

function harness() {
  const native = {
    getBrowserPageIdentity: vi.fn(async () => ({
      origin: "https://example.com",
      url: "https://example.com/path",
      secure: true,
      title: "Example",
      cookieCount: 3,
    })),
    setNativeBrowserZoom: vi.fn(async () => undefined),
    clearNativeBrowserSiteData: vi.fn(async () => undefined),
  };
  const data = {
    getSitePreferences: vi.fn(async () => ({ zoomFactor: 1.25 })),
    setSiteZoom: vi.fn(async () => undefined),
    searchBookmarks: vi.fn(
      async () => [] as Array<{ id: number; url?: string | null }>,
    ),
    addBookmark: vi.fn(async () => 17),
    deleteBookmark: vi.fn(async () => undefined),
  };
  return { native, data, actions: createBrowserSiteActions({ native, data }) };
}

describe("browser site actions", () => {
  it("composes site presentation from workspace data and one native page identity", async () => {
    const { actions, data, native } = harness();
    data.searchBookmarks.mockResolvedValue([
      { id: 7, url: "https://example.com/path" },
      { id: 8, url: "https://elsewhere.example/" },
    ]);

    await expect(actions.getBrowserSiteState("panel-1")).resolves.toEqual({
      origin: "https://example.com",
      url: "https://example.com/path",
      secure: true,
      zoomFactor: 1.25,
      bookmarkId: 7,
      cookieCount: 3,
    });
    expect(native.setNativeBrowserZoom).toHaveBeenCalledWith(
      "panel-1",
      "https://example.com",
      1.25,
    );
  });

  it("owns bookmark policy in workspace code", async () => {
    const { actions, data } = harness();

    await expect(actions.toggleBrowserBookmark("panel-1")).resolves.toEqual({
      bookmarked: true,
      bookmarkId: 17,
    });
    expect(data.addBookmark).toHaveBeenCalledWith({
      title: "Example",
      url: "https://example.com/path",
      folderPath: "/",
    });

    data.searchBookmarks.mockResolvedValue([
      { id: 17, url: "https://example.com/path" },
    ]);
    await expect(actions.toggleBrowserBookmark("panel-1")).resolves.toEqual({
      bookmarked: false,
      bookmarkId: null,
    });
    expect(data.deleteBookmark).toHaveBeenCalledWith(17);
  });

  it("persists a normalized zoom before applying the native effect", async () => {
    const { actions, data, native } = harness();

    await expect(actions.setBrowserZoom("panel-1", 1.234)).resolves.toBe(1.25);
    expect(data.setSiteZoom).toHaveBeenCalledWith("https://example.com", 1.25);
    expect(native.setNativeBrowserZoom).toHaveBeenCalledWith(
      "panel-1",
      "https://example.com",
      1.25,
    );
  });

  it("clears protected site data only through the native host effect", async () => {
    const { actions, native } = harness();

    await expect(
      actions.clearBrowserSiteData("panel-1"),
    ).resolves.toBeUndefined();
    expect(native.clearNativeBrowserSiteData).toHaveBeenCalledWith(
      "panel-1",
      "https://example.com",
    );
  });
});
