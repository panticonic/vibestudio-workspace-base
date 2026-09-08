---
name: onboarding
description: Open the state-aware setup overview, route selections to owner workflows, refresh state, or inspect templates for new workspaces.
---

# Onboarding

Onboarding projects durable state from each capability owner. It doesn't keep
completion flags, infer authority, or turn features into a checklist.

## Open the overview

```text
inline_ui({
  id: "onboarding-setup-overview",
  path: "skills/onboarding/SetupHub.tsx",
  props: {}
})
```

Don't compose a snapshot first or pass private state as props. The component
uses its panel cache immediately, then reads capability-owner state. A failed
owner read becomes an honest unknown or unavailable row without suppressing
other capabilities.

Template-registry discovery is user-initiated through the overview — don't
contact the registry during initial capability load.
The host workspace chooser is the discovery surface for development checkouts
selected at launch. Open it without a template pin so the host can present its
validated exact candidates; never ask the current workspace to inspect a local
candidate through its remote Git URL.

## Route a selection

The component sends readable text plus typed interaction metadata. Route the
complete interaction object, never its label:

- **Capability interaction**: call `executeOnboardingSelection` from
  `@workspace-skills/onboarding` through `client_eval` (navigation is
  client-affine).
- **Template interaction**: call `resolveOnboardingTemplateSelection`, then pass
  its exact registry-bound selection to [Templates](../templates/SKILL.md).

Follow the returned discriminant. A committed panel slot with unconfirmed
readiness must not be opened again. Owner-skill, model-setting, and conversation
routes return their authoritative next target; don't match button prose or
invent a fallback.

**Schedule recurring work** is a ready-now conversation route owned by
[Automations](../automations/SKILL.md). Read that returned skill, clarify only
the details needed to choose a worker method, exact inline agent eval, or agent
prompt, and launch the automation. Small recurring scripts can use the built-in
agent/EvalDO path without publishing a new codebase. Choose either an elapsed
interval or a cron calendar in an explicit timezone, and capture optional end
time, maximum-run, and natural-completion behavior. Agents can later edit, run,
pause, resume, or retire automations when the user asks. Saving an edit installs
the new revision immediately.
The successful launch immediately appears at that point in the conversation as
an inspectable running pill. The user can open it to inspect, edit, pause, run,
or stop the definition before any tick exists; it is the same durable
definition shown in Automations. Do not open an empty supervision panel in
place of helping.

After the client-affine handoff, use ordinary server-side eval unless work
depends on the inviting client's DOM, panel state, or native transport.

## Refresh

The component owns check and refresh controls. After setup succeeds, fails, is
cancelled, or changes externally, render the same component ID with no snapshot
props. Report the operation but don't claim a row's refreshed state before the
component reads it.

Creating from a template opens a separate workspace. Keep this conversation in
its owning workspace; creation does not integrate source into its context.
For explicit source copies or merges, inspect the destination's ordinary VCS
result before claiming that the changes are available there.

## Product rules

- Show durable preparation, not every ready-on-demand capability.
- Keep optional configuration neutral; omit completion denominators.
- Connection status is not effect authorization. Route repair, credentials,
  model settings, and grants to their owning surfaces.
- Secrets go through host-owned credential input, never chat or inline props.
- Open one owner-controlled workflow per selection. Don't replace it with
  feedback questions or a custom approval UI.
- Treat recurring work as an immediately usable agent capability, not setup.
  Automations owns its schedule, execution, history, and supervision.
- Onboarding may suggest catalog entries; Templates owns inspection and exact
  source selection for workspace creation. There is no installed-layer or
  automatic update workflow.

Read [GETTING_STARTED.md](GETTING_STARTED.md) for the execution recipe,
[OVERVIEW.md](OVERVIEW.md) for product concepts, and
[REMOTE_SERVER.md](REMOTE_SERVER.md) for remote setup.
