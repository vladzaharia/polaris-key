/**
 * Fetch a linked repository's `.pkey/` documents at ONE commit (ST-01a, notes/S-18 §4.3).
 *
 * Shared by `linkRepo`, `resyncRepo` and the settings backfill (ST-01c, which also reads at a
 * stored push sha to corroborate, `readManifestFilesAt`). The default branch's head is resolved
 * once, by GitHub, from the repository coordinates alone (`resolveDefaultBranchHead`), and every
 * document is then read `?ref=<that sha>`. So:
 *
 *   - R6-05 still holds: nothing caller-supplied (no webhook `after`, no request ref) chooses the
 *     content; the ref is a value GitHub just returned for the repository's default branch;
 *   - all documents of one apply come from the same commit — a push landing between two Contents
 *     reads can no longer mix them;
 *   - the returned `sha` is a trustworthy `applied_sha` for the manifest snapshot.
 *
 * Every failure throws (a `NotFoundError` from `github.ts`, or a rate-limit error); the callers
 * turn it into their structured error and apply nothing. There is no unpinned fallback.
 */

import type { FetchImpl } from "./githubApp.js";
import { fetchRepoFile, resolveDefaultBranchHead } from "./github.js";
import { MANIFEST_FILE_NAMES, MANIFEST_FILES } from "./manifestFiles.js";

export interface PinnedManifestFiles {
  /** The commit every document was read at. */
  sha: string;
  /** Raw document text keyed by document name (`product`, `schema`, …); absent ones omitted. */
  files: Record<string, string>;
}

/** Read every manifest document at the default branch's current head. */
export async function fetchPinnedManifestFiles(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: FetchImpl,
): Promise<PinnedManifestFiles> {
  const { sha } = await resolveDefaultBranchHead(token, owner, repo, fetchImpl);
  return {
    sha,
    files: await readManifestFilesAt(token, owner, repo, sha, fetchImpl),
  };
}

/**
 * Read every manifest document at `sha`, a commit id the CALLER vouches for. The pinned read above
 * passes the head GitHub just resolved; the settings backfill (ST-01c, notes/S-18 §4.14.2 step 2)
 * passes `product_sync_state.commit_sha`, the push that last triggered a sync, as CORROBORATION
 * only: it compares the documents' digest with the pinned read's and never applies them (R6-05
 * forbids applying a manifest a webhook value chose). `sha` must already be a well-formed git
 * commit id (`gitShaOrNull`): it is the only caller-influenced part of the request.
 */
export async function readManifestFilesAt(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: FetchImpl,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of MANIFEST_FILE_NAMES) {
    // The first existing variant wins (JSON before YAML, `manifestFiles.ts`).
    for (const path of MANIFEST_FILES[name]) {
      const text = await fetchRepoFile(
        token,
        owner,
        repo,
        path,
        fetchImpl,
        sha,
      );
      if (text !== null) {
        files[name] = text;
        break;
      }
    }
  }
  return files;
}
