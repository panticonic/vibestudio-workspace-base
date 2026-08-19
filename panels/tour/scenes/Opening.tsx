import { VibestudioLogo } from "@workspace/ui/brand";
import { SceneFrame } from "../lib/Scene";

export interface OpeningProps {
  goTo: (sceneId: string) => void;
}

const CLAIMS = [
  {
    id: "tiers",
    title: "A small host, a large sandbox",
    body: "The host holds keys and gates. Everything else, agents included, runs in isolates and webviews.",
  },
  {
    id: "credentials",
    title: "Agents never see credentials",
    body: "The host keeps them, bound to one audience, and attaches them only on the way out.",
  },
  {
    id: "continuum",
    title: "Apps and conversations blend",
    body: "An agent builds an app, you reshape it, agents work inside it, UI shows up in the chat. One substrate.",
  },
  {
    id: "runtime",
    title: "No containers",
    body: "Webviews and V8 isolates, one TypeScript toolchain, builds in seconds.",
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
            An <em>integrated</em> personal software environment
          </span>
        </span>
      }
      lede={
        <>
          <p>One environment where these live together, built and changed in place:</p>
          <ul>
            <li>your apps</li>
            <li>your agents</li>
            <li>your automations</li>
            <li>your data and its history</li>
          </ul>
          <p>
            Agents can write software now. What's hard is running it without handing them your keys, and
            changing the software you're using while you're using it. Vibestudio is built around those two
            problems.
          </p>
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
