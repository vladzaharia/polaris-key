/// <reference types="@cloudflare/workers-types" />

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { errorResponse, json } from "./core/errors.js";
import { pk } from "./kv.js";
import { hexDecode } from "./platform/bytes.js";
import { constantTimeEqualBytes } from "./platform/compare.js";
import { hmacSha256, importHmacKey } from "./platform/hash.js";
import { listProductsByGithubRepo, upsertProductSyncState } from "./repo.js";
import { manifestIngestFor } from "./core/registry.js";
import { systemResyncRefusal } from "./core/settingsClaims.js";
import { SERVICES } from "./mount.js";
import {
  getReleaseConfig,
  isManifestPath,
  resyncNotes,
  resyncRepo,
  syncReleaseStoreReport,
  type FetchImpl,
} from "./services/release/sync.js";

/** How long a processed `X-GitHub-Delivery` GUID is remembered (7 days). */
const DELIVERY_TTL_SECONDS = 604_800;
/** KV scope for delivery GUIDs. Not a legal product slug (`^[a-z0-9-]+$`), so it can't collide. */
const PLATFORM_SCOPE = "_platform";

interface PushPayload {
  ref?: string;
  after?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    full_name?: string;
    default_branch?: string;
    owner?: { login?: string; name?: string };
  };
  head_commit?: ChangedCommit | null;
  commits?: ChangedCommit[];
}

interface ChangedCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

/**
 * The three fields a `release` delivery is read for. Everything else in it — `release.*`
 * included — is ignored: once the secret leaks the body is attacker-shaped, and the sync
 * re-reads GitHub with the installation token rather than trusting any of it (P0-03).
 */
interface ReleasePayload {
  action?: unknown;
  installation?: { id?: unknown } | null;
  repository?: { name?: unknown; owner?: { login?: unknown } | null } | null;
}

/** The per-product result of a `release` delivery. */
interface ReleaseEventResult {
  product: string;
  ok: boolean;
  /** Truth-store statements applied; 0 when the product was refused or the sync did not run. */
  statements: number;
  error?: string;
  /**
   * GitHub release tags the sync skipped because a pack release already holds that id (P4-02:
   * `<packId>@<version>`). Never merged into the pack. Absent when none.
   */
  packTagConflicts?: string[];
  /** P4-12: the pack-set re-resolution's outcome when it failed (sets cleared) or stored sets. */
  packSets?: { ok: boolean; reason?: string; message?: string; sets?: number };
}

async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  const m = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!m || !m[1]) return false;
  const signed = await hmacSha256(await importHmacKey(secret), body);
  const presented = hexDecode(m[1]);
  return presented ? constantTimeEqualBytes(signed, presented) : false;
}

function changedPaths(payload: PushPayload): string[] {
  const paths = new Set<string>();
  const collect = (commit: ChangedCommit | null | undefined) => {
    if (!commit) return;
    for (const list of [commit.added, commit.modified, commit.removed]) {
      for (const path of list ?? []) {
        if (typeof path === "string" && path.trim()) paths.add(path);
      }
    }
  };
  collect(payload.head_commit);
  for (const commit of payload.commits ?? []) collect(commit);
  return [...paths].sort();
}

function repoCoordinates(payload: PushPayload): {
  owner: string;
  repo: string;
} | null {
  const repo = payload.repository?.name;
  const owner =
    payload.repository?.owner?.login ??
    payload.repository?.owner?.name ??
    payload.repository?.full_name?.split("/")[0];
  if (!owner || !repo) return null;
  return { owner, repo };
}

const INSTALLATION_MISMATCH = "installation id does not match the linked repo";

/**
 * Bind a delivery to the installation that owns this product's repo (R6-05). One webhook secret
 * covers every installation, so without this a single secret compromise is a cross-tenant
 * forgery capability: a delivery naming repo X must also carry the installation id that owns X.
 * Both the `push` and the `release` paths call this before writing anything for `product`.
 */
async function installationMatches(
  db: Db,
  product: string,
  installationId: unknown,
): Promise<boolean> {
  const cfg = await getReleaseConfig(db, product);
  const expected = cfg?.gh_installation_id ?? null;
  return expected === null || installationId === expected;
}

