import {
  WebsiteDocumentHost,
  type NativeWebsiteRequest,
} from "./websiteDocumentHost";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const approval = deferred<boolean>();
  const deps = {
    runtimeId: () => "panel:browser",
    bootstrap: jest.fn(async () => ({
      runtimeId: "panel:browser",
      slotId: "slot",
      contextId: "context",
      parentId: null,
      parentEntityId: null,
      theme: "dark" as const,
    })),
    hosting: jest.fn(async (method: string) =>
      method === "connect" ? approval.promise : undefined,
    ),
    relay: jest.fn(async () => "result"),
    closeRelay: jest.fn(),
    disconnected: jest.fn(),
    executionId: () => "execution-1",
  };
  return { host: new WebsiteDocumentHost(deps), deps, approval };
}
const request = (
  method: string,
  documentId = "native-document-1",
): NativeWebsiteRequest => ({
  target: 1,
  documentId,
  origin: "https://example.com",
  requestId: "request-1",
  method,
  argsJson: "[]",
});

describe("native mobile website hosting", () => {
  it("does not expose workspace RPC or bootstrap before connection approval", async () => {
    const h = harness();
    await expect(
      h.host.request("slot", request("postEnvelope")),
    ).rejects.toThrow("Connect");
    const connecting = h.host.request("slot", request("connect"));
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      h.host.request("slot", request("postEnvelope")),
    ).rejects.toThrow("Connect");
    expect(h.deps.bootstrap).not.toHaveBeenCalled();
    expect(h.deps.relay).not.toHaveBeenCalled();
    h.approval.resolve(true);
    await expect(connecting).resolves.toMatchObject({
      origin: "https://example.com",
      documentId: "execution-1",
    });
    await expect(h.host.request("slot", request("postEnvelope"))).resolves.toBe(
      "result",
    );
    expect(h.host.delivery("slot", "reply")).toEqual({
      __vibestudioWebsiteDocument: "native-document-1",
      delivery: "reply",
    });
  });

  it("retires a pending approval on navigation without delivering bootstrap", async () => {
    const h = harness();
    const connecting = h.host.request("slot", request("connect"));
    const rejected = expect(connecting).rejects.toThrow("retired");
    await Promise.resolve();
    await Promise.resolve();
    await h.host.request("slot", request("retire"));
    h.approval.resolve(true);
    await rejected;
    expect(h.deps.bootstrap).not.toHaveBeenCalled();
    expect(h.deps.closeRelay).toHaveBeenCalledWith("slot");
    expect(h.host.delivery("slot", "reply")).toBeNull();
  });

  it("does not let a delayed native retirement disconnect the replacement document", async () => {
    const h = harness();
    h.approval.resolve(true);
    await h.host.request("slot", request("connect"));
    await h.host.request("slot", request("connect", "replacement-document"));
    await h.host.request("slot", request("retire"));
    await expect(
      h.host.request("slot", request("postEnvelope", "replacement-document")),
    ).resolves.toBe("result");
  });

  it("keeps a denied connection closed", async () => {
    const h = harness();
    h.approval.resolve(false);
    await expect(h.host.request("slot", request("connect"))).rejects.toThrow(
      "declined",
    );
    await expect(h.host.request("slot", request("streamOpen"))).rejects.toThrow(
      "Connect",
    );
    expect(h.deps.bootstrap).not.toHaveBeenCalled();
  });
});
