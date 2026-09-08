import type { RpcClient, RpcCallOptions, RpcStreamOptions } from "@vibestudio/rpc";

/** The small, portable conversation surface used by connected applications.
 * It deliberately delegates to the workspace's existing channel service: the
 * channel log remains the conversation store and the channel stream remains
 * the model/agent delivery path. */
export interface ConversationClient {
  history(channelId: string, options?: RpcCallOptions): Promise<unknown>;
  send(channelId: string, text: string, options?: Record<string, unknown>): Promise<unknown>;
  subscribe(
    channelId: string,
    participantId: string,
    metadata: Record<string, unknown>,
    onRecord: (record: unknown) => void | Promise<void>,
    options?: RpcStreamOptions,
  ): Promise<void>;
}

export function createConversationClient(rpc: RpcClient): ConversationClient {
  const resolve = async (channelId: string, options?: RpcCallOptions) => {
    const service = await rpc.call<{ kind: string; targetId?: string }>(
      "main",
      "workers.resolveService",
      ["vibestudio.channel.v1", channelId],
      options,
    );
    if (service.kind !== "durable-object" || !service.targetId) {
      throw new Error("Channel service must resolve to a Durable Object RPC target");
    }
    return service.targetId;
  };

  return {
    history: async (channelId, options) => {
      const target = await resolve(channelId, options);
      return rpc.call(target, "getReplayAfter", [{ after: 0 }], options);
    },
    send: async (channelId, text, options) => {
      const target = await resolve(channelId, options);
      return rpc.call(target, "sendAsCaller", [text, options ?? {}]);
    },
    subscribe: async (channelId, participantId, metadata, onRecord, options) => {
      const target = await resolve(channelId, options);
      const response = await rpc.stream(
        target,
        "subscribe",
        [participantId, metadata],
        options,
      );
      if (!response.body) throw new Error("Conversation subscription returned no body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline < 0) break;
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line) await onRecord(JSON.parse(line));
          }
        }
        pending += decoder.decode();
        if (pending.trim()) await onRecord(JSON.parse(pending));
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
  };
}
