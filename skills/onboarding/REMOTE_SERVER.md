---
name: remote-server-onboarding
description: Connect a desktop, mobile, or CLI Vibestudio client to a state server running elsewhere (home server, VPS, remote workstation) over WebRTC.
---

# Connecting to a Remote Vibestudio Server

Vibestudio's state server (the piece that owns workspaces, the build system, agents, DOs, and secrets) can run on a different machine from the client UI. Typical setup: the server runs on a home server or VPS, and you connect from a desktop Electron app, the mobile app, or the CLI.

Remote reach is **WebRTC**: the client establishes direct DTLS-encrypted pipes
and pairs by QR. One stable pipe terminates at the hub control ingress; the
current workspace pipe terminates at its child. There is no public HTTPS data
endpoint, no TLS cert/CA/fingerprint files, no Tailscale, and no reverse proxy —
the gateway binds loopback only and remote clients reach it through WebRTC. See
`docs/webrtc-rpc-transport.md` for the design and `docs/webrtc-local-e2e.md` for
a runnable local harness.

The hub is multi-user and multi-workspace. Root/admin accounts manage users and
memberships; each person pairs devices to their own account. Workspace members
share that workspace's panels, approvals, agents, and secrets, with actions
attributed to the acting user.

## 1. Start the server as a WebRTC answerer

The hub needs a **signaling endpoint** (a tiny Cloudflare Worker/DO that brokers
the WebRTC offer/answer — it never sees your data). For an always-on Linux
server on this computer, install and deploy the server through its owned user
service:

```
npm install -g @panticonic/vibestudio-server
vibestudio remote deploy local
```

Use `vibestudio remote deploy user@host` when the server is a different
computer. The target is the only difference: both forms install the same
loopback-only systemd service, enable linger, validate the hub and default
workspace reaches, and surface the current root pairing QR from the service
journal. Manage the same target with `remote deploy status`, `logs`, `update`,
and `remove`.

For a foreground session instead:

```
vibestudio remote serve --port 3030
# → Root Pair URL: https://vibestudio.app/pair#room=…&fp=…&code=…&sig=…&v=2&ice=all
```

On an empty identity database the hub starts the default workspace child and
owns one live root-bootstrap invite at a time. If it expires before a device
claims it, the hub replaces it and publishes the new QR/link; a fresh server
does not require a restart merely because the operator stepped away.

- Signaling resolves as `--signal-url` > `VIBESTUDIO_WEBRTC_SIGNAL_URL` > hosted default (`wss://signal.vibestudio.app`).
- The QR reaches the hub's persistent control identity at
  `server-auth/webrtc/identity.pem`. Each workspace child presents its own
  persistent DTLS identity at `reach/webrtc/identity.pem`, outside semantic
  workspace state. The certificate SHA-256 is the `fp` in each reach — the
  client pins it (**fail-closed** on mismatch), so a malicious signaling server
  cannot MitM.
