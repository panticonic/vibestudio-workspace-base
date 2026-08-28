---
name: remote-access
description: Deploy, pair, inspect, repair, update, or remove a Vibestudio Iroh remote server; diagnose endpoint, relay, identity, membership, or device failures.
---

# Remote access

Run `vibestudio remote --help` for current syntax. Remote application traffic is
one RPC request per Iroh QUIC stream. Hub control and the selected workspace are
separate authenticated endpoint connections; the hub never becomes a generic
application relay.

## Invariants

- A server is a hub hosting users, devices, and workspace children.
- Each hub and child owns a persistent Iroh endpoint secret and Endpoint ID.
- A device keeps one stable hub-control reach and routes an exact workspace ID
  to obtain that child's current reach.
- Reaches contain only protocol version, Endpoint ID, and an ordered explicit
  HTTPS relay set.
- Pairing links are complete server-minted compact-v4 URLs. Never derive a
  reach, reconstruct a link, infer a workspace from a display name, or expose a
  pairing secret.
- Production endpoints disable n0 address lookup and implicit public relays.
- The callback relay remains only for OAuth/webhook HTTP callbacks; never route
  RPC, panels, bundles, or assets through it.

## Golden paths

Use `vibestudio remote deploy local` for this computer or `remote deploy
<user@host>` for another host. The deployment commands own the same systemd
user-service lifecycle and provide `pairing`, `status`, `logs`, `update`, and
`remove` operations. Pair with the complete link, then use `remote select` to
switch workspaces without replacing the device credential.

Use `remote pair-device` for another device on the same account and the
root/admin invitation command for another person. On mobile, Settings → Devices
presents the server-minted link. For a phone attached to a paired desktop, use
[phone setup](../phone-setup/SKILL.md).

## Diagnosis and repair

1. Run `remote doctor` with the exact configured relay URLs.
2. Inspect deployment status and endpoint registration logs.
3. Identify whether hub control, workspace routing, or a child endpoint failed.
4. Re-route a stale workspace reach through the still-authenticated hub.
5. Use `remote rotate-endpoint --workspace <name> --yes` only for a lost or
   compromised endpoint secret. Expect clients pinned to that Endpoint ID to
   re-pair.

Relay fallback is normal, not degraded security. Record whether the active path
is direct or relayed and which configured relay was dialed. Never enable public
lookup, restore a retired transport, replace endpoint identity, or add an HTTP
fallback merely to make a connectivity symptom disappear.

Use focused remote-transport tests for codec, authentication, cancellation,
reconnect, and routing changes. Use the full mobile composition smoke only when
native pairing, activation, lifecycle, or panel loading changes.
