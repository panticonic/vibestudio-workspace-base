import {
  ComponentInstanceIcon,
  CubeIcon,
  DashboardIcon,
  DesktopIcon,
  GearIcon,
  GlobeIcon
} from "@radix-ui/react-icons";
import { lazy, Suspense, useEffect, useState } from "react";
import type { PanelNavigationState } from "@vibestudio/shared/types";
import { useWorkspaceIcons } from "../shell/workspaceIconsContext";

const BrowserFavicon = lazy(async () => {
  const module = await import("./BrowserFavicon");
  return { default: module.BrowserFavicon };
});

export function PanelIcon({
  icon,
  iconVersion,
  iconState,
  source,
  favicon,
  size = 16,
  fallback = false
}: {
  icon?: string;
  /** Names the icon's content so the fetched glyph can be stored forever. */
  iconVersion?: string;
  /** Exact workspace state from which a historical icon can be retrieved. */
  iconState?: string;
  source?: string;
  favicon?: PanelNavigationState["favicon"];
  size?: number;
  fallback?: "panel" | "browser" | "worker" | "app" | "extension" | "system" | false;
}) {
  const unitIcons = useWorkspaceIcons();
  const key = JSON.stringify([source, icon, iconVersion, iconState]);
  const [image, setImage] = useState<{
    owner: typeof unitIcons;
    key: string;
    url: string;
  } | null>(null);
  const imageSource = icon?.startsWith("data:image/")
    ? icon
    : image?.owner === unitIcons && image.key === key
      ? image.url
      : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  useEffect(() => {
    if (!unitIcons || !icon?.startsWith("./") || !source) return;
    let active = true;
    void unitIcons
      .load(source, icon, iconVersion, iconState)
      .then((url) => {
        if (active) setImage({ owner: unitIcons, key, url });
      })
      .catch(() => {
        /* The declared fallback is the icon's error state. */
      });
    return () => {
      active = false;
    };
  }, [unitIcons, source, icon, iconVersion, iconState, key]);
  if (favicon) {
    return (
      <Suspense fallback={<GlobeIcon width={size} height={size} />}>
        <BrowserFavicon handle={favicon} size={size} />
      </Suspense>
    );
  }
  if (imageSource && failedSource !== imageSource) {
    return (
      <img
        src={imageSource}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "block",
          objectFit: "contain",
          borderRadius: Math.max(2, Math.round(size * 0.2))
        }}
        onError={() => setFailedSource(imageSource)}
      />
    );
  }
  if (icon && !icon.startsWith("./") && !icon.startsWith("data:image/")) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size,
          lineHeight: 1,
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"
        }}
      >
        {icon}
      </span>
    );
  }
  if (!fallback) return null;
  const props = { width: size, height: size, style: { flexShrink: 0 } };
  if (fallback === "browser") return <GlobeIcon {...props} />;
  if (fallback === "panel") return <DashboardIcon {...props} />;
  if (fallback === "worker") return <GearIcon {...props} />;
  if (fallback === "app") return <DesktopIcon {...props} />;
  if (fallback === "extension") return <ComponentInstanceIcon {...props} />;
  return <CubeIcon {...props} />;
}
