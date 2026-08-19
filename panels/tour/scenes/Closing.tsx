import { Figure, SceneFrame } from "../lib/Scene";
import { DeepLinks } from "../lib/DeepLinks";

export interface ClosingProps {
  goTo: (sceneId: string) => void;
}

export function Closing({ goTo }: ClosingProps) {
  return (
    <SceneFrame
      eyebrow="09 · Recap"
      title={
        <>
          One <em>integrated</em> environment: apps, agents, automations, history
        </>
      }
      lede={
        <>
          <p>A small host holds the keys and the gates. Everything else is source you own, in one place: apps, services, agents and the UI they make. It is</p>
          <ul>
            <li>versioned with its reasons</li>
            <li>built in seconds</li>
            <li>run in cheap sandboxes</li>
            <li>changeable while you use it</li>
          </ul>
        </>
      }
    >
      <div className="claims" role="list">
        {[
          ["tiers", "Topology", "Small host, large userland, agents as ordinary callers."],
          ["authority", "Authority", "Open, gated, critical. Grants are decisions."],
          ["credentials", "Credentials", "Held by the host, bound to an audience, attached on the way out."],
          ["continuum", "The continuum", "Build, reshape, embed, just-in-time UI. One substrate."],
          ["automations", "Automations", "Proposed by agents, approved by you, exact."],
          ["provenance", "Provenance & VCS", "Semantic history, net-effect merges, protected main."],
          ["runtime", "Runtime & builds", "Isolates and webviews, one toolchain, no containers."],
        ].map(([id, title, body]) => (
          <button key={id} type="button" role="listitem" className="claim" onClick={() => goTo(id!)} aria-label={`Revisit ${title}`}>
            <span className="claim__title">{title}</span>
            <span className="claim__body">{body}</span>
          </button>
        ))}
      </div>
      <Figure
        caption={
          <>
            Generated live from this panel. The first opens a panel with state; the others open shell surfaces.
            “Open here” uses the same targets from inside the session.
          </>
        }
      >
        <div className="box__title" style={{ marginBottom: 10 }}>Deep links</div>
        <DeepLinks sceneId="closing" />
      </Figure>
      <p className="scene__aside">
        Want it different for the next audience? Ask the deck's agent.
      </p>
    </SceneFrame>
  );
}
