import type { PanelTreeCacheSnapshot } from "@vibestudio/shell-core/panelTreeCache";
import type { Panel } from "@vibestudio/shared/types";
import { getNativeAppStorage, type NativeAppStorage } from "./nativeAppStorage";

const SNAPSHOT_SCHEMA_VERSION = 3;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const KEY_PREFIX = "@vibestudio/mobile-shell-startup/v3";

export interface MobileShellStartupSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  serverEndpointId: string;
  deviceId: string;
  workspaceIdentity: string;
  capturedAt: number;
  preferredPanelId: string | null;
  tree: PanelTreeCacheSnapshot;
  rootPanels: Panel[];
}

function key(
  serverEndpointId: string,
  workspaceIdentity: string,
  deviceId: string,
): string {
  return `${KEY_PREFIX}/${serverEndpointId.toLowerCase()}/${encodeURIComponent(deviceId)}/${encodeURIComponent(workspaceIdentity)}`;
}

export async function loadMobileShellStartupSnapshot(
  serverEndpointId: string,
  workspaceIdentity: string,
  deviceId: string,
  storage: NativeAppStorage = getNativeAppStorage(),
): Promise<MobileShellStartupSnapshot | null> {
  const storageKey = key(serverEndpointId, workspaceIdentity, deviceId);
  const raw = await storage.getItem(storageKey);
  if (!raw) return null;
  if (raw.length > MAX_SNAPSHOT_BYTES) {
    await storage.removeItem(storageKey);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MobileShellStartupSnapshot>;
    if (
      parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      parsed.serverEndpointId?.toLowerCase() !==
        serverEndpointId.toLowerCase() ||
      parsed.workspaceIdentity !== workspaceIdentity ||
      parsed.deviceId !== deviceId ||
      !Number.isSafeInteger(parsed.capturedAt) ||
      !parsed.tree ||
      !Array.isArray(parsed.rootPanels) ||
      (parsed.preferredPanelId !== null &&
        typeof parsed.preferredPanelId !== "string")
    ) {
      throw new Error("invalid shell startup snapshot");
    }
    return parsed as MobileShellStartupSnapshot;
  } catch {
    await storage.removeItem(storageKey);
    return null;
  }
}

export async function saveMobileShellStartupSnapshot(
  snapshot: MobileShellStartupSnapshot,
  storage: NativeAppStorage = getNativeAppStorage(),
): Promise<boolean> {
  const raw = JSON.stringify(snapshot);
  if (raw.length > MAX_SNAPSHOT_BYTES) return false;
  await storage.setItem(
    key(
      snapshot.serverEndpointId,
      snapshot.workspaceIdentity,
      snapshot.deviceId,
    ),
    raw,
  );
  return true;
}

export async function clearMobileShellStartupSnapshot(
  serverEndpointId: string,
  workspaceIdentity: string,
  deviceId: string,
  storage: NativeAppStorage = getNativeAppStorage(),
): Promise<void> {
  await storage.removeItem(key(serverEndpointId, workspaceIdentity, deviceId));
}
