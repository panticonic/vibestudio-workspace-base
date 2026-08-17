import { createHash } from "node:crypto";
import { encodeBlobRecord } from "@vibestudio/shared/panel/blobBundle";
import {
  panelBuildResourcePath,
  parsePanelBuildManifest,
  planPanelBuildPrefetch,
  prefetchPanelBuild,
  type PanelBuildManifestEntry,
  type PanelBuildPrefetchDeps,
} from "./panelBuildPrefetch";
import type { MobileStoredAsset, MobileStoredAssetMetadata } from "./mobileAssetStore";

const BUILD_KEY = "b".repeat(64);
const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));

const entry = (
  path: string,
  content: string,
  extra: Partial<PanelBuildManifestEntry> = {}
): PanelBuildManifestEntry => ({
  path,
  contentType: "application/javascript; charset=utf-8",
  byteLength: content.length,
  integrity: `sha256-${digestOf(content)}`,
  initial: true,
  ...extra,
});

/**
 * A store that keys blobs by the sha256 of what it was actually given — the
 * property the mismatch check depends on, and the one the native module
 * provides.
 */
function createFakeStore() {
  const entries = new Map<string, { digest: string; metadata: MobileStoredAssetMetadata }>();
  const writes = new Map<string, { key: string; bytes: Uint8Array[] }>();
  const claimed: string[] = [];
  const released = new Map<string, MobileStoredAsset | null>();
  let nextWrite = 0;
  const store = {
    entries,
    claimed,
    released,
    acquire: jest.fn(async (key: string) => {
      const hit = entries.get(key);
      if (hit) {
        return {
          kind: "hit" as const,
          asset: {
            handle: `vibestudio-asset-v1:${hit.digest}`,
            size: 1,
            metadata: hit.metadata,
          },
        };
      }
      claimed.push(key);
      return {
        kind: "owner" as const,
        complete: (asset: MobileStoredAsset | null) => released.set(key, asset),
        fail: (error: unknown) => {
          throw error;
        },
      };
    }),
    openWrite: jest.fn(async (key: string) => {
      const id = `w${nextWrite++}`;
      writes.set(id, { key, bytes: [] });
      return id;
    }),
    append: jest.fn(async (writeId: string, bytes: Uint8Array) => {
      writes.get(writeId)!.bytes.push(bytes);
    }),
    commit: jest.fn(async (writeId: string, metadata: MobileStoredAssetMetadata) => {
      const write = writes.get(writeId)!;
      writes.delete(writeId);
      const body = Buffer.concat(write.bytes.map((part) => Buffer.from(part)));
      const digest = createHash("sha256").update(body).digest("hex");
      entries.set(write.key, { digest, metadata });
      return { handle: `vibestudio-asset-v1:${digest}`, size: body.byteLength, metadata };
    }),
    abort: jest.fn(async (writeId: string) => {
      writes.delete(writeId);
    }),
  };
  return store;
}

function bodyOf(bytes: Uint8Array, chunk = 7): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
        yield bytes.subarray(offset, offset + chunk);
      }
    },
  };
}

/** Serve a manifest and a bundle the way `panelHttpServer` does. */
function createFakeServer(
  entries: PanelBuildManifestEntry[],
  contents: Record<string, string>,
  overrides: { bundleFor?: (indices: number[]) => Uint8Array } = {}
) {
  const paths: string[] = [];
  const fetchPath: PanelBuildPrefetchDeps["fetchPath"] = async (path) => {
    paths.push(path);
    if (path.endsWith("/__manifest.json")) {
      return { status: 200, body: bodyOf(utf8(JSON.stringify({ artifacts: entries }))) };
    }
    const bundleAt = path.indexOf("/__bundle?");
    if (bundleAt !== -1) {
      const want = new URLSearchParams(path.slice(path.indexOf("?"))).get("want") ?? "";
      const indices = want
        .split(",")
        .map((raw) => Number.parseInt(raw, 10))
        .filter((index) => Number.isInteger(index));
      if (overrides.bundleFor) return { status: 200, body: bodyOf(overrides.bundleFor(indices)) };
      const records = indices.map((index) => {
        const artifact = entries[index]!;
        const content = contents[artifact.path]!;
        return Buffer.from(encodeBlobRecord(digestOf(content), utf8(content)));
      });
      return { status: 200, body: bodyOf(new Uint8Array(Buffer.concat(records))) };
    }
    const artifactPath = path.slice(`/__vibestudio/panel-build/${BUILD_KEY}/`.length);
    const content = contents[artifactPath];
    if (content === undefined) return { status: 404, body: bodyOf(new Uint8Array(0)) };
    return { status: 200, body: bodyOf(utf8(content)) };
  };
  return { fetchPath, paths };
}

