/**
 * Test support for the pinned manifest fetch (ST-01a): `linkRepo` and `resyncRepo` first ask
 * GitHub for the default branch's head (`GET /repos/{o}/{r}/commits/HEAD`, `Accept:
 * application/vnd.github.sha`) and then read every `.pkey/` document `?ref=<that sha>`.
 *
 * `withDefaultHead` wraps a GitHub fetch stub so it answers that one call with a bare sha and
 * delegates everything else unchanged. Stubs that serve `/contents/<path>` by substring keep
 * working, because the pinned read only appends `?ref=…`.
 */

import type { FetchImpl } from "../src/services/release/githubApp.js";

/** The default-branch head every wrapped stub reports unless told otherwise. */
export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Whether `url` is the default-branch head lookup. */
export function isHeadLookup(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\/HEAD$/.test(
    url,
  );
}

/**
 * Answer the head lookup with `sha` (or `sha()` per call, for a branch that moves between
 * calls); pass every other request to `inner`.
 */
export function withDefaultHead(
  inner: FetchImpl,
  sha: string | (() => string) = HEAD_SHA,
): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    if (isHeadLookup(url))
      return new Response(typeof sha === "function" ? sha() : sha, {
        status: 200,
        headers: { "content-type": "application/vnd.github.sha" },
      });
    return inner(input, init);
  };
}
