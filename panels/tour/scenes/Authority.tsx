import { useEffect, useMemo, useState } from "react";
import { Choices, Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";

type Caller = "user" | "agent" | "worker" | "mission";
type Effect = "read-own" | "read-other" | "fetch-cred" | "open-external" | "publish-main";
type Tier = "open" | "gated" | "critical";
type Durability = "once" | "session" | "version";

const CALLERS: { value: Caller; label: string; principals: string }[] = [
  { value: "user", label: "You, in a panel", principals: "user + code" },
  { value: "agent", label: "An agent, via eval", principals: "code + session" },
  { value: "worker", label: "A worker DO", principals: "code" },
  { value: "mission", label: "An unattended mission run", principals: "mission + code" },
];

const EFFECTS: { value: Effect; label: string; tier: Tier; receiver: string; resource: string }[] = [
  { value: "read-own", label: "Read a file in its own context", tier: "open", receiver: "fs.read", resource: "context:<own>" },
  { value: "read-other", label: "Read a file in another context", tier: "critical", receiver: "fs.read · context.boundary", resource: "context:<other>" },
  { value: "fetch-cred", label: "Call api.github.com with your GitHub credential", tier: "gated", receiver: "credentials.fetch", resource: "audience:api.github.com" },
  { value: "open-external", label: "Open a URL in the system browser", tier: "gated", receiver: "external.open", resource: "https://…" },
  { value: "publish-main", label: "Publish a commit to protected main", tier: "critical", receiver: "vcs.push · protected publication", resource: "repo:panels/tour@main" },
];

type Stage = "idle" | "receiver" | "lookup" | "prompt" | "effect";
type Outcome = "allowed" | "denied" | "waiting";

interface GrantRow {
  durability: Exclude<Durability, "once">;
  sessionNo: number;
  version: number;
}

export function Authority() {
  const [caller, setCaller] = useState<Caller>("agent");
  const [effect, setEffect] = useState<Effect>("fetch-cred");
  const [stage, setStage] = useState<Stage>("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [grants, setGrants] = useState<Record<string, GrantRow>>({});
  const [sessionNo, setSessionNo] = useState(1);
  const [version, setVersion] = useState(1);
  const [log, setLog] = useState<string[]>([]);

  const spec = EFFECTS.find((e) => e.value === effect)!;
  const callerSpec = CALLERS.find((c) => c.value === caller)!;
  const grantKey = `${caller}:${effect}`;
  const grant = grants[grantKey];
  const liveGrant = useMemo(() => {
    if (!grant) return null;
    if (grant.durability === "session" && grant.sessionNo !== sessionNo) return null;
    if (grant.durability === "version" && grant.version !== version) return null;
    return grant;
  }, [grant, sessionNo, version]);
  const missionClosureCovers = caller === "mission" && (effect === "read-own" || effect === "fetch-cred");

  const reset = () => {
    setStage("idle");
    setOutcome(null);
  };
  const pushLog = (line: string) => setLog((l) => [line, ...l].slice(0, 6));

  const run = () => {
    setOutcome(null);
    setStage("receiver");
  };
  const advance = () => {
    if (stage === "receiver") {
      if (spec.tier === "open") {
        setStage("effect");
        setOutcome("allowed");
        pushLog(`${callerSpec.label}: ${spec.receiver} → open method, allowed.`);
      } else {
        setStage("lookup");
      }
      return;
    }
    if (stage === "lookup") {
      if (spec.tier === "gated" && (liveGrant || missionClosureCovers)) {
        setStage("effect");
        setOutcome("allowed");
        pushLog(
          liveGrant
            ? `${callerSpec.label}: ${spec.receiver} → ${liveGrant.durability} grant matched, allowed.`
            : `${callerSpec.label}: ${spec.receiver} → covered by the mission's reviewed closure, allowed.`
        );
      } else {
        setStage("prompt");
        if (caller === "mission") setOutcome("waiting");
      }
      return;
    }
  };
  // The call travels on its own: each intermediate stage holds for a beat so
  // the audience can read it, then moves on. It only stops where a human is
  // actually needed — the decision — or at the effect.
  useEffect(() => {
    if (stage !== "receiver" && stage !== "lookup") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(advance, reduced ? 0 : 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);
  const decide = (choice: Durability | "deny") => {
    if (choice === "deny") {
      setStage("effect");
      setOutcome("denied");
      pushLog(`${callerSpec.label}: ${spec.receiver} → denied by you. Terminal for this invocation.`);
      return;
    }
    if (choice !== "once") {
      setGrants((g) => ({ ...g, [grantKey]: { durability: choice, sessionNo, version } }));
    }
    setStage("effect");
    setOutcome("allowed");
    pushLog(
      `${callerSpec.label}: ${spec.receiver} → approved (${choice}${choice === "once" ? ", nothing stored" : ", grant stored"}).`
    );
  };

  const stageClass = (s: Stage, index: number) => {
    const order: Stage[] = ["receiver", "lookup", "prompt", "effect"];
    const current = order.indexOf(stage);
    if (stage === "idle") return "step step--pending";
    if (index < current) return "step step--done";
    if (index === current) {
      if (s === "effect" && outcome === "denied") return "step step--blocked";
      return "step step--active";
    }
    return "step step--pending";
  };
  const skipsLookup = spec.tier === "open";

  return (
    <SceneFrame
      eyebrow="03 · Authority"
      title={
        <>
          Tokens say who. Decisions say <em>what</em>.
        </>
      }
      lede={
        <>
          <p>A token identifies the caller and grants nothing. The host decides each effect from:</p>
          <ul>
            <li>who is calling</li>
            <li>which exact code</li>
            <li>in which session</li>
            <li>on which resource</li>
          </ul>
          <p>Userland can show a prompt. It cannot approve itself.</p>
        </>
      }
    >
      <Figure
        caption={
          <>
            Simplified, but this is the shape: <strong>open</strong> needs no grant, <strong>gated</strong> needs
            a stored grant matching the unit's declared request, <strong>critical</strong> needs a fresh decision
            every time.
          </>
        }
      >
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <div className="box__sub">Caller</div>
            <Choices value={caller} options={CALLERS} onChange={(c) => { setCaller(c); reset(); }} label="Caller" />
            <div className="box__sub" style={{ marginTop: 4 }}>Wants to</div>
            <Choices value={effect} options={EFFECTS} onChange={(e) => { setEffect(e); reset(); }} label="Effect" />
          </div>

          <div className="flow flow--wrap">
            <div className={stageClass("receiver", 0)}>
              <div className="step__title">
                1 · Receiver contract <span className={`tag ${spec.tier === "open" ? "" : spec.tier === "gated" ? "tag--hot" : "tag--bad"}`}>{spec.tier}</span>
              </div>
              <div className="step__body">
                <span className="mono">{spec.receiver}</span>
                <br />
                principals: {callerSpec.principals}
                <br />
                resource: <span className="mono">{spec.resource}</span>
              </div>
            </div>
            <div className={skipsLookup ? "step step--pending" : stageClass("lookup", 1)}>
              <div className="step__title">2 · Grant store</div>
              <div className="step__body">
                {skipsLookup
                  ? "Skipped — open methods don't consult it."
                  : spec.tier === "critical"
                    ? "Critical: no standing grant can exist here."
                    : missionClosureCovers
                      ? "Covered by the mission's reviewed closure."
                      : liveGrant
                        ? `Live ${liveGrant.durability} grant for this exact code${liveGrant.durability === "version" ? ` (v${liveGrant.version})` : ` (session ${liveGrant.sessionNo})`}.`
                        : grant
                          ? `A ${grant.durability} grant exists but no longer matches (${grant.durability === "version" ? `code is now v${version}` : `session ended`}).`
                          : "No matching grant."}
              </div>
            </div>
            <div className={skipsLookup ? "step step--pending" : stageClass("prompt", 2)}>
              <div className="step__title">3 · Decision</div>
              <div className="step__body">
                {stage === "prompt" ? (
                  caller === "mission" ? (
                    <>
                      Nobody is watching this run, so it <strong>waits</strong> for a human. No timeout, no
                      auto-approve. Standing authority comes only from a reviewed revision of the mission.
                      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        <button type="button" className="btn" onClick={() => decide("once")}>Owner approves later</button>
                        <button type="button" className="btn btn--ghost" onClick={() => decide("deny")}>Owner denies</button>
                      </div>
                    </>
                  ) : (
                    <>
                      The card names the caller, the code digest, the resource and the tier.
                      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        <button type="button" className="btn" onClick={() => decide("once")}>Allow once</button>
                        {spec.tier === "gated" ? (
                          <>
                            <button type="button" className="btn" onClick={() => decide("session")}>Allow this session</button>
                            <button type="button" className="btn" onClick={() => decide("version")}>Allow this version</button>
                          </>
                        ) : null}
                        <button type="button" className="btn btn--ghost" onClick={() => decide("deny")}>Deny</button>
                      </div>
                    </>
                  )
                ) : (
                  "A fresh human decision, when the store can't answer."
                )}
              </div>
            </div>
            <div className={stageClass("effect", 3)}>
              <div className="step__title">
                4 · Effect{" "}
                {outcome === "allowed" ? <span className="tag tag--good">performed</span> : null}
                {outcome === "denied" ? <span className="tag tag--bad">denied</span> : null}
                {outcome === "waiting" && stage === "prompt" ? <span className="tag tag--warn">waiting</span> : null}
              </div>
              <div className="step__body">
                {effect === "publish-main" && outcome === "allowed"
                  ? "Main advanced after the gate checked ancestry, integration and the exact candidate build."
                  : "The host performs the effect. Userland never holds the authority itself."}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {stage === "idle" || stage === "effect" ? (
              <button type="button" className="btn" onClick={run}>
                {stage === "effect" ? "Run again" : "Run"}
              </button>
            ) : (
              <button type="button" className="btn" disabled>
                {stage === "prompt" ? "Waiting for a decision…" : "Evaluating…"}
              </button>
            )}
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => { setVersion((v) => v + 1); reset(); }}
              title="Version-bound grants follow the exact execution digest, so editing the source invalidates them."
            >
              Edit the caller's source → v{version + 1}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => { setSessionNo((s) => s + 1); reset(); }}
              title="Session grants survive a host restart but are pruned when the sealed authority session ends."
            >
              End session {sessionNo}
            </button>
            <span className="box__sub">
              code v{version} · session {sessionNo} · {Object.keys(grants).length} stored grant
              {Object.keys(grants).length === 1 ? "" : "s"}
            </span>
          </div>

          {log.length ? (
            <div className="box" style={{ padding: "8px 12px" }}>
              {log.map((line, i) => (
                <div key={i} className="box__sub mono" style={{ opacity: i === 0 ? 1 : 0.6 }}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Figure>
      <LiveLink
        source="about/permissions"
        label="See it live: the grant ledger"
        hint="The rows you just simulated exist for real in Permissions."
      />
      <p className="scene__aside">
        Grants are rows in one ledger, bound to the repository and exact version that asked. Catalogs, builds
        and docs never create rows. A denial comes with a reason and a remediation, and the remediation is
        never “try another caller.”
      </p>
    </SceneFrame>
  );
}
