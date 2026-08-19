/** Scene order, titles and presenter notes for the Vibestudio Tour. */

export interface SceneMeta {
  id: string;
  title: string;
  /** Talking points shown in the presenter-notes drawer (press N). */
  notes: string[];
}

export const DECK: readonly SceneMeta[] = [
  {
    id: "opening",
    title: "An integrated personal software environment",
    notes: [
      "Thesis: one environment for apps, agents, automations and data. Software is cheap now; trust and changeability are what's hard.",
      "Everything dotted-underlined is live. Drag, click, flip — invite the audience to ask for a number.",
      "This deck is a panel in the workspace. We'll come back to why that matters.",
      "Press F for presentation mode, ? for keys.",
    ],
  },
  {
    id: "tiers",
    title: "Host and userland",
    notes: [
      "The host's list is the whole host. Everything else is userland — including the agents.",
      "Trust follows declared identity and review, not folder position.",
      "Flip the agent lens: an agent reaches exactly what any DO reaches, through the same gates.",
    ],
  },
  {
    id: "authority",
    title: "Authority",
    notes: [
      "Tokens authenticate, decisions authorize. Userland can render a prompt but can't approve itself.",
      "Press Run and let it travel; it only stops where a human is needed. Run it twice with a version grant, then edit the source — the grant no longer matches.",
      "See it live opens the real Permissions ledger — itself a gated effect.",
      "Critical effects (cross-context read, publish to main) never get standing grants.",
      "Missions wait for a human decision outside their closure — there is no timeout.",
    ],
  },
  {
    id: "credentials",
    title: "Credentials",
    notes: [
      "Contrast: secrets in the agent's env (OpenClaw-style) vs. secrets in the host, audience-bound.",
      "Press the lure: prompt injection on the left exfiltrates; on the right there is nothing to leak.",
      "Content integrity latch: reading outside content parks standing authority until reviewed.",
    ],
  },
  {
    id: "continuum",
    title: "The continuum",
    notes: [
      "This is the product idea. Drag slowly from left to right and narrate each anchor.",
      "One substrate: same source, VCS, builds, channels and authority at every point.",
      "Proof by example: at the ‘reshape’ anchor, press ‘Reshape this deck’ — the real Quickfire overlay opens bound to this panel with the request pre-filled. Send it, keep presenting, come back.",
    ],
  },
  {
    id: "automations",
    title: "Automations",
    notes: [
      "Edit the sentence live; the closure on the right is what the user reviews.",
      "Drafts are inert; only the user approves. One request → one definition.",
      "Three forms: agent prompt, inline eval (no model call), DO method.",
    ],
  },
  {
    id: "provenance",
    title: "Provenance & VCS",
    notes: [
      "Click lines; switch walks. Cause → cohort → rejections is the abduction pattern.",
      "Rejections are the strongest evidence: a human said no.",
      "Semantic VCS: net-effect merge by coordinate; Git is a projection; main is protected.",
    ],
  },
  {
    id: "runtime",
    title: "Runtime & builds",
    notes: [
      "The measured card reads hostPerformance.snapshot live: workerd RSS ÷ isolates hosted. Press ‘Use … per isolate’ to put the real number into the sentence.",
      "The sentence defaults are order-of-magnitude; drag to your own measurements before making a claim.",
      "The point: a sandbox per task/subagent/panel is a non-decision.",
      "Builds from the exact working head; activation fails closed.",
    ],
  },
  {
    id: "closing",
    title: "Recap",
    notes: ["Land the phrase: an integrated personal software environment. Small host, explicit authority, software you can change while you use it.", "Offer: change the deck for the next audience."],
  },
];

export function sceneIndex(id: string | undefined): number {
  if (!id) return 0;
  const index = DECK.findIndex((scene) => scene.id === id);
  return index < 0 ? 0 : index;
}
