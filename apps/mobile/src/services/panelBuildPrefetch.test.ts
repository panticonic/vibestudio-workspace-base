import { createHash } from "node:crypto";
import {
  panelBuildResourcePath,
  parsePanelBuildManifest,
  planPanelBuildPrefetch,
  prefetchPanelBuild,
  type PanelBuildBodyReader,
  type PanelBuildManifestEntry,
  type PanelBuildPrefetchDeps,
} from "./panelBuildPrefetch";
import type {
  MobileStoredAsset,
  MobileStoredAssetMetadata,
} from "./mobileAssetStore";

const BUILD_KEY = "b".repeat(64);
const digestOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const utf8 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "utf8"));

const entry = (
  path: string,
  content: string,
  extra: Partial<PanelBuildManifestEntry> = {},
): PanelBuildManifestEntry => ({
  path,
  contentType: "application/javascript; charset=utf-8",
  byteLength: content.length,
  integrity: `sha256-${digestOf(content)}`,
  initial: true,
  ...extra,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createFakeStore() {
  const entries = new Map<
    string,
    { digest: string; metadata: MobileStoredAssetMetadata }
  >();
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
    commit: jest.fn(
      async (writeId: string, metadata: MobileStoredAssetMetadata) => {
        const write = writes.get(writeId)!;
        writes.delete(writeId);
        const body = Buffer.concat(
          write.bytes.map((part) => Buffer.from(part)),
        );
        const digest = createHash("sha256").update(body).digest("hex");
        entries.set(write.key, { digest, metadata });
        return {
          handle: `vibestudio-asset-v1:${digest}`,
          size: body.byteLength,
          metadata,
        };
      },
    ),
    abort: jest.fn(async (writeId: string) => {
      writes.delete(writeId);
    }),
  };
  return store;
}

function bodyOf(bytes: Uint8Array, chunk = 7): PanelBuildBodyReader {
  let offset = 0;
  return {
    read: () => {
      if (offset >= bytes.byteLength) return Promise.resolve(null);
      const part = bytes.subarray(offset, offset + chunk);
      offset += chunk;
      return Promise.resolve(part);
    },
  };
}

function createFakeServer(
  entries: PanelBuildManifestEntry[],
  contents: Record<string, string>,
  override?: (
    path: string,
  ) => Promise<{ status: number; body: PanelBuildBodyReader }>,
) {
  const paths: string[] = [];
  const fetchPath: PanelBuildPrefetchDeps["fetchPath"] = async (path) => {
    paths.push(path);
    if (path.endsWith("/__manifest.json")) {
      return {
        status: 200,
        body: bodyOf(utf8(JSON.stringify({ artifacts: entries }))),
      };
    }
    if (override) return override(path);
    const artifactPath = path.slice(
      `/__vibestudio/panel-build/${BUILD_KEY}/`.length,
    );
    const content = contents[artifactPath];
    return content === undefined
      ? { status: 404, body: bodyOf(new Uint8Array(0)) }
      : { status: 200, body: bodyOf(utf8(content)) };
  };
  return { fetchPath, paths };
}

describe("panel build prewarm planning", () => {
  it("selects only the artifacts a first paint needs", () => {
    const entries = [
      entry("bundle.js", "a"),
      entry("chunk-lazy.js", "b", { initial: undefined }),
      entry("bundle.css", "c"),
    ];
    expect(
      planPanelBuildPrefetch(BUILD_KEY, entries).map(
        (candidate) => candidate.index,
      ),
    ).toEqual([0, 2]);
  });

  it("skips an artifact with no usable digest", () => {
    const entries = [
      entry("a.js", "a", { integrity: undefined }),
      entry("b.js", "b", { integrity: "sha384-nope" }),
      entry("c.js", "c"),
    ];
    expect(
      planPanelBuildPrefetch(BUILD_KEY, entries).map(
        (candidate) => candidate.path,
      ),
    ).toEqual([panelBuildResourcePath(BUILD_KEY, "c.js")]);
  });

  it("uses exactly the demanded façade cache key", () => {
    const [candidate] = planPanelBuildPrefetch(BUILD_KEY, [
      entry("assets/app.js", "a"),
    ]);
    expect(candidate?.cacheKey).toBe(
      `/__vibestudio/panel-build/${BUILD_KEY}/assets/app.js`,
    );
  });

  it("rejects invalid build keys and manifests", () => {
    expect(() => panelBuildResourcePath("../etc", "__manifest.json")).toThrow(
      /build key/,
    );
    expect(() => parsePanelBuildManifest("{}")).toThrow(/no artifact list/);
  });
});

describe("panel build per-asset prewarm", () => {
  const contents = {
    "bundle.js": "console.log('hi')",
    "bundle.css": "body{}",
    "chunk-lazy.js": "lazy",
  };
  const entries = [
    entry("bundle.js", contents["bundle.js"]),
    entry("bundle.css", contents["bundle.css"], {
      contentType: "text/css; charset=utf-8",
    }),
    entry("chunk-lazy.js", contents["chunk-lazy.js"], { initial: undefined }),
  ];

  it("fetches initial assets independently and never opens a bundle path", async () => {
    const store = createFakeStore();
    const server = createFakeServer(entries, contents);
    const report = await prefetchPanelBuild(BUILD_KEY, {
      store,
      fetchPath: server.fetchPath,
    });
    expect(server.paths).toEqual([
      `/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`,
      `/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`,
      `/__vibestudio/panel-build/${BUILD_KEY}/bundle.css`,
    ]);
    expect(
      server.paths.some((assetPath) => assetPath.includes("__bundle")),
    ).toBe(false);
    expect(report).toMatchObject({
      candidates: 2,
      requested: 2,
      stored: 2,
      rejected: 0,
    });
  });

  it("publishes one asset while an unrelated asset is stalled", async () => {
    const store = createFakeStore();
    const releaseSlow = deferred<void>();
    const selected = [entry("slow.js", "slow"), entry("fast.js", "fast")];
    const server = createFakeServer(selected, {}, async (assetPath) => {
      if (assetPath.endsWith("slow.js")) await releaseSlow.promise;
      return {
        status: 200,
        body: bodyOf(utf8(assetPath.endsWith("slow.js") ? "slow" : "fast")),
      };
    });

    const flight = prefetchPanelBuild(BUILD_KEY, {
      store,
      fetchPath: server.fetchPath,
    });
    const fastKey = `/__vibestudio/panel-build/${BUILD_KEY}/fast.js`;
    await waitFor(() => store.released.has(fastKey));
    expect(store.released.get(fastKey)).not.toBeNull();
    expect(server.paths).toEqual(
      expect.arrayContaining([
        `/__vibestudio/panel-build/${BUILD_KEY}/slow.js`,
        `/__vibestudio/panel-build/${BUILD_KEY}/fast.js`,
      ]),
    );
    releaseSlow.resolve(undefined);
    await flight;
  });

  it("treats a demand-owned completed key as a hit", async () => {
    const store = createFakeStore();
    const key = `/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`;
    store.entries.set(key, {
      digest: digestOf(contents["bundle.js"]),
      metadata: {
        status: 200,
        statusText: "OK",
        gzip: false,
        contentType: "application/javascript; charset=utf-8",
        replayHeaders: {
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      },
    });
    const server = createFakeServer([entries[0]!], contents);
    const report = await prefetchPanelBuild(BUILD_KEY, {
      store,
      fetchPath: server.fetchPath,
    });
    expect(report).toMatchObject({ alreadyStored: 1, requested: 0, stored: 0 });
    expect(server.paths).toEqual([
      `/__vibestudio/panel-build/${BUILD_KEY}/__manifest.json`,
    ]);
  });

  it("releases a failed claim while independent assets still publish", async () => {
    const store = createFakeStore();
    const selected = [entry("gone.js", "gone"), entry("ready.js", "ready")];
    const server = createFakeServer(selected, {}, async (assetPath) =>
      assetPath.endsWith("gone.js")
        ? { status: 503, body: bodyOf(new Uint8Array(0)) }
        : { status: 200, body: bodyOf(utf8("ready")) },
    );
    await expect(
      prefetchPanelBuild(BUILD_KEY, { store, fetchPath: server.fetchPath }),
    ).rejects.toThrow(/1 panel asset prewarm job/);
    expect(
      store.released.get(`/__vibestudio/panel-build/${BUILD_KEY}/gone.js`),
    ).toBeNull();
    expect(
      store.released.get(`/__vibestudio/panel-build/${BUILD_KEY}/ready.js`),
    ).not.toBeNull();
  });

  it("repairs a digest mismatch before releasing the shared claim", async () => {
    const store = createFakeStore();
    let calls = 0;
    const server = createFakeServer(
      [entry("bundle.js", "correct")],
      {},
      async () => {
        calls += 1;
        return {
          status: 200,
          body: bodyOf(utf8(calls === 1 ? "corrupt" : "correct")),
        };
      },
    );
    const report = await prefetchPanelBuild(BUILD_KEY, {
      store,
      fetchPath: server.fetchPath,
    });
    expect(report).toMatchObject({ rejected: 1, stored: 1 });
    expect(calls).toBe(2);
    expect(
      store.entries.get(`/__vibestudio/panel-build/${BUILD_KEY}/bundle.js`)
        ?.digest,
    ).toBe(digestOf("correct"));
  });

  it("fails before claiming assets when the manifest is unavailable", async () => {
    const store = createFakeStore();
    const fetchPath = jest.fn(async () => ({
      status: 410,
      body: bodyOf(new Uint8Array(0)),
    }));
    await expect(
      prefetchPanelBuild(BUILD_KEY, { store, fetchPath }),
    ).rejects.toThrow(/410/);
    expect(store.claimed).toEqual([]);
  });
});
