import { WEBSITE_PROVIDER_SCRIPT } from "./websiteProviderScript";
import type { WorkspaceProvider } from "@vibestudio/rpc";

function page() {
  const sent: Array<{ requestId: string; method: string }> = [];
  const native = {
    postMessage: (raw: string) => sent.push(JSON.parse(raw)),
    onmessage: (_event: { data: string }) => {},
  };
  const window = {};
  const globals: {
    __vibestudioWorkspaceNative: typeof native;
    vibestudio?: WorkspaceProvider;
  } = {
    __vibestudioWorkspaceNative: native,
  };
  Object.assign(window, { top: window });
  new Function("window", "globalThis", WEBSITE_PROVIDER_SCRIPT)(
    window,
    globals,
  );
  const reply = (value: unknown) =>
    native.onmessage({ data: JSON.stringify(value) });
  return { provider: globals.vibestudio!, sent, reply };
}

describe("mobile website provider", () => {
  it("keeps the shared transport closed until connection succeeds", async () => {
    const p = page();
    await expect(p.provider.postEnvelope({} as never)).rejects.toMatchObject({
      code: "EWORKSPACE_DISCONNECTED",
    });
    expect(p.sent).toEqual([]);
    const connecting = p.provider.connect();
    p.reply({
      requestId: p.sent[0]!.requestId,
      ok: true,
      value: { documentId: "one" },
    });
    await connecting;
    const sending = p.provider.postEnvelope({} as never);
    expect(p.sent[1]!.method).toBe("postEnvelope");
    p.reply({ requestId: p.sent[1]!.requestId, ok: true });
    await sending;
  });

  it("cannot reopen a retired connection through an already-resolved reply", async () => {
    const p = page();
    const connecting = p.provider.connect();
    p.reply({
      requestId: p.sent[0]!.requestId,
      ok: true,
      value: { documentId: "one" },
    });
    p.reply({ disconnected: true });
    await expect(connecting).rejects.toMatchObject({
      code: "EWORKSPACE_DISCONNECTED",
    });
    await expect(p.provider.postEnvelope({} as never)).rejects.toMatchObject({
      code: "EWORKSPACE_DISCONNECTED",
    });
    expect(p.sent).toHaveLength(1);
  });

  it("completes explicit disconnect and rejects pending transport work", async () => {
    const p = page();
    const connecting = p.provider.connect();
    p.reply({ requestId: p.sent[0]!.requestId, ok: true, value: {} });
    await connecting;
    const sending = p.provider.postEnvelope({} as never);
    const rejected = expect(sending).rejects.toMatchObject({
      code: "EWORKSPACE_DISCONNECTED",
    });
    const disconnected = jest.fn();
    p.provider.onDisconnect(disconnected);
    const closing = p.provider.disconnect();
    p.reply({ disconnected: true });
    await closing;
    await rejected;
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});
