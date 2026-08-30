/**
 * panelBuildPrefetch — fill the durable asset store through the same per-key
 * work registry used by demanded WebView requests.
 *
 * A cold panel load was measured on device at ~92 sequential `gateway.fetch`
 * calls for ~1.4 MB. The server spent ~7 ms answering each; the device observed
 * ~560 ms each. Nothing either end computes explains that gap — the cost is
 * simply the number of remote round trips, so the primary lever is to
 * take fewer of them.
 *
 * The build manifest names the initial artifacts and their digests. Each one is
 * fetched independently over Iroh after claiming its ordinary cache key. A
 * WebView demand and the prewarmer therefore join one transfer and one durable
 * publication regardless of which arrives first. Independent QUIC streams let
 * useful work interleave; one slow artifact cannot become a build-wide barrier.
 *
 * Three decisions worth keeping:
 *
 *  - **Only `initial` artifacts.** The same real build was 35.8 MB across 364
 *    artifacts while the cold load touched 1.4 MB of it. Prefetching everything
 *    absent would move 25× more bytes than the trips it saved were worth. Lazy
 *    chunks keep taking the ordinary per-request path; they are rare and often
 *    never requested at all.
 *  - **Verified bytes, never a blind cache fill.** The prewarmer requests
 *    identity bytes because the manifest digest describes that representation;
 *    native storage hashes the committed bytes and the returned handle proves
 *    they match before any waiter is released.
 *  - **The store's single-flight IS the handoff.** Each candidate key is claimed
 *    via `store.acquire` BEFORE the transfer starts, so a WebView request for
 *    the same asset waits on this one transfer rather than racing it with a
 *    fetch of its own. Every claim is released on every path, including failure:
 *    an unfilled claim completes as `null`, and the waiter falls back to its
 *    ordinary per-asset fetch. A failed prefetch must cost bytes, never a panel.
 */

import { panelAssetCacheKey } from "@vibestudio/shared/panel/assetPathPolicy";
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

export function panelBuildResourcePath(
  buildKey: string,
  resource: string,
): string {
  if (!BUILD_KEY.test(buildKey)) {
    throw new Error(
      `Panel build key must be 64 lowercase hex chars: ${buildKey}`,
    );
  }
  return `/__vibestudio/panel-build/${buildKey}/${resource}`;
}

export function parsePanelBuildManifest(
  text: string,
): PanelBuildManifestEntry[] {
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
  entries: readonly PanelBuildManifestEntry[],
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
  /** Cache keys this prewarm invocation owned and fetched. */
  requested: number;
  /** Committed to the store, and so removed from the WebView's critical path. */
  stored: number;
  bytes: number;
  /** Responses whose bytes hashed to something other than their claimed digest. */
  rejected: number;
  /** Time spent waiting on the pipe — the part a faster link would shorten. */
  transferMs: number;
  /** Time after the last byte arrived, still finishing writes. */
  storeDrainMs: number;
  ms: number;
}

/** Bytes handed to one `append` call. See the call site for why it is sliced. */
const APPEND_SLICE_BYTES = 128 * 1024;
const CATASTROPHIC_MANIFEST_BYTES = 64 * 1024 * 1024;

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
  store: Pick<
    MobileAssetStore,
    "acquire" | "openWrite" | "append" | "commit" | "abort"
  >;
  /** Issue one `gateway.fetch` for a panel-origin path and return its body. */
  fetchPath(
    path: string,
  ): Promise<{ status: number; body: PanelBuildBodyReader }>;
  now?: () => number;
}

