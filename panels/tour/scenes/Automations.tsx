import { useEffect, useMemo, useState } from "react";
import { Pick, Tangle } from "../lib/Tangle";
import { Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";
import {
  cadenceToCron,
  describeCadence,
  nextRuns,
  type Cadence,
  type CadenceUnit,
} from "../lib/schedule";

type Form = "prompt" | "eval" | "method";
type Conversation = "fresh" | "continue";

const FORMS: { value: Form; label: string }[] = [
  { value: "prompt", label: "an agent prompt" },
  { value: "eval", label: "an inline eval script" },
  { value: "method", label: "one Durable Object method" },
];
const CONVERSATIONS: { value: Conversation; label: string }[] = [
  { value: "fresh", label: "a fresh conversation" },
  { value: "continue", label: "this exact conversation" },
];
const UNITS: { value: CadenceUnit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

const fmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  day: "numeric",
});

export function Automations() {
  const [form, setForm] = useState<Form>("prompt");
  const [conversation, setConversation] = useState<Conversation>("fresh");
  const [cadence, setCadence] = useState<Cadence>({
    every: 6,
    unit: "hours",
    atHour: 9,
  });
  const [running, setRunning] = useState(true);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const cron = cadenceToCron(cadence);
  const runs = useMemo(() => nextRuns(cadence, now, 3), [cadence, now]);
  const max = cadence.unit === "minutes" ? 59 : cadence.unit === "hours" ? 23 : 30;

  return (
    <SceneFrame
      eyebrow="06 · Automations"
      title={
        <>
          Recurring work starts <em>now</em> and stays inspectable
        </>
      }
      lede={
        <>
          <p>
            An agent launches an automation directly. Its running chat pill shows the exact
            definition and controls:
          </p>
          <ul>
            <li>what runs and where</li>
            <li>on what trigger</li>
            <li>in which conversation</li>
            <li>with what standing authority while nobody is watching</li>
          </ul>
        </>
      }
    >
      <div
        className="scene__grid"
        style={{
          gridTemplateColumns: "minmax(280px, 1.2fr) minmax(260px, 1fr)",
        }}
      >
        <Figure caption="Edit the sentence. The right side is what the running pill exposes.">
          <p className="prose" style={{ fontSize: 19, lineHeight: 1.7, margin: 0 }}>
            Run <Pick value={form} options={FORMS} onChange={setForm} label="Execution form" />{" "}
            every{" "}
            <Tangle
              value={cadence.every}
              min={1}
              max={max}
              onChange={(every) => setCadence((c) => ({ ...c, every }))}
              label="Cadence count"
            />{" "}
            <Pick
              value={cadence.unit}
              options={UNITS}
              onChange={(unit) =>
                setCadence((c) => ({
                  ...c,
                  unit,
                  every: Math.min(c.every, unit === "minutes" ? 59 : unit === "hours" ? 23 : 30),
                }))
              }
              label="Cadence unit"
            />
            {cadence.unit === "days" ? (
              <>
                {" "}
                at{" "}
                <Tangle
                  value={cadence.atHour}
                  min={0}
                  max={23}
                  onChange={(atHour) => setCadence((c) => ({ ...c, atHour }))}
                  format={(h) => `${String(h).padStart(2, "0")}:00`}
                  label="Hour of day"
                />
              </>
            ) : null}
            {form === "prompt" ? (
              <>
                , in{" "}
                <Pick
                  value={conversation}
                  options={CONVERSATIONS}
                  onChange={setConversation}
                  label="Conversation policy"
                />
              </>
            ) : null}
            .
          </p>
          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <button type="button" className="btn" onClick={() => setRunning((value) => !value)}>
              {running ? "Pause automation" : "Resume automation"}
            </button>
            <span className={`tag ${running ? "tag--good" : "tag--warn"}`}>
              {running ? "running" : "paused"}
            </span>
          </div>
          {running ? (
            <div style={{ marginTop: 14 }}>
              <div className="box__sub">Next runs ({describeCadence(cadence)})</div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
                {runs.map((d) => (
                  <li key={d.getTime()}>{fmt.format(d)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="box__sub" style={{ marginTop: 14 }}>
              Pausing preserves the exact definition and history while preventing future ticks.
            </p>
          )}
        </Figure>

        <Figure caption="One request, one definition. Schedule, execution, authority, history and controls live together.">
          <div className="box__title" style={{ marginBottom: 8 }}>
            Mission closure <span className="tag">vibestudio.missions.v1</span>
          </div>
          <dl className="kv">
            <dt>trigger</dt>
            <dd className="mono">cron · {cron}</dd>
            <dt>execution</dt>
            <dd>
              {form === "prompt"
                ? "agent · normal model turn"
                : form === "eval"
                  ? "agent · exact inline eval, no model call"
                  : "method · one RPC on an exact DO build"}
            </dd>
            <dt>target</dt>
            <dd className="mono">
              {form === "method"
                ? "workers/report-store@v14 · ReportDO.refresh"
                : "workers/agent-worker@v31 · this agent"}
            </dd>
            <dt>conversation</dt>
            <dd>
              {form === "prompt"
                ? conversation === "fresh"
                  ? "isolated agent, context and conversation per run"
                  : "continues one exact conversation"
                : "none"}
            </dd>
            <dt>authority</dt>
            <dd>
              the least needed, fixed in the installed definition; a standing deny pauses the
              automation
            </dd>
            <dt>lineage</dt>
            <dd>expected outside-content classes for unattended runs</dd>
            <dt>revision</dt>
            <dd>saving changes atomically installs the next active revision</dd>
          </dl>
        </Figure>
      </div>
      <LiveLink
        source="about/automations"
        label="See it live: Automations"
        hint="Running schedules, exact definitions, runs, conversations and controls."
      />
    </SceneFrame>
  );
}
