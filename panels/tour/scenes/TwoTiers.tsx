import { useState } from "react";
import { Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";

type UnitKind = "panel" | "worker" | "extension" | "app";

const UNITS: Record<
  UnitKind,
  { title: string; dir: string; runsIn: string; trust: "sandboxed" | "trusted"; reach: string }
> = {
  panel: {
    title: "Panel",
    dir: "panels/*",
    runsIn: "An isolated webview. Talks to the server over WebSocket RPC.",
    trust: "sandboxed",
    reach: "Renders UI. Every side effect is an RPC to the host, checked like any other caller.",
  },
  worker: {
    title: "Workers",
    dir: "workers/*",
    runsIn: "Workerd V8 isolates. Each Durable Object owns its own SQLite. Agents are also DOs — the agent engine runs in-process, with its eval tool in a separate isolate.",
    trust: "sandboxed",
    reach: "Server-side logic, durable state, and agents. Agents reach exactly what any other DO can, through the same gates. No special privileges.",
  },
  extension: {
    title: "Extension",
    dir: "extensions/*",
    runsIn: "A forked Node process with full native access.",
    trust: "trusted",
    reach: "Native dependencies and long-lived services. Crosses the trust boundary, so install and update get stricter review.",
  },
  app: {
    title: "App",
    dir: "apps/*",
    runsIn: "A trusted client runtime: the Electron shell, a signed React Native bundle, or a terminal artifact.",
    trust: "trusted",
    reach: "Client software for desktop, phone, or terminal. Approved as an exact unit.",
  },
};

const HOST_DUTIES = [
  ["Identity & pairing", "tokens, device credentials"],
  ["Permissions", "grants, approval prompts"],
  ["Credentials", "storage + injection at egress"],
  ["Build system", "build, type check, resolve internal code"],
  ["Workspace state", "shared data and per-agent versions"],
  ["Supervision", "manage / limit compute and storage"],
] as const;

export function TwoTiers() {
  const [selected, setSelected] = useState<UnitKind>("worker");
  const [agentLens, setAgentLens] = useState(false);
  const unit = UNITS[selected];

  return (
    <SceneFrame
      eyebrow="03 · Topology"
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
          <p>Agents can write and change any of it. Safety comes from the boundary, not from limits on what they write.</p>
        </>
      }
    >
      <div className="scene__grid" style={{ gridTemplateColumns: "minmax(200px, 1fr) minmax(320px, 3fr)" }}>
        <Figure caption="This is the entire host. If something isn't on this list, it lives in userland.">
          <div className="wall" style={{ paddingLeft: 10 }}>
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
              Click a unit kind. Trust follows the declared package and its review, not the folder.
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
              const dim = agentLens && u.trust === "trusted";
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
              <dd>{agentLens && selected !== "worker" ? `${unit.reach} An agent reaches this only through the same typed calls.` : unit.reach}</dd>
            </dl>
            {agentLens ? (
              <p className="box__sub" style={{ marginTop: 10, marginBottom: 0 }}>
                “What can the agent do?” reduces to “what can this caller do through the permission system?”
                Trusted units (amber) are reached through typed calls, never by running code inside them.
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
