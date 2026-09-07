import { useShellWorkspaceClient } from "../shell/workspaceContext";
import { useEffect, useState } from "react";
import { GlobeIcon } from "@radix-ui/react-icons";

export type BrowserFaviconHandle = { pageUrl: string; updatedAt: number };

const faviconCaches = new WeakMap<object, Map<string, string>>();

export function BrowserFavicon({
  handle,
  size = 16
}: {
  handle: BrowserFaviconHandle;
  size?: number;
}) {
  const { browserData } = useShellWorkspaceClient();

  const faviconCache = faviconCaches.get(browserData) ?? new Map<string, string>();
  faviconCaches.set(browserData, faviconCache);
  const key = `${handle.pageUrl}\0${handle.updatedAt}`;
  const [image, setImage] = useState<{
    owner: typeof browserData;
    key: string;
    src: string;
  } | null>(null);
  const src =
    faviconCache.get(key) ??
    (image?.owner === browserData && image.key === key ? image.src : undefined);

  useEffect(() => {
    const cached = faviconCache.get(key);
    if (cached) {
      setImage({ owner: browserData, key, src: cached });
      return;
    }
    let cancelled = false;
    void browserData
      .getPageFavicon(handle.pageUrl)
      .then((record) => {
        // Image data arrives base64-encoded; raw bytes do not survive the
        // JSON-encoded RPC hop between the store and this view.
        if (!record?.image_data || cancelled) return;
        const value = `data:${record.mime_type};base64,${record.image_data}`;
        faviconCache.set(key, value);
        while (faviconCache.size > 128) {
          const oldest = faviconCache.entries().next().value as [string, string] | undefined;
          if (!oldest) break;
          faviconCache.delete(oldest[0]);
        }
        setImage({ owner: browserData, key, src: value });
      })
      .catch(() => {
        // The globe fallback is the complete error state for favicon retrieval.
      });
    return () => {
      cancelled = true;
    };
  }, [browserData, faviconCache, handle.pageUrl, key]);

  return src ? (
    <img src={src} width={size} height={size} alt="" style={{ flexShrink: 0 }} />
  ) : (
    <GlobeIcon width={size} height={size} />
  );
}
