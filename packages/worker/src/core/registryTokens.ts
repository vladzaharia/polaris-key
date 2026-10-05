/// <reference types="@cloudflare/workers-types" />
/**
 * Registry tokens (F-21, plans/F-20.md §6.1, §6.2 and §6.4): the `pkeyr_` store, the per-isolate
 * resolution cache, and the OCI pull token.
 *
 * WHY CORE. Two services mint registry tokens: Distribution, from the console, and Identity, from
 * the portal. A service may not import another (rule 6), so the store lives here and both reach
 * it. Distribution's access ladder (`services/distribution/registry/authorize.ts`) resolves a
 * presented credential through this module, and only when a feed's mode is not `public`, so the
 * public hot path never reads `registry_tokens`.
 *
 * THE TOKEN. `pkeyr_` + 256 random bits (`mintOpaqueToken`). Only `hashKey(token,
 * KEY_HASH_PEPPER)` is stored (a global unique index); the plaintext is returned once by the mint
 * and never logged, echoed or stored. Every token expires (at most 365 days out), is bound to one
 * owner (product), and is either owner-bound (console) or licence-bound (portal, or an operator
 * for a licensee). A URL token (`presentation = 'url'`) is the Godot editor's: read-only and
 * narrowed to `["godot"]`, enforced by the table's CHECK as well as here.
 *
 * THE RESOLUTION CACHE. Per isolate, `REGISTRY_TOKEN_TTL_SECONDS` (30 s), keyed by the token hash
 * (or the token id, for an OCI pull token's subject), negative entries included. An entry holds
 * the principal and, for a licence-bound token, the licence row, so a revocation, a licence
 * suspension and a product deletion take effect everywhere within the window. A write on this
 * isolate (mint, revoke) drops its cache at once (`forgetRegistryTokens`).
 *
 * THE OCI PULL TOKEN (§6.4). `v1.<b64url(claims)>.<b64url(HMAC-SHA256)>` under the secret
 * `REGISTRY_TOKEN_KEY` (`REGISTRY_TOKEN_KEY_PREVIOUS` also verifies, during a rotation). It
 * carries identity only: every OCI request re-resolves its subject through the 30 s cache and
 * re-runs the ladder, so a revoked token or a tightened feed stops it within 30 s even though the
 * pull token itself lives `REGISTRY_PULL_TOKEN_TTL_SECONDS` (300 s). It is opaque to clients, is
 * not a JWS and never reaches an SDK or the corpus (no wire change, §2).
 */

import { PACKAGE_ECOSYSTEMS } from "@polaris-key/manifest";
import type { Env } from "../env.js";
import { secret } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { hashKey, mintOpaqueToken, randomId } from "../crypto.js";
import { getLicense, type LicenseRow } from "../repo.js";
import { CI_TOKEN_PREFIX } from "./ciVocabulary.js";
import { lookupCiToken } from "./publisher.js";
import {
  ANONYMOUS,
  MAX_LIVE_TOKENS_PER_LICENSE,
  MAX_LIVE_TOKENS_PER_OWNER,
  MINTABLE_REGISTRY_SCOPES,
  REGISTRY_PUBLISH_ECOSYSTEMS,
  REGISTRY_PUBLISH_TOKEN_DEFAULT_DAYS,
  REGISTRY_PUBLISH_TOKEN_MAX_DAYS,
  REGISTRY_PULL_TOKEN_TTL_SECONDS,
  REGISTRY_TOKEN_DEFAULT_DAYS,
  REGISTRY_TOKEN_LABEL_MAX,
  REGISTRY_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_MIN_DAYS,
  REGISTRY_TOKEN_PREFIX,
  REGISTRY_TOKEN_RETENTION_SECONDS,
  REGISTRY_TOKEN_SHAPE,
  REGISTRY_TOKEN_TTL_SECONDS,
  REGISTRY_URL_TOKEN_DEFAULT_DAYS,
  type FeedPrincipal,
  type RegistryRevokeReason,
  type RegistryTokenBinding,
  type RegistryTokenPresentation,
} from "./registryVocabulary.js";

export * from "./registryVocabulary.js";

// ── Rows and views ───────────────────────────────────────────────────────────────────────────

