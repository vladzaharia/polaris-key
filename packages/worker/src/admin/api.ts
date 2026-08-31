/**
 * The admin JSON API dispatcher: `handleAdminApi(req, env, db, path, now)` where `path` is
 * everything AFTER `/manage` (e.g. `/api/me`, `/api/products/djdl/licenses`). Two route
 * families:
 *
 *   /api/me                                  — the signed-in identity + CSRF + grants
 *   /api/products                            — PLATFORM registry CRUD (platform admins only)
 *   /api/products/<slug>/...                 — per-product admin (platform admins only)
 *
 * Per-product resources are grouped by the SERVICE that owns them (plan §R1, spec §4.2). What is
 * left at the top level here is core/platform — the things a product has whether or not it runs
 * any service: `secrets/*`, `keys/rotate`, `activity`, `services[/revert]`, `bundles`. Everything
 * else is dispatched into a `ServiceDescriptor.adminHandle` with the full remaining path:
 *
 *   license/{licenses…,tiers…,policy[/revert]}   config/{catalog,profiles…}
 *   release/{health,resync,releases}             update/settings        identity/portal
 *
 * ── TWO CREDENTIALS, ONE GATE ───────────────────────────────────────────────────────────────
 *
 * There are now two ways to authenticate here, and they are ALTERNATIVES — never additive:
 *
 *   1. the console's signed `__Host-pkey_admin` cookie (a browser), or
 *   2. `Authorization: Bearer pkeya_…`, an admin API token (`./apiTokens.ts`).
 *
 * The token path exists because `pkey bundle` is not a browser and used to have to pretend to be
 * one. Everything after authentication is deliberately shared: the same rate-limit budget, the
 * same platform-admin group check, the same handlers, the same audit writer. The token principal
 * differs in exactly two places, both below — it is exempt from CSRF, and it is confined to its
 * scopes with default deny.
 *
 * Security posture, enforced on EVERY request (never trusting the SPA):
 *   - **Session-gated**: a valid signed cookie session, or a live in-scope API token, is
 *     required (401 otherwise).
 *   - **Group-gated**: every route — platform and per-product alike — requires
 *     `PLATFORM_ADMIN_GROUP`. There is no product-level admin: a product's `admin_group`
 *     column grants nothing. 403 otherwise.
 *   - **Rate-limited**: per-session-subject budget on the whole surface, plus a much tighter
 *     one on the audited 403 branch (R1-04).
 *   - **CSRF**: SESSION mutations must echo `X-PKey-CSRF`; mismatch ⇒ 403. Logout is a POST so
 *     that it goes through that check rather than around it (R1-03).
 *   - **Scoped**: a TOKEN-authenticated request must carry the scope its route demands, and
 *     every route this file has not explicitly scoped refuses tokens outright.
 *   - **Product-scoped D1**: every per-product query carries the slug — no cross-tenant read.
 *   - **Catalog-validated**: config/secret/flag values validate against the active catalog
 *     before any write (422 on failure).
 *   - **Secrets are write-only**: responses NEVER echo a stored secret value.
 *   - **Audited**: every mutation appends an audit row with the verified actor.
 *
 * This module is intentionally thin: session/CSRF gating plus top-level routing to the
 * focused handler modules under ./handlers. Shared helpers live under ./lib.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { getProduct } from "../repo.js";
import { rateLimitOk } from "../core/rateLimit.js";
import { canAdminProduct } from "./authz.js";
import { audit } from "./audit.js";

/** Admin limiter shard. One global Durable Object for the whole platform — see the note in
 *  rateLimitDo.ts; sub-sharding it is tracked as R10-04a. */
const ADMIN_RL_SHARD = "_admin";
import {
  buildClearCookie,
  CSRF_HEADER,
  sessionFromRequest,
  type AdminSession,
} from "./session.js";
import {
  AdminBodyError,
  adminJson,
  err,
  forbidden,
  isMutation,
  notFound,
  unauthorized,
} from "./lib/respond.js";
import { handleMe } from "./handlers/me.js";
import {
  auditTokenUse,
  bearerToken,
  handleAdminApiTokens,
  scopeForRequest,
  tokenSession,
  validateAdminApiToken,
  type AdminApiScope,
  type AdminApiTokenRow,
} from "./apiTokens.js";
import {
  handleProducts,
  handleProductScopedResource,
} from "./handlers/products.js";
import { handleActivity } from "./handlers/activity.js";
import { handleServicesAdmin } from "../core/servicesAdmin.js";
import { handleBundleMint } from "../core/bundles.js";
import { loadProduct } from "../core/products.js";
import { SERVICES } from "../mount.js";
import type { ServiceSlug } from "../core/services.js";

