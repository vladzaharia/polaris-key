/**
 * The admin JSON API dispatcher: `handleAdminApi(req, env, db, path, now)`, where `path` is
 * everything AFTER `/manage` (e.g. `/api/me`, `/api/products/djdl/license/licenses`).
 *
 * Deny by default (ST-29; ST-28 plan §2.7). Every route is a row of the one route table
 * (`./routes.ts`), and this module walks it in a fixed order, never trusting the SPA:
 *
 *   1. **Credential, then principal.** A valid signed cookie session, an admin API token
 *      (`Authorization: Bearer pkeya_…`, `./apiTokens.ts`) or an admin-scope personal token
 *      (`Bearer pkeyp_…`, ST-34.3: the holder's own principal, re-read per request), is required (401). They are
 *      ALTERNATIVES, never additive: a bearer that is presented decides the request, and a bad one
 *      is a 401, never a fall-through to the cookie. The principal is resolved from the session
 *      (`resolveConsoleCaller`: today the root rule, the platform admin group) or from the token's
 *      synthetic one, and set on `session.principal` for the handler. This is the ONLY module that
 *      reads the session cookie (`sessionFromRequest`) or validates a token; the docs gate uses the
 *      cookie resolver and nothing else. A principal with no grant is no member, and every route
 *      answers it 403 (after the limiter), except `GET /me` and `POST /logout`.
 *   2. **Rate limit.** A per-member budget on the whole surface (R1-04): the OIDC subject for a
 *      session, `token:<id>` for a token, so neither can spend the other's.
 *   3. **Token reach.** A token caller may call only a row that names a `tokenScope` it holds
 *      (`./routes.ts`); every other row, path and method is the same 403, so the answer reveals
 *      nothing about what exists. Default deny.
 *   4. **CSRF.** A session mutation must echo `X-PKey-CSRF`; a mismatch is a 403 (double-submit;
 *      `SameSite=Strict` is the primary defense). Logout is a POST so it goes through it (R1-03).
 *      A token request is exempt: nothing but its caller attaches an `Authorization` header, so
 *      there is no ambient credential to forge.
 *   5. **Match.** No row: 404. A row for the path but not the method: 405 with `Allow`.
 *   6. **One product load** for a `/products/:slug` row (404).
 *   7. **`can()`** on the row's area and level: a 403 `{error: {code: "forbidden", reason:
 *      "no_access", scope, area}}`, with a budgeted `access.denied` row on a product (a few per
 *      member and product per window: the burst is the signal, and an unbudgeted write per 403
 *      is a D1 amplifier).
 *   8. **Step-up** for a row that needs it: a 403 `step_up_required` (`./stepUp.ts`).
 *   9. **The handler**, with a token's use audited first (`api_token.used`) and a malformed body
 *      answered as its 4xx (P0-16).
 *
 * The handlers keep the rest of the posture: product-scoped D1 (every per-product query carries
 * the slug), catalog validation before writes, write-only secrets, an audit row per mutation with
 * the verified actor, and `writeSettings()`'s own area check on every key it writes.
 */

import { constantTimeEqual } from "../platform/compare.js";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { getProduct } from "../core/products/store.js";
import { loadProductContext, type ProductContext } from "../core/products.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { audit, platformAudit } from "../core/audit.js";
import { isPersonalToken } from "../platform/crypto.js";
import {
  ADMIN_SCOPE,
  getAccountToken,
  resolvePersonalToken,
  touchPersonalToken,
} from "../core/accounts/personalTokens.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "../core/console/session.js";
import {
  AdminBodyError,
  err,
  isMutation,
  notFound,
  unauthorized,
} from "../core/console/respond.js";
import {
  can,
  canSeeProduct,
  PLATFORM,
  PRODUCT_AREAS,
  productScope,
  resolvePrincipal,
  type AreaId,
  type Principal,
  type Scope,
} from "./authz.js";
import { findRoute, levelOf } from "./routeMatch.js";
import { liveSubjectFor } from "./consoleSession.js";
import {
  ADMIN_ROUTES,
  isProductRoute,
  methodNotAllowed,
  type AdminRoute,
} from "./routes.js";
import { requireStepUp } from "./stepUp.js";
import {
  auditTokenUse,
  presentedToken,
  tokenSession,
  validateAdminApiToken,
  type AdminApiScope,
  type ValidAdminApiToken,
} from "./apiTokens.js";
import { consoleTokenSubject } from "../services/identity/public.js";
import { SETTINGS } from "../mount.js";

