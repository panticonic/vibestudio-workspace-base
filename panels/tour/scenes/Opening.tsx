import { VibestudioLogo } from "@workspace/ui/brand";
import { SceneFrame } from "../lib/Scene";

export interface OpeningProps {
  goTo: (sceneId: string) => void;
}

const CLAIMS = [
  {
    id: "tiers",
    title: "A small host, a large sandbox",
    body: "A thin trusted layer handles keys and gates. Everything else — agents included — runs in isolates and webviews.",
  },
  {
    id: "credentials",
    title: "Agents never see credentials",
    body: "Secrets stay in the host, each bound to a specific service. The agent says where; the host decides whether to attach the key.",
  },
  {
    id: "continuum",
    title: "Apps and conversations blend",
    body: "An agent builds an app, you reshape it mid-use, agents work inside it, and UI shows up right in the conversation — all in the same substrate.",
  },
  {
    id: "runtime",
    title: "No containers",
    body: "Webviews and V8 isolates instead. One TypeScript toolchain, builds in seconds, runs on a laptop.",
  },
];

export function Opening({ goTo }: OpeningProps) {
  return (
    <SceneFrame
      eyebrow="01 · Vibestudio"
      title={
        <span style={{ display: "grid", gap: 18 }}>
          <VibestudioLogo size={64} variant="symbol" />
          <span>
            A <em>personal</em> vibe computer
          </span>
        </span>
      }
      lede={
        <>
          <p>An integrated personal software environment where:</p>
          <ul>
            <li>agents build and customize apps for you</li>
            <li>you can build apps that integrate with your agent</li>
            <li>you control all agent access to sensitive data</li>
            <li>you can customize the entire system</li>
          </ul>
        </>
      }
    >
      <div className="claims" role="list">
        {CLAIMS.map((claim) => (
          <button
            key={claim.id}
            type="button"
            role="listitem"
            className="claim"
            onClick={() => goTo(claim.id)}
            aria-label={`Go to: ${claim.title}`}
          >
            <span className="claim__title">{claim.title}</span>
            <span className="claim__body">{claim.body}</span>
          </button>
        ))}
      </div>
      <p className="scene__aside">
        Dotted numbers drag, dotted words click. This deck is a panel in the workspace:{" "}
        <code>panels/tour</code>.
      </p>
    </SceneFrame>
  );
}