interface RegistryTokenRow {
  product: string;
  token_id: string;
  token_hash: string;
  hint: string;
  label: string;
  scopes_json: string;
  ecosystems_json: string | null;
  binding: string;
  license_id: string | null;
  presentation: string;
  created_by: string;
  portal_account_id: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

/** One token as the console and the portal list it. Never the plaintext or the hash. */
export interface RegistryTokenView {
  readonly tokenId: string;
  readonly label: string;
  /** The plaintext's last four characters. */
  readonly hint: string;
  readonly scopes: readonly string[];
  /** `null` = every feed of the owner. */
  readonly ecosystems: readonly string[] | null;
  readonly binding: RegistryTokenBinding;
  readonly licenseId: string | null;
  readonly presentation: RegistryTokenPresentation;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly status: "active" | "expired" | "revoked";
}

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : [];
  } catch {
    return [];
  }
}

function viewOf(row: RegistryTokenRow, now: number): RegistryTokenView {
  return {
    tokenId: row.token_id,
    label: row.label,
    hint: row.hint,
    scopes: parseList(row.scopes_json) ?? [],
    ecosystems: parseList(row.ecosystems_json),
    binding: row.binding === "license" ? "license" : "owner",
    licenseId: row.license_id,
    presentation: row.presentation === "url" ? "url" : "header",
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    status:
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at <= now
          ? "expired"
          : "active",
  };
}

function pepper(env: Env): string | undefined {
  return secret(env, "KEY_HASH_PEPPER");
}

/** The stored hash of a presented token. */
export function hashRegistryToken(env: Env, token: string): Promise<string> {
  return hashKey(token, pepper(env));
}

/** Is `v` shaped like a registry token? (Says nothing about whether it exists.) */
export function isRegistryToken(v: string): boolean {
  return REGISTRY_TOKEN_SHAPE.test(v);
}

// ── Mint ─────────────────────────────────────────────────────────────────────────────────────

export interface MintRegistryTokenInput {
  readonly product: string;
  readonly label: string;
  /** `null` (or absent) = every feed of the owner. Ignored for a URL token (always godot). */
  readonly ecosystems?: readonly string[] | null;
  /** Default 90 (30 for a URL token, 7 for a publish token); 1 to 365 (30 for a publish token). */
  readonly expiresInDays?: number;
  readonly binding: RegistryTokenBinding;
  readonly licenseId?: string | null;
  readonly presentation?: RegistryTokenPresentation;
  /** `["read"]` (the default) or `["publish"]` / `["read", "publish"]` (F-22): `publish` implies
   *  `read` and is stored as both. */
  readonly scopes?: readonly string[];
  /** `admin:<sub>` or `portal:<accountId>`. */
  readonly createdBy: string;
  readonly portalAccountId?: string | null;
}

export type MintRegistryTokenResult =
  | {
      readonly ok: true;
      /** The plaintext: shown once, never stored. */
      readonly token: string;
      readonly view: RegistryTokenView;
    }
  | {
      readonly ok: false;
      readonly status: 404 | 409 | 422;
      readonly reason: string;
      readonly message: string;
      readonly fields?: readonly string[];
    };

/** Refuse, as the admin and portal APIs answer it. */
function refuse(
  status: 404 | 409 | 422,
  reason: string,
  message: string,
  fields?: readonly string[],
): MintRegistryTokenResult {
  return { ok: false, status, reason, message, ...(fields ? { fields } : {}) };
}

/**
 * Validate and mint one token (§6.1's rules): expiry 1 to 365 days (default 90, 30 for a URL
 * token); licence-bound tokens are `read` only; a URL token is `read` and `["godot"]`; at most
 * 10 live tokens per licence and 500 per owner. The licence must exist within the owner. Returns
 * the plaintext once. Drops this isolate's resolution cache.
 *
 * A PUBLISH token (F-22, plans/F-20.md §9: "owner-bound only, implies read") is held to more:
 * owner-bound, presented in a header, narrowed to named publish ecosystems (never "every feed"),
 * and short-lived (1 to 30 days, default 7), so a native client's publish secret is as narrow
 * and as brief as a person's own machine needs.
 */
