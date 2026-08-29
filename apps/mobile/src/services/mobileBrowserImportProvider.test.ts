import { MobileBrowserImportProvider } from "./mobileBrowserImportProvider";
import {
  pickBrowserImportArchive,
  readBrowserImportArchive,
  releaseBrowserImportArchive,
} from "./mobileBrowserImportNative";
import {
  inspectBrowserExport,
  parseSelectedBrowserExport,
  type BrowserExportInspection,
} from "@vibestudio/browser-import-archive";

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("./nativeCapabilities", () => ({ openExternalUrl: jest.fn() }));
jest.mock("./mobileBrowserImportNative", () => ({
  openSafariBrowserDataExport: jest.fn(),
  pickBrowserImportArchive: jest.fn(),
  readBrowserImportArchive: jest.fn(),
  releaseBrowserImportArchive: jest.fn(),
}));
jest.mock(
  "@vibestudio/browser-import-archive",
  () => ({
    inspectBrowserExport: jest.fn(),
    parseSelectedBrowserExport: jest.fn(),
  }),
  { virtual: true },
);

const archive = {
  handle: "staged-export-1",
  displayName: "Safari.zip",
  size: 128,
  entries: [
    { name: "Safari/Bookmarks.html", size: 64 },
    { name: "Safari/Passwords.csv", size: 64 },
  ],
};
const secret = "correct-horse-battery-staple";
const sourceInspection: BrowserExportInspection = {
  browser: "safari" as const,
  displayName: "Safari export",
  localDataSetCount: 2,
  profileCount: 1,
  supportedDataTypes: ["bookmarks", "passwords"],
  warnings: [],
  errors: [],
};

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function rpc() {
  return {
    expose: jest.fn(),
    call: jest.fn(async () => 1),
  };
}

function exposedHandler(transport: ReturnType<typeof rpc>, method: string) {
  const registration = transport.expose.mock.calls.find(
    ([name]) => name === method,
  );
  if (!registration) throw new Error(`Missing exposed method: ${method}`);
  return registration[1] as (context: { args: unknown[] }) => unknown;
}

async function acquire(provider: MobileBrowserImportProvider) {
  const result = await provider.beginAcquisition("choose-export");
  if (result.state !== "selected")
    throw new Error("Expected a selected browser export");
  return result.source;
}

describe("MobileBrowserImportProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: jest.fn(() => "operation-or-source-id") },
    });
    jest.mocked(pickBrowserImportArchive).mockResolvedValue(archive);
    jest.mocked(readBrowserImportArchive).mockResolvedValue([
      { name: "Safari/Bookmarks.html", bytes: new Uint8Array([1]) },
      { name: "Safari/Passwords.csv", bytes: new Uint8Array([2]) },
    ]);
    jest.mocked(releaseBrowserImportArchive).mockResolvedValue(undefined);
    jest.mocked(inspectBrowserExport).mockReturnValue(sourceInspection);
    jest
      .mocked(parseSelectedBrowserExport)
      .mockImplementation((_entries, selected) => ({
        ...sourceInspection,
        items: {
          bookmarks: selected.includes("bookmarks")
            ? [
                {
                  title: "Public bookmark",
                  url: "https://public.example",
                  dateAdded: 0,
                  folder: [],
                },
              ]
            : [],
          history: [],
          passwords: selected.includes("passwords")
            ? [
                {
                  url: "https://private.example",
                  username: "private-user",
                  password: secret,
                },
              ]
            : [],
        },
      }));
  });

  it("never parses or emits password values through public import frames", async () => {
    const transport = rpc();
    const provider = new MobileBrowserImportProvider(
      transport as never,
      "phone-1",
      storage(),
    );
    const source = await acquire(provider);

    const operationId = await provider.startImportRead(source.sourceId, [
      "bookmarks",
    ]);
    const frames: unknown[] = [];
    for (;;) {
      const frame = provider.nextFrame(operationId);
      frames.push(frame);
      if (frame.type === "complete") break;
    }

    expect(parseSelectedBrowserExport).toHaveBeenLastCalledWith(
      expect.any(Array),
      ["bookmarks"],
    );
    expect(JSON.stringify(frames)).toContain("https://public.example");
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(JSON.stringify(frames)).not.toContain("private-user");
    expect(transport.call).not.toHaveBeenCalled();

    await provider.releaseSource(source.sourceId);
  });

  it("rejects protected categories before a public operation can be created", async () => {
    const transport = rpc();
    const provider = new MobileBrowserImportProvider(
      transport as never,
      "phone-1",
      storage(),
    );
    provider.expose();
    const source = await acquire(provider);

    expect(() =>
      exposedHandler(
        transport,
        "browserEnvironment.startImportRead",
      )({
        args: ["device:phone-1", source.sourceId, ["passwords"]],
      }),
    ).toThrow("Protected browser data requires the sealed import path.");
    expect(parseSelectedBrowserExport).not.toHaveBeenCalled();

    await provider.releaseSource(source.sourceId);
  });

  it("releases native staging exactly once when a transient source is removed", async () => {
    const provider = new MobileBrowserImportProvider(
      rpc() as never,
      "phone-1",
      storage(),
    );
    const source = await acquire(provider);

    await provider.releaseSource(source.sourceId);
    await provider.releaseSource(source.sourceId);

    expect(releaseBrowserImportArchive).toHaveBeenCalledTimes(1);
    expect(releaseBrowserImportArchive).toHaveBeenCalledWith(archive.handle);
  });

  it("releases native staging when inspection rejects the selected export", async () => {
    jest.mocked(inspectBrowserExport).mockReturnValue({
      ...sourceInspection,
      errors: [
        {
          code: "unsupported_json_schema",
          message: "A JSON entry uses an unsupported schema.",
        },
      ],
    });
    const provider = new MobileBrowserImportProvider(
      rpc() as never,
      "phone-1",
      storage(),
    );

    await expect(provider.beginAcquisition("choose-export")).rejects.toThrow(
      "A JSON entry uses an unsupported schema.",
    );
    expect(releaseBrowserImportArchive).toHaveBeenCalledTimes(1);
    expect(releaseBrowserImportArchive).toHaveBeenCalledWith(archive.handle);
  });
});
