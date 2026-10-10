/// <reference types="@cloudflare/workers-types" />

/**
 * The three trusted-publishing routes (P2-02, README §3.4 "Publishing"), in the release namespace
 * because publishing is "into release" — a product with Release off does not have them.
 *
 *   POST /<p>/release/publish/token    GitHub OIDC JWT in → `{token, expiresAt, scopes}`
 *   POST /<p>/release/publish/uploads  `pkeyci_` + release:publish, `{objects:[{sha256,size}],
 *                                      releases?:[{deliverable,version}], deliverable?}` → a
 *                                      ticket, R2 temporary credentials for
 *                                      `staging/<p>/<ticketId>/`, which objects are `present`,
 *                                      `nextSeq`, and (P3-03) each named release's `seq` in
 *                                      `seqs`. With `deliverable` (a pack id, P4-22), `present`
 *                                      means that pack uploaded the object itself
 *   POST /<p>/release/publish/submit   `pkeyci_` + release:publish, `{ticket, descriptor, record?,
 *                                      dryRun?}` → verify every staged object, check the
 *                                      CI-signed release record (P3-03), promote, ingest; or
 *                                      (P4-02) `{ticket?, record, dryRun?}` with no descriptor:
 *                                      a pack release (`packs/publish.ts`)
 *   POST /<p>/release/publish/stage    `pkeyci_` + release:publish, `{ticket, deliverable}` → a
 *                                      stage round of a pack's objects (P4-02)
 *
 * Binaries never transit the Worker: CI PUTs them to R2 with the ticket's credentials, and the
 * Worker only verifies and promotes (`core/blobs.ts`). The credential store, the OIDC checks and
 * the tickets are Core's (`core/publisher.ts`); the descriptor rules are `descriptor.ts`'s.
 *
 * ── WHAT CI IS NEVER TOLD ───────────────────────────────────────────────────────────────────
 *
 * Whether an object it uploads was already stored by ANOTHER product. `present` comes from
 * `referencedKeys` (this product's refs only), and a submit answers identically whether
 * `promote` copied the bytes or found them `alreadyStored` (THREAT-MODEL §3).
 *
 * ── THE SUBMIT, IN ORDER ────────────────────────────────────────────────────────────────────
 *
 *  1. The ticket: this product's, held by this token, unexpired, unredeemed.
 *  2. Every `r2` location the product does not already reference must be an object of the ticket,
 *     and its staged copy must verify (present, right size, right SHA-256). A failure here
 *     promotes nothing.
 *  3. The descriptor is planned as a dry run, with the verified objects treated as promoted —
 *     so every descriptor refusal also happens before anything is promoted. Then the release
 *     record, when the submit carries one (`records.ts`, `release_record_rejected`): it must be
 *     the descriptor, signed by a declared release key, with the release's `seq`. `dryRun: true`
 *     stops here. A dry run may precede the uploads (P2-06's `--dry-run` uploads nothing): a ticket
 *     object not yet staged is then judged as if it were, and listed in `unverified`.
 *  4. The ticket is claimed (atomically, one submit), the objects promoted, and the descriptor
 *     ingested with them as `promoted`, with the record in the same batch. A failure gives the
 *     claim back, so CI can fix and resend. A record is never rewritten: a re-run whose release
 *     already holds one keeps it (`record.stored: false`).
 *
 * One descriptor per submit, by design: a path that planned several in one batch would have to
 * plan them in publication order with `seqFloor` (P2-04 hand-off (c)); submit never does.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, ErrorCode, json, notFound } from "../../core/errors.js";
import {
  readCiJson,
  requireCiScope,
  ciActor,
  type CiScope,
} from "../../core/ciScope.js";
import { rateLimitOk, clientNetwork } from "../../core/rateLimit.js";
import {
  blobKey,
  parseKey,
  promote,
  referencedKeys,
  stagingKey,
  verifyStaged,
} from "../../core/blobs.js";
import {
  claimUploadTicket,
  exchangeOidcToken,
  findUploadTicket,
  issueUploadTicket,
  mintUploadCredentials,
  parseTicketObjects,
  publishAudience,
  r2Parent,
  releaseUploadTicket,
  ticketPrefix,
  type CiTokenRecord,
  type JwksFetcher,
} from "../../core/publisher.js";
import { appendAudit } from "../../repo.js";
import { randomId } from "../../crypto.js";
import {
  APP_DELIVERABLE_ID,
  MAX_DESCRIPTOR_BYTES,
} from "@polaris-key/manifest";
import { MAX_RECORD_JWS_BYTES } from "@polaris-key/protocol/core";
import {
  ingestReleaseDescriptor,
  readAppDeliverable,
  type IngestResult,
} from "./descriptor.js";
import { bumpReleaseGeneration } from "./ghCache.js";
import { readPackDeliverableIds } from "./packs/deliverables.js";
import { packUploadedKeys } from "./packs/ingest.js";
import type { CheckCache } from "./packs/checks.js";
import {
  distributionDisabled,
  handlePackSubmit,
  handleStageRound,
} from "./packs/publish.js";
import { getReleaseConfig } from "./config.js";
import { resolveChannelReleases } from "./resolve.js";
import { handleDelegationsRead } from "./packs/delegations.js";
import {
  ingestPackageDescriptor,
  isPackageDescriptor,
  type PackageIngestResult,
  type PackageSource,
} from "./packages/ingest.js";
import {
  checkReleaseRecord,
  getRecordForRelease,
  RELEASE_RECORD_REJECTED,
  stmtInsertReleaseRecord,
  type RecordCheck,
} from "./records.js";

/** The token request carries one JWT. */
const MAX_TOKEN_BODY_BYTES = 16 * 1024;
/** A ticket request: up to 256 `{sha256, size, gated}` entries. */
const MAX_UPLOADS_BODY_BYTES = 64 * 1024;
/** A submit: the descriptor, the release record (P3-03), the ticket and a flag. */
const MAX_SUBMIT_BODY_BYTES =
  Math.max(
    MAX_DESCRIPTOR_BYTES + MAX_RECORD_JWS_BYTES,
    // P4-19: a revocation submitted with the delegation it revokes carries two records.
    2 * MAX_RECORD_JWS_BYTES,
  ) +
  4 * 1024;