export async function mintRegistryToken(
  env: Env,
  db: Db,
  input: MintRegistryTokenInput,
  now: number,
): Promise<MintRegistryTokenResult> {
  const fields: string[] = [];
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label === "" || label.length > REGISTRY_TOKEN_LABEL_MAX)
    fields.push("label");
  const presentation: RegistryTokenPresentation =
    input.presentation === "url" ? "url" : "header";
  const requested = [...new Set(input.scopes ?? ["read"])];
  if (
    requested.length === 0 ||
    requested.some(
      (s) => !(MINTABLE_REGISTRY_SCOPES as readonly string[]).includes(s),
    )
  )
    fields.push("scopes");
  const publish = requested.includes("publish");
  // `publish` implies `read`: stored as both, sorted, so the row says what the token can do.
  const scopes = publish ? ["publish", "read"] : requested;
  const days =
    input.expiresInDays ??
    (publish
      ? REGISTRY_PUBLISH_TOKEN_DEFAULT_DAYS
      : presentation === "url"
        ? REGISTRY_URL_TOKEN_DEFAULT_DAYS
        : REGISTRY_TOKEN_DEFAULT_DAYS);
  if (
    !Number.isSafeInteger(days) ||
    days < REGISTRY_TOKEN_MIN_DAYS ||
    days > (publish ? REGISTRY_PUBLISH_TOKEN_MAX_DAYS : REGISTRY_TOKEN_MAX_DAYS)
  )
    fields.push("expiresInDays");
  let ecosystems: string[] | null = null;
  if (presentation === "url") ecosystems = ["godot"];
  else if (input.ecosystems !== undefined && input.ecosystems !== null) {
    const list = [...new Set(input.ecosystems)];
    const allowed: readonly string[] = publish
      ? REGISTRY_PUBLISH_ECOSYSTEMS
      : PACKAGE_ECOSYSTEMS;
    if (list.length === 0 || list.some((e) => !allowed.includes(e)))
      fields.push("ecosystems");
    else ecosystems = [...list].sort();
  } else if (publish) fields.push("ecosystems");
  if (publish && presentation === "url") fields.push("presentation");
  const binding = input.binding;
  if (binding !== "owner" && binding !== "license") fields.push("binding");
  const licenseId = binding === "license" ? (input.licenseId ?? null) : null;
  if (binding === "license" && (typeof licenseId !== "string" || !licenseId))
    fields.push("licenseId");
  if (fields.length)
    return refuse(422, "invalid_token", "invalid registry token", fields);
  if (binding === "license" && scopes.some((s) => s !== "read"))
    return refuse(
      422,
      "license_tokens_read_only",
      "a licence-bound token can only read",
      ["scopes"],
    );
  if (binding === "license") {
    const license = await getLicense(db, input.product, licenseId!);
    if (!license)
      return refuse(404, "license_not_found", "no such licence", ["licenseId"]);
  }
  const owned = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM registry_tokens
      WHERE product = ? AND revoked_at IS NULL AND expires_at > ?`,
    input.product,
    now,
  );
  if ((owned?.n ?? 0) >= MAX_LIVE_TOKENS_PER_OWNER)
    return refuse(
      409,
      "token_limit",
      `at most ${MAX_LIVE_TOKENS_PER_OWNER} live registry tokens per product; revoke one first`,
    );
  if (binding === "license") {
    const held = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM registry_tokens
        WHERE product = ? AND license_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      input.product,
      licenseId,
      now,
    );
    if ((held?.n ?? 0) >= MAX_LIVE_TOKENS_PER_LICENSE)
      return refuse(
        409,
        "token_limit",
        `at most ${MAX_LIVE_TOKENS_PER_LICENSE} live registry tokens per licence; revoke one first`,
      );
  }
  const token = `${REGISTRY_TOKEN_PREFIX}${mintOpaqueToken()}`;
  const row: RegistryTokenRow = {
    product: input.product,
    token_id: randomId("rtok"),
    token_hash: await hashRegistryToken(env, token),
    hint: token.slice(-4),
    label,
    scopes_json: JSON.stringify(scopes),
    ecosystems_json: ecosystems === null ? null : JSON.stringify(ecosystems),
    binding,
    license_id: licenseId,
    presentation,
    created_by: input.createdBy.slice(0, 320),
    portal_account_id: input.portalAccountId ?? null,
    created_at: now,
    expires_at: now + days * 86_400,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
  };
  await db.run(
    `INSERT INTO registry_tokens
       (product, token_id, token_hash, hint, label, scopes_json, ecosystems_json, binding,
        license_id, presentation, created_by, portal_account_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.product,
    row.token_id,
    row.token_hash,
    row.hint,
    row.label,
    row.scopes_json,
    row.ecosystems_json,
    row.binding,
    row.license_id,
    row.presentation,
    row.created_by,
    row.portal_account_id,
    row.created_at,
    row.expires_at,
  );
  forgetRegistryTokens();
  return { ok: true, token, view: viewOf(row, now) };
}

