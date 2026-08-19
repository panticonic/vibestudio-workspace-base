import { useState } from "react";
import { Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";

type UnitKind = "panel" | "worker" | "extension" | "app" | "agent";

const UNITS: Record<
  UnitKind,
  { title: string; dir: string; runsIn: string; trust: "sandboxed" | "trusted"; reach: string }
> = {
  panel: {
    title: "Panel",
    dir: "panels/*",
    runsIn: "An isolated webview. Talks to the server over WebSocket RPC.",
    trust: "sandboxed",
    reach: "Renders UI. Every effect is an RPC to the host, checked like any other caller's.",
  },
  worker: {
    title: "Worker / Durable Object",
    dir: "workers/*",
    runsIn: "A workerd V8 isolate. A DO owns its own SQLite (this.sql) — the app-database primitive.",
    trust: "sandboxed",
    reach: "Server-side logic and durable state. Offers services by protocol. Never touches the host process.",
  },
  agent: {
    title: "Agent",
    dir: "workers/agent-worker",
    runsIn: "Also a Durable Object: the coding-agent engine (Pi) runs in-process inside an isolate. Its eval tool runs in its own EvalDO.",
    trust: "sandboxed",
    reach: "Exactly what any DO can reach, through the same gates. No special privileges.",
  },
  extension: {
    title: "Extension",
    dir: "extensions/*",
    runsIn: "A forked Node process with full Node access.",
    trust: "trusted",
    reach: "Native dependencies and long-lived services. Crosses the trust line, so install and update get a stricter review.",
  },
  app: {
    title: "App",
    dir: "apps/*",
    runsIn: "A trusted client runtime: the Electron shell view, a signed React Native bundle, or a terminal artifact.",
    trust: "trusted",
    reach: "Client software for desktop, phone or terminal. Approved as an exact unit.",
  },
};

const HOST_DUTIES = [
  ["Identity & pairing", "tokens, device credentials"],
  ["Permissions", "grants, approval prompts"],
  ["Credentials", "storage + injection at egress"],
  ["Protected main", "approval-gated compare-and-swap"],
  ["Builds & blobs", "content-addressed stores"],
  ["Disk projection", "materializing contexts"],
  ["Supervision", "workerd, extensions, webviews"],
] as const;

export function TwoTiers() {
  const [selected, setSelected] = useState<UnitKind>("agent");
  const [agentLens, setAgentLens] = useState(false);
  const unit = UNITS[selected];

  return (
    <SceneFrame
      eyebrow="02 · Topology"
      title={
        <>
          A small <em>host</em>, a large <em>userland</em>
        </>
      }
      lede={
        <>
          <p>The host never runs workspace code in its own process. Everything under the workspace root is source:</p>
          <ul>
            <li>panels and apps</li>
            <li>workers and Durable Objects</li>
            <li>extensions</li>
            <li>the agents themselves</li>
          </ul>
          <p>Agents can write any of it. The boundary keeps that safe, not limits on what they write.</p>
        </>
      }
    >
      <div className="scene__grid" style={{ gridTemplateColumns: "minmax(200px, 1fr) minmax(320px, 3fr)" }}>
        <Figure caption="The whole host. If it isn't on this list, it lives in userland.">
          <div className="wall" style={{ paddingLeft: 10 }}>
          <div className="box__title" style={{ marginBottom: 2 }}>Trusted host</div>
          <div className="box__sub mono" style={{ marginBottom: 10 }}>electron shell · workspace server</div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {HOST_DUTIES.map(([k, v]) => (
              <li key={k}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{k}</div>
                <div className="box__sub">{v}</div>
              </li>
            ))}
          </ul>
          </div>
        </Figure>

        <Figure
          caption={
            <>
              Click a unit kind. Trust comes from the declared package and its review, not from the folder.
            </>
          }
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="box__title">Userland</div>
            <label className="box__sub" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={agentLens}
                onChange={(event) => setAgentLens(event.target.checked)}
              />
              Show what an agent can reach
            </label>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: 8,
              marginTop: 10,
            }}
          >
            {(Object.keys(UNITS) as UnitKind[]).map((kind) => {
              const u = UNITS[kind];
              const dim = agentLens && kind !== "agent" && u.trust === "trusted";
              return (
                <button
                  key={kind}
                  type="button"
                  className={`box${selected === kind ? " box--hot" : ""}${dim ? " box--muted" : ""}`}
                  style={{ cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}
                  aria-pressed={selected === kind}
                  onClick={() => setSelected(kind)}
                >
                  <div className="box__title">{u.title}</div>
                  <div className="box__sub mono">{u.dir}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className={`tag ${u.trust === "trusted" ? "tag--warn" : "tag--good"}`}>{u.trust}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="box" style={{ marginTop: 12 }}>
            <div className="box__title">
              {unit.title} <span className="tag">{unit.dir}</span>
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Runs in</dt>
              <dd>{unit.runsIn}</dd>
              <dt>Reach</dt>
              <dd>{agentLens && selected !== "agent" ? `${unit.reach} An agent reaches this only through the same typed calls.` : unit.reach}</dd>
            </dl>
            {agentLens ? (
              <p className="box__sub" style={{ marginTop: 10, marginBottom: 0 }}>
                “What can the agent do?” is always “what can this caller do through the permission system?”
                Trusted units (amber) are reached through typed receivers, never by running inside them.
              </p>
            ) : null}
          </div>
        </Figure>
      </div>
      <LiveLink
        source="about/permissions"
        label="See it live: Permissions"
        hint="The real grant ledger. Opening it is a gated effect, so expect an approval card the first time."
      />
    </SceneFrame>
  );
}