- `VIBESTUDIO_WEBRTC_ICE=relay` forces TURN (set the signaling worker's `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` secrets); host candidates suffice for LAN/loopback.
- `vibestudio remote doctor` checks node-datachannel, signaling, and the stable
  hub control identity by default. Pass `--workspace <name>` to inspect one
  child identity explicitly.
- For local development, run signaling on Cloudflare's local runtime (`cd apps/signaling && wrangler dev --local`) — see `docs/webrtc-local-e2e.md`.

### Dogfood mode from a source checkout

When the remote server is meant to edit Vibestudio itself, start it with `pnpm dev:self:server`. This layers a source-checkout workflow on top of pairing: a managed workspace with `projects/vibestudio`, userland pushes routed through the Vibestudio Git gateway and mirrored back into the host checkout when clean and fast-forwardable, then rebuild/restart on the same gateway port. Userland detects the mode via `meta/dogfood.json`.

## 2. Pair a client

The pairing link / QR carries everything needed to reach its hub invite room
(`room`, `fp`, `code`, `sig`). On first boot, the first valid root invite
redemption creates the root account. Later, root/admin uses `invite-user` for a
new person, while any member uses `pair-device` for another device they own.

Redemption atomically promotes that hub invite room to the device's durable
control room and returns a **durable, user-bound device credential** plus the
exact one-time `PairingContext.workspaceId` selected by the invite. The client
routes that ID over the same hub connection and saves the returned child
`workspaceReach`. No process token leaves the server.

- **CLI** — run `vibestudio remote pair "https://vibestudio.app/pair#…"` to pair over WebRTC. The CLI stores the device credential, stable hub control pairing, exact selected workspace ID, and current workspace pairing; later workspace switches preserve the control pairing.
- **Desktop (Electron)** — open the `vibestudio://connect?…` link (or scan the QR); the shell pairs over WebRTC and stores the device credential in the OS keychain. Use the connection badge → **Paired devices** → **Connect a device**, or `vibestudio remote pair-device`, for another device on your account; root/admin uses `vibestudio remote invite-user --handle <handle> --workspace <name>` for another person. Selecting another remote workspace reuses this identity without pairing again.
- **Mobile** — scan the QR or follow a `vibestudio://connect?…` link. Once connected, use **Settings** → **Devices** → **Connect another device** to share a new one-time link with another phone or desktop. The native host stores its own credential via `react-native-keychain`.

The QR `code` is the one-time pairing secret; the `fp` is the pinned hub DTLS
fingerprint. A workspace route returns only `workspaceReach`, never a new
control reach. There is no child pairing activation, proposed credential, or
legacy pairing shape.

## 3. OAuth from a remote client

When you trigger an OAuth flow from a remotely-connected client, the flow opens through `externalOpen.openExternal` and **the client that started it** opens the URL in its local browser (desktop `shell.openExternal`, mobile `Linking.openURL`). Provider redirect URIs that need a public HTTPS endpoint resolve through the **callback relay** (`VIBESTUDIO_RELAY_URL`, plan §7), which backhauls the callback to your loopback server over the pipe — no public server URL or tunnel required.

## 4. Verifying the connection

The Electron connection badge is always visible because it is also the stable
entry point for connection settings and device pairing. It indicates:

- **Gray globe** — connected to the co-located server.
- **Green globe with hostname** — connected to a remote server over WebRTC.
- **Amber "reconnecting"** — the pipe dropped and the client is re-establishing (full ICE re-establish, not a socket retry).
- **Red "disconnected"** — recovery exhausted.

Clicking the badge opens the connection dialog.

## 5. What lives where

| On the server (host machine)                                                                                    | On the client                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Hub identity/membership (`server-auth/identity.db`) and workspaces (`~/.config/vibestudio/workspaces/`)         | Global device credential + stable hub control reach + selected workspace ID and child reach |
| Credentials + consent state (`~/.config/vibestudio/credentials/`, `credentials-consent.sqlite`)                 | Theme / local UI preferences                                                                |
| Hub control identity (`server-auth/webrtc/identity.pem`) and per-child identities (`reach/webrtc/identity.pem`) | Electron userData cache for remote mode                                                     |
| Durable Object state (`.databases/workerd-do/`)                                                                 |                                                                                             |
| Agent/worker execution                                                                                          |                                                                                             |

Back up the server side; the client is disposable.

## 6. Troubleshooting

| Symptom                               | Likely cause                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing link never appears or renews  | Follow `remote deploy logs <target>`. The server may not reach signaling, or `node-datachannel` is not built — run `pnpm rebuild node-datachannel` once on the server.                                                  |
| `fingerprint mismatch` on hub control | The saved control `fp` no longer matches the hub cert — restore the expected hub identity from its exact backup and investigate possible signaling attack. In-place hub identity rotation is intentionally unsupported. |
| `fingerprint mismatch` on a workspace | The saved workspace `fp` no longer matches that child. Re-route its exact workspace ID through the still-pinned hub control connection; do not replace the device credential.                                           |
| Client connects then drops repeatedly | Symmetric NAT with no TURN — set `VIBESTUDIO_WEBRTC_ICE=relay` on the server and TURN secrets on the signaling worker.                                                                                                  |
| OAuth dialog never opens a browser    | Check the badge: is the client actually connected? The event only fires to subscribers.                                                                                                                                 |
