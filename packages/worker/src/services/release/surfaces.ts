/// <reference types="@cloudflare/workers-types" />

/**
 * Release's own surface: the changelog.
 *
 * The installer and the artifact download (`/release/dl/:version/:binary-:arch[.dmg]`) were
 * served here until P2b-04 moved every byte route into Distribution (README §3.5). Their
 * canonical paths are `/<p>/distribution/install.sh` and `/<p>/distribution/dl/…`; the old
 * `/<p>/release/…` spellings are permanent aliases the router rewrites. What only Release can do
 * for them — resolve a selector against GitHub, stream with the installation token, render the
 * installer from `release_config` — lives in `source.ts`, behind the `releaseCatalog` hook.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import type { ProductPublic } from "../../core/products.js";
import { json, notFound } from "../../core/errors.js";
import type { FetchImpl } from "./githubApp.js";
import { listReleases } from "./github.js";
import { type ChangelogEntry, extractSummary } from "./changelog.js";
import { versionFromTag } from "./channels.js";
import { isResolved, type ReleaseConfigRow } from "./config.js";
import {
  installationToken,
  serveReleaseSurface,
  type ReleaseParams,
  type SurfaceContext,
} from "./gateway.js";

/** The surface this service serves. Update owns the feed's three; Distribution the bytes. */
export type ReleaseSurfaceKind = "changelog";

/**
 * Serve a Release surface. The public entry point for the descriptor's router — and for the
 * suites that drive these handlers directly.
 */
export function handleRelease(
  req: Request,
  env: Env,
  db: Db,
  product: ProductPublic,
  kind: ReleaseSurfaceKind,
  params: ReleaseParams,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  return serveReleaseSurface(
    req,
    env,
    db,
    product,
    kind,
    params,
    fetchImpl,
    (ctx) => handleChangelog(ctx),
  );
}

async function handleChangelog({
  env,
  cfg,
  now,
  fetchImpl,
}: SurfaceContext): Promise<Response> {
  if (!isResolved(cfg)) return notFound();
  const tok = await installationToken(env, cfg, now, fetchImpl);
  const releases = await listReleases(
    tok,
    cfg.gh_owner,
    cfg.gh_repo,
    50,
    fetchImpl,
  );
  const entries: ChangelogEntry[] = releases
    .filter((r) => !r.draft)
    .map((r) => ({
      version: versionFromTag(r.tag_name),
      tag: r.tag_name,
      date: r.published_at,
      summary: extractSummary(r.body, cfg.summary_marker),
      url: r.html_url,
    }));
  return json(
    { entries },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export type { ReleaseConfigRow };
