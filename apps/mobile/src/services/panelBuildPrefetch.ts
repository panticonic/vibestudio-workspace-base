/**
 * panelBuildPrefetch — fill the durable asset store for a panel build in ONE
 * transfer instead of one round trip per file.
 *
 * A cold panel load was measured on device at ~92 sequential `gateway.fetch`
 * calls for ~1.4 MB. The server spent ~7 ms answering each; the device observed
 * ~560 ms each. Nothing either end computes explains that gap — the cost is
 * simply the number of trips across the WebRTC pipe, so the only lever is to
 * take fewer of them.
 *
 * The build namespace already exposes what that needs (`panelHttpServer`):
 * `__manifest.json` names every artifact with the sha256 the bundle keys it
 * under, and `__bundle?want=<indices>` streams exactly the requested ones as a
 * `blobBundle`. Both live inside `/__vibestudio/panel-build/<buildKey>/`, which
 * is already panel-reachable and already content-addressed, so this adds no new
 * authority surface.
 *
 * Three decisions worth keeping:
 *
 *  - **Only `initial` artifacts.** The same real build was 35.8 MB across 364
 *    artifacts while the cold load touched 1.4 MB of it. Prefetching everything
 *    absent would move 25× more bytes than the trips it saved were worth. Lazy
 *    chunks keep taking the ordinary per-request path; they are rare and often
 *    never requested at all.
 *  - **Identity bytes, not gzip.** The façade's per-asset path asks the gateway
 *    for gzip and hands the compressed body straight to the WebView, which
 *    inflates it natively. Here the bytes pass THROUGH Hermes, which has no
 *    cheap inflate — and a gzipped body would also hash to something other than
 *    the manifest's `integrity`, discarding the verification below. Raw bytes
 *    cost more pipe, but the pipe is not the bottleneck the measurement found.
 *  - **The store's single-flight IS the handoff.** Each candidate key is claimed
 *    via `store.acquire` BEFORE the transfer starts, so a WebView request for
 *    the same asset waits on this one transfer rather than racing it with a
 *    fetch of its own. Every claim is released on every path, including failure:
 *    an unfilled claim completes as `null`, and the waiter falls back to its
 *    ordinary per-asset fetch. A failed prefetch must cost bytes, never a panel.
 */

import { panelAssetCacheKey } from "@vibestudio/shared/panel/assetPathPolicy";
import { createBlobBundleReader } from "@vibestudio/shared/panel/blobBundle";
import type {
  MobileAssetStore,
  MobileStoredAsset,
  MobileStoredAssetMetadata,
} from "./mobileAssetStore";

const BUILD_KEY = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha256-([0-9a-f]{64})$/u;

/** Entries as `servePanelBuildManifest` writes them. */
export interface PanelBuildManifestEntry {
  path: string;
  contentType: string;
  byteLength?: number;
  integrity?: string;
  initial?: boolean;
}

/** One artifact this device could usefully receive in the bundle. */
export interface PanelBuildPrefetchCandidate {
  /** Position in the manifest — the bundle's selection vocabulary. */
  index: number;
  /** Panel-origin path, for the per-asset fallback. */
  path: string;
  cacheKey: string;
  /** Bare sha256 hex, as the bundle frames it. */
  digest: string;
  contentType: string;
}

export function panelBuildResourcePath(buildKey: string, resource: string): string {
  if (!BUILD_KEY.test(buildKey)) {
    throw new Error(`Panel build key must be 64 lowercase hex chars: ${buildKey}`);
  }
  return `/__vibestudio/panel-build/${buildKey}/${resource}`;
}

export function parsePanelBuildManifest(text: string): PanelBuildManifestEntry[] {
  const parsed: unknown = JSON.parse(text);
  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new Error("Panel build manifest has no artifact list");
  }
  return artifacts as PanelBuildManifestEntry[];
}

/**
 * The artifacts worth asking for, in manifest order.
 *
 * An entry without a usable `integrity` is skipped rather than fetched blind:
 * its bytes would enter the store under a digest nothing had claimed, so there
 * would be no way to tell a correct payload from a misattributed one.
 */