// ── per-product routing ────────────────────────────────────────────────────────
async function handleProductScoped(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  const product = await getProduct(db, slug);
  if (!product) return notFound();
  if (!canAdminProduct(env, session)) {
    // Authenticated-but-unauthorized access is low-volume + high-signal, so we audit it
    // (attributed to the verified actor). NOTE: we intentionally do NOT audit the
    // unauthenticated credential-path 401s — that would be a D1-write DoS amplifier.
    //
    // R1-04: the same reasoning applies here. The 403 branch is a GET, so no CSRF token is
    // required, and one D1 write per request is an amplifier for any actor holding a session
    // that fails this gate. The audit row is therefore budgeted: a few per actor+product per
    // window is all the signal an operator needs — the burst itself is the interesting event,
    // not each request in it — and beyond that the 403 is still returned, just not written.
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
    ) {
      await audit(
        db,
        slug,
        session,
        now,
        "access.denied",
        { kind: "product", id: slug },
        `Denied admin access to product ${slug}`,
      );
    }
    return forbidden("not an admin of this product");
  }

  // §R1 regrouped the customer-portal settings under Identity. The console spells the canonical
  // `identity/portal`, and the transitional `portal` → `identity/portal` rewrite is GONE: the
  // bare spelling now falls through to the 404 every other unknown resource gets. Everything
  // else in §R1's admin table moved the same way — `licenses`/`tiers`/`policy` are License's,
  // `schema`/`profiles` are Config's — with no aliases left behind.
  const [resource, id] = rest;

  // ── per-SERVICE admin (design spec §4.2) ────────────────────────────────────────────────
  //
  // `/manage/api/products/<slug>/<service>/…` is the service's own, dispatched through the same
  // descriptor the public router uses (`ServiceDescriptor.adminHandle`). The FULL remaining path
  // is handed over, not the five destructured positions below — a service routes itself.
  //
  // Enablement is NOT checked here, unlike the public dispatcher. An operator has to be able to
  // reach a service's settings in order to configure it before turning it on, and the console is
  // already behind the platform-admin gate above; hiding a disabled service from an authenticated
  // platform admin would protect nothing and would make "enable then configure" impossible.
  if (resource && SERVICES.has(resource as ServiceSlug)) {
    const descriptor = SERVICES.get(resource as ServiceSlug)!;
    if (descriptor.adminHandle) {
      const loaded = await loadProduct(env, db, slug);
      if (!loaded) return notFound();
      const res = await descriptor.adminHandle({
        req,
        env,
        db,
        product: loaded,
        rest: rest.slice(1),
        now,
        session,
      });
      if (res) return res;
    }
    return notFound();
  }

  // Platform-owned per-product resources — they exist for a product running NO service at all,
  // which is why they are not under one:
  //   PUT  /products/<slug>/secrets/<name>
  //   POST /products/<slug>/keys/rotate
  if (resource === "secrets" || resource === "keys") {
    return handleProductScopedResource(
      req,
      env,
      db,
      session,
      slug,
      resource,
      id,
      now,
    );
  }

  // Which Polaris Key services this product runs (plan §R4). A CORE resource, not a per-service
  // one: a service cannot own its own off switch, because it would have to be running to be
  // turned off. `id` carries the single sub-action (`revert`).
  if (resource === "services") {
    return handleServicesAdmin(req, env, db, session, slug, id, now);
  }

  // Offline activation bundles (wire v3 §7). CORE for the same reason `services` is: one bundle
  // carries the License document AND the Config document, either of which may be absent, so it
  // belongs to neither service — a config-only product mints one with no licence in it at all.
  if (resource === "bundles") {
    return handleBundleMint(req, env, db, session, slug, id, now);
  }

  if (resource === "activity") {
    return handleActivity(req, db, slug);
  }

  return notFound();
}

/**
 * Admin API dispatcher. `path` is everything AFTER `/manage` (so it begins with `/api`).
 * Verifies the session, CSRF-checks mutations, then routes. Returns 401/403 cleanly.
 */