/**
 * `x-github-event: release` (P0-03). Every action — published, unpublished, created, edited,
 * deleted, prereleased, released — is handled the same way: refresh the release truth store of
 * each product linked to the repo, through the ordinary paginated, floor-aware sync.
 *
 * It deliberately does NOT re-read `.pkey/`, touch any manifest-owned row, or write
 * `product_sync_state`: that row records the MANIFEST sync, and a release event overwriting it
 * would hide a failed `.pkey/` sync. `release_health.checked_at` is the release sync's record.
 */
async function handleReleaseEvent(
  raw: Uint8Array,
  env: Env,
  db: Db,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Response> {
  let payload: ReleasePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as ReleasePayload;
  } catch {
    return errorResponse(400, "bad_request", "invalid JSON payload");
  }
  if (!payload || typeof payload !== "object") {
    return errorResponse(400, "bad_request", "invalid JSON payload");
  }
  const action = typeof payload.action === "string" ? payload.action : null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo
  ) {
    return errorResponse(400, "bad_request", "repository missing");
  }
  const installationId = payload.installation?.id;

  const products = await listProductsByGithubRepo(db, owner, repo);
  const results: ReleaseEventResult[] = [];
  for (const product of products) {
    if (!(await installationMatches(db, product.slug, installationId))) {
      results.push({
        product: product.slug,
        ok: false,
        statements: 0,
        error: INSTALLATION_MISMATCH,
      });
      continue;
    }
    // Idempotent and bounded (P0-02's capped pagination), so it is safe on every delivery;
    // bursts are not coalesced. `syncReleaseStore` never throws and applies all or nothing.
    const { statements, packTagConflicts, packSets } =
      await syncReleaseStoreReport(env, db, product.slug, now, fetchImpl);
    results.push(
      statements > 0
        ? {
            product: product.slug,
            ok: true,
            statements,
            ...(packTagConflicts.length > 0 ? { packTagConflicts } : {}),
            ...(packSets ? { packSets } : {}),
          }
        : {
            product: product.slug,
            ok: false,
            statements: 0,
            error: "release store sync did not run",
          },
    );
  }

  return json({
    ok: results.every((result) => result.ok),
    event: "release",
    action,
    results,
  });
}