export function planPanelBuildPrefetch(
  buildKey: string,
  entries: readonly PanelBuildManifestEntry[]
): PanelBuildPrefetchCandidate[] {
  const candidates: PanelBuildPrefetchCandidate[] = [];
  entries.forEach((entry, index) => {
    if (!entry.initial || typeof entry.path !== "string" || !entry.path) return;
    const digest = INTEGRITY.exec(entry.integrity ?? "")?.[1];
    if (!digest) return;
    const path = panelBuildResourcePath(buildKey, entry.path);
    candidates.push({
      index,
      path,
      cacheKey: panelAssetCacheKey(path, {}),
      digest,
      contentType: entry.contentType || "application/octet-stream",
    });
  });
  return candidates;
}

export interface PanelBuildPrefetchReport {
  /** Artifacts the manifest marked as needed for a first paint. */
  candidates: number;
  /** Of those, the ones this device already held. */
  alreadyStored: number;
  /** Asked for in the bundle. */
  requested: number;
  /** Committed to the store, and so removed from the WebView's critical path. */
  stored: number;
  bytes: number;
  /** Records whose bytes hashed to something other than their claimed digest. */
  rejected: number;
  ms: number;
}

/**
 * A pull-based body, deliberately NOT an `AsyncIterable`.
 *
 * Hermes does not define `Symbol.asyncIterator`, so an object literal keyed by
 * it silently becomes a property named `undefined` and `for await` fails with
 * "Object is not async iterable" — observed on device, after the desktop tests
 * passed. `read()` resolving to null at end of stream needs no runtime support
 * at all.
 */
export interface PanelBuildBodyReader {
  read(): Promise<Uint8Array | null>;
}

export interface PanelBuildPrefetchDeps {
  store: Pick<MobileAssetStore, "acquire" | "openWrite" | "append" | "commit" | "abort">;
  /** Issue one `gateway.fetch` for a panel-origin path and return its body. */
  fetchPath(path: string): Promise<{ status: number; body: PanelBuildBodyReader }>;
  now?: () => number;
}

async function readAll(body: PanelBuildBodyReader): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await body.read();
    if (part === null) break;
    parts.push(part);
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const decodeUtf8 = (bytes: Uint8Array): string => {
  // Hermes has TextDecoder only behind Intl; the manifest is ASCII JSON, and
  // chunking keeps a multi-KB inventory off the argument-count cliff.
  let text = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 4096) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return text;
};

/**
 * Populate the store with everything this build needs for a first paint and
 * this device does not already hold.
 *
 * Resolves with what happened rather than throwing: the caller's panel is not
 * waiting on this, and every outcome short of success simply leaves the WebView
 * to fetch that asset the ordinary way.
 */
