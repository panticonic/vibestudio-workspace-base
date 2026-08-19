---
name: templates
description: Inspect, add, adopt, update, remove, author, publish, or suggest changes to workspace templates through the template-composer extension.
---

# Workspace templates

`@workspace-extensions/template-composer` owns template resolution, verified
content acquisition, relationship changes, retained repair contexts, and host
review. Invoke it through `extensions.invoke(...)`.

Use the machine-readable [public contract](public-contract.json) for exact
methods and result discriminants. Read [template
authoring](references/template-authoring.md) for release creation and [errors
and remedies](references/errors-and-remedies.md) for failure recovery.

## User-facing language

Describe named templates, the parts they add or change, exact versions, incoming
changes, and suggestions to maintainers. Keep graph, pin, fragment, ref, and
object-ID details in an optional technical view.

## Invariants

- Invoke one composer operation per intent. Composer owns dependency resolution,
  VCS deltas, retained state, and the single protected review.
- Templates contribute changes; they don't own repositories. Overlapping
  contributions and local edits resolve through semantic VCS.
- Never edit managed template relationship files directly — use composer or the
  reviewed workspace-settings flow.
- A mutation isn't complete until its typed result confirms application or
  returns the requested contribution. A decline is a valid terminal outcome.
- Logical credential names may be stored; concrete credential IDs and secrets
  may not.

## Observe and resume

Start with `status` and `operations`. Run `check` only when the user asks or
opens a template status view — update discovery is not a background schedule.

For a retained operation, follow its state:

- `reviewing`: merge each returned source delta into the operation's exact
  review context through the ordinary [VCS
  workflow](../vibestudio-vcs/SKILL.md), then `resume`.
- `repairing`: edit the exact repair context from its structured failures, run
  focused checks, then `resume`.
- other resumable states: call `resume` and follow the next discriminant.

Cancel only when the user abandons a user-initiated operation. Product-owned
release operations must be repaired or resumed. A retained operation is not an
approval card; publication still crosses its normal review boundary.

After an applied result, honor `contextIntegration`: continue immediately after
`integrated`, merge the exact `publicationEventId` into the returned context
after `needs-merge`, and avoid claiming the current conversation observes it
after `unavailable`. That final publication merge takes only the context, source
event, and intent. Do not pass `coordinates`: coordinate decisions belong only
to unresolved `review.items[].sourceDeltaId` merges, and an applied publication
event has already concluded them.

## Add, adopt, update, and remove

For `add`, pass either the exact catalog selection or a direct URL with a fresh
command ID. Refresh the catalog only on explicit request. Never preflight the
same release unless the user asked for a read-only comparison.

For a named catalog entry, the cache-only `catalog` call is selection—not a
release preflight. Match the returned display name to its opaque `id`, then run
the single mutation:

```js
const composer = "@workspace-extensions/template-composer";
const catalog = await extensions.invoke(composer, "catalog", []);
const selected = catalog.entries.find((entry) => entry.name === requestedName);
if (!selected) throw new Error(`No verified template named ${requestedName}`);
return extensions.invoke(composer, "add", [
  {
    commandId: `template-add-${crypto.randomUUID()}`,
    source: { catalogId: selected.id },
  },
]);
```

Do not inspect composer source code to discover this call shape. The public
contract above and this workflow are the operative interface.

If `add` returns `pending`, leave eval and merge each returned
`review.items[].sourceDeltaId` in `review.contextId` with the ordinary `vcs`
tool, then call
`extensions.invoke(composer, "resume", [{ operationId: result.operationId }])`.
Repeat only for a newly returned typed review or repair state; stop at `applied`
and honor `contextIntegration`.

Use `adopt` only when the user asserts the workspace already descends from the
inspected exact release. Adoption records lineage without importing that
release's repository state — it is not a shortcut around an add conflict.

For updates, run `check` for the selected alias, then `pull` only after the user
chooses to update. Resolve each returned delta through ordinary semantic merge
and resume when every decision is accounted for.

Only directly configured templates can be removed. If a template arrives as a
dependency, identify the direct parent instead. Removal preserves other
templates' contributions and local edits per the semantic merge.

`suggest` publishes a contribution for template maintainers without changing the
workspace. Report only the returned branch or URL.

## Author and publish

Use `authoringParts` to discover publishable protected-main parts, then
`inspectAuthoring` for one user outcome and its required dependencies. Review
the returned requested, required, dependency, and overlap parts. Include
contract notes when a release changes a userland contract.

Publish only the exact inspected fingerprint through `publishAuthoring` with an
explicit destination, version, and fresh command ID. Contract-breaking changes
publish as one new current epoch; they never carry migration notes or readers.
The returned web URL, ref,
commit, snapshot, and template URL are the completion evidence. A publication
creates an installable release; registry recommendation is a separate reviewed
contribution through `suggestRegistryEntry`.

Keep the authoring workflow inside composer — never copy workspace files with a
shell command or create an auxiliary repository.

## Catalog ownership

Composer is the sole catalog and mutation owner. Onboarding may hand a selected
registry identity to this workflow but doesn't install templates itself.

Use cache-only `catalog` reads for ordinary rendering. Refresh only on explicit
user action. Preserve a stale verified snapshot as stale, distinguish an
uncached `null` from an empty catalog, and surface a failed explicit refresh
without hiding template status.