export async function handleGithubWebhook(
  req: Request,
  env: Env,
  db: Db,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  if (req.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "method not allowed");
  }
  const secret =
    typeof env.GITHUB_WEBHOOK_SECRET === "string"
      ? env.GITHUB_WEBHOOK_SECRET
      : "";
  if (!secret) {
    return errorResponse(
      500,
      "server_misconfigured",
      "GITHUB_WEBHOOK_SECRET is not configured",
    );
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  const ok = await verifySignature(
    secret,
    raw,
    req.headers.get("x-hub-signature-256"),
  );
  if (!ok) return errorResponse(401, "unauthorized", "invalid signature");

  // Replay protection (R6-06). A captured delivery (body + signature) was previously an
  // unlimited-use state-rollback primitive: `resyncRepo` DELETEs and re-inserts oidc_config,
  // profiles, tiers and more, so re-posting an old delivery reverted an operator's incident
  // response. GitHub's own redelivery UI hands the App owner exactly that artifact. Recorded
  // AFTER signature verification so an unauthenticated flood can't fill KV.
  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  if (!deliveryId) {
    return errorResponse(400, "bad_request", "missing X-GitHub-Delivery");
  }
  const deliveryKey = pk(PLATFORM_SCOPE, "gh-delivery", deliveryId);
  if (await env.HOT.get(deliveryKey)) {
    return json({ ok: true, ignored: "duplicate-delivery", deliveryId });
  }
  await env.HOT.put(deliveryKey, String(now), {
    expirationTtl: DELIVERY_TTL_SECONDS,
  });

  const event = req.headers.get("x-github-event") ?? "";
  if (event === "release") {
    return handleReleaseEvent(raw, env, db, now, fetchImpl);
  }
  if (event !== "push") {
    return json({ ok: true, ignored: event || "unknown-event" });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as PushPayload;
  } catch {
    return errorResponse(400, "bad_request", "invalid JSON payload");
  }

  // A structural gate only: tags and other non-branch refs are not `.pkey/` sources. The
  // old check compared `payload.ref` against `payload.repository.default_branch` — both
  // attacker-supplied, i.e. self-attestation. The branch that actually gets applied is now
  // resolved by GitHub from the DB-configured repo (`resyncRepo` takes no ref), so nothing
  // in this body can steer which content lands. R6-05.
  if (!payload.ref?.startsWith("refs/heads/")) {
    return json({
      ok: true,
      ignored: "non-branch-ref",
      ref: payload.ref ?? null,
    });
  }

  const paths = changedPaths(payload);
  // `manifestFiles.ts` owns the shape: `.pkey/` itself, or anything under it. GitHub reports a
  // whole-directory rename as the bare path, so the bare-path case is deliberate.
  if (!paths.some(isManifestPath)) {
    return json({
      ok: true,
      ignored: "no-manifest-changes",
      changedPaths: paths,
    });
  }

  const coords = repoCoordinates(payload);
  if (!coords) return errorResponse(400, "bad_request", "repository missing");

  const products = await listProductsByGithubRepo(
    db,
    coords.owner,
    coords.repo,
  );
  const results: Array<{
    product: string;
    ok: boolean;
    updated?: string[];
    error?: string;
    errors?: string[];
    reason?: string;
  }> = [];

  const installationId = payload.installation?.id;
  for (const product of products) {
    // ST-20 (S-18 §4.5 item 8): the system product is linked to the platform monorepo, so a push
    // there names it, but its one writer is the deploy hook (the root `.pkey/` at the deployed
    // commit). Refused, without a sync-state row: nothing failed to sync.
    const systemRefusal = systemResyncRefusal(product);
    if (systemRefusal) {
      results.push({
        product: product.slug,
        ok: false,
        error: systemRefusal,
        reason: "system_product",
      });
      continue;
    }
    // Bind the delivery to the installation that owns this product's repo (R6-05).
    if (!(await installationMatches(db, product.slug, installationId))) {
      results.push({
        product: product.slug,
        ok: false,
        error: INSTALLATION_MISMATCH,
      });
      continue;
    }
    const result = await resyncRepo(
      env,
      db,
      product.slug,
      now,
      fetchImpl,
      manifestIngestFor(SERVICES),
    );
    if (result.ok) {
      await upsertProductSyncState(db, {
        product: product.slug,
        source: "webhook",
        status: "ok",
        last_checked_at: now,
        last_synced_at: now,
        commit_sha: payload.after ?? null,
        changed_paths_json: JSON.stringify(paths),
        updated_json: JSON.stringify(result.updated),
        // P3-03: parts the sync refused while applying the rest (`release_key_is_product_key`);
        // ST-01b: the console-row conflicts it kept.
        ...resyncNotes(result),
      });
      results.push({
        product: product.slug,
        ok: true,
        updated: result.updated,
        ...(result.packSets ? { packSets: result.packSets } : {}),
        // ST-20: every resync summary lists the live break-glass claims.
        ...(result.breakGlass
          ? {
              breakGlass: result.breakGlass.map((b) => ({
                key: b.key,
                expiresAt: b.expiresAt,
              })),
            }
          : {}),
      });
    } else {
      await upsertProductSyncState(db, {
        product: product.slug,
        source: "webhook",
        status: "error",
        last_checked_at: now,
        last_synced_at: null,
        commit_sha: payload.after ?? null,
        changed_paths_json: JSON.stringify(paths),
        updated_json: null,
        errors_json: result.errors ? JSON.stringify(result.errors) : null,
        message: result.error,
      });
      results.push({
        product: product.slug,
        ok: false,
        error: result.error,
        errors: result.errors,
      });
    }
  }

  return json({
    // ST-20: the system product's refusal is expected (the deploy hook is its writer), not a
    // failed sync, so it is listed without turning the delivery's answer into a failure.
    ok: results.every(
      (result) => result.ok || result.reason === "system_product",
    ),
    repository: `${coords.owner}/${coords.repo}`,
    commitSha: payload.after ?? null,
    changedPaths: paths,
    products: results,
  });
}