/** At most this many releases per ticket request's `releases` (P3-03). */
const MAX_TICKET_RELEASES = 16;
/** `@polaris-key/manifest`'s deliverable and version shapes, for the `releases` entries. */
const DELIVERABLE_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * Budgets on the token exchange (both fail closed: it mints credentials). The per-IP one is
 * charged first, on every request; the per-product one only once a token has passed the
 * signature, audience and publisher-policy checks (see `handleToken`).
 */
const TOKEN_RL_PER_IP = { limit: 30, windowSec: 60 };
const TOKEN_RL_PER_PRODUCT = { limit: 120, windowSec: 60 };

/** Test seam: the JWKS fetcher the token route uses (`null` = GitHub's). */
let jwksFetcherOverride: JwksFetcher | null = null;
export function setPublishJwksFetcherForTests(f: JwksFetcher | null): void {
  jwksFetcherOverride = f;
}

/** `rest` after `/release`: `["publish", "token" | "uploads" | "submit"]`. */
export async function handlePublishRoute(
  ctx: ServiceContext,
  action: string,
): Promise<Response | null> {
  if (ctx.req.method !== "POST") return null;
  if (action === "token") return handleToken(ctx);
  if (action === "uploads") return handleUploads(ctx);
  if (action === "submit") return handleSubmit(ctx);
  if (action === "stage") return handleStage(ctx);
  if (action === "delegations") return handleDelegations(ctx);
  return null;
}

// ── POST /<p>/release/publish/delegations (P4-19) ───────────────────────────────────────────

/** The product's delegations, for `pkey release delegate` (plans/P4-19.md §6.3). Same token,
 *  scope and body cap as `uploads`; no blob store needed (a delegation is a signature). */
async function handleDelegations(ctx: ServiceContext): Promise<Response> {
  const holder = await requirePublisher(ctx);
  if (holder instanceof Response) return holder;
  const body = await readCiJson(ctx.req, MAX_UPLOADS_BODY_BYTES);
  if (body instanceof Response) return body;
  return handleDelegationsRead(ctx, body);
}

// ── POST /<p>/release/publish/stage (P4-02) ─────────────────────────────────────────────────

/** A stage round of a pack's objects (`packs/publish.ts`); same token, scope and body cap as
 *  `uploads`. */
async function handleStage(ctx: ServiceContext): Promise<Response> {
  if (!ctx.env.BLOBS) return notFound();
  const holder = await requirePublisher(ctx);
  if (holder instanceof Response) return holder;
  const body = await readCiJson(ctx.req, MAX_UPLOADS_BODY_BYTES);
  if (body instanceof Response) return body;
  return handleStageRound(ctx, holder, body);
}

function refusal(
  status: number,
  code: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return errorResponse(status, code, message, { reason, ...extra });
}

function codeFor(status: number): string {
  if (status === 401) return ErrorCode.Unauthorized;
  if (status === 403) return ErrorCode.Forbidden;
  if (status === 404) return ErrorCode.NotFound;
  return ErrorCode.BadRequest;
}

/** The principal `requireCiScope` answered, as the token record the store returns. */
function asTokenRecord(p: unknown): CiTokenRecord | null {
  return p && typeof p === "object" && "tokenHash" in p && "expiresAt" in p
    ? (p as CiTokenRecord)
    : null;
}

async function requirePublisher(
  ctx: ServiceContext,
  scopes: readonly CiScope[] = ["release:publish"],
): Promise<CiTokenRecord | Response> {
  const principal = await requireCiScope(
    ctx.req,
    ctx.env,
    ctx.db,
    ctx.product.slug,
    scopes,
    ctx.now,
  );
  if (principal instanceof Response) return principal;
  const record = asTokenRecord(principal);
  if (!record)
    return refusal(
      401,
      ErrorCode.Unauthorized,
      "invalid_ci_token",
      "unknown, expired or revoked CI token",
    );
  return record;
}

// ── POST /<p>/release/publish/token ─────────────────────────────────────────────────────────

