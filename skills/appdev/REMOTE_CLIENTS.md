# Remote Clients And Pairing

Vibestudio remote clients use hub-owned user/device credentials and short-lived
principal grants. Device and user invitations are hub-control operations made
by an authenticated human account.

## Concepts

| Concept           | Purpose                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| Pairing invite    | One-time Iroh bootstrap material: Endpoint ID, ordered relay set, code, expiry         |
| Device credential | Long-lived device id plus refresh token, stored by the client/native host              |
| Shell token       | Remote shell credential presented as `refresh:<deviceId>:<refreshToken>` over the pipe |
| Principal grant   | Short-lived grant scoped to one app/runtime principal                                  |
| Connection info   | Iroh reach plus server/workspace identity                                              |

## Desktop Remote Shell

Remote startup retains a hub session and separate workspace sessions:

1. Redeem a user-bound or root-bootstrap invite and store the global device
   credential.
2. Call `hubControl.ensureUserWorkspaces` on the authenticated hub session to
   obtain the user's private Personal/System pair. Load native client source
   from System.
3. Use `hubControl.routeWorkspace` for each workspace the user opens. It returns
   that child's current Iroh reach without minting another account identity.
   Keep the hub session for the catalog and account operations; bind each child
   session to its exact workspace. Changing focus must not retarget an in-flight
   operation or replace the System client implementation.

`vibestudio remote pair "https://vibestudio.app/p#<compact-payload>"`
or the equivalent `vibestudio://connect/<compact-payload>` link exchanges a pairing invite
over the pipe and stores the device credential.
`vibestudio remote select <name>` switches the selected child's reach while
keeping that same credential for later workspace listing/selection.

## Mobile Client

Mobile native host stores a device credential and requests a principal grant for
the React Native app:

```json
{
  "principal": "react-native-app"
}
```

The resulting caller id is device-scoped, for example:

```text
app:apps/mobile:<device-id>
```

The selected mobile source is supplied during bundle bootstrap and
principal-grant refresh:

```json
{
  "principal": "react-native-app",
  "source": "apps/field-mobile"
}
```

That yields a source-scoped caller id such as:

```text
app:apps/field-mobile:<device-id>
```

The native host persists the selected source alongside the activated bundle so
future reconnects refresh grants for the same app. No implicit app-source
fallback should be added to clients.

The selected source belongs to the authenticated user's designated System
workspace. A panel, website, or app in another workspace cannot select itself
as the native client by declaring the same source name or capabilities.

The workspace app should use that principal grant for RPC. It should not store
or handle the refresh token directly in JS.

## Terminal Client

The terminal target produces a Node ESM entry and the workspace server can
launch it as a supervised app process only in a designated System workspace.
Ordinary workspaces may retain its source for authoring. A terminal app should:

- connect over `/rpc` with the runner-provided principal grant
- use app identity and manifest capabilities for privileged calls
- keep workspace work on the child session; account/device/workspace-catalog
  control belongs to a human shell's separate stable hub session

The built-in `@workspace-apps/remote-cli` is the canonical terminal app shape:
it connects as an app principal and lists workspace status. It is declared in
the template so it is available for debugging, but it stays dormant until the shell UI or
`runtime.supervision.activate({ kind: "app", releaseId:
"@workspace-apps/remote-cli" })` starts it.

Initial source comes from the selected distribution's explicit inventory:
Personal and System have different source sets. Importing or copying source
does not copy approvals or grants. Unit admission, capability changes, source
changes, dependency changes, and target changes use the normal approval path.

## Pairing Invite Creation

Pairing invite creation belongs to the stable hub session held by desktop,
mobile, and external CLI shells. A workspace app has only its exact child
session and cannot deputy a hub-control request. `pairDevice` binds an invite to
the authenticated shell's account. `inviteUser` requires an account admin and
explicit workspace-admin authority for every target workspace. Personal and
System are exclusively owned and cannot receive additional members.

## URL And Transport Rules

- Remote clients pair through Iroh using an Endpoint ID and ordered explicit
  HTTPS relay set. Do not add public-ingress, VPN, or cleartext-host
  exceptions for RPC reachability.
- Pairing QR codes should use the HTTPS carrier
  `https://vibestudio.app/p#...`; native carriers use
  `vibestudio://connect/...`. Both use the same compact-v4 parser and payload.
- Pairing invites are complete artifacts: `deepLink`, `pairUrl`, `endpointId`,
  `relays`, and `code` are non-null. Do not reintroduce bare-code or nullable-link
  handling.
- `vibestudio://connect` is for pairing bootstrap. OAuth callbacks use the
  platform-specific OAuth seam and must not trigger pairing reset.

## Recovery And UX

Remote-client UX should handle:

- revoked device credential
- stale endpoint reach
- expired pairing code or unreachable configured relays
- Endpoint ID mismatch after an explicit server identity rotation
- no active mobile app bootstrap
- terminal app build available but process not started
- terminal app process exited or failed session auth

The recovery surface should remain usable even when the workspace app cannot be
loaded.

## Operational Debugging

When testing pairing or remote-server state without a shell UI:

1. Start the hub with `--ready-file`; on a fresh identity DB, redeem the one
   `rootInvite` with the CLI to become root. Its deep link and HTTPS/QR URL are
   presentation carriers for the same invitation fact, not separate invites.
2. Select a workspace and inspect/resolve approvals through the authenticated
   workspace services. Do not mint a shell principal from a process token.
3. Use `build.listUnits()` for declared build readiness. From
   `runtime.supervision.list({ kind: "app" })`, retain the exact `identity` and
   use `describe`, `health`, `logs`, or `restart` for that live execution.
4. From app, panel, worker, or eval contexts, use `serverLog.query/tail/stats`
   (`services.serverLog.*` in eval, raw `rpc.call("main", "serverLog.*", ...)`
   elsewhere) or the `about/server-logs` viewer for host server logs such as
   pairing, reconnect, app reconcile, gateway, and shutdown events. See
   `../server-logs/SKILL.md`.
