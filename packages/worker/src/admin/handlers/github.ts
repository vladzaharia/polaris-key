/**
 * What the Polaris Key GitHub App can read (UX-72, FLOWS.md §3.11 W22): the New Product wizard's
 * repository picker.
 *
 *   GET /api/github/repositories?q=&cursor=&limit=
 *     The App (its install page), its installations (account, repository selection, permissions,
 *     repository count) and one page of the repositories they can read, newest push first, each
 *     with `product` (the slug when a product is linked to it already, F15) and `hasManifest`
 *     (a `.pkey/product` on its default branch; probed for the page shown only, `null` when
 *     GitHub would not say). `q` filters by `owner/name`; a pasted URL or `owner/repo` matches
 *     that repository exactly. `cursor` is the next page's offset, as `nextCursor` returned it.
 *
 * Platform admin: creating a product is (F16), and the list names private repositories. The
 * App's inventory and each page's probe are cached in this isolate for 60 seconds, so a picker
 * that re-renders, searches or polls for a new installation does not re-list GitHub each time.
 * Nothing is written. An App that is not configured answers `configured: false` with empty
 * lists (the wizard then offers From scratch only); GitHub refusing answers 502.
 *
 * Rule 10: documented in `openapi/polaris-key.v3.yaml` (tag `admin`) and pinned in
 * `routeCoverage.test.ts`'s ADMIN_KIND_PATHS.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, forbidden, notFound } from "../lib/respond.js";
import {
  getAppInfo,
  listInstallationRepositories,
  listInstallations,
  probeManifests,
  type FetchImpl,
  type GithubAppInfo,
  type GithubInstallation,
  type GithubRepository,
} from "../../services/release/githubApp.js";
import {
  parseRepoUrl,
  productsByRepository,
} from "../../services/release/linkRepo.js";
import { secret } from "../../core/platform.js";

/** How long the App's inventory and a page's probe stay fresh, in seconds. */
export const REPOSITORY_CACHE_SECONDS = 60;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface Inventory {
  app: GithubAppInfo;
  installations: (GithubInstallation & { repositoryCount: number })[];
  repositories: GithubRepository[];
}

let inventoryCache: { at: number; value: Inventory } | null = null;
const probeCache = new Map<string, { at: number; value: boolean | null }>();

/** Forget the cached inventory and probes (tests; a new installation shows within 60 s anyway). */
export function resetGithubRepositoryCache(): void {
  inventoryCache = null;
  probeCache.clear();
}

async function inventory(
  env: Env,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Inventory> {
  if (inventoryCache && now - inventoryCache.at < REPOSITORY_CACHE_SECONDS)
    return inventoryCache.value;
  const [app, installs] = await Promise.all([
    getAppInfo(env, now, fetchImpl),
    listInstallations(env, now, fetchImpl),
  ]);
  const lists = await Promise.all(
    installs.map((i) =>
      listInstallationRepositories(env, i.id, now, fetchImpl),
    ),
  );
  const value: Inventory = {
    app,
    installations: installs.map((i, n) => ({
      ...i,
      repositoryCount: lists[n]!.length,
    })),
    repositories: lists.flat(),
  };
  inventoryCache = { at: now, value };
  return value;
}

/** Newest push first; never-pushed last; then by name, so the order is stable. */
function byNewestPush(a: GithubRepository, b: GithubRepository): number {
  const pa = a.pushedAt ?? -1;
  const pb = b.pushedAt ?? -1;
  if (pa !== pb) return pb - pa;
  return a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase());
}

/** `q` as a filter: a pasted URL or `owner/repo` matches exactly, anything else as a substring. */
function matcher(q: string): (r: GithubRepository) => boolean {
  const t = q.trim().toLowerCase();
  if (!t) return () => true;
  const exact = parseRepoUrl(t);
  if (exact) {
    const full = `${exact.owner}/${exact.repo}`.toLowerCase();
    return (r) => r.fullName.toLowerCase() === full;
  }
  return (r) => r.fullName.toLowerCase().includes(t);
}

async function probePage(
  env: Env,
  page: GithubRepository[],
  now: number,
  fetchImpl: FetchImpl,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const keyOf = (r: GithubRepository) =>
    `${r.installationId}:${r.fullName.toLowerCase()}:${r.pushedAt ?? ""}`;
  const missing = new Map<number, GithubRepository[]>();
  for (const r of page) {
    const hit = probeCache.get(keyOf(r));
    if (hit && now - hit.at < REPOSITORY_CACHE_SECONDS)
      out.set(r.fullName, hit.value);
    else
      missing.set(r.installationId, [
        ...(missing.get(r.installationId) ?? []),
        r,
      ]);
  }
  await Promise.all(
    [...missing].map(async ([installId, repos]) => {
      const found = await probeManifests(env, installId, repos, now, fetchImpl);
      for (const r of repos) {
        const value = found.get(`${r.owner}/${r.name}`) ?? null;
        out.set(r.fullName, value);
        // A null is GitHub not answering; it is retried on the next read, not remembered.
        if (value !== null) probeCache.set(keyOf(r), { at: now, value });
      }
    }),
  );
  return out;
}

export async function handleGithub(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (!isPlatformAdmin(env, session))
    return forbidden("platform admin required");
  if (segments.length !== 1 || segments[0] !== "repositories")
    return notFound();
  if (req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  const cursorRaw = params.get("cursor") ?? "0";
  const limitRaw = params.get("limit") ?? String(DEFAULT_LIMIT);
  const offset = /^\d{1,6}$/.test(cursorRaw) ? Number(cursorRaw) : NaN;
  const limit = /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!Number.isInteger(offset))
    return err(422, ErrorCode.BadRequest, "cursor must be a nextCursor", {
      fields: ["cursor"],
    });
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    return err(
      422,
      ErrorCode.BadRequest,
      `limit must be a whole number from 1 to ${MAX_LIMIT}`,
      { fields: ["limit"] },
    );

  if (!secret(env, "GITHUB_APP_ID") || !secret(env, "GITHUB_APP_PRIVATE_KEY"))
    return adminJson({
      configured: false,
      app: null,
      installations: [],
      repositories: [],
      total: 0,
      nextCursor: null,
    });

  let inv: Inventory;
  try {
    inv = await inventory(env, now, fetchImpl);
  } catch (e) {
    return err(
      502,
      ErrorCode.BadRequest,
      e instanceof Error ? e.message : "github listing failed",
      { reason: "github" },
    );
  }

  const matching = inv.repositories.filter(matcher(q)).sort(byNewestPush);
  const page = matching.slice(offset, offset + limit);
  const [linked, probed] = await Promise.all([
    productsByRepository(db),
    probePage(env, page, now, fetchImpl),
  ]);
  const next = offset + page.length;

  return adminJson({
    configured: true,
    app: inv.app,
    installations: inv.installations,
    repositories: page.map((r) => ({
      ...r,
      product: linked.get(r.fullName.toLowerCase()) ?? null,
      hasManifest: probed.get(r.fullName) ?? null,
    })),
    total: matching.length,
    nextCursor: next < matching.length ? String(next) : null,
  });
}
