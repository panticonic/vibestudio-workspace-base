import { useCallback, useState } from "react";
import { panel } from "@workspace/runtime";
import { Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";

const ANCHORS = [
  {
    title: "An agent builds an app",
    mechanism: "createProjects · runtime builds · Durable Object SQLite · semantic VCS publish",
    body: "You describe what you want. The agent scaffolds a panel and a worker, the build runs, and the panel opens. Data lives in a Durable Object, source in the workspace VCS, and publishing to main requires approval.",
  },
  {
    title: "You reshape it while using it",
    mechanism: "Quickfire conversation on any panel · context-local edits · rebuild in place · provenance",
    body: "Every panel has its own command conversation. Say “make this sortable” — the agent edits the source in its context, rebuilds, and the panel you’re looking at updates. The history records why each change happened.",
  },
  {
    title: "Agents live inside the app",
    mechanism: "channel DO · agent worker DO · useAgentState / parent.state() · participant methods as tools",
    body: "An app can embed agents as participants: a channel, a worker running the model, and the panel exposing its state so the agent sees what you see. The app's own functions become tools, behind the same gates.",
  },
  {
    title: "Agents reach the app's data directly",
    mechanism: "DO SQL queries · managed file reads · VCS context access · authority-gated, no user present",
    body: "An agent can query a Durable Object's SQLite or read managed files without the user being present. The same authority gates apply — but the data is accessible, not locked behind a UI.",
  },
  {
    title: "UI appears inside the conversation",
    mechanism: "inline_ui · skills shipping TSX · exposeModules · persistent transcript components",
    body: "The agent writes a component and renders it into the transcript — a setup form, a chart, a review card. It persists there with state as part of the conversation. Skills ship components; panels expose modules for them.",
  },
] as const;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

const RESHAPE_PROMPT =
  "Add a short scene to panels/tour after “The continuum” that explains one thing this audience cares about, then rebuild this panel so I can present it.";

export function Continuum() {
  const [t, setT] = useState(1.0);
  const [ask, setAsk] = useState<"idle" | "opening" | "opened" | "unavailable">("idle");
  const [askDetail, setAskDetail] = useState<string | null>(null);
  const askAgent = useCallback(async () => {
    setAsk("opening");
    try {
      await panel.openCommandAgent({ prompt: RESHAPE_PROMPT });
      setAsk("opened");
    } catch (error) {
      setAsk("unavailable");
      setAskDetail(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const anchor = Math.min(ANCHORS.length - 1, Math.round(t));
  const current = ANCHORS[anchor]!;

  // App/chat proportions along the continuum (5 anchors: 0–4).
  const appShare = t <= 1 ? 1 : t <= 2 ? lerp(1, 0.58, t - 1) : t <= 3 ? lerp(0.58, 0.4, t - 2) : lerp(0.4, 0, t - 3);
  const chatShare = 1 - appShare;
  const showQuickfire = t >= 0.5 && t < 2.2;
  const bubbles = Math.max(0, Math.round(lerp(0, 4, Math.min(1, Math.max(0, (t - 1.2) / 2.3)))));
  const inlineWidgets = t >= 3.4 ? Math.round(lerp(0, 2, Math.min(1, (t - 3.4) / 0.6))) : 0;
  const widgets = Math.max(0, Math.round(lerp(6, 2, Math.min(1, Math.max(0, (t - 1) / 3)))));

  const columns =
    appShare <= 0.02
      ? "minmax(0, 1fr)"
      : chatShare <= 0.02
        ? "minmax(0, 1fr)"
        : `minmax(0, ${appShare.toFixed(2)}fr) minmax(0, ${chatShare.toFixed(2)}fr)`;

  return (
    <SceneFrame
      eyebrow="02 · The continuum"
      title={
        <>
          No boundary between your agents and your <em>software</em>
        </>
      }
      lede={
        <>
          Building an app, reshaping it while you use it, embedding agents inside it, agents reading its
          data on their own, and UI appearing in the conversation — these blur into one continuum. Same
          source, same VCS, same authority at every point.
        </>
      }
    >
      <Figure
        caption={
          <>
            Drag the slider. One substrate — same source, VCS, builds, channels, and authority — so these
            aren't separate features, they're points on a continuum.
          </>
        }
      >
        <div style={{ display: "grid", gap: 14 }}>
          <input
            className="slider"
            type="range"
            min={0}
            max={4}
            step={0.01}
            value={t}
            onChange={(event) => setT(Number(event.target.value))}
            aria-label="Position on the continuum"
            aria-valuetext={current.title}
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: 6,
              fontSize: 12.5,
            }}
          >
            {ANCHORS.map((a, i) => (
              <button
                key={a.title}
                type="button"
                className="choice"
                aria-pressed={anchor === i}
                onClick={() => setT(i)}
                style={{ textAlign: "center", borderRadius: 10 }}
              >
                {a.title}
              </button>
            ))}
          </div>

          <div className="scene__grid" style={{ gridTemplateColumns: "minmax(260px, 1.1fr) minmax(260px, 1fr)" }}>
            <div className="mock" aria-hidden="true">
              <div className="mock__bar">
                <span className="mock__dot" />
                <span className="mock__dot" />
                <span className="mock__dot" />
                <span style={{ marginLeft: 6 }}>
                  {appShare > 0.02 ? "panels/task-board" : "panels/chat"}
                </span>
              </div>
              <div className="mock__body" style={{ gridTemplateColumns: columns }}>
                {appShare > 0.02 ? (
                  <div className="mock__app">
                    <div style={{ fontSize: 11, color: "var(--tour-hot-ink)", fontWeight: 600 }}>Task board</div>
                    {Array.from({ length: widgets }).map((_, i) => (
                      <div key={i} className="mock__widget" style={{ width: `${100 - (i % 3) * 18}%` }} />
                    ))}
                    {showQuickfire ? (
                      <div className="mock__quickfire">
                        <span>⌘ make this sortable…</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {chatShare > 0.02 ? (
                  <div className="mock__chat">
                    {Array.from({ length: Math.max(1, bubbles) }).map((_, i) => (
                      <div key={i} className={`mock__bubble${i % 2 === 0 ? " mock__bubble--user" : ""}`}>
                        {i % 2 === 0 ? "Can you show me the overdue ones?" : "Here — sorted by due date."}
                      </div>
                    ))}
                    {Array.from({ length: inlineWidgets }).map((_, i) => (
                      <div key={`w${i}`} className="mock__inline">
                        <span>{i === 0 ? "Overdue tasks · inline component" : "Approve plan · inline form"}</span>
                        <div className="mock__widget" style={{ width: "80%" }} />
                        <div className="mock__widget" style={{ width: "55%" }} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="box" aria-live="polite">
              <div className="box__title">{current.title}</div>
              <div className="box__sub mono" style={{ margin: "6px 0 10px" }}>{current.mechanism}</div>
              <div style={{ fontSize: 14 }}>{current.body}</div>
              {anchor === 1 ? (
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  <button type="button" className="btn" onClick={askAgent} disabled={ask === "opening"}>
                    ⌘ Reshape this deck — open its command conversation
                  </button>
                  <span className="box__sub">
                    {ask === "idle"
                      ? "Opens this panel's real command conversation with a request filled in. You press send."
                      : ask === "opening"
                        ? "Opening…"
                        : ask === "opened"
                          ? "Bound to this deck. Send it, or change it first."
                          : `No command overlay on this host (${askDetail ?? "unavailable"}). On the desktop shell, use the panel's ⌘ button.`}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </Figure>
      <LiveLink
        source="panels/chat"
        label="See it live: open a chat beside this deck"
        hint="Ask for a new scene in panels/tour, then come back and present it."
      />
      <p className="scene__aside">
        This deck is a panel. Ask its agent for a new scene, a different chart, or a ten-minute version. It
        edits <code>panels/tour</code>, rebuilds, and you present the result.
      </p>
    </SceneFrame>
  );
}
