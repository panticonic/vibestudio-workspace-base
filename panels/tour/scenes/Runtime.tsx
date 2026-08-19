import { useCallback, useEffect, useState } from "react";
import { rpc } from "@workspace/runtime";
import { Tangle } from "../lib/Tangle";
import { Figure, SceneFrame } from "../lib/Scene";

function mb(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`;
}
function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

interface HostPerformanceSnapshot {
  sampledAt: number;
  process: { rssBytes: number; uptimeMs: number };
  workerd: {
    rssBytes: number | null;
    rssPeakBytes: number | null;
    uptimeMs: number | null;
    regularWorkers: number;
    doServices: number;
    doObjectBuilds: number;
    runtimeImages: number;
  } | null;
}

type Measurement =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; snapshot: HostPerformanceSnapshot; isolates: number; perIsolateMb: number | null }
  | { state: "failed"; error: string };

export function Runtime() {
  const [agents, setAgents] = useState(12);
  const [measured, setMeasured] = useState<Measurement>({ state: "idle" });
  const measure = useCallback(async () => {
    setMeasured({ state: "loading" });
    try {
      const snapshot = await rpc.call<HostPerformanceSnapshot>("main", "hostPerformance.snapshot", [{}]);
      const w = snapshot.workerd;
      const isolates = w ? w.regularWorkers + w.doServices : 0;
      const perIsolateMb =
        w?.rssBytes && isolates > 0 ? w.rssBytes / isolates / (1024 * 1024) : null;
      setMeasured({ state: "ready", snapshot, isolates, perIsolateMb });
    } catch (error) {
      setMeasured({ state: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  useEffect(() => {
    void measure();
  }, [measure]);
  const [containerMem, setContainerMem] = useState(250);
  const [containerStart, setContainerStart] = useState(1500);
  const [isolateMem, setIsolateMem] = useState(5);
  const [isolateStart, setIsolateStart] = useState(5);

  const cMem = agents * containerMem;
  const iMem = agents * isolateMem;
  const cStart = containerStart; // environments start in parallel; wall-clock is per env
  const iStart = isolateStart;
  const memMax = Math.max(cMem, iMem, 1);
  const startMax = Math.max(cStart, iStart, 1);

  return (
    <SceneFrame
      eyebrow="08 · Runtime & builds"
      title={
        <>
          No container per agent. <em>Isolates</em> and <em>webviews</em>.
        </>
      }
      lede={
        <>
          Userland runs in the sandboxes browsers and edge runtimes already have: panels are webviews, workers
          and agents are V8 isolates in workerd. One TypeScript toolchain builds both, on demand, into a
          content-addressed store. No Docker, no VM, no image to pull. A laptop runs it; a phone pairs to it.
        </>
      }
    >
      <Figure
        caption={
          <>
            The defaults are rough placeholders. Drag them to your own numbers. The point is not a benchmark:
            it's that a sandbox per task, per subagent, per panel is cheap enough not to think about.
          </>
        }
      >
        <p className="prose" style={{ fontSize: 18, lineHeight: 1.7, margin: 0 }}>
          Say{" "}
          <Tangle value={agents} min={1} max={200} onChange={setAgents} label="Number of agents" /> agents are
          working, each in its own sandboxed environment. A container per environment at around{" "}
          <Tangle value={containerMem} min={50} max={2000} step={10} onChange={setContainerMem} format={mb} label="Memory per container" />{" "}
          and{" "}
          <Tangle value={containerStart} min={100} max={10000} step={100} onChange={setContainerStart} format={ms} label="Container cold start" />{" "}
          to start costs <strong>{mb(cMem)}</strong>. An isolate per environment at around{" "}
          <Tangle value={isolateMem} min={1} max={50} onChange={setIsolateMem} format={mb} label="Memory per isolate" />{" "}
          and{" "}
          <Tangle value={isolateStart} min={1} max={200} onChange={setIsolateStart} format={ms} label="Isolate cold start" />{" "}
          costs <strong>{mb(iMem)}</strong> — about{" "}
          <strong>{(cMem / Math.max(iMem, 1)).toFixed(0)}×</strong> less memory and{" "}
          <strong>{(cStart / Math.max(iStart, 1)).toFixed(0)}×</strong> faster to ready.
        </p>
        <div style={{ display: "grid", gap: 10, marginTop: 18, fontSize: 13 }}>
          <div className="box__sub">Memory for {agents} environments</div>
          <BarRow label="containers" value={cMem} max={memMax} text={mb(cMem)} alt />
          <BarRow label="isolates" value={iMem} max={memMax} text={mb(iMem)} />
          <div className="box__sub" style={{ marginTop: 6 }}>Time until an environment is ready</div>
          <BarRow label="containers" value={cStart} max={startMax} text={ms(cStart)} alt />
          <BarRow label="isolates" value={iStart} max={startMax} text={ms(iStart)} />
        </div>
      </Figure>

      <Figure
        caption={
          <>
            Read from <code>hostPerformance.snapshot</code>, a read-only host method. One workerd process hosts
            every worker, Durable Object and agent in this workspace. Its memory divided by the isolates it
            hosts is an upper bound per isolate, since it includes the runtime itself.
          </>
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <div className="box__title">Measured on this host, right now</div>
          <button type="button" className="btn btn--ghost" onClick={measure} disabled={measured.state === "loading"}>
            {measured.state === "loading" ? "Measuring…" : "Measure again"}
          </button>
          {measured.state === "ready" && measured.perIsolateMb !== null ? (
            <button
              type="button"
              className="btn"
              onClick={() => setIsolateMem(Math.max(1, Math.min(50, Math.round(measured.perIsolateMb ?? 5))))}
            >
              Use {measured.perIsolateMb.toFixed(1)} MB per isolate above
            </button>
          ) : null}
        </div>
        {measured.state === "ready" ? (
          <dl className="kv">
            <dt>workerd process</dt>
            <dd>
              {measured.snapshot.workerd?.rssBytes != null ? mb(measured.snapshot.workerd.rssBytes / (1024 * 1024)) : "n/a"} resident
              {measured.snapshot.workerd?.rssPeakBytes != null
                ? ` · peak ${mb(measured.snapshot.workerd.rssPeakBytes / (1024 * 1024))}`
                : ""}
              {measured.snapshot.workerd?.uptimeMs != null
                ? ` · up ${Math.round(measured.snapshot.workerd.uptimeMs / 60000)} min`
                : ""}
            </dd>
            <dt>isolates hosted</dt>
            <dd>
              {measured.isolates} ({measured.snapshot.workerd?.regularWorkers ?? 0} workers ·{" "}
              {measured.snapshot.workerd?.doServices ?? 0} Durable Object services ·{" "}
              {measured.snapshot.workerd?.runtimeImages ?? 0} runtime images)
            </dd>
            <dt>≈ per isolate</dt>
            <dd>{measured.perIsolateMb !== null ? `${measured.perIsolateMb.toFixed(1)} MB (upper bound)` : "n/a — no isolates yet"}</dd>
            <dt>workspace server</dt>
            <dd>
              {mb(measured.snapshot.process.rssBytes / (1024 * 1024))} resident · up{" "}
              {Math.round(measured.snapshot.process.uptimeMs / 60000)} min
            </dd>
          </dl>
        ) : measured.state === "failed" ? (
          <div className="box__sub">Couldn't read host performance: {measured.error}</div>
        ) : (
          <div className="box__sub">Measuring…</div>
        )}
      </Figure>

      <div className="scene__grid">
        <div className="box">
          <div className="box__title">Builds</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
            <li>Run from the exact working head of a context, so unpublished code can be tried before commit.</li>
            <li>Keyed by content. Artifacts are disposable projections in a content-addressed store.</li>
            <li>Publication builds and typechecks the exact candidate before main advances.</li>
            <li>A bad build keeps the last runnable artifact live.</li>
          </ul>
        </div>
        <div className="box">
          <div className="box__title">What that buys</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
            <li>Edit, rebuild, and the panel you're looking at updates in seconds.</li>
            <li>A subagent gets a context, an isolate and a channel, not a machine.</li>
            <li>Every app gets a SQLite database through its Durable Object.</li>
            <li>One language and one module graph for UI, services and agents.</li>
          </ul>
        </div>
      </div>
    </SceneFrame>
  );
}

function BarRow({ label, value, max, text, alt }: { label: string; value: number; max: number; text: string; alt?: boolean }) {
  const width = `${Math.max(1, (value / max) * 100)}%`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 80px", alignItems: "center", gap: 10 }}>
      <span className="box__sub">{label}</span>
      <div style={{ background: "var(--gray-a3)", borderRadius: 7 }}>
        <div className={`bar${alt ? " bar--alt" : ""}`} style={{ width }} />
      </div>
      <span className="mono" style={{ textAlign: "right" }}>{text}</span>
    </div>
  );
}
