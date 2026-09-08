import type { RuntimeConnectionInfo, WorkspaceProvider } from "@vibestudio/rpc";

export interface NativeWebsiteRequest {
  target: number;
  documentId: string;
  origin: string;
  requestId: string;
  method: string;
  argsJson: string;
}

interface Document {
  id: string;
  origin: string;
  runtimeId: string;
  executionId?: string;
  connected: boolean;
  admission?: Promise<unknown>;
  pending?: Promise<Awaited<ReturnType<WorkspaceProvider["connect"]>>>;
}

/** Native frame evidence enters here; page-provided RPC never selects a host principal. */
export class WebsiteDocumentHost {
  private documents = new Map<string, Document>();
  constructor(
    private readonly deps: {
      runtimeId(panelId: string): string;
      bootstrap(panelId: string): Promise<RuntimeConnectionInfo>;
      hosting(
        method: "begin" | "connect" | "end",
        input: unknown,
      ): Promise<unknown>;
      relay(panelId: string, method: string, args: unknown[]): Promise<unknown>;
      closeRelay(panelId: string): void;
      disconnected(panelId: string, documentId: string): void;
      executionId(): string;
    },
  ) {}

  async request(
    panelId: string,
    request: NativeWebsiteRequest,
  ): Promise<unknown> {
    const origin = new URL(request.origin);
    if (!/^https?:$/.test(origin.protocol) || origin.origin !== request.origin)
      throw new Error("Invalid native website origin");
    let doc = this.documents.get(panelId);
    if (request.method === "retire") {
      if (doc?.id === request.documentId) await this.retire(panelId);
      return;
    }
    if (!doc || doc.id !== request.documentId) {
      if (request.method !== "connect")
        throw new Error("Connect this website to the workspace first");
      const retiring = this.retire(panelId);
      doc = {
        id: request.documentId,
        origin: request.origin,
        runtimeId: this.deps.runtimeId(panelId),
        connected: false,
      };
      this.documents.set(panelId, doc);
      await retiring;
      this.assertCurrent(panelId, doc);
    }
    if (
      doc.origin !== request.origin ||
      doc.runtimeId !== this.deps.runtimeId(panelId)
    )
      throw new Error("Website document ownership changed");
    if (request.method === "disconnect") {
      await this.retire(panelId);
      return;
    }
    if (request.method === "connect") return this.connect(panelId, doc);
    if (!doc.connected)
      throw new Error("Connect this website to the workspace first");
    const args: unknown = JSON.parse(request.argsJson);
    if (!Array.isArray(args))
      throw new Error("Invalid website bridge arguments");
    const result = await this.deps.relay(panelId, request.method, args);
    this.assertCurrent(panelId, doc);
    return result;
  }

  private connect(panelId: string, doc: Document) {
    if (doc.pending) return doc.pending;
    const executionId =
      doc.connected && doc.executionId
        ? doc.executionId
        : this.deps.executionId();
    doc.executionId = executionId;
    const input = { runtimeId: doc.runtimeId, documentId: executionId };
    doc.pending = (async () => {
      if (!doc.connected) {
        doc.admission = this.deps.hosting("begin", {
          ...input,
          origin: doc.origin,
        });
        await doc.admission;
        this.assertCurrent(panelId, doc);
        const allowed = await this.deps.hosting("connect", input);
        this.assertCurrent(panelId, doc);
        if (allowed !== true)
          throw new Error("Workspace connection was declined");
      }
      const bootstrap = await this.deps.bootstrap(panelId);
      this.assertCurrent(panelId, doc);
      if (bootstrap.runtimeId !== doc.runtimeId)
        throw new Error("Website runtime changed");
      doc.connected = true;
      return { documentId: executionId, origin: doc.origin, bootstrap };
    })().finally(() => {
      doc.pending = undefined;
    });
    return doc.pending;
  }

  private assertCurrent(panelId: string, doc: Document) {
    if (
      this.documents.get(panelId) !== doc ||
      this.deps.runtimeId(panelId) !== doc.runtimeId
    )
      throw new Error("Website document was retired");
  }

  async retire(panelId: string): Promise<void> {
    const doc = this.documents.get(panelId);
    if (!doc) return;
    this.documents.delete(panelId);
    doc.connected = false;
    this.deps.closeRelay(panelId);
    this.deps.disconnected(panelId, doc.id);
    await doc.admission?.catch(() => {});
    if (doc.executionId)
      await this.deps.hosting("end", {
        runtimeId: doc.runtimeId,
        documentId: doc.executionId,
      });
  }

  delivery(panelId: string, payload: unknown): unknown {
    const doc = this.documents.get(panelId);
    return doc?.connected
      ? { __vibestudioWebsiteDocument: doc.id, delivery: payload }
      : null;
  }

  async changed(change: {
    runtimeId: string;
    documentId: string;
    connected: boolean;
  }) {
    if (change.connected) return;
    for (const [panelId, doc] of this.documents) {
      if (
        doc.runtimeId === change.runtimeId &&
        doc.executionId === change.documentId
      )
        await this.retire(panelId);
    }
  }
}