export async function handleAdminApi(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  now: number,
): Promise<Response> {
  // The bearer token wins when one is presented, and a presented-but-bad token is a 401 rather
  // than a fall-through to the cookie. Falling through would mean a request carrying BOTH an
  // expired token and a live session silently ran as the human — the ambiguity a "try everything"
  // authenticator always creates, and the reason `readSingleCookie` fails closed on a duplicate
  // cookie rather than choosing a winner. One request, one credential, chosen by what it presents.
  const presented = bearerToken(req);
  let apiToken: { row: AdminApiTokenRow; scopes: AdminApiScope[] } | null =
    null;
  let session: AdminSession | null;
  if (presented !== null) {
    const auth = await validateAdminApiToken(env, db, presented, now);
    // ONE 401 for malformed / unknown / revoked / expired / unusable. Telling them apart would
    // let a holder of a dead token learn whether the string was ever valid, and the operator who
    // needs the distinction has the roster (`GET /manage/api/tokens`) to read it from.
    if (!auth.ok) return unauthorized();
    apiToken = { row: auth.row, scopes: auth.scopes };
    session = tokenSession(env, auth.row);
  } else {
    session = await sessionFromRequest(env, req, now);
  }
  if (!session) return unauthorized();

  // R1-04: the admin API had NO rate limiter of any kind — only /manage/login and
  // /manage/callback were limited — while several of its routes write to D1. The budget is
  // keyed by the VERIFIED session subject, not the IP, so it follows the actor rather than
  // the network path, and it is generous enough that the SPA's normal fan-out never trips it.
  // Fails OPEN (see rateLimit.ts): a signed-in operator must not be locked out of the console
  // by a limiter outage, and the session gate above is the real access control here.
  if (
    !(await rateLimitOk(
      env,
      ADMIN_RL_SHARD,
      {
        bucket: "adminApi",
        id: session.sub,
        limit: 600,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return err(429, "rate_limited", "too many admin API requests");
  }

  // Strip the `/api` prefix; tolerate trailing slash.
  let p = path.startsWith("/api") ? path.slice(4) : path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  const segments = p.split("/").filter(Boolean);

  // CSRF on every SESSION mutation (double-submit; SameSite=Strict is the primary defense).
  //
  // A TOKEN-authenticated request is exempt, and the reason is not convenience. CSRF defends
  // against a credential the browser attaches AMBIENTLY: an attacker's page can cause a request
  // to this origin, and the cookie rides along without the attacker ever seeing it. An
  // `Authorization` header is not ambient — nothing attaches it but the caller, so a cross-site
  // page cannot cause a token-authenticated request at all, and there is no forgeable request to
  // defend against. (The converse is what makes this safe to skip only here: `tokenSession` mints
  // an empty `csrf`, so if this exemption were ever removed the token path would fail closed
  // rather than pass with a blank token.)
  if (apiToken === null && isMutation(req.method)) {
    const csrf = req.headers.get(CSRF_HEADER);
    if (!csrf || csrf !== session.csrf) return forbidden("csrf");
  }

  // Scope confinement, DEFAULT DENY. `scopeForRequest` names the routes a token may reach; every
  // other route — including the token surface itself, so a token can neither mint nor revoke one
  // — returns `null` here and is refused. A route added without a scope decision is therefore
  // unreachable by token rather than silently covered by every token already in circulation.
  if (apiToken !== null) {
    const required = scopeForRequest(req.method, segments);
    if (required === null || !apiToken.scopes.includes(required)) {
      return forbidden("token is not scoped for this route");
    }
    // Audited BEFORE dispatch: the credential was accepted and exercised, which is the event an
    // operator reviewing a token's history needs, whatever the handler goes on to answer.
    await auditTokenUse(
      db,
      apiToken.row,
      session,
      req.method,
      segments,
      required,
      now,
    );
  }

  const [head, ...rest] = segments;

  if (head === "me") return handleMe(env, db, session);
  // The admin API-token surface (A2-02/A2-05). PLATFORM-scoped, like `/products`: a token belongs
  // to the platform, not to a product, so it is not under a slug.
  if (head === "tokens")
    return withBodyErrors(() =>
      handleAdminApiTokens(req, env, db, session, rest, now),
    );
  if (head === "logout") {
    // R1-03: logout clears the session, so it is a mutation and must go through the CSRF
    // check above — which `isMutation` only applies to non-GET methods. As a GET it was a
    // state-changing route that skipped the gate entirely; cross-site exploitation was
    // blocked only by `SameSite=Strict`, i.e. by a cookie attribute that a future relax to
    // `SameSite=Lax` (the usual fix for post-OIDC redirects) would quietly remove.
    if (req.method !== "POST")
      return err(405, "method_not_allowed", "logout requires POST");
    return adminJson({ ok: true }, 200, { "set-cookie": buildClearCookie() });
  }
  if (head === "products") {
    // /products, /products/link-repo, or /products/<slug>/...
    // `link-repo` is a single-segment action, NOT a slug — handleProducts special-cases it
    // (with its platform-admin gate) before treating the segment as a product slug.
    return withBodyErrors(async () => {
      if (rest.length <= 1)
        return handleProducts(req, env, db, session, rest, now);
      const [slug, ...productRest] = rest;
      return handleProductScoped(
        req,
        env,
        db,
        session,
        slug!,
        productRest,
        now,
      );
    });
  }

  return notFound();
}

/**
 * Turn a malformed/oversized request body into its declared status instead of a 500.
 *
 * `readBody` throws `AdminBodyError` from deep inside a handler rather than returning it, so the
 * boundary that converts it has to sit at dispatch. It was inline around the `/products` arm; it
 * is a function now because `/tokens` reads a body too, and the second copy of a `catch` is how
 * one of them ends up not being there.
 */
async function withBodyErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AdminBodyError)
      return err(e.status, e.code, e.message, e.extra);
    throw e;
  }
}
