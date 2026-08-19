/**
 * "Take it with you" — the deck's own deep links, generated live.
 *
 * Two link families, one idea: a panel with state
 * (`vibestudio://panel?…`, `@vibestudio/shared/panelLocation`) and a shell
 * surface (`vibestudio://ask|about|command?…`, `@vibestudio/shared/shellSurface`).
 * Each row can also be opened from inside the session through
 * `panel.openShellSurface`, gated by what this host reports it can open.
 */
import { useEffect, useMemo, useState } from "react";
import { panel } from "@workspace/runtime";
import { createPanelDeepLink } from "@vibestudio/shared/panelLocation";
import { createShellSurfaceLink, type ShellSurfaceKind, type ShellSurfaceTarget } from "@vibestudio/shared/shellSurface";

interface Row {
  label: string;
  link: string;
  /** In-session equivalent, when one exists. */
  surface?: ShellSurfaceTarget;
}

export function DeepLinks({ sceneId }: { sceneId: string }) {
  const [supported, setSupported] = useState<ShellSurfaceKind[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    panel
      .describeShellSurfaces()
      .then((result) => setSupported(result.surfaces))
      .catch(() => setSupported([]));
  }, []);

  const rows = useMemo<Row[]>(() => {
    const ask: ShellSurfaceTarget = {
      kind: "command-agent",
      panelId: panel.slotId,
      mode: "quickfire",
      prompt: "Make a two-minute version of this deck.",
    };
    const about: ShellSurfaceTarget = { kind: "about", page: "permissions" };
    const next: ShellSurfaceTarget = { kind: "panel-command", panelId: panel.slotId, commandId: "tour-next" };
    return [
      {
        label: "This scene",
        link: createPanelDeepLink({ source: "panels/tour", stateArgs: { scene: sceneId }, focus: true }),
      },
      { label: "Ask this deck's agent", link: createShellSurfaceLink(ask), surface: ask },
      { label: "Open Permissions", link: createShellSurfaceLink(about), surface: about },
      { label: "Next scene (a panel command)", link: createShellSurfaceLink(next), surface: next },
    ];
  }, [sceneId]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied.");
    } catch {
      setStatus("Clipboard isn't available here — select the text instead.");
    }
  };
  const open = async (target: ShellSurfaceTarget) => {
    try {
      await panel.openShellSurface(target);
      setStatus("Opened through app.openShellSurface.");
    } catch (error) {
      setStatus(`Couldn't open: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((row) => {
        const canOpen =
          row.surface !== undefined &&
          supported !== null &&
          supported.includes(typeof row.surface === "string" ? row.surface : row.surface.kind);
        return (
          <div key={row.label} className="box" style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="box__title">{row.label}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn--ghost" onClick={() => copy(row.link)}>
                Copy link
              </button>
              {row.surface ? (
                <button type="button" className="btn" disabled={!canOpen} onClick={() => row.surface && open(row.surface)}
                  title={canOpen ? "Open it here, through app.openShellSurface" : "This host reports it cannot open this surface"}>
                  Open here
                </button>
              ) : null}
            </div>
            <input
              readOnly
              className="mono"
              value={row.link}
              onFocus={(event) => event.currentTarget.select()}
              aria-label={`${row.label} deep link`}
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--tour-line)",
                background: "var(--gray-a2)",
                color: "var(--tour-muted)",
                boxSizing: "border-box",
              }}
            />
          </div>
        );
      })}
      <div className="box__sub" aria-live="polite" style={{ minHeight: 18 }}>
        {status ??
          (supported === null
            ? "Asking the host what it can open…"
            : supported.length === 0
              ? "No shell chrome on this host. Follow the links from a desktop shell."
              : `This host can open: ${supported.join(", ")}.`)}
      </div>
    </div>
  );
}
