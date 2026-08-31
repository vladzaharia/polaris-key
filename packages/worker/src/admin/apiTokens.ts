/**
 * Admin API tokens — the admin surface's SECOND credential, and the first machine one.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Until now the admin API had exactly one credential: the console's OIDC browser session. So the
 * one non-browser caller — `pkey bundle`, a build-tool command run from terminals and from CI —
 * authenticated by having an operator copy their live `__Host-pkey_admin` cookie into an
 * environment variable and then impersonate a browser well enough to satisfy the CSRF
 * double-submit. That credential is unnarrowable (it carries the human's full authority),
 * unrevocable in isolation (killing it means killing every session that identity holds),
 * indistinguishable in the audit log from the human clicking in the console, and short-lived in a
 * way that makes automation flaky rather than safe.
 *
 * A `pkeya_` token fixes each of those separately: it is scoped, individually revocable,
 * separately attributed in the audit trail, and given an explicit expiry at mint.
 *
 * ── WHY EXACTLY ONE SCOPE ───────────────────────────────────────────────────────────────────
 *
 * `bundles:mint` is the whole vocabulary, because minting a bundle is the whole use case. The
 * temptation with a scope column is to populate it with the shape of a permission system —
 * `products:read`, `licenses:write`, `*` — ahead of any caller. That is worse than having no
 * scopes at all: a scope string the dispatcher does not consult is a claim about authority that
 * nothing enforces, and the first person to read `scopes: ["products:read"]` in a token row will
 * reasonably believe the token cannot write. Scopes are added HERE, with a matching arm in
 * `scopeForRequest`, in the same change as the caller that needs them.
 *
 * ── DEFAULT DENY ────────────────────────────────────────────────────────────────────────────
 *
 * `scopeForRequest` returns `null` for every route it does not explicitly name, and `null` is a
 * refusal for a token principal — not a pass. That inverts the usual failure mode: adding an
 * admin route does not silently widen every existing token, it leaves the route unreachable by
 * token until somebody decides which scope it belongs to. In particular, the token routes in this
 * very file are unscoped, so a token cannot mint, list or revoke a token — including itself.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import {
  hashKey,
  isAdminApiToken,
  mintAdminApiToken,
  randomId,
} from "../crypto.js";
import { ErrorCode } from "../core/errors.js";
import { adminJson, err, notFound, readBody } from "./lib/respond.js";
import { audit } from "./audit.js";
import { isPlatformAdmin } from "./authz.js";
import type { AdminSession } from "./session.js";

/** The scope vocabulary. One entry, deliberately — see the header. */
export const ADMIN_API_SCOPES = ["bundles:mint"] as const;

export type AdminApiScope = (typeof ADMIN_API_SCOPES)[number];

function isAdminApiScope(value: unknown): value is AdminApiScope {
  return (
    typeof value === "string" &&
    (ADMIN_API_SCOPES as readonly string[]).includes(value)
  );
}

/** One row of `admin_api_tokens` (migrations/0027). The plaintext is never stored. */
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

const SECONDS_PER_DAY = 86400;

/** How many tokens one platform holds. A bound, not a design constraint — it keeps the list
 *  endpoint's cost flat and makes a runaway minting loop visible instead of unbounded. */
export const MAX_ADMIN_API_TOKENS = 100;

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

// ── Store ────────────────────────────────────────────────────────────────────
//
// These live here rather than in `repo.ts` because that module's stated invariant is that EVERY
// query carries a product predicate — a tenant boundary enforced by shape. This table has no
// product: it is the platform's own credential store, and putting it there would be the first
// exception to a rule whose whole value is that it has none.

async function getTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<AdminApiTokenRow | null> {
  return db.first<AdminApiTokenRow>(
    "SELECT * FROM admin_api_tokens WHERE token_hash = ?",
    tokenHash,
  );
}

async function listTokens(db: Db): Promise<AdminApiTokenRow[]> {
  return db.all<AdminApiTokenRow>(
    "SELECT * FROM admin_api_tokens ORDER BY created_at DESC, id",
  );
}

async function countLiveTokens(db: Db, now: number): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM admin_api_tokens WHERE revoked_at IS NULL AND expires_at > ?",
    now,
  );
  return Number(row?.n ?? 0);
}

/** Mark a token used. Never blocks or fails the request it describes — a token that worked must
 *  not become a 500 because a bookkeeping write lost a race. */
async function touchToken(db: Db, id: string, now: number): Promise<void> {
  await db.run(
    "UPDATE admin_api_tokens SET last_used_at = ? WHERE id = ?",
    now,
    id,
  );
}

/** Revoke by id, only while live. Returns false when the id is unknown or already revoked, so
 *  the handler can answer 404/409 instead of pretending. */
async function revokeToken(db: Db, id: string, now: number): Promise<number> {
  return db.runChanges(
    "UPDATE admin_api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    now,
    id,
  );
}

