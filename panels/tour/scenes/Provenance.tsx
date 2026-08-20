import { useState } from "react";
import { Choices, Figure, SceneFrame } from "../lib/Scene";
import { LiveLink } from "../lib/live";

type Walk = "cause" | "cohort" | "rejections";

interface WalkRow {
  kind: string;
  text: string;
  human?: boolean;
}

interface Line {
  text: string;
  cause: WalkRow[];
  cohort: WalkRow[];
  rejections: WalkRow[];
}

/* An illustrative record: the shape of what the provenance tool returns for a
   managed file — artifact → change → work unit → command → invocation → turn →
   the human statement that started it. */
const FILE = "workers/report-store/src/retry.ts";
const LINES: Line[] = [
  {
    text: "export const MAX_BACKOFF_MS = 30_000;",
    cause: [
      { kind: "change · edit", text: "MAX_BACKOFF_MS 120_000 → 30_000" },
      { kind: "work unit", text: "cap retry backoff for the deploy target" },
      { kind: "command", text: "apply_patch (1 file) · intent: “deploy target kills idle connections”" },
      { kind: "invocation", text: "tool call #r7-1c9a in turn 14" },
      { kind: "turn", text: "assistant, after reading the deploy notes" },
      { kind: "message · human", text: "“cap the backoff at 30s, the long waits keep dying”", human: true },
    ],
    cohort: [
      { kind: "same work unit", text: "src/retry.ts:12 — KEEPALIVE_MS 60_000 → 20_000" },
      { kind: "same work unit", text: "src/upload.ts:40 — chunk timeout 90s → 25s" },
      { kind: "same turn", text: "projects/default/notes/deploy.md — appended a caveat" },
    ],
    rejections: [
      { kind: "counteracted", text: "turn 9 raised MAX_BACKOFF_MS to 300_000 — undone in turn 11 (“no, the deploy target can't hold that”)", human: true },
    ],
  },
  {
    text: "export const KEEPALIVE_MS = 20_000;",
    cause: [
      { kind: "change · edit", text: "KEEPALIVE_MS 60_000 → 20_000" },
      { kind: "work unit", text: "cap retry backoff for the deploy target" },
      { kind: "command", text: "apply_patch (1 file)" },
      { kind: "invocation", text: "tool call #r7-1c9a in turn 14" },
      { kind: "message · human", text: "“cap the backoff at 30s, the long waits keep dying”", human: true },
    ],
    cohort: [
      { kind: "same work unit", text: "src/retry.ts:3 — MAX_BACKOFF_MS 120_000 → 30_000" },
      { kind: "same work unit", text: "src/upload.ts:40 — chunk timeout 90s → 25s" },
    ],
    rejections: [{ kind: "—", text: "nothing counteracted at this coordinate" }],
  },
  {
    text: "",
    cause: [],
    cohort: [],
    rejections: [],
  },
  {
    text: "export function nextDelay(attempt: number): number {",
    cause: [
      { kind: "change · create", text: "file created with nextDelay()" },
      { kind: "work unit", text: "initial retry helper" },
      { kind: "command", text: "write" },
      { kind: "invocation", text: "tool call #r3-11ab in turn 4" },
      { kind: "message · human", text: "“add exponential backoff to the report fetcher”", human: true },
    ],
    cohort: [
      { kind: "same turn", text: "src/index.ts — wired nextDelay into fetchReport()" },
      { kind: "same turn", text: "src/retry.test.ts — created" },
    ],
    rejections: [{ kind: "—", text: "nothing counteracted at this coordinate" }],
  },
  {
    text: "  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);",
    cause: [
      { kind: "change · edit", text: "base 1_000 → 500" },
      { kind: "work unit", text: "faster first retry" },
      { kind: "command", text: "edit · intent: “first retry should be sub-second”" },
      { kind: "invocation", text: "tool call #r5-9e0d in turn 8" },
      { kind: "message · human", text: "“the first retry feels slow”", human: true },
    ],
    cohort: [{ kind: "same work unit", text: "src/retry.test.ts — expectation 1000 → 500" }],
    rejections: [
      { kind: "superseded external delta", text: "an imported snapshot set the base to 2_000; declined at integration (“we measured, 500 is fine”)", human: true },
    ],
  },
  {
    text: "}",
    cause: [
      { kind: "change · create", text: "file created with nextDelay()" },
      { kind: "message · human", text: "“add exponential backoff to the report fetcher”", human: true },
    ],
    cohort: [],
    rejections: [],
  },
];