/** Admin limiter shard. One global Durable Object for the whole platform — see the note in
 *  rateLimitDo.ts; sub-sharding it is tracked as R10-04a. */
const ADMIN_RL_SHARD = "_admin";

/** A verified console caller: the session and the principal resolved for it. */
export interface ConsoleCaller {
  session: AdminSession;
  principal: Principal;
}

/** The principal for a verified session, set on the session for the handler: the one step both
 *  credentials share, so a token is authorized by the same rule as a cookie. */
async function callerFor(
  env: Env,
  db: Db | null,
  session: AdminSession,
  now: number,
): Promise<ConsoleCaller> {
  const principal = await resolvePrincipal(
    env,
    db,
    {
      sub: session.sub,
      groups: session.groups,
      // A v2 session's root is the computed rule (strong link, fresh assertion); a break-glass or
      // token session has none and falls back to its groups.
      ...(session.root !== undefined ? { root: session.root } : {}),
      // ST-31.2: only a v2 session has an account id; a break-glass session and a token stay root-only.
      ...(session.aid ? { accountId: session.aid } : {}),
    },
    now,
  );
  return { session: { ...session, principal }, principal };
}

/**
 * The console's one session reader (ST-29): verify the cookie, then resolve the principal. `null`
 * when there is no valid, unrevoked session. The admin API (below) and the docs gate (`docs.ts`)
 * both come through here, so they cannot disagree about who is asking; a grep test keeps
 * `sessionFromRequest` to this module. It reads the COOKIE only: an `Authorization` header is the
 * admin API's alone, so a token opens nothing else (the docs gate included).
 */
/** Set on a 401 when the request carried a console session cookie that no longer verifies. */
export const SESSION_STATE_HEADER = "X-PKey-Session";

function hasAdminCookie(req: Request): boolean {
  return (req.headers.get("cookie") ?? "")
    .split(";")
    .some((c) => c.trim().startsWith(`${ADMIN_COOKIE}=`));
}

export async function resolveConsoleCaller(
  env: Env,
  db: Db | null,
  req: Request,
  now: number,
): Promise<ConsoleCaller | null> {
  // A v2 cookie is resolved against its session row (at most every 30 s); with no database to ask
  // it is refused, never trusted.
  const session = await sessionFromRequest(
    env,
    req,
    now,
    db ? liveSubjectFor(env, db, now) : undefined,
  );
  return session ? callerFor(env, db, session, now) : null;
}

/** The scope string a 403 names: `platform`, or `product:<slug>`. */
function scopeName(scope: Scope): string {
  return scope.kind === "product" ? `product:${scope.slug}` : "platform";
}

/**
 * The area a row needs. `byKey` (`settings/:key`, `claims/:key`) takes the registry key's
 * `rbacArea`; a key the registry does not know needs `settings`, and its handler answers 404.
 * `anyArea` is any one of the product's areas; a refusal names `core`, the record's own.
 */
export function areaFor(
  route: AdminRoute,
  params: Record<string, string>,
): AreaId {
  if (route.area === "anyArea") return "core";
  if (route.area !== "byKey") return route.area;
  const key = params.key ?? "";
  return SETTINGS.get(key, "product")?.rbacArea ?? "settings";
}

/** Does the principal hold what the row needs, in this scope? */
function allowedRoute(
  principal: Principal,
  scope: Scope,
  route: AdminRoute,
  params: Record<string, string>,
): boolean {
  const level = levelOf(route);
  if (route.area === "anyArea")
    return PRODUCT_AREAS.some((a) => can(principal, scope, a, level));
  return can(principal, scope, areaFor(route, params), level);
}

/** The 403 for a principal that lacks the area (P0-16's nested error shape). */
function forbiddenArea(scope: Scope, area: AreaId): Response {
  return err(403, "forbidden", "You don't have access to this.", {
    reason: "no_access",
    scope: scopeName(scope),
    area,
  });
}

/**
 * The budgeted `access.denied` row for an authenticated reach into a product (R1-04). One D1
 * write per denied request is an amplifier for anyone holding a session that fails the check, and
 * the denial needs no CSRF token on a GET: a few rows per member and product per window carry all
 * the signal, and beyond that the 403 is still returned, just not written. A platform-scope
 * denial writes nothing, as before the route table.
 */
async function auditDenied(
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  area: AreaId,
  now: number,
): Promise<void> {
  if (
    await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminAccessDenied",
        id: `${session.sub}:${slug}`,
        limit: 3,
        windowSec: 300,
      },
      now,
    )
  )
    await audit(
      db,
      slug,
      session,
      now,
      "access.denied",
      { kind: "product", id: slug },
      `Denied admin access to product ${slug} (${area})`,
    );
}

