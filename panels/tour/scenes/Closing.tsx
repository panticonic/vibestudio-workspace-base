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
          <p>A small host holds the keys and the gates. Everything else is source you own, in one place — apps, services, agents, and the UI they produce.</p>
          <ul>
            <li>Versioned with its reasons</li>
            <li>Built in seconds</li>
            <li>Run in lightweight sandboxes</li>
            <li>Changeable while you use it</li>
          </ul>
        </>
      }
    >
      <div className="claims" role="list">
        {[
          ["tiers", "Topology", "Small host, large userland. Agents are ordinary callers."],
          ["authority", "Authority", "Open, gated, critical — grants follow decisions, not roles."],
          ["credentials", "Credentials", "Held by the host, bound to an audience, attached at egress."],
          ["continuum", "The continuum", "Build, reshape, embed, and just-in-time UI — one substrate."],
          ["automations", "Automations", "Proposed by agents, approved by you, with exact scope."],
          ["provenance", "Provenance & VCS", "Semantic history, net-effect merges, protected main."],
          ["runtime", "Runtime & builds", "Isolates and webviews. One toolchain, no containers."],
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