async function handleToken(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  // Per IP, before anything: an anonymous flood only ever spends the flooder's own budget.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "ciPublishToken",
        id: `ip:${clientNetwork(req)}`,
        ...TOKEN_RL_PER_IP,
      },
      now,
    ))
  )
    return refusal(
      429,
      "rate_limited",
      "rate_limited",
      "too many token requests",
    );

  const body = await readCiJson(req, MAX_TOKEN_BODY_BYTES);
  if (body instanceof Response) return body;
  if (typeof body.token !== "string" || body.token === "")
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "token must be the GitHub Actions OIDC token (a JWT)",
    );
  const result = await exchangeOidcToken(env, db, {
    product: product.slug,
    oidcToken: body.token,
    audience: publishAudience(new URL(req.url).origin, product.slug),
    now,
    ...(jwksFetcherOverride ? { fetchJwks: jwksFetcherOverride } : {}),
    // Per product, charged only AFTER the signature, audience and publisher policy pass: only
    // the product's own declared workflow can spend it, so nobody else can exhaust it and lock
    // the product's CI out (the rule the RFC 8628 paragraph of THREAT-MODEL states).
    admit: () =>
      rateLimitOk(
        env,
        product.slug,
        {
          bucket: "ciPublishTokenProduct",
          id: "product",
          ...TOKEN_RL_PER_PRODUCT,
        },
        now,
      ),
  });
  if (!result.ok)
    return refusal(
      result.status,
      result.status === 429 ? "rate_limited" : codeFor(result.status),
      result.reason,
      result.message,
      result.claim ? { claim: result.claim } : {},
    );
  return json({
    token: result.token,
    expiresAt: result.expiresAt,
    scopes: result.scopes,
  });
}

// ── POST /<p>/release/publish/uploads ───────────────────────────────────────────────────────

async function handleUploads(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  // No blob store or no parent R2 token in this environment: there is nothing to upload to, and
  // the route does not exist (the brief's "answers not-found" until the operator sets them).
  const parent = r2Parent(env);
  if (!env.BLOBS || !parent) return notFound();

  // A ticket also carries the F-Droid repository files `pkey feeds fdroid` uploads (P2b-05):
  // `distribution:feeds` buys one too. Only the submit (`release:publish`) ingests a release, and
  // only the feed register (`distribution:feeds`) registers feed files, each redeeming its own.
  // So does `distribution:listing` (A-18d), for the listing assets `pkey listing assets` derived;
  // only the listing register redeems that ticket. And `assets:write` (HA-06), for the files
  // `pkey assets push` hosts; only `POST /<p>/assets` redeems that one.
  const holder = await requirePublisher(ctx, [
    "release:publish",
    "distribution:feeds",
    "distribution:listing",
    "assets:write",
  ]);
  if (holder instanceof Response) return holder;
  const body = await readCiJson(req, MAX_UPLOADS_BODY_BYTES);
  if (body instanceof Response) return body;
  const releases = parseTicketReleases(body.releases);
  if ("error" in releases)
    return refusal(400, ErrorCode.BadRequest, "bad_releases", releases.error);
  // The preflight (P4-02, plans/P4-01.md §6): a request naming releases may omit `objects`, and
  // then issues no ticket and answers only `seqs` — each release's seq, its record's hash when it
  // exists, and a pack's delivery gate, all before CI builds or uploads anything. An `objects`
  // array that is present stays non-empty (P2-02).
  const preflight = body.objects === undefined && releases.length > 0;
  const objects = preflight ? [] : parseTicketObjects(body.objects);
  if ("error" in objects)
    return refusal(400, ErrorCode.BadRequest, "bad_objects", objects.error);
  const gates = await packGatesFor(ctx, releases);
  if (gates instanceof Response) return gates;
  // P4-22: a pack's ticket names its pack, and `present` then means a `pack-upload` ref of THAT
  // pack (what its stage round skips and its chunk ingest requires), never only the product's.
  const deliverable = body.deliverable;
  if (deliverable !== undefined) {
    const packIds = await readPackDeliverableIds(db, product.slug);
    if (typeof deliverable !== "string" || !packIds.includes(deliverable))
      return refusal(
        400,
        ErrorCode.BadRequest,
        "unknown_pack_deliverable",
        "deliverable, when given, must be a pack deliverable this product declares in .pkey/release",
      );
  }

  const nextSeq = await nextSeqByDeliverable(ctx);
  if (preflight)
    return json({ seqs: await seqsFor(ctx, releases, nextSeq, gates) });
  const issued = await issueUploadTicket(env, db, {
    product: product.slug,
    holder,
    objects,
    now,
  });
  const targets = objects.map((o) => blobKey(o.sha256, { gated: o.gated }));
  // THIS product's refs only — never `blob_objects` (THREAT-MODEL §3: a ref is earned per
  // product, and another product's copy must neither be revealed nor skip the upload).
  const owned =
    typeof deliverable === "string"
      ? await packUploadedKeys(db, product.slug, deliverable, targets)
      : await referencedKeys(db, product.slug, targets);
  const credentials = await mintUploadCredentials(
    parent,
    ticketPrefix(product.slug, issued.ticketId),
    now,
    issued.expiresAt,
  );
  return json({
    ticket: issued.ticket,
    expiresAt: issued.expiresAt,
    credentials: {
      endpoint: credentials.endpoint,
      bucket: credentials.bucket,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    prefix: ticketPrefix(product.slug, issued.ticketId),
    objects: objects.map((o, i) => ({
      sha256: o.sha256,
      size: o.size,
      gated: o.gated,
      key: stagingKey(product.slug, issued.ticketId, o.sha256),
      target: targets[i],
      present: owned.has(targets[i]!),
    })),
    nextSeq,
    seqs: await seqsFor(ctx, releases, nextSeq, gates),
  });
}

/**
 * The delivery gate of every PACK among `releases` (P4-02, decision 35), by pack id, read
 * through Distribution's `delivery.entitlement` (never `dist_access` directly: rule 6). A
 * release of a pack while Distribution is off is refused `distribution_disabled`: the pack could
 * not be served anyway, and its gate is unknown.
 */
async function packGatesFor(
  ctx: ServiceContext,
  releases: readonly { deliverable: string }[],
): Promise<Map<string, string | null> | Response> {
  const gates = new Map<string, string | null>();
  const packIds = new Set(
    await readPackDeliverableIds(ctx.db, ctx.product.slug),
  );
  for (const r of releases) {
    if (!packIds.has(r.deliverable) || gates.has(r.deliverable)) continue;
    const delivery = ctx.hooks.delivery();
    if (!delivery) return distributionDisabled(r.deliverable);
    gates.set(r.deliverable, await delivery.entitlement(r.deliverable));
  }
  return gates;
}

/** `releases` (P3-03): the releases CI is about to publish, so it can sign each one's `seq`. */
function parseTicketReleases(
  raw: unknown,
): { deliverable: string; version: string }[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TICKET_RELEASES)
    return {
      error: `releases must be an array of at most ${MAX_TICKET_RELEASES} {deliverable, version} entries`,
    };
  const out: { deliverable: string; version: string }[] = [];
  for (const entry of raw) {
    const e = entry as { deliverable?: unknown; version?: unknown } | null;
    if (
      !e ||
      typeof e !== "object" ||
      typeof e.deliverable !== "string" ||
      e.deliverable.length > 64 ||
      !DELIVERABLE_ID_RE.test(e.deliverable) ||
      typeof e.version !== "string" ||
      !VERSION_RE.test(e.version)
    )
      return {
        error:
          "each releases entry must be {deliverable, version} with a deliverable id and a version",
      };
    out.push({ deliverable: e.deliverable, version: e.version });
  }
  return out;
}