export function Provenance() {
  const [line, setLine] = useState(0);
  const [walk, setWalk] = useState<Walk>("cause");
  const selected = LINES[line]!;
  const rows = selected[walk];

  return (
    <SceneFrame
      eyebrow="07 · Provenance & VCS"
      title={
        <>
          A semantic <em>git blame</em> for agentic work
        </>
      }
      lede={
        <>
          <p>
            Agents produce code, but they also need to understand existing code before changing it.
            Managed source tracks semantic history — a structured record of intent, not just file diffs.
            Each edit, move, copy, and merge decision is linked to:
          </p>
          <ul>
            <li>the tool call that made it</li>
            <li>the turn it happened in</li>
            <li>the human message behind it</li>
          </ul>
          <p>This gives agents memory across sessions: the reasoning behind existing code is always recoverable.</p>
        </>
      }
    >
      <div className="scene__grid" style={{ gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1fr)" }}>
        <Figure caption={<>Click a line. (Illustrative record for <code>{FILE}</code>.)</>}>
          <div className="box__sub mono" style={{ marginBottom: 8 }}>{FILE}</div>
          <pre className="code">
            {LINES.map((l, i) =>
              l.text === "" ? (
                <span key={i} className="code__line" aria-hidden="true">{" "}</span>
              ) : (
                <button
                  key={i}
                  type="button"
                  className="code__line"
                  aria-pressed={line === i}
                  onClick={() => setLine(i)}
                >
                  <span style={{ opacity: 0.45, display: "inline-block", width: 22 }}>{i + 1}</span>
                  {l.text}
                </button>
              )
            )}
          </pre>
          <div style={{ marginTop: 12 }}>
            <Choices
              value={walk}
              onChange={setWalk}
              label="Provenance walk"
              options={[
                { value: "cause", label: "cause — what was attempted?" },
                { value: "cohort", label: "cohort — what else, under that intent?" },
                { value: "rejections", label: "rejections — what was tried and undone?" },
              ]}
            />
          </div>
        </Figure>

        <Figure
          caption={
            <>
              One call: <code>provenance({"{"} target, walk: "{walk}" {"}"})</code>. Intent first, mechanics
              after. Where the record ends — a subagent brief, an import, something outside view — it says
              so rather than guessing.
            </>
          }
        >
          <div className="box__title" style={{ marginBottom: 8 }}>
            line {line + 1} · {walk}
          </div>
          {rows.length === 0 ? (
            <div className="box__sub">Nothing recorded under this walk for the selected line.</div>
          ) : (
            <div className="walk">
              {rows.map((row, i) => (
                <div key={i} className={`walk__row${row.human ? " walk__row--human" : ""}`}>
                  <div className="walk__kind">{row.kind}</div>
                  <div className="walk__text">{row.text}</div>
                </div>
              ))}
            </div>
          )}
        </Figure>
      </div>

      <Figure
        caption="Merging works by coordinate and net effect, not by replaying edits. Two contexts that touched the same file reconcile by what changed, not who typed first."
      >
        <div className="flow flow--wrap">
          <div className="step step--done">
            <div className="step__title">Contexts</div>
            <div className="step__body">Each agent works in its own context with a working head and a committed boundary.</div>
          </div>
          <div className="step step--done">
            <div className="step__title">Commit</div>
            <div className="step__body">Turns the local chain into one event. No partial commits.</div>
          </div>
          <div className="step step--done">
            <div className="step__title">Net-effect merge</div>
            <div className="step__body">Per coordinate. Conflicts become recorded decisions with reasons — provenance later surfaces these as rejections.</div>
          </div>
          <div className="step step--done">
            <div className="step__title">Protected main</div>
            <div className="step__body">Advances only with approval, after the exact candidate builds and typechecks. Git is a projection.</div>
          </div>
        </div>
      </Figure>
      <LiveLink
        source="about/workspace-history"
        label="See it live: Workspace history"
        hint="This workspace's real history, including the commit that added this deck."
      />
    </SceneFrame>
  );
}
