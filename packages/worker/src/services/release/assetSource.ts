/**
 * Repo-path asset sources (HA-05; notes/S-20 §6.3 "Pull a repo path").
 *
 * A manifest asset ref like `art/icon.png` names a file in the product's OWN linked repository,
 * read at the commit being synced, through the GitHub App installation token. That works for
 * private repositories, which retires the "public assets repo" workaround (S-20 §5).
 *
 * Two reads, both `contents: read`, both against the coordinates in `release_config` (never a
 * value from the manifest or a queue message):
 *
 *   - `repoBlobLookup`: the git blob SHA of a path at a commit, from its directory listing (one
 *     call per directory, no file bodies). The planner compares it with the stored copy's blob, so
 *     a resync at a new commit that leaves the file alone enqueues nothing.
 *   - `resolveRepoAssetSource`: the raw Contents URL (`GET /repos/{o}/{r}/contents/{path}?ref=
 *     <sha>`, `Accept: application/vnd.github.raw+json`) and the token header, for `ingest`'s
 *     guarded fetch. `safeFetch` sends `authorization` on the first hop only, so a redirect never
 *     carries the token anywhere.
 */

import type { Db, Env } from "../../core/platform.js";
import { gitShaOrNull } from "../../core/manifestSnapshot.js";
import type {
  RepoBlobLookup,
  RepoPullSource,
} from "../../core/hostedAssetPulls.js";
import { readCappedText } from "../../core/readCapped.js";
import { getReleaseConfig } from "./config.js";
import {
  discoverInstallation,
  getInstallationToken,
  type FetchImpl,
} from "./githubApp.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "polaris-key-asset-puller/1";
/** A directory listing is names and SHAs only; this bounds a pathological directory. */
const MAX_LISTING_BYTES = 1024 * 1024;

const encPath = (path: string): string =>
  path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");

function contentsUrl(
  owner: string,
  repo: string,
  path: string,
  commit: string,
): string {
  const tail = path === "" ? "" : `/${encPath(path)}`;
  return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${tail}?ref=${commit}`;
}

/**
 * A blob lookup for one repo at one commit. Listings are cached per directory for the life of the
 * returned function (one plan), so N screenshots in one folder cost one call.
 */
export function repoBlobLookup(
  token: string,
  owner: string,
  repo: string,
  commit: string,
  fetchImpl: FetchImpl = fetch,
): RepoBlobLookup {
  const listings = new Map<
    string,
    Promise<Map<string, string> | "missing" | "error">
  >();
  const list = async (
    dir: string,
  ): Promise<Map<string, string> | "missing" | "error"> => {
    try {
      const res = await fetchImpl(contentsUrl(owner, repo, dir, commit), {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
      });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return "missing";
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return "error";
      }
      const body = JSON.parse(
        await readCappedText(
          res,
          MAX_LISTING_BYTES,
          (d) => new Error(`listing too large: ${d}`),
        ),
      ) as unknown;
      if (!Array.isArray(body)) return "error";
      const out = new Map<string, string>();
      for (const e of body as {
        path?: unknown;
        sha?: unknown;
        type?: unknown;
      }[])
        if (
          e &&
          e.type === "file" &&
          typeof e.path === "string" &&
          typeof e.sha === "string" &&
          gitShaOrNull(e.sha)
        )
          out.set(e.path, e.sha);
      return out;
    } catch {
      return "error";
    }
  };
  return async (path) => {
    if (!gitShaOrNull(commit)) return "error";
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    let listing = listings.get(dir);
    if (!listing) {
      listing = list(dir);
      listings.set(dir, listing);
    }
    const got = await listing;
    if (typeof got === "string") return got;
    return got.get(path) ?? "missing";
  };
}

/**
 * The raw Contents source for `path` at `commit` in `product`'s linked repository, or `null` when
 * the product has no linked repository or the App cannot mint a token for it.
 */
export async function resolveRepoAssetSource(
  env: Env,
  db: Db,
  product: string,
  path: string,
  commit: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<RepoPullSource | null> {
  if (!gitShaOrNull(commit)) return null;
  const cfg = await getReleaseConfig(db, product);
  if (!cfg?.gh_owner || !cfg.gh_repo) return null;
  const owner = cfg.gh_owner;
  const repo = cfg.gh_repo;
  let token: string;
  try {
    const installId =
      cfg.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch {
    return null;
  }
  return {
    url: contentsUrl(owner, repo, path, commit),
    headers: {
      accept: "application/vnd.github.raw+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  };
}
