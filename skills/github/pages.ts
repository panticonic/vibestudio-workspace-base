import { credentials, gatewayFetch } from "@workspace/runtime";
import {
  createGitHubClient,
  configureGitHubPagesPublication,
  observeGitHubPagesPublication,
  type GitHubPagesPublication,
} from "@workspace/integrations/github";

export type { GitHubPagesPublication };

function publicAssets(url: string, signal?: AbortSignal): Promise<Response> {
  if (!gatewayFetch)
    throw new Error(
      "GitHub Pages verification requires workspace network access",
    );
  return gatewayFetch(url, { signal });
}

/** Call after Git push and persist the exact publication input before configuration. */
export function enableGitHubPages(
  publication: GitHubPagesPublication,
  options: { credentialId: string },
) {
  const github = createGitHubClient(credentials, options);
  return configureGitHubPagesPublication(github, publication, publicAssets);
}

/** Read-only recovery: never creates repositories, pushes code, or modifies Pages. */
export function observeGitHubPages(
  publication: GitHubPagesPublication,
  options: { credentialId: string },
) {
  const github = createGitHubClient(credentials, options);
  return observeGitHubPagesPublication(github, publication, publicAssets);
}