async function readAll(
  body: PanelBuildBodyReader,
  maximumBytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await body.read();
    if (part === null) break;
    parts.push(part);
    total += part.byteLength;
    if (total > maximumBytes) {
      throw new Error(
        `Panel build manifest exceeded catastrophic ${maximumBytes}-byte boundary`,
      );
    }
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
  deps: PanelBuildPrefetchDeps,
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
    transferMs: 0,
    storeDrainMs: 0,
    ms: 0,
  };

  const manifestResponse = await deps.fetchPath(
    panelBuildResourcePath(buildKey, "__manifest.json"),
  );
  if (manifestResponse.status !== 200) {
    throw new Error(
      `Panel build manifest responded ${manifestResponse.status}`,
    );
  }
  const entries = parsePanelBuildManifest(
    decodeUtf8(
      await readAll(manifestResponse.body, CATASTROPHIC_MANIFEST_BYTES),
    ),
  );
  const candidates = planPanelBuildPrefetch(buildKey, entries);
  report.candidates = candidates.length;

  // Every candidate begins independently. There is no build-wide queue and no
  // private prefetch registry: store.acquire is the same single-flight gate the
  // WebView miss path uses. A demand-first owner turns this into a hit; a
  // prewarm-first owner hands its completed asset directly to the waiter.
  const failures: unknown[] = [];
  await Promise.all(
    candidates.map(async (candidate) => {
      let release: Release | null = null;
      try {
        const acquisition = await deps.store.acquire(candidate.cacheKey);
        if (acquisition.kind === "hit") {
          report.alreadyStored += 1;
          return;
        }
        release = acquisition;
        report.requested += 1;

        const transferAt = now();
        const response = await deps.fetchPath(candidate.path);
        report.transferMs += now() - transferAt;
        if (response.status !== 200) {
          throw new Error(
            `Panel asset ${candidate.path} responded ${response.status}`,
          );
        }
        const committed = await commitBody(
          deps.store,
          { ...candidate, release },
          candidate.digest,
          response.body,
          false,
          now,
        );
        report.transferMs += committed.transferMs;
        report.storeDrainMs += committed.storeDrainMs;
        let stored = committed.asset;
        if (!stored) {
          report.rejected += 1;
          stored = await refetchArtifact(deps, { ...candidate, release });
        }
        release.complete(stored);
        release = null;
        if (stored) {
          report.stored += 1;
          report.bytes += stored.size;
        }
      } catch (error) {
        release?.complete(null);
        failures.push(error);
      }
    }),
  );

  report.ms = now() - startedAt;
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} panel asset prewarm job(s) failed`,
    );
  }
  return report;
}

/**
 * A claim is only ever COMPLETED, never failed — including when the prefetch
 * itself fails. `store.acquire` rethrows a failed population into every waiter,
 * which would turn a prefetch problem into a broken panel; completing with null
 * sends the waiter down its ordinary fetch path instead.
 */
type Release = { complete(asset: MobileStoredAsset | null): void };

function artifactMetadata(
  contentType: string,
  gzip: boolean,
): MobileStoredAssetMetadata {
  return {
    status: 200,
    statusText: "OK",
    // The façade turns this into a real Content-Encoding, so it must describe
    // the bytes actually stored.
    gzip,
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
async function commitBody(
  store: PanelBuildPrefetchDeps["store"],
  claim: PanelBuildPrefetchCandidate & { release: Release },
  payloadDigest: string,
  body: PanelBuildBodyReader,
  gzip: boolean,
  now: () => number,
): Promise<{
  asset: MobileStoredAsset | null;
  transferMs: number;
  storeDrainMs: number;
}> {
  const writeId = await store.openWrite(claim.cacheKey);
  let committed = false;
  let transferMs = 0;
  let storeDrainMs = 0;
  try {
    for (;;) {
      const transferAt = now();
      const bytes = await body.read();
      transferMs += now() - transferAt;
      if (bytes === null) break;
      // Appended in slices: `append` base64-encodes on the JS thread and crosses
      // the bridge as one string. Streaming keeps a whole artifact out of
      // Hermes and yields between bridge messages so pipe reads and keepalives
      // continue making progress.
      for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += APPEND_SLICE_BYTES
      ) {
        const storeAt = now();
        await store.append(
          writeId,
          bytes.subarray(offset, offset + APPEND_SLICE_BYTES),
        );
        storeDrainMs += now() - storeAt;
      }
    }
    const commitAt = now();
    const stored = await store.commit(
      writeId,
      artifactMetadata(claim.contentType, gzip),
    );
    storeDrainMs += now() - commitAt;
    committed = true;
    return {
      asset: stored.handle.endsWith(`:${payloadDigest}`) ? stored : null,
      transferMs,
      storeDrainMs,
    };
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
  claim: PanelBuildPrefetchCandidate & { release: Release },
): Promise<MobileStoredAsset | null> {
  try {
    const response = await deps.fetchPath(claim.path);
    if (response.status !== 200) return null;
    const writeId = await deps.store.openWrite(claim.cacheKey);
    try {
      for (;;) {
        const bytes = await response.body.read();
        if (bytes === null) break;
        for (
          let offset = 0;
          offset < bytes.byteLength;
          offset += APPEND_SLICE_BYTES
        ) {
          await deps.store.append(
            writeId,
            bytes.subarray(offset, offset + APPEND_SLICE_BYTES),
          );
        }
      }
      return await deps.store.commit(
        writeId,
        artifactMetadata(claim.contentType, false),
      );
    } catch (error) {
      await deps.store.abort(writeId).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.warn(
      `[panel-prefetch] could not replace a mismatched artifact at ${claim.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