export async function prefetchPanelBuild(
  buildKey: string,
  deps: PanelBuildPrefetchDeps
): Promise<PanelBuildPrefetchReport> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const report: PanelBuildPrefetchReport = {
    candidates: 0,
    alreadyStored: 0,
    requested: 0,
    stored: 0,
    bytes: 0,
    rejected: 0,
    ms: 0,
  };

  const manifestResponse = await deps.fetchPath(
    panelBuildResourcePath(buildKey, "__manifest.json")
  );
  if (manifestResponse.status !== 200) {
    throw new Error(`Panel build manifest responded ${manifestResponse.status}`);
  }
  const entries = parsePanelBuildManifest(decodeUtf8(await readAll(manifestResponse.body)));
  const candidates = planPanelBuildPrefetch(buildKey, entries);
  report.candidates = candidates.length;

  // Claim every key up front. Two candidates can share a digest (identical files
  // under different names), so the pending map is keyed by digest and holds a
  // list — one blob may satisfy several claims.
  const pending = new Map<string, (PanelBuildPrefetchCandidate & { release: Release })[]>();
  const wanted: number[] = [];
  try {
    for (const candidate of candidates) {
      const acquisition = await deps.store.acquire(candidate.cacheKey);
      if (acquisition.kind === "hit") {
        report.alreadyStored += 1;
        continue;
      }
      const claims = pending.get(candidate.digest) ?? [];
      claims.push({ ...candidate, release: acquisition });
      pending.set(candidate.digest, claims);
      wanted.push(candidate.index);
    }
    report.requested = wanted.length;
    if (wanted.length === 0) {
      report.ms = now() - startedAt;
      return report;
    }

    const bundle = await deps.fetchPath(
      `${panelBuildResourcePath(buildKey, "__bundle")}?want=${wanted.join(",")}`
    );
    if (bundle.status !== 200) {
      throw new Error(`Panel build bundle responded ${bundle.status}`);
    }
    const reader = createBlobBundleReader();
    for (;;) {
      const chunk = await bundle.body.read();
      if (chunk === null) break;
      for (const blob of reader.push(chunk)) {
        const claims = pending.get(blob.digest);
        if (!claims) continue;
        // Removed before the writes: whatever happens below, this key is
        // released here and must not be released a second time by the
        // finally-block sweep.
        pending.delete(blob.digest);
        for (const claim of claims) {
          // One artifact failing to reach the store is not a reason to strand
          // the rest. Release this claim and let the WebView fetch it.
          let stored: MobileStoredAsset | null = null;
          try {
            stored = await commitBlob(deps.store, claim, blob.digest, blob.bytes);
            if (!stored) {
              report.rejected += 1;
              stored = await refetchArtifact(deps, claim);
            }
          } catch (error) {
            console.warn(
              `[panel-prefetch] could not store ${claim.path}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
          claim.release.complete(stored);
          if (stored) {
            report.stored += 1;
            report.bytes += stored.size;
          }
        }
      }
    }
    // A short stream means the answer was incomplete, not that the missing
    // artifacts do not exist; the claims released below send those to the
    // ordinary path.
    reader.end();
  } finally {
    for (const claims of pending.values()) {
      for (const claim of claims) claim.release.complete(null);
    }
    pending.clear();
  }

  report.ms = now() - startedAt;
  return report;
}

/**
 * A claim is only ever COMPLETED, never failed — including when the prefetch
 * itself fails. `store.acquire` rethrows a failed population into every waiter,
 * which would turn a prefetch problem into a broken panel; completing with null
 * sends the waiter down its ordinary fetch path instead.
 */
type Release = { complete(asset: MobileStoredAsset | null): void };

function artifactMetadata(contentType: string): MobileStoredAssetMetadata {
  return {
    status: 200,
    statusText: "OK",
    // Identity bytes: the façade must not tell the WebView otherwise.
    gzip: false,
    contentType,
    // A build artifact is immutable and content-addressed by its path. The
    // per-asset path stores exactly this, so a prefetched entry and a fetched
    // one are indistinguishable to a later request.
    replayHeaders: { "Cache-Control": "public, max-age=31536000, immutable" },
  };
}

/**
 * Write one blob under its claimed key, and report a mismatch between the
 * store's own digest and the one the record claimed.
 *
 * This is the only integrity check in the path, and it is nearly free: native
 * already hashes what it stores in order to name the blob, so checking it costs
 * a string compare rather than a second SHA-256 pass over megabytes on the JS
 * thread — the thread whose starvation breaks the pipe in the first place.
 *
 * It cannot reject BEFORE writing, because the digest is what `commit` returns;
 * the store has no per-key delete, so a mismatch leaves the key pointing at the
 * wrong bytes until the caller overwrites it. `refetchArtifact` is that
 * overwrite, and it is why this returns null instead of throwing.
 */
async function commitBlob(
  store: PanelBuildPrefetchDeps["store"],
  claim: PanelBuildPrefetchCandidate & { release: Release },
  digest: string,
  bytes: Uint8Array
): Promise<MobileStoredAsset | null> {
  const writeId = await store.openWrite(claim.cacheKey);
  let committed = false;
  try {
    await store.append(writeId, bytes);
    const stored = await store.commit(writeId, artifactMetadata(claim.contentType));
    committed = true;
    return stored.handle.endsWith(`:${digest}`) ? stored : null;
  } finally {
    if (!committed) await store.abort(writeId).catch(() => undefined);
  }
}

/**
 * Overwrite a key whose bundled bytes did not hash to their claimed digest.
 *
 * This is deliberately just "what would have happened without prefetch": one
 * ordinary per-asset fetch, stored unverified, exactly as the façade's own miss
 * path does. It buys no new guarantee for these bytes — it exists so a
 * mis-framed bundle cannot leave a durable entry that no later request would
 * ever replace, because every later request would be served from it.
 */
async function refetchArtifact(
  deps: PanelBuildPrefetchDeps,
  claim: PanelBuildPrefetchCandidate & { release: Release }
): Promise<MobileStoredAsset | null> {
  try {
    const response = await deps.fetchPath(claim.path);
    if (response.status !== 200) return null;
    const bytes = await readAll(response.body);
    const writeId = await deps.store.openWrite(claim.cacheKey);
    try {
      await deps.store.append(writeId, bytes);
      return await deps.store.commit(writeId, artifactMetadata(claim.contentType));
    } catch (error) {
      await deps.store.abort(writeId).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.warn(
      `[panel-prefetch] could not replace a mismatched artifact at ${claim.path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