/**
 * Each named release's `seq`: the stored one when the release exists (the GitHub sync may have
 * created it first, and P2-04's ingest refuses any other), else the next one for its
 * deliverable — counting the new releases named before it in the same request. A re-run asks
 * again and gets the stored value, so it stays idempotent; two publishes racing for one new
 * `seq` meet at ingest (`seq_not_increasing`) and CI retries with a new ticket. That is for the
 * releases whose signed record carries the seq (app, packs). A package release is never signed,
 * so `pkey` sends its descriptor without a `seq` and the ingest takes the next one at insert:
 * a `main` prerelease and a tag's stable release of one package can then publish concurrently
 * in either order (the v0.8.22 `npm.zstd-wasm` refusal).
 */
async function seqsFor(
  ctx: ServiceContext,
  releases: readonly { deliverable: string; version: string }[],
  nextSeq: Record<string, number>,
  gates: ReadonlyMap<string, string | null>,
): Promise<SeqAnswer[]> {
  const out: SeqAnswer[] = [];
  const next = { ...nextSeq };
  for (const r of releases) {
    // A pack's entry carries its delivery gate (P4-02): CI stages under it and signs it.
    const gate = gates.has(r.deliverable)
      ? { entitlement: gates.get(r.deliverable) ?? null }
      : {};
    const row = await ctx.db.first<{
      seq: number | null;
      record: string | null;
    }>(
      `SELECT m.seq AS seq,
              (SELECT record_sha256 FROM release_records x
                WHERE x.product = m.product AND x.release_id = m.release_id) AS record
         FROM release_metadata m
        WHERE m.product = ? AND m.deliverable_id = ? AND m.version = ? AND m.seq IS NOT NULL
        ORDER BY m.seq DESC LIMIT 1`,
      ctx.product.slug,
      r.deliverable,
      r.version,
    );
    if (row?.seq != null) {
      // An existing release's record hash (P4-02): resolves `--pin <packId>@<version>` and
      // proves CI's cached delta bases.
      out.push({
        ...r,
        seq: row.seq,
        ...(row.record ? { recordSha256: row.record } : {}),
        ...gate,
      });
      continue;
    }
    const seq = next[r.deliverable] ?? 1;
    next[r.deliverable] = seq + 1;
    out.push({ ...r, seq, ...gate });
  }
  return out;
}

/** One `seqs[]` entry of the uploads answer. */
interface SeqAnswer {
  deliverable: string;
  version: string;
  seq: number;
  /** The stored release's record hash, when it has one (P4-02). */
  recordSha256?: string;
  /** A pack's delivery gate, `null` when ungated (P4-02, decision 35). */
  entitlement?: string | null;
}

