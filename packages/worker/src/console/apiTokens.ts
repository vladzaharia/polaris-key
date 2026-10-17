/**
 * Admin API tokens: the admin API's SECOND credential, and its first machine one.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * The admin API had exactly one credential: the console's OIDC browser session. So the one
 * non-browser caller, `pkey bundle`, a build-tool command run from terminals and from CI,
 * authenticated by having an operator copy their live `__Host-pkey_admin` cookie into an
 * environment variable and impersonate a browser well enough to satisfy the CSRF double-submit.
 * That credential is unnarrowable (it carries the human's full authority), unrevocable in
 * isolation (killing it means killing every session that identity holds), indistinguishable in the
 * audit log from the human clicking in the console, and short-lived in a way that makes
 * automation flaky rather than safe.
 *
 * A `pkeya_` token fixes each of those separately: it is scoped, individually revocable,
 * separately attributed in the audit trail, and given an explicit expiry at mint.
 *
 * ── WHY EXACTLY ONE SCOPE ───────────────────────────────────────────────────────────────────
 *
 * `bundles:mint` is the whole vocabulary, because minting a bundle is the whole use case. The
 * temptation with a scope column is to populate it with the shape of a permission system
 * (`products:read`, `licenses:write`, `*`) ahead of any caller. That is worse than having no
 * scopes at all: a scope string the dispatcher does not consult is a claim about authority that
 * nothing enforces, and the first person to read `scopes: ["products:read"]` in a token row will
 * reasonably believe the token cannot write. A scope is added HERE and as a `tokenScope` on the
 * route-table row that needs it (`./routes.ts`), in the same change as the caller that needs it.
 *
 * ── DEFAULT DENY ────────────────────────────────────────────────────────────────────────────
 *
 * The route table is the only place a token's reach is declared: a row carries a `tokenScope`
 * or it does not, and a row without one refuses every token, as does a path no row matches. That
 * inverts the usual failure mode. Adding an admin route does not silently widen every existing
 * token; it leaves the route unreachable by token until somebody decides which scope it belongs
 * to. In particular the token routes themselves carry no `tokenScope`, so a token cannot mint,
 * list or revoke a token, including itself.
 *
 * ── THE PRINCIPAL ───────────────────────────────────────────────────────────────────────────
 *
 * A token acts as a `Principal` resolved the way a session's is (`resolvePrincipal`), from a
 * synthetic session whose subject is `token:<id>` and whose groups carry the deployment's
 * `PLATFORM_ADMIN_GROUP`: the same input the root rule reads, so there is one authorization
 * implementation rather than a parallel one. When the deployment has configured no such group
 * the groups are empty and the token authorises nothing, the same fail-closed answer a cookie
 * gets. Authority is not invented here: the token was minted by a platform admin, and it is
 * narrowed further, to its scopes, by the route table.
 */

import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { bearer } from "../platform/http.js";
import { hashKey, isAdminApiToken } from "../platform/crypto.js";
import { audit, platformAudit } from "../core/audit.js";
import type { AdminSession } from "../core/console/session.js";

/**
 * The scope vocabulary. Two entries, each added with the caller that needs it (see the header).
 * `migrations:report` (P0-49) reaches the data-migration runner's READ side only: the job list, a
 * run's report and a dry run. Apply and down need a console step-up, which a token cannot have,
 * so they stay console-only.
 */
export const ADMIN_API_SCOPES = ["bundles:mint", "migrations:report"] as const;

export type AdminApiScope = (typeof ADMIN_API_SCOPES)[number];

export function isAdminApiScope(value: unknown): value is AdminApiScope {
  return (
    typeof value === "string" &&
    (ADMIN_API_SCOPES as readonly string[]).includes(value)
  );
}