// ── Presentation ─────────────────────────────────────────────────────────────

/** The console's view of a token. Note what is absent: `token_hash`. It is not the secret, but
 *  it IS the lookup key, and a surface that echoes it invites somebody to treat it as an id. */
function tokenView(
  row: AdminApiTokenRow,
  now: number,
): Record<string, unknown> {
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

// ── Authentication ───────────────────────────────────────────────────────────

/** Why a presented token was refused. Never surfaced to the caller in this detail — one 401
 *  answers all of them — but the distinction is what the tests pin. */
export type TokenRejection =
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "unusable";

export type TokenAuthResult =
  | { ok: true; row: AdminApiTokenRow; scopes: AdminApiScope[] }
  | { ok: false; reason: TokenRejection };

/** The `Authorization: Bearer <token>` value, or null. Case-insensitive scheme per RFC 7235. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Validate a presented admin API token.
 *
 * Order is deliberate and mirrors `validateDeviceToken`: SHAPE first (cheap, and it is what makes
 * "a foreign credential is refused" a property of the code rather than of the data), then hash +
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
  const row = await getTokenByHash(db, hash);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };
  const scopes = parseScopes(row.scopes_json);
  // A live row whose scope list will not parse grants nothing, so it can never satisfy
  // `scopeForRequest`. Refused here rather than three lines later so the audit trail records an
  // unusable credential instead of a scope mismatch that misdescribes the cause.
  if (scopes.length === 0) return { ok: false, reason: "unusable" };
  await touchToken(db, row.id, now);
  return { ok: true, row, scopes };
}

/**
 * The synthetic session a token principal presents to the rest of the admin API.
 *
 * Everything downstream — `canAdminProduct`, `audit` — reads an `AdminSession`, and giving the
 * token path its own parallel type would mean every one of those call sites growing a branch, i.e.
 * two authorization implementations where there is currently one. So the token becomes a session
 * shape instead, with two properties worth stating plainly:
 *
 *  - The `sub` is `token:<id>`, NOT the minting operator's OIDC subject. An audit row must say
 *    which credential acted; attributing a CI run to the human who minted its token six months
 *    ago is exactly the confusion this whole credential exists to remove. The `:` cannot collide
 *    with an OIDC `sub` we would ever issue, and it is what the rate limiter keys on too.
 *  - `groups` carries `PLATFORM_ADMIN_GROUP` — the SAME group the session path requires, so
 *    `isPlatformAdmin` is one implementation with one input. When the deployment has not
 *    configured that group, the array is empty and the token authorises nothing, which is the
 *    same fail-closed answer a cookie gets (`authz.ts`). Authority is not being invented here:
 *    the token was minted BY a platform admin, and it is narrowed further by its scopes.
 */
export function tokenSession(env: Env, row: AdminApiTokenRow): AdminSession {
  const group = env.PLATFORM_ADMIN_GROUP;
  return {
    sub: `token:${row.id}`,
    name: row.label,
    email: "",
    groups: group ? [group] : [],
    // No CSRF token: a token-authenticated request is exempt (see `admin/api.ts`), and an empty
    // string here can never satisfy the header check even if that exemption were ever removed.
    csrf: "",
    exp: row.expires_at,
  };
}

/**
 * Which scope a request needs — the whole authorization table for token principals.
 *
 * `segments` is the path after `/api`, already split: `["products", "<slug>", "bundles"]` for the
 * bundle mint. `null` means "no scope covers this route", which for a token is a refusal.
 */
export function scopeForRequest(
  method: string,
  segments: string[],
): AdminApiScope | null {
  if (
    method === "POST" &&
    segments.length === 3 &&
    segments[0] === "products" &&
    segments[2] === "bundles"
  ) {
    return "bundles:mint";
  }
  return null;
}

/**
 * The product a token-authenticated request acts on, for the audit row. `null` when the request
 * is not product-scoped — which today cannot happen, because the only scoped route is, but the
 * audit table is product-keyed and a caller has to answer the question before writing.
 */
function auditProduct(segments: string[]): string | null {
  return segments[0] === "products" && segments[1] ? segments[1] : null;
}

/**
 * Record that a token was used. Every use, not just every mutation: the point of a machine
 * credential's audit trail is that an operator can answer "what has this token been doing", and a
 * trail that omits reads answers a different question.
 */
export async function auditTokenUse(
  db: Db,
  row: AdminApiTokenRow,
  session: AdminSession,
  method: string,
  segments: string[],
  scope: AdminApiScope,
  now: number,
): Promise<void> {
  const product = auditProduct(segments);
  if (!product) return;
  await audit(
    db,
    product,
    session,
    now,
    "api_token.used",
    { kind: "api_token", id: row.id },
    `API token ${row.label} (${row.id}) exercised ${scope} on ${method} /${segments.join("/")}`,
  );
}

// ── The mint / list / revoke surface ─────────────────────────────────────────

/**
 * `/manage/api/tokens[/<id>]`.
 *
 *   GET    /tokens        — the roster. Never a secret, never a hash.
 *   POST   /tokens        — mint. The plaintext appears in THIS response and nowhere else, ever.
 *   DELETE /tokens/<id>   — revoke.
 *
 * Platform-admin gated like the rest of the registry surface, and reachable only by a SESSION:
 * `scopeForRequest` names no scope for these paths, so the dispatcher refuses a token principal
 * before this function is called. Minting a credential is an interactive, attributable act.
 */
export async function handleAdminApiTokens(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  segments: string[],
  now: number,
): Promise<Response> {
  if (!isPlatformAdmin(env, session)) return forbiddenPlatform();

  const [id, ...extra] = segments;
  if (extra.length > 0) return notFound();

  if (!id) {
    if (req.method === "GET") {
      const rows = await listTokens(db);
      return adminJson({ tokens: rows.map((row) => tokenView(row, now)) });
    }
    if (req.method === "POST") return mintToken(req, env, db, now);
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  if (req.method !== "DELETE")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const row = await db.first<AdminApiTokenRow>(
    "SELECT * FROM admin_api_tokens WHERE id = ?",
    id,
  );
  if (!row) return notFound();
  if ((await revokeToken(db, id, now)) === 0) {
    return err(409, ErrorCode.BadRequest, "token is already revoked", { id });
  }
  return adminJson({
    ok: true,
    token: tokenView({ ...row, revoked_at: now }, now),
  });
}

function forbiddenPlatform(): Response {
  return err(403, ErrorCode.Forbidden, "platform admin required");
}

/**
 * ── WHERE THE LIFECYCLE TRAIL LIVES, AND WHY IT IS NOT IN `audit` ───────────────────────────
 *
 * Every USE of a token writes an `audit` row (`auditTokenUse`), because a use always names a
 * product and that is what the audit table is keyed by — `audit.product` is `NOT NULL REFERENCES
 * products(slug)` (migrations/0001). MINT and REVOKE have no product, and inventing a pseudo-slug
 * for them would either violate that foreign key on D1 (where it is enforced) or, worse, appear to
 * work in the SQLite the tests run against and fail only in production.
 *
 * So the roster row IS the lifecycle record: `created_at`, `expires_at`, `revoked_at` and
 * `last_used_at` are all on it, all shown by `GET /tokens`, and a revoked row is kept rather than
 * deleted precisely so the history survives. What that trail does not carry is WHICH operator
 * minted it; a platform-scoped audit log is the right place for that and this repository does not
 * have one — see the note in `handlers/products.ts`'s KEK sweep, which fans out per product for
 * exactly this reason. Adding one is a schema change with its own retention and access story, not
 * a column smuggled in beside a credential.
 */
async function mintToken(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const body = await readBody(req);
  const fields: string[] = [];

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 200) fields.push("label");

  // Mandatory, and bounded at both ends. There is no default: a machine credential's lifetime is
  // the one decision the person minting it has to make consciously, and a form field that
  // defaults to something is not that decision.
  const days =
    typeof body.expiresInDays === "number" ? body.expiresInDays : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS)
    fields.push("expiresInDays");

  // Omitted means every scope this build knows about — which is one. Stated explicitly so a
  // future second scope does not silently widen tokens that an older console minted.
  const requested =
    body.scopes === undefined ? [...ADMIN_API_SCOPES] : body.scopes;
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    !requested.every(isAdminApiScope)
  ) {
    fields.push("scopes");
  }

  if (fields.length > 0)
    return err(422, ErrorCode.BadRequest, "invalid token request", { fields });

  if ((await countLiveTokens(db, now)) >= MAX_ADMIN_API_TOKENS) {
    return err(
      409,
      ErrorCode.BadRequest,
      `at most ${MAX_ADMIN_API_TOKENS} live admin API tokens; revoke one first`,
    );
  }

  const scopes = [...new Set(requested as AdminApiScope[])].sort();
  const secret = mintAdminApiToken();
  const row: AdminApiTokenRow = {
    id: randomId("apitok"),
    token_hash: await hashKey(secret, env.KEY_HASH_PEPPER),
    label,
    scopes_json: JSON.stringify(scopes),
    created_at: now,
    expires_at: now + days * SECONDS_PER_DAY,
    last_used_at: null,
    revoked_at: null,
  };
  await db.run(
    `INSERT INTO admin_api_tokens
       (id, token_hash, label, scopes_json, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    row.id,
    row.token_hash,
    row.label,
    row.scopes_json,
    row.created_at,
    row.expires_at,
  );
  // The ONLY response that will ever carry the plaintext. `GET /tokens` cannot reproduce it —
  // nothing stored can — which is what makes "shown once" a fact about the system rather than a
  // convention that the console happens to follow.
  return adminJson({ ok: true, token: tokenView(row, now), secret }, 201);
}