/** Each deliverable's highest seq + 1 at issue time (`app` always present). */
async function nextSeqByDeliverable(
  ctx: ServiceContext,
): Promise<Record<string, number>> {
  const rows = await ctx.db.all<{ deliverable_id: string; m: number | null }>(
    `SELECT d.deliverable_id AS deliverable_id,
            (SELECT MAX(seq) FROM release_metadata r
              WHERE r.product = d.product AND r.deliverable_id = d.deliverable_id) AS m
       FROM release_deliverables d WHERE d.product = ?
     UNION
     SELECT deliverable_id, MAX(seq) FROM release_metadata
      WHERE product = ? AND deliverable_id IS NOT NULL GROUP BY deliverable_id`,
    ctx.product.slug,
    ctx.product.slug,
  );
  const out: Record<string, number> = { app: 1 };
  for (const r of rows)
    out[r.deliverable_id] = Math.max(
      out[r.deliverable_id] ?? 1,
      (r.m ?? 0) + 1,
    );
  return out;
}

// ── POST /<p>/release/publish/submit ────────────────────────────────────────────────────────

interface R2Location {
  key: string;
  sha256: string;
  size: number;
}

/**
 * The `r2` locations a descriptor names, read defensively (the descriptor is validated by the
 * ingest's plan; this only decides which staged objects to verify). Entries that are not even
 * shaped like one are skipped — the plan refuses them.
 */
function r2Locations(descriptor: unknown): R2Location[] {
  const out: R2Location[] = [];
  const builds = (descriptor as { builds?: unknown } | null)?.builds;
  // A package release's files are its `package.files` (F-03), one flat list.
  const files = (descriptor as { package?: { files?: unknown } } | null)
    ?.package?.files;
  const groups: unknown[] = [
    ...(Array.isArray(builds) ? builds : []),
    ...(Array.isArray(files) ? [{ artifacts: files }] : []),
  ];
  for (const b of groups) {
    const artifacts = (b as { artifacts?: unknown } | null)?.artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const a of artifacts) {
      const art = a as {
        sha256?: unknown;
        size?: unknown;
        locations?: unknown;
      } | null;
      if (
        !art ||
        typeof art.sha256 !== "string" ||
        typeof art.size !== "number" ||
        !Array.isArray(art.locations)
      )
        continue;
      for (const l of art.locations) {
        const loc = l as { provider?: unknown; key?: unknown } | null;
        if (loc?.provider === "r2" && typeof loc.key === "string")
          out.push({ key: loc.key, sha256: art.sha256, size: art.size });
      }
    }
  }
  return out;
}

function ingestRefusal(r: Extract<IngestResult, { ok: false }>): Response {
  return refusal(r.status, r.code, r.reason, r.message, {
    ...(r.errors ? { errors: r.errors } : {}),
    ...(r.retryable ? { retryable: true } : {}),
  });
}

