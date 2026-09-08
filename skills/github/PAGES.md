# Publish a workspace-enabled website

Use the existing GitHub setup, semantic VCS and Git Bridge. Pages adds a public
website to a repository; it does not supply workspace credentials to that site.
The same App component and portable runtime work in an installed panel and a
connected website. See [website development](../workspace-dev/WEBSITES.md).

## Build and review

Use the Host developer scaffold to vendor an exact standalone SDK:

```sh
pnpm build:website-runtime --out-dir /tmp/website-sdk
pnpm create:website --out-dir /tmp/my-website --sdk-dir /tmp/website-sdk --name my-website
cd /tmp/my-website
npm ci
npm run build
```

The public output is `docs/`, with relative asset URLs, `.nojekyll` and the
content-hashed build manifest. Review the generated source and output together,
including the SDK artifact and lockfile. Test ordinary browsing under a project
path such as `/my-website/`, then connection and denial in Vibestudio. These are
Host commands; do not present them as workspace eval exports.

Bring the reviewed repository into a dedicated managed project using ordinary
workspace authoring/import, then commit and publish it to protected main through
[Vibestudio VCS](../vibestudio-vcs/SKILL.md). Review the complete repository's
public file inventory, not only `docs/`: a public repository also exposes source
and its Git history. Retain the reviewed `mainEventId` and build manifest's
`buildId`. Credentials, workspace transcripts and private source do not belong
in this public repository.

## Connect GitHub and publish the repository

Use `GitHubSetup` from the [GitHub skill](SKILL.md), selecting **Publish websites**
(`publish-pages`). That component owns account, repository access and any repair;
never ask for tokens in chat. Keep its concrete credential ID for the operation.

Use the existing `publishToGitHub` helper with explicit repository name, audience,
and `expectedMainEventId`. This comparison is enforced at the actual protected
source export. Unrelated workspace configuration changes are allowed; changed repository contents
require reviewing the new source before trying again.

```ts
import { publishToGitHub } from "@workspace-skills/github";

const published = await publishToGitHub({
  repoPath: "projects/my-website",
  name: "my-website",
  private: false,
  credentialId,
  expectedMainEventId: reviewedMainEventId,
});
```

Persist the successful result before continuing. A failed repository-creation
response must not trigger a blind second `publishToGitHub` call. Inspect the
existing target and Git Bridge status; its error identifies a created repository
and the remaining configuration or push step. Use normal Git Bridge recovery
for that same repository. Never force-push to make publication pass.

## Enable and verify Pages

After a successful push, retain this exact publication record. Use the actual
repository name selected above and the returned owner, branch and commit; never
infer a deployed URL from a title or username.

```ts
import { enableGitHubPages, observeGitHubPages } from "@workspace-skills/github";

if (!published.pushed || !published.headCommit) throw new Error("Finish Git push first");
const publication = {
  owner: published.owner,
  repository: "my-website",
  branch: published.branch,
  commit: published.headCommit,
  buildId: reviewedBuildId,
};
// Persist publication before the configuration request.
const observation = await enableGitHubPages(publication, { credentialId });
```

This configures the existing branch's `/docs` source. It refuses to replace an
existing workflow or different Pages source. Repository-scoped Pages access uses
the same credential system as GitHub setup. Permission failures return the
bounded `publish-pages` repair choice; a denial does not trigger broader access.

Only `state: "deployed"` means verification succeeded: the GitHub build must match
the retained commit, and the public manifest and every listed asset must match
the retained build identity. `building`, `failed`, `unverified` and
`not-configured` are distinct results. Display their reason where present.

Retry `observeGitHubPages(publication, { credentialId })` to watch an uncertain
or pending deployment. Observation creates nothing and changes no configuration.
If configuration itself was interrupted, retry `enableGitHubPages` with the same
record; source creation reconciles an already successful request.

## Update

Build, review and publish the changed source to protected main. Push through
`git.pushUpstream(repoPath, { expectedMainEventId: reviewedMainEventId })`, retain
the returned `headCommit` with the new `buildId`, then observe that exact record.
Keep automatic upstream push disabled for this reviewed publication workflow.
Do not rebuild or create another repository merely because Pages is still busy.

GitHub project paths on one owner domain share a web origin. Remembered workspace
access applies to that origin, not just one repository path. A dedicated custom
origin is needed for an independent website trust identity.

Live public deployment and iOS connection acceptance still require verification
in their real environments; successful local builds and mocked API tests do not
establish those outcomes.
