import { AgentWorkerBase, type AgentToolExecutionContext } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import { createRpcFs } from "@workspace/runtime/worker";
import { QUICKFIRE_AGENT_PROMPT } from "./prompts.js";
import { createPanelDescribeTool, formatPanelContext } from "./panel-describe-tool.js";
import {
  createPanelCdpEndpointTool,
  createPanelConsoleTool,
  createPanelEvalTool,
  createPanelScreenshotTool,
} from "./panel-debug-tools.js";

/** Mutations are attributed to a bound trajectory invocation or they do not run. */
function requireBoundMutationInvocation(): never {
  throw new Error("A semantic mutation requires a bound trajectory invocation command id");
}

const QUICKFIRE_PARTICIPANT_METHOD_NAMES = [
  "pause",
  "resume",
  "getAgentSettings",
  "setModel",
  "setThinkingLevel",
  "getDebugState",
] as const;
const QUICKFIRE_PARTICIPANT_METHODS = new Set<string>(QUICKFIRE_PARTICIPANT_METHOD_NAMES);

/**
 * The panel-scoped micro-session agent behind the shell's quickfire overlay
 * (quickfire-overlay-spec §5).
 *
 * It is a thin configuration of the standard harness, not a new agent kind:
 * the identity prompt, a low default thinking level (the whole point is that it
 * answers before the user's attention moves), a deliberately tiny tool surface,
 * and one addition — a freshly derived `<panel-context>` block on every model
 * call.
 *
 * That block goes through `prepareImmediatePrompt`, not the system prompt: it
 * is volatile per-call state, and putting it in the cached system prompt would
 * both break provider prompt-cache keys and make the model reason about a
 * stale panel. Re-describe, never diff (the SA0 principle, scoped to one slot).
 */
export class QuickfireAgentWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  constructor(ctx: ConstructorParameters<typeof AgentWorkerBase>[0], env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Command agent");
  }

  /**
   * The panel slot this conversation is bound to, from the host-supplied
   * creation stateArgs. The host is the only writer: quickfire entities are
   * created by the `quickfire` service, never by a caller naming coordinates.
   */
  protected boundSlotId(): string | null {
    const stateArgs = this.env["STATE_ARGS"];
    const quickfire =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["quickfire"]
        : null;
    const slotId =
      quickfire && typeof quickfire === "object"
        ? (quickfire as Record<string, unknown>)["slotId"]
        : null;
    return typeof slotId === "string" && slotId.length > 0 ? slotId : null;
  }

  protected override getParticipantInfo(
    _channelId: string,
    _config?: unknown
  ): ParticipantDescriptor {
    return {
      handle: "quickfire",
      name: "Command agent",
      type: "agent",
      metadata: { productOwned: true },
      methods: this.getStandardAgentMethods({ include: QUICKFIRE_PARTICIPANT_METHOD_NAMES }),
    };
  }

  protected override isParticipantMethodEnabled(methodName: string): boolean {
    return QUICKFIRE_PARTICIPANT_METHODS.has(methodName);
  }

  /** Answer speed is the product. Deeper work belongs in a promoted chat panel. */
  protected override getDefaultThinkingLevel(): ReturnType<
    AgentWorkerBase["getDefaultThinkingLevel"]
  > {
    return "low";
  }

  protected override getAgentPrompt(): string {
    return QUICKFIRE_AGENT_PROMPT;
  }

  /** Product-owned identity: a subscription cannot rewrite who this agent is. */
  protected override getPromptOverride(): Record<string, never> {
    return {};
  }

  protected override async loadPromptResources(): Promise<Record<string, never>> {
    return {};
  }

  protected override includeMemoryRecallTool(): boolean {
    return false;
  }

  /**
   * Prepend the current panel description to every model call. Failure is
   * reported inside the block rather than thrown: a quickfire turn that cannot
   * read its panel is still a usable conversation, and the model needs to know
   * the difference between "no console errors" and "I could not look".
   */
  protected override async prepareImmediatePrompt(
    channelId: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const inherited = await super.prepareImmediatePrompt(channelId, signal);
    const slotId = this.boundSlotId();
    const block = slotId
      ? await this.panelContextBlock(slotId)
      : "<panel-context>\nunavailable: this conversation is not attached to a panel slot\n</panel-context>";
    return [block, inherited].filter(Boolean).join("\n\n");
  }

  /** Seam: the one server read this agent performs outside its tool surface. */
  protected describePanel(
    slotId: string
  ): Promise<import("@vibestudio/service-schemas/panelContext").PanelContextSnapshot> {
    return this.rpc.call("main", "panelContext.describe", [slotId]);
  }

  private async panelContextBlock(slotId: string): Promise<string> {
    try {
      return formatPanelContext(await this.describePanel(slotId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `<panel-context>\nslot: ${slotId}\nunavailable: ${reason}\n</panel-context>`;
    }
  }

  /**
   * The §5.3 tool surface: look at the panel, poke it, make a small fix, speak.
   *
   * The CDP tools are prompt-free on an ordinary panel because of the reviewed
   * closure and the grants the host mints when the user opens quickfire over
   * that panel (§6) — not because anything here is privileged. Source read/edit
   * are the standard harness tools, which is what "scoped to the panel's unit
   * path" already means in practice: `fs` reads and `vcs` writes are sandboxed
   * by the host to this conversation's context, and that context is the panel's.
   *
   * Everything else the standard harness offers — spawning subagents, eval,
   * web, docs search — is deliberately still absent. Work that needs those is
   * work that belongs in a promoted chat panel.
   */
  protected override async getLoopTools(
    channelId: string,
    execution?: AgentToolExecutionContext
  ): Promise<AgentTool[]> {
    const { createReadTool, createEditTool, createToolVcs, createAgentFileVisibility } =
      await import("@workspace/harness/standard-tools");
    const toolRpc = execution?.rpc ?? this.rpc;
    const fs = createRpcFs(toolRpc as never);
    const callMain = <T>(method: string, args: unknown[]) => toolRpc.call<T>("main", method, args);
    const boundPanelId = this.boundSlotId();
    const cwd = "/";
    const visibility = createAgentFileVisibility(cwd, fs);
    const vcs = createToolVcs(callMain);
    const contextId = () => this.subscriptions.getContextId(channelId);
    // A semantic mutation is only ever attributed to a real invocation. The
    // registry is also built without one (to expose schemas), so the check is
    // deferred to the moment an edit actually executes.
    const mutationContext = {
      contextId,
      commandId: execution?.commandId ?? requireBoundMutationInvocation,
    };
    return [
      createPanelDescribeTool(callMain, boundPanelId),
      createPanelScreenshotTool(callMain, boundPanelId),
      createPanelConsoleTool(callMain, boundPanelId),
      createPanelEvalTool(callMain, boundPanelId),
      createPanelCdpEndpointTool(callMain, boundPanelId),
      createReadTool(cwd, fs, {
        rpc: toolRpc,
        provenance: { vcs, context: { contextId } },
        visibility,
      }),
      createEditTool(cwd, vcs, mutationContext, fs),
      this.createNotifyTool(channelId, fs),
    ];
  }
}