/** One row of `admin_api_tokens` (migrations/0119). The plaintext is never stored. */
export interface AdminApiTokenRow {
  id: string;
  token_hash: string;
  label: string;
  scopes_json: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Longest life a token may be minted with. Same ceiling as a bundle's grace window, for the
 *  same reason: a year is the outer edge of "an operator is still thinking about this". */
export const MAX_TOKEN_DAYS = 365;

/** How many live tokens the platform holds. A bound, not a design constraint: it keeps the
 *  roster's cost flat and makes a runaway minting loop visible instead of unbounded. */
export const MAX_ADMIN_API_TOKENS = 100;

/** The roster's read bound: newest first, revoked and expired rows included. */
const ROSTER_LIMIT = 1000;

/** The scopes on a row, defensively parsed: a row whose `scopes_json` is unreadable grants
 *  NOTHING rather than everything. */
export function parseScopes(json: string | null | undefined): AdminApiScope[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAdminApiScope);
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────
//
// These live here and not in `core/repo.ts`, whose stated invariant is that EVERY query there
// carries a product predicate: a tenant boundary enforced by shape. This table has no product. It
// is the platform's own credential store, and putting it there would be the first exception to a
// rule whose whole value is that it has none.

export async function getApiToken(
  db: Db,
  id: string,
): Promise<AdminApiTokenRow | null> {
  return db.first<AdminApiTokenRow>(
    "SELECT * FROM admin_api_tokens WHERE id = ?",
    id,
  );
}

export async function listApiTokens(db: Db): Promise<AdminApiTokenRow[]> {
  return db.all<AdminApiTokenRow>(
    `SELECT * FROM admin_api_tokens ORDER BY created_at DESC, id LIMIT ${ROSTER_LIMIT}`,
  );
}

export async function countLiveApiTokens(db: Db, now: number): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM admin_api_tokens WHERE revoked_at IS NULL AND expires_at > ?",
    now,
  );
  return Number(row?.n ?? 0);
}