describe("panel build prefetch planning", () => {
  it("selects only the artifacts a first paint needs", () => {
    // Prefetching everything absent would move a build's lazy chunks, images and
    // source maps — measured at 35.8 MB against a 1.4 MB cold load.
    const entries = [
      entry("bundle.js", "a"),
      entry("chunk-lazy.js", "b", { initial: undefined }),
      entry("bundle.css", "c"),
    ];
    expect(planPanelBuildPrefetch(BUILD_KEY, entries).map((c) => c.index)).toEqual([0, 2]);
  });

  it("skips an artifact with no usable digest rather than fetching it blind", () => {
    // Its bytes would land in the store under a digest nothing claimed, so a
    // correct payload would be indistinguishable from a misattributed one.
    const entries = [
      entry("a.js", "a", { integrity: undefined }),
      entry("b.js", "b", { integrity: "sha384-nope" }),
      entry("c.js", "c"),
    ];
    expect(planPanelBuildPrefetch(BUILD_KEY, entries).map((c) => c.path)).toEqual([
      panelBuildResourcePath(BUILD_KEY, "c.js"),
    ]);
  });

  it("keys candidates exactly as the façade keys a served request", () => {
    // The whole handoff depends on this: a different key means the WebView's
    // request misses everything this prefetched.
    const [candidate] = planPanelBuildPrefetch(BUILD_KEY, [entry("assets/app.js", "a")]);
    expect(candidate?.cacheKey).toBe(`/__vibestudio/panel-build/${BUILD_KEY}/assets/app.js`);
  });

  it("refuses a build key that is not a digest", () => {
    expect(() => panelBuildResourcePath("../etc", "__manifest.json")).toThrow(/build key/);
  });

  it("rejects a manifest without an artifact list", () => {
    expect(() => parsePanelBuildManifest("{}")).toThrow(/no artifact list/);
  });
});

