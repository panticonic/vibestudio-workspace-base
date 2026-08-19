---
name: tour-panel
description: Extend or restyle the Vibestudio Tour deck (panels/tour) — an explorable presentation of the system.
---

# Vibestudio Tour

`panels/tour` is a presentation panel framing Vibestudio as an integrated
personal software environment: one scene at a time, keyboard navigable, with
live widgets (draggable numbers, word pickers, step-through
simulations) instead of bullet points. It explains the host/userland split,
authority, credentials, the build→reshape→embed→JIT-UI continuum, automations,
provenance/VCS, and the containerless runtime.

## Shape

- `deck.ts` — scene order, titles and presenter notes. Scene ids are the
  public contract; `index.tsx` maps ids to components.
- `scenes/*.tsx` — one component per scene, wrapped in `SceneFrame`
  (`lib/Scene.tsx`: eyebrow, title, lede, figures, choice chips).
- `lib/Tangle.tsx` — `Tangle` (draggable number inside prose) and `Pick`
  (clickable word). Use them wherever a claim has a knob the audience might
  want to turn.
- `lib/schedule.ts` — cadence → cron → next runs for the automations scene.
- `tour.css` — all styling; only Radix/foundation tokens, so light/dark and the
  app accent follow the host.

State args `{ scene?: string; notes?: boolean }` hold the current scene and
whether presenter notes are open. The panel persists them so a reopened panel
resumes, and an agent can drive the deck with
`panel.stateArgs.setForPanel(id, { scene: "continuum" })`. Unknown ids fall
back to the opening scene. `useAgentState("tour", …)` exposes the current
position to `parent.state()`.

## Adding a scene

1. Add `{ id, title, notes }` to `DECK` in `deck.ts` at the desired position.
2. Create `scenes/<Name>.tsx` using `SceneFrame`; keep one idea per scene and
   prefer a live figure over prose.
3. Map the id in the `switch` in `index.tsx`. Eyebrows are `"NN · Topic"` and
   must match the rail number.
4. Keep illustrative records labelled as illustrative (see `Provenance.tsx`);
   never present them as live workspace data. Numbers that are placeholders
   must be `Tangle`s the presenter can change.
5. Run `deck.test.ts` and `lib/schedule.test.ts`; open the panel from the exact
   context (`openPanel("panels/tour", { contextId, ref: "ctx:<id>" })`) and read
   it visually before publishing.

Host commands (`Tour › Next scene / Previous scene / Toggle presenter notes /
Toggle presentation mode / Restart`) and keys (`←/→`, `PageUp/Down`,
`Home/End`, `1–9`, `N` notes, `F` presentation mode, `?` key help) are owned by
`index.tsx`. Presentation mode and the help overlay are ephemeral; scene and
notes persist.

The Continuum scene's “Reshape this deck” button calls
`panel.openCommandAgent({ prompt })` (the shell's real Quickfire overlay bound to
this panel); the Runtime scene reads `hostPerformance.snapshot` (open method)
for its measured card. Both degrade to explanatory text on hosts without the
feature. `lib/live.tsx` (`LiveLink`) opens the real panel a scene is about (Permissions,
Credentials, Automations, Workspace history, a chat). Opening a panel is the
gated `workspace.runtime-state.manage` effect declared in `package.json`; keep
that request if you add more live links, and don't add broader authority for
decoration.