async function handleSubmit(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  const bucket = env.BLOBS;
  if (!bucket) return notFound();

  const holder = await requirePublisher(ctx);
  if (holder instanceof Response) return holder;
  const body = await readCiJson(req, MAX_SUBMIT_BODY_BYTES);
  if (body instanceof Response) return body;
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "dryRun must be a boolean",
    );
  // A pack release (P4-02): a record and no descriptor, the record being the whole truth.
  if (body.descriptor === undefined && body.record !== undefined)
    return handlePackSubmit(ctx, holder, body);
  if (!body.descriptor || typeof body.descriptor !== "object")
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "descriptor must be a release descriptor object",
    );
  if (
    body.record !== undefined &&
    (typeof body.record !== "string" || body.record === "")
  )
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "record must be the compact JWS of the release record (pkey-release+jws)",
    );
  const dryRun = body.dryRun === true;
  // P4-20: the app's content-interface fingerprint, unsigned release metadata (never a record
  // member): stored with the release and compared by the CLI with the channel's current one.
  if (
    body.contentInterface !== undefined &&
    (typeof body.contentInterface !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.contentInterface))
  )
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "contentInterface must be the 64-hex SHA-256 of the app's content-interface registry",
    );
  const contentInterface =
    typeof body.contentInterface === "string" ? body.contentInterface : null;
  // F-03: a package release is never signed (plans/F-01.md §2), and carries no app fingerprint.
  const isPackage = isPackageDescriptor(body.descriptor);
  if (isPackage && body.record !== undefined)
    return refusal(
      400,
      RELEASE_RECORD_REJECTED,
      "package-unsigned",
      "a package release carries no release record: package versions are never signed (the package feeds and each ecosystem's own integrity checks serve them), so publish the descriptor alone.",
    );
  if (isPackage && contentInterface !== null)
    return refusal(
      400,
      ErrorCode.BadRequest,
      "bad_body",
      "contentInterface is an app release's; a package release carries none",
    );

  // 1. The ticket.
  const found = await findUploadTicket(env, db, {
    ticket: body.ticket,
    product: product.slug,
    holder,
    now,
  });
  if (!found.ok)
    return refusal(
      found.status,
      codeFor(found.status),
      found.reason,
      found.message,
    );
  const ticket = found.ticket;

  // 2. Which staged objects this submit needs, and that each one verifies.
  const locations = r2Locations(body.descriptor);
  const owned = await referencedKeys(
    db,
    product.slug,
    locations.map((l) => l.key),
  );
  const needed = new Map<
    string,
    { sha256: string; size: number; staging: string }
  >();
  for (const loc of locations) {
    if (owned.has(loc.key) || needed.has(loc.key)) continue;
    const parsed = parseKey(loc.key);
    // Not a content-addressed blob key for this artifact's hash: the plan refuses it
    // (`r2_key_not_content_addressed`), so there is nothing to stage for it.
    if (
      !parsed ||
      parsed.area !== "locked" ||
      parsed.kind !== "blob" ||
      parsed.sha256 !== loc.sha256
    )
      continue;
    const inTicket = ticket.objects.some(
      (o) =>
        o.sha256 === loc.sha256 &&
        o.size === loc.size &&
        o.gated === parsed.gated,
    );
    if (!inTicket)
      return refusal(
        400,
        ErrorCode.BadRequest,
        "object_not_in_ticket",
        `${loc.key} is not an object of this ticket (request it in the uploads call)`,
        { key: loc.key },
      );
    needed.set(loc.key, {
      sha256: loc.sha256,
      size: loc.size,
      staging: stagingKey(product.slug, ticket.ticketId, loc.sha256),
    });
  }
  // A dry run may come BEFORE the uploads (`pkey release publish --dry-run` uploads nothing): an
  // object of the ticket not yet staged is judged as if it were, and named in `unverified`. A
  // staged copy that IS there must still verify. Nothing here depends on another product's
  // objects — a pending key is judged by the ticket alone (THREAT-MODEL §3).
  const unverified: string[] = [];
  for (const [key, n] of needed) {
    const v = await verifyStaged(bucket, n.staging, {
      sha256: n.sha256,
      size: n.size,
    });
    if (!v.ok && dryRun && v.reason === "missing") {
      unverified.push(key);
      continue;
    }
    if (!v.ok)
      return refusal(
        400,
        ErrorCode.BadRequest,
        v.reason === "missing"
          ? "staged_object_missing"
          : "staged_object_mismatch",
        v.reason === "missing"
          ? `${n.staging} was not uploaded`
          : `${n.staging} does not have the descriptor's sha256 and size`,
        {
          key,
          staged: n.staging,
          ...(v.reason === "missing" ? {} : { detail: v.reason }),
        },
      );
  }

  // F-03: a package release takes its own ingest from here (`packages/ingest.ts`).
  if (isPackage)
    return finishPackageSubmit(ctx, {
      holder,
      bucket,
      ticketHash: ticket.ticketHash,
      needed,
      unverified,
      dryRun,
      descriptor: body.descriptor,
    });

  // 3. The descriptor, judged as the real submit will judge it, before anything is promoted.
  const pending = new Map(
    [...needed].map(([k, n]) => [k, { sha256: n.sha256, size: n.size }]),
  );
  // One memo for both plans of this request: the pack-set check resolves once (P4-12).
  const packCache: CheckCache = new Map();
  const plan = await ingestReleaseDescriptor(
    db,
    env,
    product.slug,
    body.descriptor,
    {
      source: "ci",
      now,
      dryRun: true,
      pendingPromotion: pending,
      packCache,
    },
  );
  if (!plan.ok) return ingestRefusal(plan);

  // 3b. The release record (P3-03), before anything is promoted or stored.
  let record: Extract<RecordCheck, { ok: true }> | null = null;
  if (body.record !== undefined) {
    const checked = await checkReleaseRecord(db, {
      product: product.slug,
      jws: body.record,
      descriptor: plan.descriptor,
      cfg: await getReleaseConfig(db, product.slug),
      app: await readAppDeliverable(db, product.slug),
      seq: plan.seq,
    });
    if (!checked.ok) return recordRefusal(checked);
    record = checked;
  }
  // P4-20: the fingerprint belongs to an app release; the answer names the channel's current one.
  let interfaceAnswer: Record<string, unknown> = {};
  if (contentInterface !== null) {
    if (plan.descriptor.deliverable !== APP_DELIVERABLE_ID)
      return refusal(
        400,
        ErrorCode.BadRequest,
        "bad_body",
        "contentInterface is an app release's; a pack release carries none",
      );
    interfaceAnswer = {
      contentInterface: {
        sha256: contentInterface,
        previous: await currentContentInterface(
          ctx,
          plan.descriptor.channel ?? "stable",
          plan.releaseId,
        ),
      },
    };
  }
  if (dryRun)
    return json({
      ok: true,
      dryRun: true,
      releaseId: plan.releaseId,
      outcome: plan.outcome,
      descriptorSha256: plan.descriptorSha256,
      planned: plan.planned,
      unverified,
      ...(record ? { record: { sha256: record.sha256, kid: record.kid } } : {}),
      ...(plan.packSets ? { packSets: plan.packSets } : {}),
      ...interfaceAnswer,
    });

  // 4. Claim, promote, ingest.
  if (!(await claimUploadTicket(db, ticket.ticketHash, now)))
    return refusal(
      409,
      ErrorCode.BadRequest,
      "ticket_redeemed",
      "this upload ticket was already redeemed",
    );
  for (const [key, n] of needed) {
    const res = await promote(
      bucket,
      n.staging,
      key,
      { sha256: n.sha256, size: n.size },
      { db, now, product: product.slug },
    );
    // `res.alreadyStored` is deliberately never read here: CI is answered the same either way.
    if (!res.ok) {
      await releaseUploadTicket(db, ticket.ticketHash, now);
      const reason =
        res.reason === "missing"
          ? "staged_object_missing"
          : res.reason === "size_mismatch" || res.reason === "digest_mismatch"
            ? "staged_object_mismatch"
            : "promote_failed";
      return refusal(
        reason === "promote_failed" ? 409 : 400,
        ErrorCode.BadRequest,
        reason,
        `${n.staging} could not be promoted (${res.reason})`,
        {
          key,
          staged: n.staging,
          ...(reason === "promote_failed" ? { retryable: true } : {}),
        },
      );
    }
  }
  const checkedRecord = record;
  const result = await ingestReleaseDescriptor(
    db,
    env,
    product.slug,
    body.descriptor,
    {
      source: "ci",
      now,
      promoted: needed.keys(),
      packCache,
      ...(checkedRecord || contentInterface !== null
        ? {
            extraStatements: (p) => [
              ...(checkedRecord
                ? [
                    stmtInsertReleaseRecord({
                      product: product.slug,
                      releaseId: p.releaseId,
                      deliverableId: p.deliverableId,
                      descriptorSha256: p.descriptorSha256,
                      check: checkedRecord,
                      now,
                    }),
                  ]
                : []),
              ...(contentInterface !== null
                ? [
                    {
                      sql: "UPDATE release_metadata SET content_interface = ? WHERE product = ? AND release_id = ?",
                      params: [contentInterface, product.slug, p.releaseId],
                    },
                  ]
                : []),
            ],
          }
        : {}),
    },
  );
  if (!result.ok) {
    await releaseUploadTicket(db, ticket.ticketHash, now);
    return ingestRefusal(result);
  }
  // The record, as stored: this one, or the release's earlier one (never rewritten). None is
  // not expected — the record check requires the descriptor's explicit seq, so a seq race is
  // refused by the ingest above and stores nothing — but if the release was stored without its
  // record anyway, it is still a stored publish: spent copies cleaned, audited, generation
  // bumped, and only then answered `seq` (retryable: a re-run attaches the record).
  let storedRecord: { sha256: string; stored: boolean } | null = null;
  let recordLost = false;
  if (checkedRecord) {
    const row = await getRecordForRelease(db, product.slug, result.releaseId);
    if (row)
      storedRecord = {
        sha256: row.record_sha256,
        stored: row.record_sha256 === checkedRecord.sha256,
      };
    else recordLost = true;
  }

  // The staged copies are spent; the bucket's one-day rule would take them anyway.
  if (needed.size > 0) {
    try {
      await bucket.delete([...needed.values()].map((n) => n.staging));
    } catch {
      // Best effort.
    }
  }
  if (result.outcome !== "unchanged") {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: ciActor(holder),
      actor_name: "CI",
      actor_email: null,
      action: "release.publish",
      target_kind: "release",
      target_id: result.releaseId,
      parent_id: null,
      summary: `Published ${result.releaseId} (${result.outcome}) through trusted publishing${storedRecord?.stored ? ` with release record ${storedRecord.sha256.slice(0, 12)}` : ""}`,
    });
    await bumpReleaseGeneration(env, product.slug, now);
  } else if (storedRecord?.stored) {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: ciActor(holder),
      actor_name: "CI",
      actor_email: null,
      action: "release.record",
      target_kind: "release",
      target_id: result.releaseId,
      parent_id: null,
      summary: `Stored release record ${storedRecord.sha256.slice(0, 12)} for ${result.releaseId}`,
    });
    await bumpReleaseGeneration(env, product.slug, now);
  }
  if (recordLost)
    return refusal(
      409,
      RELEASE_RECORD_REJECTED,
      "seq",
      `${result.releaseId} was stored, but not with the record's seq, so its record was not; ask the upload route for its seq and publish again to attach one.`,
      { retryable: true, releaseId: result.releaseId },
    );
  return json({
    ok: true,
    dryRun: false,
    releaseId: result.releaseId,
    outcome: result.outcome,
    descriptorSha256: result.descriptorSha256,
    ...(storedRecord ? { record: storedRecord } : {}),
    ...(result.packSets ? { packSets: result.packSets } : {}),
    ...interfaceAnswer,
  });
}

