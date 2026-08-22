---
name: workspace-mobile-app
description: Develop and diagnose the trusted React Native app in apps/mobile, including pairing recovery, OTA activation, and mobile equivalents of shared shell behavior.
---

# Workspace Mobile App

`apps/mobile` is the trusted React Native app streamed to the native host after
pairing.

## Boundaries

- First pairing belongs to the shipped native bootstrap in `apps/mobile`.
- This app runs only after the native host has paired, fetched the current
  platform artifact, verified integrity, and reloaded React Native.
- Long-lived device credentials live in `@vibestudio/mobile-webrtc`; this app
  uses the active WebRTC transport and short-lived app principal grants.
- Bundle installation and self-update use the shared streamed delivery helper in
  `@vibestudio/mobile-webrtc`. Do not add HTTP-direct artifact fetches or native
  workspace-selection APIs.

## Pairing And Re-Pair

- Accept both `https://vibestudio.app/p#...` and
  `vibestudio://connect/...` links through the shared compact-v3 parser.
- The login/recovery surface should offer paste-link and scanner entry points
  that delegate to native host capabilities.
- Consumed or stale links must fail visibly and leave the recovery UI usable.
- Re-pairing clears the active OTA bundle and returns to the shipped bootstrap;
  do not try to pair from a stale workspace bundle.
- A connected app may create another-device invitations through
  `hubControl.pairDevice` for its exact current workspace. The Settings →
  Devices surface presents the complete server-minted HTTPS link, expiry,
  copy/share actions, and regeneration; it never reconstructs pairing fields or
  handles the current device's refresh credential.

## OTA Updates

- `appUpdatePrompt.ts` prompts for trusted mobile app updates.
- Choosing Install must call the shared bundle-delivery flow over the app's
  current `MobileRpcClient` transport, then activate the prepared bundle.
- Choosing Roll back changes the trusted server build first, then activates the
  selected bundle.
- Keep `rnHostAbi` aligned with the native host. Read the value from
  `apps/mobile/package.json`; `@vibestudio/mobile-webrtc` owns the matching
  native delivery constant.

## Desktop Parity

- Treat `apps/shell` and this app as clients of the same workspace model. Audit
  shared navigation, approval, identity, and lifecycle behavior in both.
- Consume the same canonical identity and state projections. Keep native and
  web rendering idiomatic, but never create a mobile-only fallback data path.
- For unit identities, use `MobileUnitIcon`/`MobilePanelIcon`; relative manifest
  images must resolve through the authenticated local asset facade, browser
  panels must use captured favicons, SVG artwork must render through
  `react-native-svg` rather than React Native `Image`, and fallbacks must remain
  kind-specific.
- Add a focused mobile behavioral test when shared shell behavior changes. A
  desktop-only test is not evidence for the mobile client.
- The command palette and panel-scoped agent sessions are shared model, native
  renderer: `src/commands/slate.ts` binds `@workspace/quickfire-core`'s slate
  definitions to mobile implementations, `src/components/CommandSheet.tsx` runs
  the shared omnibox engine and argument state machine, and
  `src/components/QuickfireSheet.tsx` drives the same durable conversation the
  desktop overlay does through `@workspace/quickfire-core/session`. Do not add a
  mobile-only command definition or a second ranking path.
- The command sheet's "Recent pages" group and the `AppBar` address field share
  one source: `ShellClient.panels.getBrowserAddressOptions`, ranked by
  `@workspace/omnibox-core`. Search-engine rows are dropped in the sheet (an
  address-bar affordance, not a destination) and favicons are not fetched.
  `nav.history` re-scopes the sheet to `@history:` rather than navigating.

## Verification

- Run the focused checks declared by the app package and the affected workspace
  packages.
- Use `extensions/mobile-debug/SKILL.md` for device or simulator verification.
- Use the repository mobile smoke workflow only when the change crosses native
  bootstrap, pairing, transport, or OTA boundaries.