/** An admin-scope personal token that passed every check, as the session it presents. */
interface PersonalAdminToken {
  id: string;
  label: string;
  hint: string;
  /** `last_used_at` as read at resolution: a fresh one means the use writes nothing. */
  lastUsedAt: number | null;
  session: AdminSession;
}

/**
 * Resolve `Bearer pkeyp_…` for the admin API (ST-34.3), or `null` for the one 401. Three checks, none
 * cached: the token (`resolvePersonalToken`, scope `admin` only: live, unexpired, unrevoked, account
 * not erased), then who the holder IS right now (`consoleTokenSubject`: account active and not
 * merged, a strong console link through an allowed issuer, and the root rule recomputed from
 * `asserted_at`, so a lapsed assertion is `root: false` with no groups), then the token's row for its
 * label and expiry. The subject is read on every request, never held longer than
 * `LIVE_CHECK_SECONDS` (here: not at all), so a disabled or merged holder stops on the next request.
 * The session carries the member id as `sub`, the account as `aid` (so `resolvePrincipal` reads the
 * holder's stored bindings), the token's expiry, no CSRF token and NO `stepUpAt`.
 */
async function personalAdminToken(
  env: Env,
  db: Db,
  presented: string,
  now: number,
): Promise<PersonalAdminToken | null> {
  const resolved = await resolvePersonalToken(
    env,
    db,
    presented,
    ADMIN_SCOPE,
    now,
    // `last_used_at` is written by the dispatcher once the request has cleared every gate.
    { touch: false },
  );
  if (!resolved) return null;
  const subject = await consoleTokenSubject(env, db, resolved.accountId, now);
  if (!subject) return null;
  const view = await getAccountToken(
    db,
    resolved.accountId,
    resolved.tokenId,
    now,
  );
  if (!view || view.status !== "active") return null;
  return {
    id: view.id,
    label: view.label,
    hint: view.hint,
    lastUsedAt: view.lastUsedAt,
    session: {
      sub: subject.sub,
      name: subject.name,
      email: subject.email,
      groups: subject.groups,
      root: subject.root,
      aid: resolved.accountId,
      tokenId: view.id,
      csrf: "",
      exp: view.expiresAt,
    },
  };
}

/**
 * D-15: every use of an admin personal token is audited as `account_token.used`, before the
 * handler: on the product for a product row, in `platform_audit` otherwise. The actor is the member
 * id; the summary names the label and the last four characters, never the token or its hash.
 */
async function auditPersonalTokenUse(
  db: Db,
  token: PersonalAdminToken,
  use: { method: string; path: string; product: string | null },
  now: number,
): Promise<void> {
  const target = { kind: "personal_token", id: token.id };
  const summary = `Personal token ${token.label} (…${token.hint}) used on ${use.method} ${use.path}`;
  if (use.product)
    await audit(
      db,
      use.product,
      token.session,
      now,
      "account_token.used",
      target,
      summary,
    );
  else
    await platformAudit(
      db,
      token.session,
      now,
      "account_token.used",
      target,
      summary,
    );
}

/**
 * The admin API dispatcher. `path` is everything AFTER `/manage` (so it begins with `/api`).
 */