// ── List and revoke ──────────────────────────────────────────────────────────────────────────

/** Narrows a list or a revoke: one licence's tokens, or those one portal account minted. */
export interface RegistryTokenFilter {
  readonly licenseId?: string;
  readonly portalAccountId?: string;
}

function filterSql(filter: RegistryTokenFilter): {
  sql: string;
  params: string[];
} {
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.licenseId !== undefined) {
    parts.push("license_id = ?");
    params.push(filter.licenseId);
  }
  if (filter.portalAccountId !== undefined) {
    parts.push("portal_account_id = ?");
    params.push(filter.portalAccountId);
  }
  return {
    sql: parts.length ? ` AND ${parts.join(" AND ")}` : "",
    params,
  };
}

/** The owner's tokens (newest first), revoked and expired ones included until purged. */
export async function listRegistryTokens(
  db: Db,
  product: string,
  now: number,
  filter: RegistryTokenFilter = {},
): Promise<RegistryTokenView[]> {
  const f = filterSql(filter);
  const rows = await db.all<RegistryTokenRow>(
    `SELECT * FROM registry_tokens WHERE product = ?${f.sql}
      ORDER BY created_at DESC, token_id DESC LIMIT 1000`,
    product,
    ...f.params,
  );
  return rows.map((r) => viewOf(r, now));
}

/** One token, or `null` (absent, or outside `filter`). */
export async function getRegistryToken(
  db: Db,
  product: string,
  tokenId: string,
  now: number,
  filter: RegistryTokenFilter = {},
): Promise<RegistryTokenView | null> {
  const f = filterSql(filter);
  const row = await db.first<RegistryTokenRow>(
    `SELECT * FROM registry_tokens WHERE product = ? AND token_id = ?${f.sql}`,
    product,
    tokenId,
    ...f.params,
  );
  return row ? viewOf(row, now) : null;
}

/**
 * Revoke one token. Answers the token as it now stands (already revoked included), or `null`
 * when there is no such token within `filter`.
 */
export async function revokeRegistryToken(
  db: Db,
  product: string,
  tokenId: string,
  by: string,
  reason: RegistryRevokeReason,
  now: number,
  filter: RegistryTokenFilter = {},
): Promise<RegistryTokenView | null> {
  const f = filterSql(filter);
  await db.run(
    `UPDATE registry_tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
      WHERE product = ? AND token_id = ? AND revoked_at IS NULL${f.sql}`,
    now,
    by,
    reason,
    product,
    tokenId,
    ...f.params,
  );
  forgetRegistryTokens();
  return getRegistryToken(db, product, tokenId, now, filter);
}

/** Revoke every live token of the owner (within `filter`); answers how many. */
export async function revokeAllRegistryTokens(
  db: Db,
  product: string,
  by: string,
  reason: RegistryRevokeReason,
  now: number,
  filter: RegistryTokenFilter = {},
): Promise<number> {
  const f = filterSql(filter);
  const n = await db.runChanges(
    `UPDATE registry_tokens SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
      WHERE product = ? AND revoked_at IS NULL${f.sql}`,
    now,
    by,
    reason,
    product,
    ...f.params,
  );
  forgetRegistryTokens();
  return n;
}

/**
 * The cascade when a portal account is erased: every token it minted, on every product, is
 * revoked (`account_deleted`). A statement, so the erasure batch stays atomic.
 */