/**
 * The rest of a package release's submit (F-03): plan it as a dry run (every refusal before
 * anything is promoted), then claim the ticket, promote, ingest, audit. The same steps 3 and 4 as
 * an app release's, through the package ingest and with no record.
 */
async function finishPackageSubmit(
  ctx: ServiceContext,
  s: {
    holder: CiTokenRecord;
    bucket: R2Bucket;
    ticketHash: string;
    needed: Map<string, { sha256: string; size: number; staging: string }>;
    unverified: string[];
    dryRun: boolean;
    descriptor: unknown;
  },
): Promise<Response> {
  const { db, env, product, now } = ctx;
  const descriptor = s.descriptor;
  const eco = (descriptor as { package?: { ecosystem?: unknown } } | null)
    ?.package?.ecosystem;
  const delivery = ctx.hooks.delivery();
  const feed = delivery
    ? typeof eco === "string"
      ? await delivery.packageFeed(eco)
      : null
    : undefined;
  const source: PackageSource = {
    kind: s.holder.kind,
    ...(s.holder.kind === "oidc" ? { publisher: ciActor(s.holder) } : {}),
    tokenId: s.holder.tokenId,
    ...(provenanceRun(descriptor)
      ? { runUrl: provenanceRun(descriptor)! }
      : {}),
  };
  const plan = await ingestPackageDescriptor(
    db,
    env,
    product.slug,
    descriptor,
    {
      now,
      dryRun: true,
      pendingPromotion: new Map(
        [...s.needed].map(([k, n]) => [k, { sha256: n.sha256, size: n.size }]),
      ),
      feed,
      source,
    },
  );
  if (!plan.ok) return packageRefusal(plan);
  if (s.dryRun)
    return json({
      ok: true,
      dryRun: true,
      releaseId: plan.releaseId,
      outcome: plan.outcome,
      descriptorSha256: plan.descriptorSha256,
      planned: plan.planned,
      unverified: s.unverified,
    });
  if (!(await claimUploadTicket(db, s.ticketHash, now)))
    return refusal(
      409,
      ErrorCode.BadRequest,
      "ticket_redeemed",
      "this upload ticket was already redeemed",
    );
  for (const [key, n] of s.needed) {
    const res = await promote(
      s.bucket,
      n.staging,
      key,
      { sha256: n.sha256, size: n.size },
      { db, now, product: product.slug },
    );
    if (!res.ok) {
      await releaseUploadTicket(db, s.ticketHash, now);
      return refusal(
        res.reason === "missing" ||
          res.reason === "size_mismatch" ||
          res.reason === "digest_mismatch"
          ? 400
          : 409,
        ErrorCode.BadRequest,
        res.reason === "missing"
          ? "staged_object_missing"
          : res.reason === "size_mismatch" || res.reason === "digest_mismatch"
            ? "staged_object_mismatch"
            : "promote_failed",
        `${n.staging} could not be promoted (${res.reason})`,
        { key, staged: n.staging },
      );
    }
  }
  const result = await ingestPackageDescriptor(
    db,
    env,
    product.slug,
    descriptor,
    { now, promoted: s.needed.keys(), feed, source },
  );
  if (!result.ok) {
    await releaseUploadTicket(db, s.ticketHash, now);
    return packageRefusal(result);
  }
  if (s.needed.size > 0) {
    try {
      await s.bucket.delete([...s.needed.values()].map((n) => n.staging));
    } catch {
      // Best effort: the bucket's one-day rule takes them anyway.
    }
  }
  if (result.outcome !== "unchanged") {
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: ciActor(s.holder),
      actor_name: "CI",
      actor_email: null,
      action: "release.publish",
      target_kind: "release",
      target_id: result.releaseId,
      parent_id: null,
      summary: `Published package ${result.descriptor.package.name} ${result.descriptor.version} (${result.releaseId}, ${result.outcome}) ${s.holder.kind === "oidc" ? "through trusted publishing" : "with a CI upload token"}`,
    });
    await bumpReleaseGeneration(env, product.slug, now);
  }
  return json({
    ok: true,
    dryRun: false,
    releaseId: result.releaseId,
    outcome: result.outcome,
    descriptorSha256: result.descriptorSha256,
  });
}