describe("panel build prefetch transfer", () => {
  const contents = {
    "bundle.js": "console.log('hi')",
    "bundle.css": "body{}",
    "chunk-lazy.js": "lazy",
  };
  const entries = [
    entry("bundle.js", contents["bundle.js"]),
    entry("bundle.css", contents["bundle.css"], { contentType: "text/css; charset=utf-8" }),
    entry("chunk-lazy.js", contents["chunk-lazy.js"], { initial: undefined }),
  ];

  it("fills the store for a cold build in two round trips", async () => {
    // Two, not ninety-two: one inventory and one bundle, regardless of how many
    // artifacts the panel needs.
    const store = createFakeStore();
    const server = createFakeServer(entries, contents);

    const report = await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect(server.paths).toEqual([
      `/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`,
      `/__vibestudio/panel-build/${BUILD_KEY}/__bundle?want=0,1`,
    ]);
    expect(report).toMatchObject({ candidates: 2, alreadyStored: 0, requested: 2, stored: 2 });
    expect(report.bytes).toBe(contents["bundle.js"].length + contents["bundle.css"].length);
    expect([...store.entries.keys()]).toEqual([
      `/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`,
      `/__vibestudio/panel-build/${BUILD_KEY}/bundle.css`,
    ]);
  });

  it("stores artifacts the façade can replay verbatim", async () => {
    // Identity bytes, so the response must not claim gzip; and the metadata has
    // to satisfy the store's immutable-only rule.
    const store = createFakeStore();
    const server = createFakeServer(entries, contents);
    await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    const css = store.entries.get(`/__vibestudio/panel-build/${BUILD_KEY}/bundle.css`);
    expect(css?.metadata).toEqual({
      status: 200,
      statusText: "OK",
      gzip: false,
      contentType: "text/css; charset=utf-8",
      replayHeaders: { "Cache-Control": "public, max-age=31536000, immutable" },
    });
  });

  it("asks for nothing when the device already holds the build", async () => {
    const store = createFakeStore();
    const server = createFakeServer(entries, contents);
    await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });
    server.paths.length = 0;

    const report = await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect(report).toMatchObject({ candidates: 2, alreadyStored: 2, requested: 0, stored: 0 });
    expect(server.paths).toEqual([`/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`]);
  });

  it("releases every claim it took, so a waiting request is never stranded", async () => {
    const store = createFakeStore();
    const server = createFakeServer(entries, contents);
    await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect([...store.released.keys()].sort()).toEqual(store.claimed.sort());
    expect([...store.released.values()].every(Boolean)).toBe(true);
  });

  it("releases claims for artifacts a short bundle never delivered", async () => {
    // The claim IS the handoff: an unreleased key would leave the WebView
    // waiting forever on a transfer that already ended.
    const store = createFakeStore();
    const server = createFakeServer(entries, contents, {
      bundleFor: (indices) =>
        new Uint8Array(
          encodeBlobRecord(digestOf(contents["bundle.js"]), utf8(contents["bundle.js"]))
        ).subarray(0, indices.length > 0 ? undefined : 0),
    });

    const report = await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect(report.stored).toBe(1);
    const cssKey = `/__vibestudio/panel-build/${BUILD_KEY}/bundle.css`;
    expect(store.released.get(cssKey)).toBeNull();
  });

  it("releases every claim when the bundle transfer fails outright", async () => {
    const store = createFakeStore();
    const fetchPath = jest.fn(async (path: string) => {
      if (path.endsWith("/__manifest.json")) {
        return { status: 200, body: bodyOf(utf8(JSON.stringify({ artifacts: entries }))) };
      }
      throw new Error("pipe went down");
    });

    await expect(prefetchPanelBuild(BUILD_KEY, { store, fetchPath })).rejects.toThrow(
      "pipe went down"
    );
    expect([...store.released.keys()].sort()).toEqual(store.claimed.sort());
    expect([...store.released.values()]).toEqual([null, null]);
  });

  it("fails loud on a bundle cut mid-record instead of reporting success", async () => {
    const store = createFakeStore();
    const full = encodeBlobRecord(digestOf(contents["bundle.js"]), utf8(contents["bundle.js"]));
    const server = createFakeServer(entries, contents, {
      bundleFor: () => full.subarray(0, full.byteLength - 3),
    });

    await expect(
      prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath })
    ).rejects.toThrow(/ended mid-record/);
  });

  it("replaces bytes that do not hash to their claimed digest", async () => {
    // A mismatched payload has already entered the store by the time the digest
    // is known (the store has no per-key delete), so the key must be overwritten
    // with an ordinary per-asset fetch rather than left poisoned.
    const store = createFakeStore();
    const server = createFakeServer(entries, contents, {
      bundleFor: (indices) =>
        new Uint8Array(
          Buffer.concat(
            indices.map((index) =>
              Buffer.from(
                encodeBlobRecord(
                  digestOf(contents[entries[index]!.path as keyof typeof contents]),
                  utf8("corrupted")
                )
              )
            )
          )
        ),
    });

    const report = await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect(report.rejected).toBe(2);
    expect(report.stored).toBe(2);
    expect(store.entries.get(`/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`)?.digest).toBe(
      digestOf(contents["bundle.js"])
    );
    expect(server.paths).toContain(`/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`);
  });

  it("does not strand a claim when a per-artifact replacement also fails", async () => {
    const store = createFakeStore();
    const server = createFakeServer([entry("gone.js", "x")], {}, {
      bundleFor: () => new Uint8Array(encodeBlobRecord(digestOf("x"), utf8("corrupted"))),
    });

    const report = await prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath });

    expect(report).toMatchObject({ rejected: 1, stored: 0 });
    expect(store.released.get(`/__vibestudio/panel-build/${BUILD_KEY}/gone.js`)).toBeNull();
  });

  it("refuses a manifest the server would not serve", async () => {
    const store = createFakeStore();
    const fetchPath = jest.fn(async () => ({ status: 410, body: bodyOf(new Uint8Array(0)) }));
    await expect(prefetchPanelBuild(BUILD_KEY, { store, fetchPath })).rejects.toThrow(/410/);
    expect(store.claimed).toEqual([]);
  });
});
