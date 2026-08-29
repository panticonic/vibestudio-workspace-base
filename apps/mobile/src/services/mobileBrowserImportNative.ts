import { NativeModules, Platform } from "react-native";
import { base64ToBytes } from "@vibestudio/rpc";
import { requireApprovedAppCapability } from "./appCapabilities";

export interface NativeBrowserImportEntry {
  name: string;
  size: number;
}

export interface NativeBrowserImportArchive {
  handle: string;
  displayName: string;
  mimeType?: string;
  size: number;
  entries: NativeBrowserImportEntry[];
}

interface NativeBrowserImportHost {
  openSafariBrowserDataExport(): Promise<{
    opened: boolean;
    unavailableReason?: string;
  }>;
  pickBrowserImportArchive(): Promise<NativeBrowserImportArchive | null>;
  readBrowserImportEntry(
    handle: string,
    name: string,
    offset: number,
    maximumBytes: number,
  ): Promise<{ dataBase64: string; eof: boolean }>;
  releaseBrowserImportArchive(handle: string): Promise<void>;
}

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_JS_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_JS_ARCHIVE_BYTES = 256 * 1024 * 1024;

function nativeHost(): NativeBrowserImportHost {
  requireApprovedAppCapability("browser-import", "browser export import");
  const host = NativeModules["VibestudioMobileHost"] as
    | NativeBrowserImportHost
    | undefined;
  if (!host)
    throw new Error(
      "Browser export import is unavailable in this mobile app version.",
    );
  return host;
}

export async function openSafariBrowserDataExport(): Promise<string> {
  if (Platform.OS !== "ios") {
    throw new Error(
      "Safari browser export is available only on iPhone and iPad.",
    );
  }
  const result = await nativeHost().openSafariBrowserDataExport();
  if (!result.opened) {
    throw new Error(
      result.unavailableReason ?? "Safari browser export is unavailable.",
    );
  }
  return "Finish the Safari export, save it to Files, then return and choose the exported ZIP.";
}

export function pickBrowserImportArchive(): Promise<NativeBrowserImportArchive | null> {
  return nativeHost().pickBrowserImportArchive();
}

export async function readBrowserImportArchive(
  archive: NativeBrowserImportArchive,
): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  let totalBytes = 0;
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const entry of archive.entries) {
    if (entry.size < 0 || entry.size > MAX_JS_ENTRY_BYTES) {
      throw new Error(
        "A browser export entry exceeds the supported mobile import size.",
      );
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_JS_ARCHIVE_BYTES) {
      throw new Error(
        "The browser export is too large to inspect safely on this device.",
      );
    }
    const bytes = new Uint8Array(entry.size);
    let offset = 0;
    while (offset < entry.size) {
      const chunk = await nativeHost().readBrowserImportEntry(
        archive.handle,
        entry.name,
        offset,
        Math.min(READ_CHUNK_BYTES, entry.size - offset),
      );
      const decoded = base64ToBytes(chunk.dataBase64);
      if (
        decoded.byteLength === 0 ||
        offset + decoded.byteLength > entry.size
      ) {
        throw new Error(
          "The staged browser export changed while it was being read.",
        );
      }
      bytes.set(decoded, offset);
      offset += decoded.byteLength;
      if (chunk.eof && offset !== entry.size) {
        throw new Error(
          "The staged browser export ended before its declared size.",
        );
      }
    }
    entries.push({ name: entry.name, bytes });
  }
  return entries;
}

export function releaseBrowserImportArchive(handle: string): Promise<void> {
  return nativeHost().releaseBrowserImportArchive(handle);
}