function packageRefusal(
  r: Extract<PackageIngestResult, { ok: false }>,
): Response {
  return refusal(r.status, r.code, r.reason, r.message, {
    ...(r.errors ? { errors: r.errors } : {}),
    ...(r.retryable ? { retryable: true } : {}),
  });
}

/** The descriptor's `provenance.workflowRun`, read defensively. */
function provenanceRun(descriptor: unknown): string | null {
  const run = (descriptor as { provenance?: { workflowRun?: unknown } } | null)
    ?.provenance?.workflowRun;
  return typeof run === "string" ? run : null;
}

/**
 * P4-20: the channel's current app release other than `releaseId` (the newest one the channel
 * serves), with its contentApi and stored content-interface fingerprint, or null when the channel
 * serves none.
 */
async function currentContentInterface(
  ctx: ServiceContext,
  channel: string,
  releaseId: string,
): Promise<{
  releaseId: string;
  version: string;
  contentApi: number | null;
  sha256: string | null;
} | null> {
  const resolved = await resolveChannelReleases(
    ctx.db,
    ctx.product.slug,
    APP_DELIVERABLE_ID,
    channel,
  );
  const row = resolved?.releases.find((r) => r.release_id !== releaseId);
  if (!row) return null;
  return {
    releaseId: row.release_id,
    version: row.version,
    contentApi: row.content_api ?? null,
    sha256: row.content_interface ?? null,
  };
}

/** `release_record_rejected` with its reason (`records.ts`); `seq` is an ordering conflict. */
function recordRefusal(r: Extract<RecordCheck, { ok: false }>): Response {
  return errorResponse(
    r.reason === "seq" ? 409 : 400,
    "release_record_rejected",
    r.message,
    { reason: r.reason },
  );
}