export async function handleAdminApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  // 1. Credential, then principal. A bearer that is presented decides the request: a token that
  // is malformed, unknown, revoked, expired or unusable is a 401, never a fall-through to the
  // cookie. Falling through would mean a request carrying BOTH an expired token and a live session
  // silently ran as the human: the ambiguity a "try everything" authenticator always creates, and
  // the reason the cookie reader fails closed on a duplicate cookie rather than choosing a winner.
  // One request, one credential, chosen by what it presents.
  const presented = presentedToken(req);
  let token: ValidAdminApiToken | null = null;
  let personal: PersonalAdminToken | null = null;
  let caller: ConsoleCaller | null;
  if (presented !== null && isPersonalToken(presented)) {
    // ST-34.3: a `pkeyp_` is routed by its prefix. Any failure (a packages token, an unknown,
    // revoked or expired one, a holder who can no longer open the console) is the same 401.
    personal = await personalAdminToken(env, db, presented, now);
    if (!personal) return unauthorized();
    caller = await callerFor(env, db, personal.session, now);
  } else if (presented !== null) {
    const auth = await validateAdminApiToken(env, db, presented, now);
    // ONE 401 for every cause. Telling them apart would let the holder of a dead token learn
    // whether the string was ever valid; the operator who needs the distinction has the roster
    // (`GET /manage/api/tokens`) to read it from.
    if (!auth.ok) return unauthorized();
    token = auth;
    caller = await callerFor(env, db, tokenSession(env, auth.row), now);
  } else {
    caller = await resolveConsoleCaller(env, db, req, now);
  }
  if (!caller) {
    const res = unauthorized();
    // A session cookie was presented and no longer holds: the SPA says "Your session ended".
    // No cookie (a first visit) carries no header, and the SPA shows the plain sign-in card.
    if (presented === null && hasAdminCookie(req))
      res.headers.set(SESSION_STATE_HEADER, "expired");
    return res;
  }
  const { session, principal } = caller;

  // 2. R1-04: a budget keyed by the VERIFIED member, not the IP, so it follows the actor rather
  // than the network path, and generous enough that the SPA's normal fan-out never trips it.
  // Fails OPEN (see rateLimit.ts): a signed-in operator must not be locked out of the console by
  // a limiter outage, and the checks below are the real access control here.
  if (
    !(await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminApi",
        // A personal token has its own budget, so a CLI loop cannot spend the person's console one.
        id: personal ? `ptok:${personal.id}` : principal.memberId,
        limit: 600,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return err(429, "rate_limited", "too many admin API requests");
  }
  // ST-34.4: and one cap across ALL of a member's personal tokens (up to 25), so many tokens do
  // not multiply the budget, and with it the `account_token.used` rows a holder can write.
  if (
    personal &&
    !(await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminApiPersonal",
        id: principal.memberId,
        limit: 600,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return err(429, "rate_limited", "too many admin API requests");
  }

  // Strip the `/api` prefix; tolerate a trailing slash. HEAD reads as GET.
  let p = path.split(/[?#]/)[0]!;
  p = p.startsWith("/api") ? p.slice(4) : p;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const found = findRoute(ADMIN_ROUTES, method, segments);

  // 3. A token's reach, DEFAULT DENY. The route table names what a token may call (a row's
  // `tokenScope`); every other row, a path no row matches and a method no row serves are refused
  // the same way, so the answer reveals nothing about what exists, and a route added without a
  // scope decision is unreachable by token rather than silently covered by every token already in
  // circulation. The token routes name no scope, so a token can neither mint nor revoke one,
  // itself included.
  let scopeUsed: AdminApiScope | null = null;
  if (token) {
    const needed = found.kind === "route" ? found.route.tokenScope : undefined;
    if (!needed || !token.scopes.includes(needed))
      return err(403, "forbidden", "token is not scoped for this route");
    scopeUsed = needed;
  }

  // The same default deny for a personal token (ST-34.3): only a row flagged `personalToken`.
  // The answer is the one a `pkeya_` gets, so it reveals nothing about what exists.
  if (personal && !(found.kind === "route" && found.route.personalToken))
    return err(403, "forbidden", "token is not scoped for this route");
  // A verified session whose principal holds no grant is not a member: every route answers the
  // same 403, so it learns nothing about what exists. (The sign-in gate mints no such session; one
  // appears when the platform group changes under a live cookie.) A reach into an existing
  // product is still audited on that product. Five rows stay open to it, so a refused member can
  // still read who they are (`GET /me`, for the console's "no access" screen), sign out
  // (`POST /logout`, which still passes the CSRF check below), and find and end their OWN personal
  // tokens (`GET /me/personal-tokens`, `DELETE /me/personal-tokens/:id`, ST-34.4 review: they read
  // no product data, a revoke only narrows, and both are session-only), and a personal token whose
  // holder lost every grant can still end ITSELF (`DELETE /me/personal-tokens/current`, ST-34.7
  // review: `pkey logout` must be able to revoke); none reads any product data.
  const noGrantRow =
    found.kind === "route" &&
    ((found.route.method === "GET" && found.route.path === "/me") ||
      (found.route.method === "POST" && found.route.path === "/logout") ||
      (found.route.method === "GET" &&
        found.route.path === "/me/personal-tokens") ||
      (found.route.method === "DELETE" &&
        found.route.path === "/me/personal-tokens/:id") ||
      (found.route.method === "DELETE" &&
        found.route.path === "/me/personal-tokens/current"));
  if (!noGrantRow && !can(principal, PLATFORM, "console", "view")) {
    if (found.kind === "route" && isProductRoute(found.route)) {
      const target = await getProduct(db, found.match.params.slug ?? "");
      if (target)
        await auditDenied(env, db, session, target.slug, "console", now);
    }
    return forbiddenArea(PLATFORM, "console");
  }

  // ST-34.4: a row only a personal token may call (`DELETE /me/personal-tokens/current`, which
  // revokes the presenting token). Gated on the dispatcher's `personal`, never on `session.aid` or
  // `tokenId` being present: a token session carries an `aid`, and a cookie body cannot name a
  // `tokenId`, but neither is what says which credential this request presented.
  if (found.kind === "route" && found.route.personalOnly && !personal)
    return err(403, "forbidden", "this route takes a personal token");

  // 4. CSRF on every SESSION mutation (double-submit; SameSite=Strict is the primary defense).
  //
  // A token request is exempt, and the reason is not convenience. CSRF defends against a
  // credential the browser attaches AMBIENTLY: an attacker's page can cause a request to this
  // origin, and the cookie rides along without the attacker ever seeing it. An `Authorization`
  // header is not ambient: nothing attaches it but the caller, so a cross-site page cannot cause a
  // token request at all, and there is no forgeable request to defend against. The converse is
  // what makes the exemption safe only here: `tokenSession` carries an empty `csrf`, so if the
  // exemption were ever removed the token path would fail closed, refused, not waved through with
  // a blank token.
  if (!token && !personal && isMutation(req.method)) {
    const csrf = req.headers.get(CSRF_HEADER);
    if (!csrf || !constantTimeEqual(csrf, session.csrf))
      return err(403, "forbidden", "csrf");
  }

  // 5. Match.
  if (found.kind === "none") return notFound();
  if (found.kind === "method") return methodNotAllowed(found.allow);
  const { route, match } = found;

  // 6. One product load for a product-scoped row.
  let scope: Scope = PLATFORM;
  let product = null;
  let productCtx: ProductContext | null = null;
  if (isProductRoute(route)) {
    product = await getProduct(db, match.params.slug ?? "");
    if (!product) {
      // ST-31.8: an unknown slug answers like a real product the caller cannot reach (a 403 that
      // names the same scope and area), unless the caller holds a product scope that would reach
      // it (Superadmin, `products:*`), who can list every product anyway. A 404 here for everyone
      // else would tell a member of one product which other slugs exist.
      const slug = match.params.slug ?? "";
      const ghost = { slug, system: 0 };
      if (!canSeeProduct(principal, ghost))
        return forbiddenArea(productScope(ghost), areaFor(route, match.params));
      return notFound();
    }
    scope = productScope(product);
    productCtx = loadProductContext(env, db, product);
  }

  // 7. The area.
  const area = areaFor(route, match.params);
  if (!noGrantRow && !allowedRoute(principal, scope, route, match.params)) {
    if (scope.kind === "product")
      await auditDenied(env, db, session, scope.slug, area, now);
    return forbiddenArea(scope, area);
  }

  // 8. Step-up. (A token has none, so it is refused every row that needs one.)
  if (route.stepUp) {
    const refused = requireStepUp(session, now);
    if (refused) return refused;
  }

  // 9. The handler. A token's use is audited first: the credential was accepted and exercised,
  // which is the event an operator reviewing a token's history needs, whatever the handler goes on
  // to answer. It is written here, not earlier, because by now the product is known to exist (the
  // row is keyed by it) and the request has cleared every gate.
  if (token && scopeUsed)
    await auditTokenUse(
      db,
      token.row,
      session,
      {
        scope: scopeUsed,
        method: req.method,
        path: `/${segments.join("/")}`,
        product: product?.slug ?? null,
      },
      now,
    );

  if (personal) {
    // Every gate is cleared: only now does the use mark the token.
    await touchPersonalToken(db, personal.id, now, personal.lastUsedAt);
  }
  // A holder with no grant reaches only `GET /me`: budget its use rows like `access.denied`, so a
  // de-privileged holder's tokens cannot write a row per request.
  if (
    personal &&
    (can(principal, PLATFORM, "console", "view") ||
      (await rateLimitOk(
        env,
        ADMIN_RL_SHARD,
        {
          bucket: "adminPersonalUseNoGrant",
          id: principal.memberId,
          limit: 3,
          windowSec: 300,
        },
        now,
      )))
  )
    await auditPersonalTokenUse(
      db,
      personal,
      {
        method: req.method,
        path: `/${segments.join("/")}`,
        product: product?.slug ?? null,
      },
      now,
    );

  try {
    return await route.handler({
      req,
      env,
      db,
      session,
      now,
      segments,
      params: match.params,
      rest: match.rest,
      product,
      productCtx,
    });
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}
