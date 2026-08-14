---
name: workspace-shell-app
description: Develop and diagnose the trusted Electron shell in apps/shell, including panel chrome, lifecycle projections, device pairing, and desktop/mobile parity.
---

# Workspace Shell App

`apps/shell` hosts desktop panel chrome and device-management UI.

## Devices Surface

- "Connect a device" calls `hubControl.pairDevice` on the currently connected
  server, local or remote. The desktop is a broker, never a data relay.
- Render the HTTPS pair URL and QR from the complete invite object. Do not build
  client-side fallback links or accept nullable `deepLink`/`room`.
- The modal should show expiry, server/workspace label, waiting state, and then
  the paired device once `hubControl.listDevices` observes it.
- Device revocation uses `hubControl.revokeDevice`; after revoking the desktop's
  own stored device, explicitly call local `remoteCred.clear` before relaunching.
  A revoked phone should return to recovery/re-pair.

## Remote Parity

- Remote sessions serve panels, manifests, and assets through the bridge-backed
  facade. Avoid code that assumes the server's workspace path is readable on the
  desktop filesystem.
- Pairing URLs can arrive through the desktop protocol handler or as typed URLs;
  both carriers must feed the shared parser.

## Mobile Parity

- Treat desktop shell UX and `apps/mobile` as paired clients of the
  same workspace model. Before finishing a user-facing shell change, audit the
  mobile equivalent: title bar/AppBar, panel tree/drawer, approvals, launcher
  and about/new flows, browser favicons, and loading/error/empty states.
- Share canonical data and presentation rules, not renderer components. Add a
  focused behavioral test in every affected client; explicitly state when a
  surface has no mobile equivalent instead of silently omitting it.
- Command palette and quickfire: the desktop overlay (`components/QuickfireOwner`
  + `overlay/QuickfireSurface`) and the mobile `CommandSheet` / `QuickfireSheet`
  are two renderers over one model. Ranking lives in `@workspace/omnibox-core`;
  the slate's *definitions*, the row projection, the transcript projection and
  the session lifecycle live in `@workspace/quickfire-core`. Each client owns
  only its `run` implementations and its renderer, so a new command is a
  definition plus two runs — never a second definition.
- Surface flags are the honest record of parity. A command whose `surfaces`
  omit `"mobile"` must say why in a comment on the definition. Currently
  desktop-only beyond the spec's own list: `view.accent` (mobile has no accent
  system) and `app.check-updates` (mobile updates go through the trusted OTA
  prompt, not a command). Mobile also reshapes two behaviors deliberately:
  `workspace.switch` opens Settings rather than re-routing from a search field,
  and the `/` scope hands off to the full-height quickfire sheet instead of
  rendering inline.
- One omnibox, one ranking path. `@workspace/omnibox-core` ranks `about/new`,
  the palette's `@` scope, the title bar's address autocomplete and the mobile
  address field. `@vibestudio/shared/panelChrome` keeps only chrome *facts*
  (address parsing, history/bookmark normalization and merging); it must not
  grow a second row builder. The prefix grammar is uniform: `>` commands, `@`
  go to, `/` quickfire, bare mixed. `about/new` has no command slate, so its
  `>` is a deprecated alias of `@` for one release and shows a hint row saying
  so.
- Palette history comes from `panel.getBrowserAddressOptions` — the exact call
  the address bar makes — with search-engine rows filtered out and no favicon
  fetch (glyph-only rows, matching the address bar). Do not add a second
  history query.
- Slate gaps left open on purpose, because their backing surface does not
  exist yet rather than because they were forgotten: `panel.move` (the
  placement engine in `layout/placementEngine.ts` has no directional move
  action — only `move-pane-to-new-column`), `panel.collapse` (no collapse
  concept in the layout model at all), and `authority.pause-agents` /
  `authority.lock` (the shell requests no `permissions.*` capability; adding
  them is an authority-manifest expansion, not a UI change). Add the backing
  action or capability first, then the command.

## Panel Lifecycle and UI Projections

- `view.createPanel` and `panel.createPanel` resolve at the durable slot-commit
  boundary. Runtime-image preparation, native attachment, navigation, and app
  boot continue independently. Do not make a creation button await readiness.
- `panel-created` is the sole creation-placement fact. It may arrive before the
  create RPC response and before a tree or presentation read contains the slot.
  Reducers must be idempotent and merge by `panelId`; never append a second
  optimistic panel when the response arrives.
- Render committed panels immediately in a preparing state. Keep preparing,
  ready, and failed as projections of authoritative lifecycle state, not as
  reasons to hide or delete the durable slot.
- Subscribe to `panel-presentation-changed`, then fetch the changed ids with one
  `panel.getPresentations(panelIds)` call. Coalesce bursts by revision and id.
  Do not refetch the full panel tree or issue one RPC per panel.
- Focus, presentation lease acquisition, runtime activation, and boot readiness
  are separate transitions. Shell creation promises only the first; the
  portable `openPanel(...)` API has the stronger boot-ready contract.
- Approval and other long-running work must not occupy a renderer interaction
  lane. Async handlers show local pending/error state and leave unrelated panel
  creation, focus, navigation, and input responsive.
- Never add sleeps or polling loops to bridge event ordering. The slot event is
  durable intent, presentation events are invalidations, and exact readiness
  waits use the server-minted attempt stream.

## Verification

- Run the smallest focused shell tests and browser flow that exercise the
  changed behavior.
- Use the repository desktop-pairing smoke workflow for pairing changes and
  the full mobile composition smoke only for cross-client changes.