export async function insertApiToken(
  db: Db,
  row: AdminApiTokenRow,
): Promise<void> {
  await db.run(
    `INSERT INTO admin_api_tokens
       (id, token_hash, label, scopes_json, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.token_hash,
    row.label,
    row.scopes_json,
    row.created_at,
    row.expires_at,
    row.last_used_at,
    row.revoked_at,
  );
}

/** Revoke by id, only while live. The number of rows changed is 0 when the id is unknown or
 *  already revoked, so the handler can answer 404/409 instead of pretending. */
export async function revokeApiToken(
  db: Db,
  id: string,
  now: number,
): Promise<number> {
  return db.runChanges(
    "UPDATE admin_api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    now,
    id,
  );
}

// ── Presentation ─────────────────────────────────────────────────────────────────────────────

export type AdminApiTokenStatus = "active" | "expired" | "revoked";

/** The console's view of a token. Note what is absent: `token_hash`. It is not the secret, but it
 *  IS the lookup key, and a surface that echoes it invites somebody to treat it as an id. */
export interface AdminApiTokenView {
  id: string;
  label: string;
  scopes: AdminApiScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  status: AdminApiTokenStatus;
}

export function apiTokenView(
  row: AdminApiTokenRow,
  now: number,
): AdminApiTokenView {
  return {
    id: row.id,
    label: row.label,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    status:
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at <= now
          ? "expired"
          : "active",
  };
}

// ── Authentication ───────────────────────────────────────────────────────────────────────────

/** Why a presented token was refused. Never surfaced to the caller in this detail (one 401
 *  answers all of them), but the distinction is what the tests pin. */
export type TokenRejection =
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "unusable";

/** A token that passed every check: its row, and the scopes that row holds. */
export interface ValidAdminApiToken {
  ok: true;
  row: AdminApiTokenRow;
  scopes: AdminApiScope[];
}

export type TokenAuthResult =
  | ValidAdminApiToken
  | { ok: false; reason: TokenRejection };

/**
 * The token this request presents, or `null` when it presents none. Any `Authorization` header
 * in the `Bearer` scheme IS a presentation, even a bare `Bearer` with nothing after it (that one
 * is the empty string, which no token matches): the dispatcher refuses it with the one 401 rather
 * than quietly authenticating the request by its cookie instead. Another scheme is not a token
 * presentation and is ignored. One request, one credential, chosen by what it presents.
 */
export function presentedToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null || !/^Bearer(?:\s|$)/i.test(header)) return null;
  return bearer(req) ?? "";
}

/**
 * Validate a presented admin API token.
 *
 * Order is deliberate and mirrors `validateDeviceToken`: SHAPE first (cheap, and it is what makes
 * "a foreign credential is refused" a property of the code rather than of the data), then hash and
 * lookup, then the two lifecycle gates. Revocation is checked before expiry only so the reason is
 * the more actionable of the two when both apply.
 */
export async function validateAdminApiToken(
  env: Env,
  db: Db,
  presented: string,
  now: number,
): Promise<TokenAuthResult> {
  if (!isAdminApiToken(presented)) return { ok: false, reason: "malformed" };
  const hash = await hashKey(presented, env.KEY_HASH_PEPPER);
  const row = await db.first<AdminApiTokenRow>(
    "SELECT * FROM admin_api_tokens WHERE token_hash = ?",
    hash,
  );
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const scopes = parseScopes(row.scopes_json);
  // A live row whose scope list will not parse grants nothing, so it can never satisfy a route's
  // `tokenScope`. Refused here, with the credential, rather than later as a scope mismatch that
  // would misdescribe the cause.
  if (scopes.length === 0) return { ok: false, reason: "unusable" };
  // Only now, with every check passed: `last_used_at` is the time of the last request this token
  // authenticated, whatever the route then does with it.
  await db.run(
    "UPDATE admin_api_tokens SET last_used_at = ? WHERE id = ?",
    now,
    row.id,
  );
  return { ok: true, row, scopes };
}

/**
 * The synthetic session a token presents to the rest of the admin API.
 *
 * Everything downstream (`resolvePrincipal`, `audit`, the handlers) reads an `AdminSession`, and
 * giving the token path its own parallel type would mean every one of those call sites growing a
 * branch: two implementations where there is currently one. So the token becomes a session shape
 * instead, with three properties worth stating plainly:
 *
 *  - The `sub` is `token:<id>`, NOT the minting operator's OIDC subject. An audit row must say
 *    which credential acted; attributing a CI run to the human who minted its token six months
 *    ago is exactly the confusion this credential exists to remove. The `:` cannot collide with
 *    an OIDC `sub` we would ever issue, and it is what the rate limiter keys on too.
 *  - `groups` carries `PLATFORM_ADMIN_GROUP` (see "The principal" in the header), so the
 *    principal resolves through the same rule as a session's, and is empty, authorising nothing,
 *    when the deployment configured no such group.
 *  - There is no CSRF token and no step-up. A token request is exempt from the CSRF check (see
 *    `./api.ts`), and an empty `csrf` can never satisfy the header comparison even if that
 *    exemption were ever removed, so removing it fails closed. With no `stepUpAt`, a token is
 *    refused every step-up row outright.
 */
export function tokenSession(env: Env, row: AdminApiTokenRow): AdminSession {
  const group = env.PLATFORM_ADMIN_GROUP;
  return {
    sub: `token:${row.id}`,
    name: row.label,
    email: "",
    groups: group ? [group] : [],
    csrf: "",
    exp: row.expires_at,
  };
}

/**
 * Record that a token was used. Every use, not just every mutation: the point of a machine
 * credential's audit trail is that an operator can answer "what has this token been doing", and a
 * trail that omits reads answers a different question.
 *
 * A use of a product-scoped route is that product's audit row (`audit.product` is `NOT NULL
 * REFERENCES products(slug)`); a use of a platform-scoped route goes to `platform_audit`, so a
 * `tokenScope` added to either kind of row is audited without a second decision.
 */
export async function auditTokenUse(
  db: Db,
  row: AdminApiTokenRow,
  session: AdminSession,
  use: {
    scope: AdminApiScope;
    method: string;
    path: string;
    product: string | null;
  },
  now: number,
): Promise<void> {
  const target = { kind: "api_token", id: row.id };
  const summary = `API token ${row.label} (${row.id}) exercised ${use.scope} on ${use.method} ${use.path}`;
  if (use.product)
    await audit(
      db,
      use.product,
      session,
      now,
      "api_token.used",
      target,
      summary,
    );
  else await platformAudit(db, session, now, "api_token.used", target, summary);
}
