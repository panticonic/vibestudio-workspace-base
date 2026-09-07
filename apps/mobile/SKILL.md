---
name: workspace-mobile-app
description: Develop and diagnose the React Native client in the user’s System workspace, including workspace navigation, scoped approvals, pairing, and mobile equivalents of shared shell behavior.
---

# Workspace Mobile App

`apps/mobile` is the React Native client source in the user’s **System** workspace, streamed to the native host after pairing. It presents Personal, System and other accessible workspaces through one account connection. A workspace is the isolation boundary; contexts stay inside it.

## Boundaries

- First pairing belongs to the shipped native bootstrap in `apps/mobile`.
- This app runs only after the native host has paired, fetched the current
  platform artifact, verified integrity, and reloaded React Native.
- Long-lived device credentials and the native Endpoint identity live in
  `@vibestudio/mobile-iroh`; this app uses the active Iroh transport and
  short-lived app principal grants.
- Bundle installation and self-update use the shared streamed delivery helper in
  `@vibestudio/mobile-iroh`. Do not add HTTP-direct artifact fetches or native
  workspace-selection APIs.

## Workspace ownership

- `MobileWorkspaceDirectory` retains one `MobileWorkspaceAccount` control pipe and lazily opens immutable child sessions. Selecting a workspace changes visible content; it never changes the saved native bundle source or reloads the app.
- Apps ensure the account’s Personal and System workspaces with `hubControl.ensureUserWorkspaces`. Both remain private to that account. Other workspaces may have multiple members.
- Each opened workspace owns a `ShellClient`, Jotai store, panel tree, local focus and pinned panels. Only activated workspaces mount panel screens; expanding a tree or reviewing an approval does not materialize its panels.
- Keep app-source capabilities and host launch on the System client. A target workspace session hosts its own panels and calls its own services. Do not expose native browser import through target workspace sessions.
- New belongs to the focused panel’s workspace; the + on a workspace heading explicitly belongs to that heading. About panels load source from their own workspace. Never fetch a missing about page from System.
- Quickfire requests, command arguments, file reviews and async actions retain their initiating workspace and panel. Changing focus must not retarget a pending operation or move its draft.
- The phone drawer and permanent tablet drawer show the same stacked workspace sections. Preserve the existing Command, Quickfire and Approval sheets; do not add another bottom-navigation system.

## Approvals and connections

- `WorkspaceApprovalSurface` is the single visible approval surface. It projects the existing controllers for opened workspaces; unopened workspaces have unknown attention until the host supplies metadata. Background requests add attention without opening a modal.
- Show the requesting workspace and verified website origin. Closing the surface leaves the approval pending. A decision on another device removes it through the existing pending-change event.
- Settings is account-level UI bound to System. Capture the workspace being managed when Settings opens; subsequent panel focus does not change the policy editor’s target.
- `WorkspaceConnectionsSection` edits the existing host policy with `expectedPolicy` compare-and-swap. Rules name an exact peer workspace, initiating user, RPC target, method and purpose (`call` or `discover`). Incoming and outgoing are independent ceilings; opening a ceiling does not grant method/resource access. System incoming calls remain locked closed.
- Application-to-application integration uses the existing RPC with an explicit destination workspace and the existing target/context semantics. UI-owned child sessions are account navigation, not a grant that untrusted application code can reuse.
- Push payloads carry host-stamped `{serverId, userId, workspaceId}`. Queued decisions and deep links must match that scope before using a client; never infer it from the focused workspace. Unscoped legacy actions are not replayed. Notification IDs and local state include the account and workspace namespace.

## Pairing And Re-Pair

- Accept both `https://vibestudio.app/p#...` and
  `vibestudio://connect/...` links through the shared compact-v4 parser.
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
  System app-source `MobileRpcClient` transport, then activate the prepared bundle.
- Choosing Roll back changes the trusted server build first, then activates the
  selected bundle.
- Keep `rnHostAbi` aligned with the native host. Read the value from
  `apps/mobile/package.json`; `@vibestudio/mobile-iroh` owns the matching
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


## Browser storage boundaries

All managed and website WebViews use `VibestudioWorkspaceWebView` through React
Native WebView's supported `nativeConfig` extension. The native manager binds a
profile before the view loads anything, using a captured account/workspace key.
Android uses `WebViewCompat.setProfile` and requires `MULTI_PROFILE`; iOS uses
`WKWebsiteDataStore.dataStoreForIdentifier` and the app minimum is iOS 17.
Missing support must show an update message, never fall back to a shared profile
or simulate isolation with cookie flags/incognito. Native ABI is `rn-host-5`.

The loopback asset façade port is also persisted per account/workspace. Its
native content-addressed asset store remains keyed by server/workspace; immutable
asset reuse does not grant a browser profile or runtime session access.
