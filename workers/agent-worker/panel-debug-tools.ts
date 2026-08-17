/**
 * Configurable panel debugging tools for AiChatWorker.
 *
 * Every tool here is a thin wrapper over an existing, gated `panelCdp` RPC;
 * none creates a privileged path. A launcher may attach exact panel authority
 * through a runtime resource binding, while the host continues to decide
 * whether each requested target is allowed.
 *
 * Each one defaults to the conversation's bound slot and accepts an explicit
 * `panelId` for the rare deliberate cross-panel look; the host decides whether
 * that is allowed, exactly as it does for the bound panel.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

export type CallMain = <T>(method: string, args: unknown[]) => Promise<T>;

const panelTarget = {
  panelId: Type.Optional(
    Type.String({
      description:
        "Panel slot id. Omit to act on the panel this conversation is attached to.",
    })
  ),
};

/* ── panel_screenshot ─────────────────────────────────────────────────── */

const screenshotParameters = Type.Object(
  {
    ...panelTarget,
    format: Type.Optional(
      Type.Union([Type.Literal("png"), Type.Literal("jpeg")], {
        description: "Image format. Defaults to png.",
      })
    ),
  },
  { additionalProperties: false }
);

export type PanelScreenshotParams = Static<typeof screenshotParameters>;

interface PanelScreenshotResult {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export function createPanelScreenshotTool(
  callMain: CallMain,
  boundPanelId: string
): AgentTool<typeof screenshotParameters> {
  return {
    name: "panel_screenshot",
    label: "screenshot panel",
    description:
      "Capture what the panel currently looks like. This force-paints the view, so it works even when the panel is hidden or scrolled off — use it whenever the question is about appearance, layout, or what the user is actually seeing.",
    parameters: screenshotParameters,
    execute: async (
      _toolCallId,
      params: PanelScreenshotParams
    ): Promise<AgentToolResult<PanelScreenshotResult | null>> => {
      const panelId = params.panelId ?? boundPanelId;
      const result = await callMain<PanelScreenshotResult>("panelCdp.screenshot", [
        panelId,
        params.format ? { format: params.format } : {},
      ]);
      return {
        content: [
          { type: "image", data: result.data, mimeType: result.mimeType },
          {
            type: "text",
            text: `Screenshot of ${panelId} (${result.width}×${result.height}).`,
          },
        ],
        details: result,
      };
    },
  };
}

/* ── panel_console ────────────────────────────────────────────────────── */

const consoleParameters = Type.Object(
  {
    ...panelTarget,
    limit: Type.Optional(
      Type.Number({ description: "Maximum console entries to return. Defaults to the host's." })
    ),
    errorsOnly: Type.Optional(
      Type.Boolean({ description: "Return only warnings and errors. Defaults to false." })
    ),
  },
  { additionalProperties: false }
);

export type PanelConsoleParams = Static<typeof consoleParameters>;

interface ConsoleEntry {
  timestamp: number;
  level: string;
  message: string;
  line: number;
  sourceId: string;
  url: string;
}

interface PanelConsoleResult {
  entries: ConsoleEntry[];
  errors: ConsoleEntry[];
  dropped: { entries: number; errors: number };
  capacity: { entries: number; errors: number };
}

function renderEntries(label: string, entries: ConsoleEntry[]): string {
  if (entries.length === 0) return `${label}: (none)`;
  const lines = entries.map(
    (entry) => `  [${entry.level}] ${entry.message}${entry.url ? ` (${entry.url}:${entry.line})` : ""}`
  );
  return `${label}:\n${lines.join("\n")}`;
}

export function createPanelConsoleTool(
  callMain: CallMain,
  boundPanelId: string
): AgentTool<typeof consoleParameters> {
  return {
    name: "panel_console",
    label: "read panel console",
    description:
      "Read the panel's recorded console history — the actual log and error bodies, not counts. This is the first thing to reach for when something is broken and you do not yet know why.",
    parameters: consoleParameters,
    execute: async (
      _toolCallId,
      params: PanelConsoleParams
    ): Promise<AgentToolResult<PanelConsoleResult | null>> => {
      const panelId = params.panelId ?? boundPanelId;
      const result = await callMain<PanelConsoleResult>("panelCdp.consoleHistory", [
        panelId,
        {
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.errorsOnly === true ? { levels: ["warning", "error"] } : {}),
        },
      ]);
      const dropped =
        result.dropped.entries > 0 || result.dropped.errors > 0
          ? `\n(${result.dropped.entries} entries and ${result.dropped.errors} errors were dropped before this read — the history is bounded.)`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `${renderEntries("console", result.entries)}\n\n${renderEntries(
              "errors",
              result.errors
            )}${dropped}`,
          },
        ],
        details: result,
      };
    },
  };
}

