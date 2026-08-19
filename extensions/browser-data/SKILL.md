---
name: browser-environment
description: Import and manage non-sensitive browser records, open browser tabs as panels, and launch sealed host imports for protected browser data.
---

# Browser Environment

Use the `browserData` client from `@workspace/runtime`. Use `docs_search` and
`docs_open` for the live method schemas.

The environment is derived from the verified user and workspace. Never ask for
or pass a user id, environment key, Electron partition, source profile, or
filesystem path.

## Import

Import is a migration snapshot, not sync:

For user-driven setup, open `about/browser-import-inspector`. It is the
first-party cohesive workflow for device/browser selection, data categories,
preview, warnings, progress, cancellation, retry, and history. Do not recreate
it as chat questions or chained feedback forms. Do not ask users for internal
host IDs, source IDs, profile paths, or import job IDs.

When opening that inspector only to automate, diagnose, or verify it, treat the
panel as an owned temporary resource: retain its handle, archive it after the
observation (including on failure), and do not leave it in the user's panel
tree. A panel opened for the user's ongoing migration is not temporary and
should remain available.

Use the API sequence below for automation, diagnostics, or code that already
has a complete user-approved selection:

1. `listImportHosts()`
2. `listImportSources(hostId)`
3. `previewImport({ hostId, sourceId, dataTypes })` for bookmarks, history,
   search engines, and favicons only.
4. `startImport({ hostId, sourceId, dataTypes })` for those non-sensitive categories.
5. For cookies, passwords, or form fill, call
   `previewSensitiveImport({ hostId, sourceId, dataTypes })` for aggregate
   review counts, then call
   `startSensitiveImport({ hostId, sourceId, dataTypes, operationId })` once.
   Mint `operationId` before invocation and reuse it only for transport retries
   of the same exact request. Poll `observeSensitiveImport(operationId)` and use
   `cancelSensitiveImport(operationId)` when requested. Start owns the one
   user-facing import gate; preview, observe, and cancel do not add gates. The
   host returns aggregate status; plaintext never enters Base.
6. Poll `getImportJob(jobId)` for non-sensitive jobs; use `cancelImport(jobId)` when requested.
7. Optionally call `listOpenTabs(hostId, sourceId)` and
   `openTabsAsPanels(...)`. It defaults to a new workspace root with nested
   source-window collections; use `destination: "caller"` only when the user
   wants the hierarchy attached to the invoking panel. The imported recursive
   subtree shares its root collection's orchestration context, so its resident
   conductors can title, regroup, and automate those panels without one
   context-boundary prompt per tab. See
   [the collection conductor skill](../../about/collection/SKILL.md).

Sources are opaque installed-browser records. Local profiles are merged inside
the trusted provider and are never presented to userland. The preview schema
is the source of truth for supported categories; do not infer unsupported
settings, extensions, or site permissions.

Non-sensitive imports commit bounded idempotent batches. A cancelled or interrupted job keeps
committed batches; starting the same source again continues through the
coordinator's deterministic batch identities. Preview returns counts, masked
samples, and warnings only.

## Runtime data

- Use bookmark/history methods for normal reads, writes, search, and deletion.
- Use `putPageFavicon` and `getPageFavicon` for byte-validated, page-associated
  browser icons. PNG, JPEG, GIF, WebP, ICO, SVG, BMP, and AVIF are supported.
- Site permissions are managed by the browser-permission approval service, not
  by browser data and never imported.

Browser passwords, form-fill values, and cookies have no Base read, CRUD, or
export API. Their import is a sealed host effect whose receipt contains counts
only. `openBrowserPrivacyManager(section)` hands an intentional user action to
the host-owned manager and returns no protected data. Raw secrets, local files,
and decrypted import batches must never be rendered, logged, or forwarded
through the Base coordinator.