export function stmtRevokeAccountRegistryTokens(
  accountId: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE registry_tokens
             SET revoked_at = ?, revoked_by = ?, revoke_reason = 'account_deleted'
           WHERE portal_account_id = ? AND revoked_at IS NULL`,
    params: [now, `portal:${accountId}`, accountId],
  };
}

/**
 * A deleted product's tokens, revoked in the deletion batch (`product_deleted`). The lookup also
 * refuses a deleted product's tokens; this makes the revocation visible in the list too.
 */
export function stmtRevokeProductRegistryTokens(
  product: string,
  now: number,
): DbStatement {
  return {
    sql: `UPDATE registry_tokens
             SET revoked_at = ?, revoked_by = 'system', revoke_reason = 'product_deleted'
           WHERE product = ? AND revoked_at IS NULL`,
    params: [now, product],
  };
}

/** Retention (the nightly cron): rows 90 days past their expiry or revocation go. */
export async function purgeRegistryTokens(
  db: Db,
  now: number,
): Promise<number> {
  const cutoff = now - REGISTRY_TOKEN_RETENTION_SECONDS;
  try {
    return await db.runChanges(
      `DELETE FROM registry_tokens
        WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      cutoff,
      cutoff,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return 0;
    throw err;
  }
}

// ── Resolution (the 30-second cache) ─────────────────────────────────────────────────────────

/** What a stored token resolves to, before the ladder judges it. */
export type ResolvedRegistryToken =
  | {
      readonly kind: "owner" | "license";
      readonly product: string;
      readonly tokenId: string;
      readonly presentation: RegistryTokenPresentation;
      readonly ecosystems: readonly string[] | null;
      /** Licence-bound only. `null` when the licence row is gone (refused by the ladder). */
      readonly license: LicenseRow | null;
      /** The token's scopes (`read`; `publish` and `read`, F-22). */
      readonly scopes: readonly string[];
    }
  | {
      readonly kind: "ci";
      readonly product: string;
      readonly tokenId: string;
      /** The CI token's scopes (`release:publish`, …): F-22 publishes only with `release:publish`. */
      readonly scopes: readonly string[];
      /** `oidc` (trusted publishing) or `static` (an operator-issued token). */
      readonly ciKind: "oidc" | "static";
      /** The CI token's subject, audited as `ci:<subject>` (`ciActor`). */
      readonly subject: string;
    };

interface CacheEntry {
  readonly value: ResolvedRegistryToken | null;
  readonly until: number;
}

const MAX_ENTRIES = 5_000;
const resolutionCache = new Map<string, CacheEntry>();

function cached(
  key: string,
  nowMs: number,
): { value: ResolvedRegistryToken | null } | undefined {
  const hit = resolutionCache.get(key);
  if (hit === undefined) return undefined;
  if (hit.until > nowMs) return { value: hit.value };
  resolutionCache.delete(key);
  return undefined;
}

function remember(
  key: string,
  value: ResolvedRegistryToken | null,
  nowMs: number,
): ResolvedRegistryToken | null {
  if (resolutionCache.size >= MAX_ENTRIES) resolutionCache.clear();
  resolutionCache.set(key, {
    value,
    until: nowMs + REGISTRY_TOKEN_TTL_SECONDS * 1000,
  });
  return value;
}

/** Drop this isolate's resolution cache (a mint or a revoke here; tests). */
export function forgetRegistryTokens(): void {
  resolutionCache.clear();
}

/** A resolution, and whether it missed both the cache and D1 (`registryCredentialMiss`). */
export interface RegistryTokenLookup {
  readonly resolved: ResolvedRegistryToken | null;
  readonly miss: boolean;
}

