export interface BrowserPageIdentity {
  origin: string;
  url: string;
  secure: boolean;
  title: string;
  cookieCount: number;
}

export interface BrowserSiteNativeEffects {
  getBrowserPageIdentity(panelId: string): Promise<BrowserPageIdentity>;
  setNativeBrowserZoom(
    panelId: string,
    origin: string,
    zoomFactor: number,
  ): Promise<void>;
  clearNativeBrowserSiteData(panelId: string, origin: string): Promise<void>;
}

export interface BrowserSiteData {
  getSitePreferences(origin: string): Promise<{ zoomFactor: number }>;
  setSiteZoom(origin: string, zoomFactor: number): Promise<void>;
  searchBookmarks(
    query: string,
  ): Promise<Array<{ id: number; url?: string | null }>>;
  addBookmark(input: {
    title: string;
    url: string;
    folderPath: string;
  }): Promise<number>;
  deleteBookmark(id: number): Promise<void>;
}

export function createBrowserSiteActions(deps: {
  native: BrowserSiteNativeEffects;
  data: BrowserSiteData;
}) {
  const page = (panelId: string) => deps.native.getBrowserPageIdentity(panelId);

  return {
    async getBrowserSiteState(panelId: string) {
      const identity = await page(panelId);
      const [preferences, bookmarks] = await Promise.all([
        deps.data.getSitePreferences(identity.origin),
        deps.data.searchBookmarks(identity.url),
      ]);
      await deps.native.setNativeBrowserZoom(
        panelId,
        identity.origin,
        preferences.zoomFactor,
      );
      const bookmark = bookmarks.find((item) => item.url === identity.url);
      return {
        origin: identity.origin,
        url: identity.url,
        secure: identity.secure,
        zoomFactor: preferences.zoomFactor,
        bookmarkId: bookmark?.id ?? null,
        cookieCount: identity.cookieCount,
      };
    },

    async toggleBrowserBookmark(panelId: string) {
      const identity = await page(panelId);
      const bookmark = (await deps.data.searchBookmarks(identity.url)).find(
        (item) => item.url === identity.url,
      );
      if (bookmark) {
        await deps.data.deleteBookmark(bookmark.id);
        return { bookmarked: false, bookmarkId: null };
      }
      const bookmarkId = await deps.data.addBookmark({
        title: identity.title.trim() || new URL(identity.url).hostname,
        url: identity.url,
        folderPath: "/",
      });
      return { bookmarked: true, bookmarkId };
    },

    async setBrowserZoom(panelId: string, zoomFactor: number) {
      const identity = await page(panelId);
      const rounded =
        Math.round(Math.min(5, Math.max(0.25, zoomFactor)) * 20) / 20;
      await deps.data.setSiteZoom(identity.origin, rounded);
      await deps.native.setNativeBrowserZoom(panelId, identity.origin, rounded);
      return rounded;
    },

    async clearBrowserSiteData(panelId: string) {
      const identity = await page(panelId);
      await deps.native.clearNativeBrowserSiteData(panelId, identity.origin);
    },
  };
}
