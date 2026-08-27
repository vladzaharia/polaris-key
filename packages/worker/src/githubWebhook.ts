/// <reference types="@cloudflare/workers-types" />

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import { errorResponse, json } from "./core/errors.js";
import { pk } from "./kv.js";
import { listProductsByGithubRepo, upsertProductSyncState } from "./repo.js";
import {
  getReleaseConfig,
  isManifestPath,
  resyncRepo,
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

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  const m = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!m || !m[1]) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as BufferSource),
  );
  const presented = hexToBytes(m[1]);
  return presented ? timingSafeEqual(signed, presented) : false;
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
  // Both manifest directories (`manifestFiles.ts`): a push that ADDS `.polaris/product.yaml` is
  // the migration itself, and a filter that only knew `.pkey/` would ignore the one delivery
  // that mattered.
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
  }> = [];

  const installationId = payload.installation?.id;
  for (const product of products) {
    // Bind the delivery to the installation that owns this product's repo (R6-05). One
    // webhook secret covers every installation, so without this a single secret compromise
    // is a cross-tenant forgery capability.
    const cfg = await getReleaseConfig(db, product.slug);
    const expected = cfg?.gh_installation_id ?? null;
    if (expected !== null && installationId !== expected) {
      results.push({
        product: product.slug,
        ok: false,
        error: "installation id does not match the linked repo",
      });
      continue;
    }
    const result = await resyncRepo(env, db, product.slug, now, fetchImpl);
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
        errors_json: null,
        message: null,
      });
      results.push({
        product: product.slug,
        ok: true,
        updated: result.updated,
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
    ok: results.every((result) => result.ok),
    repository: `${coords.owner}/${coords.repo}`,
    commitSha: payload.after ?? null,
    changedPaths: paths,
    products: results,
  });
}
