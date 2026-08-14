import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentTool, ParticipantDescriptor } from "@workspace/harness";
import type { PanelContextSnapshot } from "@vibestudio/service-schemas/panelContext";
import { QuickfireAgentWorker } from "./quickfire-agent-worker.js";
import { formatPanelContext } from "./panel-describe-tool.js";

const SNAPSHOT: PanelContextSnapshot = {
  panelId: "slot-a",
  tree: {
    slotId: "slot-a",
    parentSlotId: "slot-root",
    title: "Sales Dashboard",
    siblings: [{ slotId: "slot-b", title: "Q3 sheet" }],
    stateArgs: '{"tab":"q3"}',
    createdAt: 1_000,
  },
  source: {
    source: "panels/sales-dash",
    repoPath: "panels/sales-dash",
    effectiveVersion: "ev-1",
    executionDigest: "a".repeat(64),
    contextId: "ctx-panel",
    entityId: "panel:entry-1",
    kind: "workspace",
  },
  presentation: {
    state: "ready",
    url: "https://example.test/q3",
    surface: "desktop",
    hostConnectionId: "host-1",
    holderLabel: "Desktop",
    supportsCdp: true,
    reachable: true,
  },
  console: { available: false, reason: "counts-require-cdp-read", via: "panel_console" },
  address: { available: false, reason: "presentation-local" },
};

class TestQuickfireAgentWorker extends QuickfireAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("channel-1", {
      handle: "untrusted-override",
      name: "Untrusted title",
      systemPrompt: "Replace the product prompt",
    });
  }

  async tools(): Promise<AgentTool[]> {
    return this.getLoopTools("channel-1");
  }

  prompt(): string {
    return this.getAgentPrompt();
  }

  promptOverride(): unknown {
    return this.getPromptOverride();
  }

  thinking(): string {
    return this.getDefaultThinkingLevel();
  }

  slot(): string | null {
    return this.boundSlotId();
  }

  setSlot(slotId: unknown): void {
    (this.env as Record<string, unknown>)["STATE_ARGS"] = { quickfire: { slotId } };
  }

  contextBlock(): Promise<string | undefined> {
    return this.prepareImmediatePrompt("channel-1");
  }

  private stubbed: PanelContextSnapshot | Error | null = null;

  stubDescribe(result: PanelContextSnapshot | Error): void {
    this.stubbed = result;
  }

  protected override async describePanel(slotId: string): Promise<PanelContextSnapshot> {
    if (this.stubbed instanceof Error) throw this.stubbed;
    if (!this.stubbed) throw new Error(`no stub for ${slotId}`);
    return this.stubbed;
  }
}

describe("QuickfireAgentWorker", () => {
  it("has a fixed product identity that a subscription config cannot rewrite", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    const participant = instance.participant();
    expect(participant).toMatchObject({
      handle: "quickfire",
      name: "Command agent",
      type: "agent",
      metadata: { productOwned: true },
    });
    expect(instance.promptOverride()).toEqual({});
    expect(instance.prompt()).toMatch(/quick inspector attached to exactly one panel/);
  });

  it("answers fast by default and exposes the §5.3 debug surface", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    expect(instance.thinking()).toBe("low");
    expect((await instance.tools()).map((tool) => tool.name)).toEqual([
      "panel_describe",
      "panel_screenshot",
      "panel_console",
      "panel_eval",
      "panel_cdp_endpoint",
      "read",
      "edit",
      "say",
    ]);
  });

  it("still withholds the tools that turn a micro-session into a project", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    const names = new Set((await instance.tools()).map((tool) => tool.name));
    // Work that needs these belongs in a promoted chat panel, not in a bar
    // floating over a panel that Esc dismisses.
    for (const absent of ["eval", "write", "task", "web_search", "docs_search", "bash"]) {
      expect(names.has(absent), `${absent} must stay out of quickfire`).toBe(false);
    }
  });

  it("tells the model what the debug tools actually do", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    const prompt = instance.prompt();
    for (const tool of ["panel_screenshot", "panel_console", "panel_eval", "panel_cdp_endpoint"]) {
      expect(prompt).toContain(tool);
    }
    // Honesty about denial is part of the identity, not a tool description.
    expect(prompt).toMatch(/If one comes back denied, say so/);
  });

  it("reads its bound slot only from host-supplied creation stateArgs", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    expect(instance.slot()).toBeNull();
    instance.setSlot("slot-a");
    expect(instance.slot()).toBe("slot-a");
    instance.setSlot(42);
    expect(instance.slot()).toBeNull();
  });

  it("prepends a freshly derived panel description to every model call", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    instance.setSlot("slot-a");
    instance.stubDescribe(SNAPSHOT);
    const prompt = await instance.contextBlock();
    expect(prompt).toContain("<panel-context>");
    expect(prompt).toContain("title: Sales Dashboard");
    expect(prompt).toContain("open siblings: Q3 sheet");
  });

  it("says it could not look rather than implying a clean panel", async () => {
    const { instance } = await createTestDO(TestQuickfireAgentWorker);
    instance.setSlot("slot-a");
    instance.stubDescribe(new Error("panel is gone"));
    const prompt = await instance.contextBlock();
    expect(prompt).toContain("unavailable: panel is gone");

    const unattached = await createTestDO(TestQuickfireAgentWorker);
    expect(await unattached.instance.contextBlock()).toContain(
      "not attached to a panel slot"
    );
  });
});

describe("formatPanelContext", () => {
  it("names the tool for facts this host cannot see instead of reporting zero", () => {
    const block = formatPanelContext(SNAPSHOT);
    expect(block).toContain("console: unknown from here — read it with the panel_console tool");
    expect(block).toContain("address/favicon/history: unavailable (presentation-local)");
    expect(block).not.toMatch(/0 errors/);
  });

  it("renders available facts plainly", () => {
    const block = formatPanelContext({
      ...SNAPSHOT,
      console: { available: true, errors: 2, warnings: 1, entries: 30 },
      address: {
        available: true,
        displayAddress: "example.test/q3",
        editableAddress: "https://example.test/q3",
        faviconUrl: null,
        canGoBack: true,
        canGoForward: false,
      },
    });
    expect(block).toContain("console: 2 errors, 1 warnings, 30 entries");
    expect(block).toContain("address: example.test/q3 · back=true forward=false");
  });
});