/* ── panel_eval ───────────────────────────────────────────────────────── */

const evalParameters = Type.Object(
  {
    ...panelTarget,
    expression: Type.String({
      description:
        "A JavaScript expression evaluated in the panel's page, exactly as a console would. The value is serialized and returned; a promise is awaited.",
    }),
  },
  { additionalProperties: false }
);

/**
 * The loop hands tool params through as a partial of the schema (it validates
 * against the schema itself, not this type), so `expression` is checked here
 * rather than assumed.
 */
export type PanelEvalParams = Partial<Static<typeof evalParameters>>;

interface PanelEvaluateResult {
  ok: boolean;
  type: string;
  value: string | null;
  error: string | null;
  truncated: boolean;
}

export function createPanelEvalTool(
  callMain: CallMain,
  boundPanelId: string
): AgentTool<typeof evalParameters> {
  return {
    name: "panel_eval",
    label: "evaluate in panel",
    description:
      "Run one JavaScript expression inside the panel's page and get the serialized result back — measure an element, read computed style, check a global, call a debug hook. It runs under an 8 second bound; an expression that throws comes back as a reported error rather than a failed tool call. This runs real code in the live page, so prefer reading over mutating.",
    parameters: evalParameters,
    execute: async (
      _toolCallId,
      params: PanelEvalParams
    ): Promise<AgentToolResult<PanelEvaluateResult | null>> => {
      const panelId = params.panelId ?? boundPanelId;
      const expression = params.expression;
      if (typeof expression !== "string" || expression.length === 0) {
        return {
          content: [{ type: "text", text: "panel_eval needs an expression to evaluate." }],
          isError: true,
          details: null,
        };
      }
      const result = await callMain<PanelEvaluateResult>("panelCdp.evaluate", [
        panelId,
        expression,
        {},
      ]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `${result.type}: ${result.error ?? "(no detail)"}` }],
          isError: true,
          details: result,
        };
      }
      const truncated = result.truncated ? "\n(truncated at the host's serialization limit)" : "";
      return {
        content: [
          { type: "text", text: `${result.type}: ${result.value ?? "(no value)"}${truncated}` },
        ],
        details: result,
      };
    },
  };
}

/* ── panel_cdp_endpoint ───────────────────────────────────────────────── */

const cdpEndpointParameters = Type.Object({ ...panelTarget }, { additionalProperties: false });

export type PanelCdpEndpointParams = Static<typeof cdpEndpointParameters>;

interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export function createPanelCdpEndpointTool(
  callMain: CallMain,
  boundPanelId: string
): AgentTool<typeof cdpEndpointParameters> {
  return {
    name: "panel_cdp_endpoint",
    label: "open panel devtools protocol",
    description:
      "Mint a Chrome DevTools Protocol WebSocket endpoint for the panel — the full firehose, for debugging that genuinely needs to drive the protocol (setting breakpoints, stepping, tracing). For looking, measuring, and poking, panel_screenshot / panel_console / panel_eval are faster and cheaper.",
    parameters: cdpEndpointParameters,
    execute: async (
      _toolCallId,
      params: PanelCdpEndpointParams
    ): Promise<AgentToolResult<CdpEndpoint | null>> => {
      const panelId = params.panelId ?? boundPanelId;
      const endpoint = await callMain<CdpEndpoint>("panelCdp.getCdpEndpoint", [panelId]);
      return {
        content: [{ type: "text", text: `CDP endpoint for ${panelId}: ${endpoint.wsEndpoint}` }],
        details: endpoint,
      };
    },
  };
}
