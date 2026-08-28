---
name: remote-server-onboarding
description: Connect a desktop, mobile, or CLI Vibestudio client to a state server running elsewhere over Iroh.
---

# Connecting to a remote Vibestudio server

Vibestudio's state server can run on a home server, VPS, or remote workstation.
Desktop, mobile, and CLI clients reach it over end-to-end encrypted Iroh QUIC.
The gateway remains loopback-only: there is no public RPC HTTP endpoint, reverse
proxy, VPN requirement, negotiation service, or media relay deployment.

The server advertises a stable Iroh Endpoint ID and an ordered set of explicit
HTTPS relay URLs. Iroh attempts a direct UDP path and uses those relays when a
direct path is unavailable. Production does not use n0 address lookup or an
implicit public-relay preset. OAuth and webhook callbacks still use the separate
callback relay; application RPC and assets never do.

## Start or deploy

Install and manage the owned user service locally:

```bash
npm install -g @panticonic/vibestudio-server
vibestudio remote deploy local
```

Use `vibestudio remote deploy user@host` for another computer. Inspect it with
`remote deploy pairing`, `status`, and `logs`; apply releases with `update`; use
`remove` only when decommissioning it. For a foreground session:

```bash
vibestudio remote serve --port 3030
```

The relay set is mandatory server configuration. Run `vibestudio remote doctor
--relay-url <https-url> --relay-url <https-url>` before exposing an invite. Pass
`--workspace <name>` to inspect a child Endpoint or `--identity <endpoint.key>`
to inspect one identity directly. Doctor validates release compatibility,
identity persistence, relay reachability, endpoint binding, and retired native
transport absence.

Each hub and workspace child owns a private persistent endpoint secret. Back up
the server state that contains it. Endpoint rotation changes the Endpoint ID and
invalidates saved reaches; it is therefore an explicit recovery operation:

```bash
vibestudio remote rotate-endpoint --workspace <name> --yes
```

Do not rotate an endpoint as a generic connectivity fix.

## Pair a client

The compact v4 HTTPS/deep-link payload contains a one-time code, expiry, hub
Endpoint ID, and ordered relay set. It contains no certificate fingerprint,
negotiation-room or candidate-policy fields.

```bash
vibestudio remote pair "https://vibestudio.app/p#..."
```

Desktop can open the same URL; mobile can scan its QR or open the HTTPS/deep
link. Redemption returns a durable user-bound device credential. The client
retains the hub-control reach, routes the exact selected workspace ID through
that authenticated connection, and stores the returned child reach. Switching
workspaces replaces only the child reach and never mints a second identity.

One-time links cannot be replayed. If redemption has not reached the server, a
local storage error may be fixed and the same link retried. Once accepted, an
expired or consumed link requires a fresh `remote pair-device` or administrator
invite.

## Connection diagnosis

The UI reports connecting, direct, relayed, reconnecting, and offline states.
When relayed it may show the active relay region. Diagnostics include the path,
relay URL, path changes, RTT, close cause, retry attempt, and endpoint generation
without logging pairing codes or credentials.

Investigate outside-in:

1. Run `remote doctor` with the exact configured relay set.
2. Inspect the server service and endpoint registration logs.
3. Distinguish the stable hub-control endpoint from the selected workspace
   endpoint.
4. Re-route the exact workspace through hub control when only the child reach is
   stale.
5. Rotate an endpoint only when its persisted secret is lost or compromised,
   then deliberately re-pair affected clients.

Back up hub identity/membership, endpoint secrets, workspace state, credentials,
Durable Objects, and agent/worker state. Client-side credentials and cached panel
assets are disposable and can be recreated by pairing again.
