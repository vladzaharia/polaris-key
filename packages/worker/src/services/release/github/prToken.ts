/**
 * The `githubPrToken` descriptor hook (A-32.7; plan D-G1): the token Distribution's CI exchange
 * hands to a run so it can open a pull request on the product's own tap or bucket.
 *
 * It lives beside the App in Release, which Distribution reaches only through Core's hook
 * (`core/hooks.ts`, rule 6). The token is minted per call, never cached (`mintInstallationToken`
 * does not touch the read-token cache), narrowed by GitHub to the one repository and to Contents
 * and Pull requests write, and is not logged here. Which repositories may be asked for is
 * Distribution's decision; this file only mints.
 */

import type { GithubPrToken, HookContext } from "../../../core/hooks.js";
import {
  discoverInstallation,
  mintInstallationToken,
  type FetchImpl,
} from "../githubApp.js";

/** What a pull-request token carries: the branch and file writes, and the pull request. */
export const PR_TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

/** GitHub's installation tokens last one hour from the mint. */
export const GITHUB_TOKEN_TTL_SECONDS = 3600;

/** `discoverInstallation`'s message for GitHub's 404 on `/repos/{o}/{r}/installation`. */
const NOT_INSTALLED = "github app is not installed on this repository";

export function githubPrToken(
  ctx: HookContext,
  fetchImpl: FetchImpl = fetch,
): GithubPrToken {
  return {
    async mint(owner, repo) {
      let installId: number;
      try {
        installId = await discoverInstallation(
          ctx.env,
          owner,
          repo,
          ctx.now,
          fetchImpl,
        );
      } catch (e) {
        if (e instanceof Error && e.message === NOT_INSTALLED) return null;
        throw e;
      }
      const token = await mintInstallationToken(
        ctx.env,
        installId,
        { repositories: [repo], permissions: { ...PR_TOKEN_PERMISSIONS } },
        ctx.now,
        fetchImpl,
      );
      return { token, expiresAt: ctx.now + GITHUB_TOKEN_TTL_SECONDS };
    },
  };
}