export interface LookupOptions {
  readonly nowMs?: number;
  /** Finish the `last_used_at` write after answering; awaited inline without it. */
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

const LAST_USED_GRANULARITY = 3_600;

async function resolveRow(
  db: Db,
  row: RegistryTokenRow,
  now: number,
  opts: LookupOptions,
): Promise<ResolvedRegistryToken> {
  if (
    row.last_used_at === null ||
    row.last_used_at < now - LAST_USED_GRANULARITY
  ) {
    const write = db
      .run(
        "UPDATE registry_tokens SET last_used_at = ? WHERE product = ? AND token_id = ?",
        now,
        row.product,
        row.token_id,
      )
      .catch(() => undefined);
    if (opts.waitUntil) opts.waitUntil(write);
    else await write;
  }
  const license =
    row.binding === "license" && row.license_id !== null
      ? await getLicense(db, row.product, row.license_id)
      : null;
  return {
    kind: row.binding === "license" ? "license" : "owner",
    product: row.product,
    tokenId: row.token_id,
    presentation: row.presentation === "url" ? "url" : "header",
    ecosystems: parseList(row.ecosystems_json),
    license,
    scopes: parseList(row.scopes_json) ?? [],
  };
}

const LIVE_ROW_SQL = `SELECT t.* FROM registry_tokens t JOIN products p ON p.slug = t.product
  WHERE t.revoked_at IS NULL AND t.expires_at > ? AND COALESCE(p.status, 'active') <> 'deleted'`;

/**
 * Who a presented `pkeyr_` or `pkeyci_` token is, through the 30-second cache. `null` for a
 * malformed, unknown, expired or revoked token, or one whose product is deleted. A CI token is
 * any live `pkeyci_` of its product, whatever its scopes (Q4: CI passes every mode).
 */
export async function lookupRegistryCredential(
  env: Env,
  db: Db,
  token: string,
  opts: LookupOptions = {},
): Promise<RegistryTokenLookup> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  const isRegistry = isRegistryToken(token);
  const isCi = !isRegistry && token.startsWith(CI_TOKEN_PREFIX);
  if (!isRegistry && !isCi) return { resolved: null, miss: false };
  const hash = await hashRegistryToken(env, token);
  const key = `h:${hash}`;
  const hit = cached(key, nowMs);
  if (hit) return { resolved: hit.value, miss: false };
  if (isCi) {
    const ci = await lookupCiToken(env, db, token, now);
    const value: ResolvedRegistryToken | null = ci
      ? {
          kind: "ci",
          product: ci.product,
          tokenId: ci.tokenId,
          scopes: ci.scopes,
          ciKind: ci.kind,
          subject: ci.subject,
        }
      : null;
    return { resolved: remember(key, value, nowMs), miss: value === null };
  }
  let row: RegistryTokenRow | null;
  try {
    row = await db.first<RegistryTokenRow>(
      `${LIVE_ROW_SQL} AND t.token_hash = ?`,
      now,
      hash,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) row = null;
    else throw err;
  }
  if (!row) return { resolved: remember(key, null, nowMs), miss: true };
  return {
    resolved: remember(key, await resolveRow(db, row, now, opts), nowMs),
    miss: false,
  };
}

/**
 * An OCI pull token's subject, re-resolved through the cache: `tokenId` (a registry token of
 * `product`) or `ci:<tokenId>` (a CI token of `product`). `null` once revoked or expired.
 */
export async function lookupRegistrySubject(
  db: Db,
  product: string,
  subject: string,
  opts: LookupOptions = {},
): Promise<ResolvedRegistryToken | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  const key = `s:${product}\u0000${subject}`;
  const hit = cached(key, nowMs);
  if (hit) return hit.value;
  if (subject.startsWith("ci:")) {
    const row = await db.first<{
      token_id: string;
      scopes_json: string | null;
      kind: string | null;
      subject: string;
    }>(
      `SELECT t.token_id, t.scopes_json, t.kind, t.subject FROM ci_tokens t JOIN products p ON p.slug = t.product
        WHERE t.product = ? AND t.token_id = ? AND t.revoked_at IS NULL AND t.expires_at > ?
          AND COALESCE(p.status, 'active') <> 'deleted'`,
      product,
      subject.slice(3),
      now,
    );
    return remember(
      key,
      row
        ? {
            kind: "ci",
            product,
            tokenId: row.token_id,
            scopes: parseList(row.scopes_json) ?? [],
            ciKind: row.kind === "static" ? "static" : "oidc",
            subject: row.subject,
          }
        : null,
      nowMs,
    );
  }
  let row: RegistryTokenRow | null;
  try {
    row = await db.first<RegistryTokenRow>(
      `${LIVE_ROW_SQL} AND t.product = ? AND t.token_id = ?`,
      now,
      product,
      subject,
    );
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) row = null;
    else throw err;
  }
  return remember(
    key,
    row ? await resolveRow(db, row, now, opts) : null,
    nowMs,
  );
}

