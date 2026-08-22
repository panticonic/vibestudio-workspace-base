---
name: remote-access
description: Deploy, pair, inspect, repair, update, or remove a Vibestudio remote server; diagnose WebRTC, identity, membership, or device failures.
---

# Remote access

Run `vibestudio remote --help` for current CLI syntax. Main workflows: deploy,
serve, pair, doctor, status/logs/update/remove, user invitations, device
pairing/revocation, membership, and child identity repair.

## Model

- A server is a hub hosting users, devices, and workspace children. The first
  redeemed startup invite establishes the root user. Until then, the hub owns
  one live root-bootstrap invite at a time and renews it on expiry; later users
  and devices join through authenticated hub actions.
- Users may pair several devices. Workspace membership is hub-owned, enforced
  before routing to a child.
- Keep one stable hub-control reach per device. Route a workspace by exact ID;
  replace only the returned workspace reach.
- Each workspace child owns its own WebRTC ingress and persistent identity. The
  hub routes control but never relays workspace media or turns internal tokens
  into user credentials.
- Pairing links are complete signed URLs. Never construct bare-code or partial
  invites.

Never infer a workspace from a display name, derive one reach from another, or
expose pairing secrets. The live hub-control schema is authoritative for method
arguments and return types.

## Golden paths

Use `vibestudio remote deploy local` when the current computer is the server, or
`vibestudio remote deploy <user@host>` for a different machine. Both targets use
the same systemd user-service lifecycle, exact artifact/version, hub plus
default-workspace diagnostics, and pairing/status/logs/update/remove commands.
The deployment output includes the fresh server's current root QR through its
protected managed ready state. Run `vibestudio remote deploy pairing <target>`
at any time before it is claimed to display the current renewed link and QR;
the service does not write that secret to its journal. Logs are diagnostic
output, not a pairing-secret interface.

After pairing, select another workspace through the retained hub-control
identity; workspace switching replaces only child reach and never requires a
second device pairing. Use the authenticated hub to invite another person or
pair another device. Desktop exposes connection badge → Paired devices →
Connect a device; mobile exposes Settings → Devices → Connect another device.

For a phone attached to the connected desktop, use [phone
setup](../phone-setup/SKILL.md) — it routes installation and same-account
pairing through the trusted desktop. If unavailable, use the shell's Devices
surface and its HTTPS QR.

## Diagnosis

Run the doctor ladder outside-in:

1. Verify signaling and TURN/relay availability.
2. Inspect service status and logs on the target host (`local` or `user@host`).
3. Distinguish hub-control identity from the selected workspace child's identity
   before any repair.
4. Restore a hub identity from its exact backup. Rotate only a damaged child
   through the explicit repair command, then re-route that workspace from the
   stable hub connection.
5. Apply any exact host remediation from deploy or doctor output, then rerun the
   failed check.

Never replace identity as a generic connectivity fix. Preserve the narrow
failure state and report which endpoint, route, or dependency failed.

Use the focused desktop-pairing smoke for pairing changes. Use the full mobile
composition smoke only when changes span desktop pairing, remote transport,
mobile activation, and panel loading.
