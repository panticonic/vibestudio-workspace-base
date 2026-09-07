# Workspace Mobile App

Workspace browser profiles require iOS 17 or later. Android requires a System
WebView supporting AndroidX WebKit's `MULTI_PROFILE` capability. The native host
binds each browser view to one account/workspace profile before loading content;
unsupported engines show an update message and never use shared browser storage.
This native contract is `rn-host-5`.

Settings → This device → Website cookies clears only the workspace captured when
Settings opened. The explicit review names that workspace. Native cookie storage
is separate from the server browser vault; clearing one does not clear the other,
and the app does not claim to enumerate device cookies.

Settings → Copy selected files reads an exact main version through `vcs.mainState`,
pages the selected repository, and previews only checked files, their byte sizes,
and the destination audience. Copy creates a separate review context, rechecks
access and its captured main head, then uses the existing VCS/blob transport.
The optional Review with agent action opens a local chat in that context; copying
never publishes to main or starts an agent automatically. An interrupted copy
may already have written selected files; its review branch remains inspectable,
and another copy requires a fresh review.

Camera and microphone requests use native origin/document identity and the
workspace's existing website-permission approval queue. Android location requests
use the same route. A navigation or closed panel cancels pending consent; an old
approval cannot authorize the next document. Android keeps its OS permission
checks through a small maintained React Native WebView patch. iOS 17 has no public
WebKit location-permission hook, so this app does not request location entitlement
there; iOS location remains unsupported. No page-injected permission shim is used.

This directory is the hot-updatable Vibestudio mobile product: React Native
screens, navigation, panel WebViews, approvals, notifications, OAuth, and
workspace-facing services. It is a userland workspace app built by buildV2 and
delivered as a signed/verified bundle to the installed native host.

The shipped Android/iOS projects and minimal first-pairing/recovery bootstrap
live in the repository's native `apps/mobile` package. Native modules, signing,
release packaging, and OS-level integration belong there; product UI and
workspace behavior belong here.

The connected product exposes **Settings** → **Devices** → **Connect another
device**. It asks hub control for a complete, workspace-targeted invitation and
offers copy/share actions; first pairing and recovery remain native-host
responsibilities.

The client runs from **System** and keeps one authenticated account connection.
Its drawer stacks Personal, System and other accessible workspaces, each with its
own panel tree. Opening another workspace keeps existing panel screens, drafts
and Quickfire sessions attached to their original workspace. Approvals open only
when requested and identify the workspace they concern; connections settings
edit the host’s exact incoming/outgoing rules. People and connection management
use the user's role in that workspace. Personal and System cannot be shared.

The drawer creates a minimal workspace. A source link from the workspace catalog
opens a native review sheet: System verifies its exact pin, the user names the
workspace, then explicitly creates it. A failed opening can retry the same
created workspace without creating another one. Source and creation approvals
remain reachable from the sheet.

## Checks

Run the native package's commands from the repository root; its Jest and
TypeScript configuration intentionally includes this workspace app:

```bash
pnpm -C apps/mobile test
pnpm type-check:userland
pnpm test:iroh-mobile-e2e
```

See [SKILL.md](SKILL.md) for the architecture and change-specific verification
matrix.