/** The principal a resolution is, for an owner and ecosystem the ladder then judges. */
export function principalOf(
  resolved: ResolvedRegistryToken | null,
): FeedPrincipal {
  if (resolved === null) return ANONYMOUS;
  if (resolved.kind === "ci")
    return { kind: "ci", product: resolved.product, tokenId: resolved.tokenId };
  if (resolved.kind === "owner")
    return {
      kind: "owner",
      product: resolved.product,
      tokenId: resolved.tokenId,
      ecosystems: resolved.ecosystems,
    };
  if (resolved.license === null) return ANONYMOUS;
  return {
    kind: "license",
    product: resolved.product,
    tokenId: resolved.tokenId,
    license: resolved.license,
    ecosystems: resolved.ecosystems,
  };
}

// ── The OCI pull token ───────────────────────────────────────────────────────────────────────

/** What a pull token carries: identity only (§6.4). */
export interface PullTokenClaims {
  /** A registry token id, `ci:<id>`, or `anonymous`. */
  readonly sub: string;
  /** The owner the subject belongs to; `null` for an anonymous token. */
  readonly own: string | null;
  /** The repositories granted, as `<owner>/<repository>`. */
  readonly repos: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

const PULL_PREFIX = "v1.";

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(
      s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4),
    );
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(
    b.byteOffset,
    b.byteOffset + b.byteLength,
  ) as ArrayBuffer;
}

async function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toBuffer(new TextEncoder().encode(material)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Is the pull-token secret set? Without it `/v2/token` answers 503 and `/v2/` stays 200. */
export function registryTokenKeyConfigured(env: Env): boolean {
  return !!secret(env, "REGISTRY_TOKEN_KEY");
}

/** Sign a pull token under `REGISTRY_TOKEN_KEY`; `null` when the secret is unset. */
export async function signPullToken(
  env: Env,
  claims: Omit<PullTokenClaims, "iat" | "exp">,
  now: number,
): Promise<{ token: string; expiresIn: number; issuedAt: number } | null> {
  const material = secret(env, "REGISTRY_TOKEN_KEY");
  if (!material) return null;
  const full: PullTokenClaims = {
    ...claims,
    iat: now,
    exp: now + REGISTRY_PULL_TOKEN_TTL_SECONDS,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const signed = `${PULL_PREFIX}${body}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(material),
    toBuffer(new TextEncoder().encode(signed)),
  );
  return {
    token: `${signed}.${b64urlEncode(new Uint8Array(sig))}`,
    expiresIn: REGISTRY_PULL_TOKEN_TTL_SECONDS,
    issuedAt: now,
  };
}

/** Does `v` look like a pull token? (Cheap; says nothing about its signature.) */
export function isPullToken(v: string): boolean {
  return v.startsWith(PULL_PREFIX) && v.length < 4_096;
}

/**
 * The claims of a pull token signed under `REGISTRY_TOKEN_KEY` or `REGISTRY_TOKEN_KEY_PREVIOUS`
 * and not yet expired, else `null`. The signature is checked with `crypto.subtle.verify`.
 */
export async function verifyPullToken(
  env: Env,
  token: string,
  now: number,
): Promise<PullTokenClaims | null> {
  if (!isPullToken(token)) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= PULL_PREFIX.length) return null;
  const signed = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  const body = b64urlDecode(signed.slice(PULL_PREFIX.length));
  if (!sig || !body) return null;
  const keys = [
    secret(env, "REGISTRY_TOKEN_KEY"),
    secret(env, "REGISTRY_TOKEN_KEY_PREVIOUS"),
  ].filter((k): k is string => !!k);
  let valid = false;
  for (const material of keys) {
    if (
      await crypto.subtle.verify(
        "HMAC",
        await hmacKey(material),
        toBuffer(sig),
        toBuffer(new TextEncoder().encode(signed)),
      )
    ) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object") return null;
  const c = claims as Record<string, unknown>;
  if (
    typeof c.sub !== "string" ||
    (c.own !== null && typeof c.own !== "string") ||
    !Array.isArray(c.repos) ||
    !c.repos.every((r) => typeof r === "string") ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number"
  )
    return null;
  if (c.exp <= now) return null;
  return {
    sub: c.sub,
    own: c.own as string | null,
    repos: c.repos as string[],
    iat: c.iat,
    exp: c.exp,
  };
}
