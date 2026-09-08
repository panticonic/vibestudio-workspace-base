/** Document-local adapter for the same envelope/stream contract used by installed panels. */
export const WEBSITE_PROVIDER_SCRIPT = `
(() => {
  if (window !== window.top) return;
  const native = globalThis.__vibestudioWorkspaceNative;
  if (!native) return;
  let connected = false;
  let generation = 0;
  let sequence = 0;
  const pending = new Map();
  const envelopes = new Set();
  const streams = new Set();
  const disconnected = new Set();
  const fail = () => Object.assign(new Error("Connect this website to the workspace first"), {code:"EWORKSPACE_DISCONNECTED"});
  const call = (method, args) => new Promise((resolve, reject) => {
    const requestId = String(++sequence);
    pending.set(requestId, {resolve, reject, method});
    try { native.postMessage(JSON.stringify({requestId, method, args})); }
    catch (error) { pending.delete(requestId); reject(error); }
  });
  const send = (method, args) => {
    if (!connected) return Promise.reject(fail());
    return call(method, args);
  };
  native.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.disconnected) {
      generation++;
      connected = false;
      for (const request of pending.values()) {
        if (request.method === "disconnect") request.resolve(); else request.reject(fail());
      }
      pending.clear();
      for (const handler of disconnected) handler();
      return;
    }
    if (message.delivery) {
      if (!connected) return;
      const payload = message.delivery;
      const listeners = payload.__vibestudioBridgeStream ? streams : envelopes;
      for (const handler of listeners) handler(payload.__vibestudioBridgeStream ? payload.msg : payload);
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(String(message.value)));
  };
  const listen = (listeners, handler) => { listeners.add(handler); return () => listeners.delete(handler); };
  globalThis.vibestudio = {
    connect: async () => {
      const expectedGeneration = generation;
      const result = await call("connect", []);
      if (expectedGeneration !== generation) throw fail();
      connected = true;
      return result;
    },
    disconnect: async () => { generation++; connected = false; await call("disconnect", []); },
    onDisconnect: handler => listen(disconnected, handler),
    postEnvelope: envelope => send("postEnvelope", [envelope]),
    onEnvelope: handler => listen(envelopes, handler),
    streamChunkFormat: "base64",
    streamOpen: message => send("streamOpen", [message]),
    streamBodyChunk: message => send("streamBodyChunk", [message]),
    streamAbort: opId => { void send("streamAbort", [opId]).catch(() => {}); },
    streamAck: (opId, seq) => { void send("streamAck", [opId, seq]).catch(() => {}); },
    onStreamMessage: handler => listen(streams, handler),
  };
})();true;
`;
