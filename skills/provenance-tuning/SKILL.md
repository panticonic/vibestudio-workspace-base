---
name: provenance-tuning
description: Diagnose slow, incomplete, stale, or confusing provenance reads; repair graph recording, indexes, content mappings, or presentation.
---

# Provenance read review

Read [Vibestudio VCS](../vibestudio-vcs/SKILL.md) and [provenance
orientation](../provenance-orientation/SKILL.md) first. The system stores
normalized immediate edges and derives views by walking them.

## Reproduce one exact read

Capture:

- the precise typed root or file state/range
- the method: `readMemory`, `inspect`, `neighbors`, `history`, `blame`,
  `walk`, `query`, or `search`
- cursor, direction, and limit
- every returned node, edge, span, and typed refusal
- timing and the agent invocation that issued the read

Re-run the smallest focused call. Follow one cursor without changing its root.
Never compare results from different event/application states as one read.

For automatic read-time memory, capture the full bytes hash and exact displayed
UTF-16 range from the `read` details. Confirm the attachment is `stale`
(semantic state no longer names those bytes) rather than present, and confirm
this diagnostic adds no warning prose to the file content. Inspect
blame-selected roots instead of comparing rendered prose. Then inspect the
model-visible block: it should answer why the lines exist with tier-labeled
intent and bounded, reusable continuations.

## Classify the ownership problem

| Symptom | Root cause |
| --- | --- |
| Wrong or missing relationship | Graph-recording or edge-projection bug |
| Wrong copied span | Content-coordinate mapping bug |
| Missing source change | Integration decision or reachability bug |
| Sibling-context data | Authorization failure — stop, don't filter |
| Slow bounded page | Index/query-plan problem on the exact edge kind |
| Walk stops early with a boundary label | Correct behavior — evidence ends there |
| `query` refused at `validation` | The statement is not one SELECT over `prov_*`; read `prov_schema` |
| `query` refused at `plan` | Missing index or missing join predicate on the named relation |
| `query` refused at `execution` | The plan streamed past the scan budget; narrow the filter |
| `search` returns `indexMode: "scan"` | FTS5 is unavailable in this build; ranking is degraded, results are not |
| Search misses an obviously indexed phrase | Index maintenance gap — rebuild and fix the writing transaction |
| Confusing result | Typed summary or UI navigation problem |

Fix the owning abstraction. `readMemory` is the one narrow task projection for
ordinary reads: exact context + path + bytes hash + displayed range → bounded
blame-backed episodes and reusable typed roots. Keep the service projection rich
and default rendering small; structured tool details are the lossless machine
surface. Never turn it into an all-purpose provenance endpoint or add a
persisted traversal session, ranking layer, claims store, or opaque
node-handle shortcut.

The relational surface is allowed and is governed by four invariants, not by a
ban:

- **views are the contract** — agents read `prov_*` only; canonical tables stay
  private and refactorable, and a refactor that preserves view semantics must be
  invisible to every agent surface;
- **no canonical-table access** — a query naming a `gad_`/`vcs_` table is
  refused by name before it runs;
- **no unbounded scans** — the plan gate refuses full scans of large relations
  and cartesian joins pre-execution, and the streamed abort stops the rest;
- **no authorization bypass** — the host supplies the caller's reachable
  contexts and the executor materializes them into the visibility basis every
  view joins through. Query-reachable and walk-reachable are the same predicate;
  if they ever diverge, that is the bug.

## Diagnose a slow or refused `query`

A row-budget abort or a plan refusal points at a missing index on the relation
the plan named, or at a join predicate the author omitted. Fix the index or the
query. Raising a budget to make a refusal go away removes the only evidence that
the surface is being used pathologically; the recorded `rowsRead` accounting
exists precisely so that a real quota decision can be made on measurement.

## Validate the repair

Use deterministic generated fixtures with many relevant immediate edges. Assert
direction, stable ordering, pagination, exact state isolation, range selection,
content-hash staleness, bounded rendering, and restart behavior. For content
history, include edits, counteractions, moves, copies, imports, and integration
decisions; verify same moved identity plus new copied identity. For walks,
assert the spine's order, its boundary labels, and that no rendered line
contains a content-addressed identity. For the relational surface, assert both
directions of the visibility parity property and each typed refusal. For UX changes,
add a fresh vague agentic scenario that learns the recorded reason from an
ordinary read without being prompted to call a provenance method.

Report the exact symptom, owner, semantic change, focused tests, and measured
before/after behavior. Never widen global page limits to hide an indexing or
query-plan defect.
