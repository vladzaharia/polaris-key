/**
 * The admin route table (ST-29; ST-28 plan §2.7): every `/manage/api` route the console serves,
 * with the area `can()` checks, the level, and whether it needs a console step-up. The
 * dispatcher (`./api.ts`) walks it deny-by-default: a request no row matches is a 404, a matching
 * path without the method is a 405 with `Allow`, and no handler runs before the principal passes
 * `can()` for the row's area.
 *
 * Scope. A path under `/products/:slug` is product scope: the dispatcher loads the product once
 * (404) and checks the area on it (the system product is evaluated as the platform, `can()` rule
 * 4). Every other row is platform scope, and its area says what it needs: `console` for what
 * every member may use, `platform` for the instance.
 *
 * Granularity. A row names a handler module's entry point; the handler still routes its own
 * sub-paths, so a row ending in `/**` covers a handler that owns a subtree (a service's
 * `adminHandle`, the feeds, the store connections). Its methods are the ones that subtree serves.
 *
 * Token reach. An admin API token (`./apiTokens.ts`) reaches a row only through the row's
 * `tokenScope`; a row without one refuses every token, and so does a path no row matches. Today
 * that is `POST /products/:slug/bundles` and the three read-side migration rows. A tokenised row still goes through `can()` for
 * its area like any other, and never needs a step-up (a token has none).
 *
 * Personal-token reach (ST-34.3). An admin-scope personal token (`Bearer pkeyp_`) reaches a row only
 * through `personalToken: true`; default deny, as above. Today: `GET /me`, `GET /access/admins`,
 * `GET /products`, `POST /products/:slug/bundles`, `GET /products/:slug/integration`, the three
 * read-side migration rows, `POST /products/:slug/distribution/listing/import` and (personal token
 * only, ST-34.4) `DELETE /me/personal-tokens/current`. The holder's own principal still passes `can()` per row, and a row
 * that needs a step-up never carries the flag (`test/surfaces/console/adminPersonalToken.test.ts` pins it).
 *
 * Drift. `test/fixtures/rbac-route-areas.json` pins every row's `METHOD path → area`; a new or
 * removed row updates it in the same change, and a changed area needs an `AREA_MOVES` entry
 * (`core/rbac/areas.ts`). The sidebar is never an input. `test/surfaces/console/rbacRouteMatrix.test.ts` drives
 * every row with eight principals against a hand-written oracle.
 */

import type { ProductContext } from "../core/products.js";
import type { Db } from "../db/types.js";
import type { Env } from "../platform/env.js";
import { SERVICE_SLUGS, type ServiceSlug } from "../core/services.js";
import { SERVICE_AREA } from "../core/rbac/areas.js";
import type { ProductRow } from "../core/repo.js";
import type { AdminSession } from "../core/console/session.js";
import { adminJson, err, notFound } from "../core/console/respond.js";
import { revokeAdminSessions } from "../core/console/sessionRevocation.js";
import { endConsoleCookieSession } from "./consoleSession.js";
import { consoleMemberIdForIdpSub } from "../services/identity/public.js";
import { buildClearCookie } from "../core/console/session.js";
import type { Method, RouteDecl } from "./routeMatch.js";
import { handleMe, handleMyPrefs } from "./handlers/me.js";
import {
  handleMyMethods,
  handleMyMethodStrong,
  handleMyPasskeyAdd,
  handleMyPasskeyOptions,
} from "./handlers/myMethods.js";
import { handleAttention } from "./handlers/attention.js";
import { handleAccessAdmins } from "./handlers/access.js";
import { handleSearch } from "./handlers/search.js";
import { handleSupportCodes } from "./handlers/supportCodes.js";
import { handleGithub } from "./handlers/github.js";
import { handlePlatformStoreConnections } from "./handlers/platformStoreConnections.js";
import { handlePlatform } from "./handlers/platform.js";
import { handlePlatformConnections } from "./handlers/platformConnections.js";
import { handleProducts } from "./handlers/products.js";
import { handleIntegration } from "./handlers/integration.js";
import {
  handleMyTokenList,
  handleMyTokenRevoke,
  handleMyTokenRevokeCurrent,
} from "./handlers/myTokens.js";
import { handleProductScoped } from "./productScoped.js";
import {
  handleApiTokenList,
  handleApiTokenMint,
  handleApiTokenRevoke,
} from "./handlers/apiTokens.js";
import {
  handleAccountTokenList,
  handleAccountTokenRevoke,
} from "./handlers/accountTokens.js";
import {
  handleProductMemberCreate,
  handleProductMemberEdit,
  handleProductMemberRevoke,
  handleProductMembers,
} from "./handlers/productMembers.js";
import {
  handleBindingCreate,
  handleBindingEdit,
  handleBindingRevoke,
} from "./handlers/bindings.js";
import { handleMemberGet, handleMembersList } from "./handlers/members.js";
import {
  handleMemberSignOut,
  handleMemberSignOutPreview,
} from "./handlers/memberSignOut.js";

/** What every handler receives once the dispatcher has authorized the request. */
export interface AdminCtx {
  req: Request;
  env: Env;
  db: Db;
  /** The verified session, with `principal` set by the dispatcher. */
  session: AdminSession;
  now: number;
  /** The path under `/manage/api`, split (empty segments dropped). */
  segments: readonly string[];
  params: Readonly<Record<string, string>>;
  /** The segments a trailing `/**` covered. */
  rest: readonly string[];
  /** The product, loaded once for a `/products/:slug` route; `null` elsewhere. */
  product: ProductRow | null;
  /** The same product as a request-scoped context: `load()` is the full `Product`, once. */
  productCtx: ProductContext | null;
}

export type AdminHandler = (ctx: AdminCtx) => Promise<Response>;
export type AdminRoute = RouteDecl<AdminHandler>;

// ── Handlers the dispatcher owns outright ────────────────────────────────────────────────────

/**
 * `POST /logout`. R1-03: logout clears the session, so it is a mutation and goes through the CSRF
 * check (as a GET it skipped the gate, and only `SameSite=Strict` stood between it and a
 * cross-site request). Sign-out also voids the cookie server-side, for every browser this
 * operator holds; a replay of the old cookie is a 401.
 */
async function logout(c: AdminCtx): Promise<Response> {
  let revoked = true;
  try {
    await revokeAdminSessions(c.env, c.session.sub, c.now);
    // A v2 session's `sub` is the member id; the operator's v1 cookies (signed before the deploy)
    // carry the IdP subject, so the mark goes there too.
    if (c.session.breakGlass) {
      // ST-30c.1: a break-glass session has no account; the mark under its IdP subject ends it,
      // and the operator's ordinary sessions are not touched.
    } else if (c.session.idpSub)
      await revokeAdminSessions(c.env, c.session.idpSub, c.now);
    else {
      // A v1 cookie: its `sub` is the IdP subject. The operator's v2 sessions read the mark under
      // the member id, so write that one too when the account is known.
      const member = await consoleMemberIdForIdpSub(c.env, c.db, c.session.sub);
      if (member) await revokeAdminSessions(c.env, member, c.now);
    }
    // A v2 session also ends its own row at once (and this isolate forgets it); the mark above
    // ends the operator's other cookies, v1 included.
    await endConsoleCookieSession(c.env, c.db, c.session, c.now);
  } catch {
    revoked = false;
  }
  return adminJson({ ok: true, revoked }, 200, {
    "set-cookie": buildClearCookie(),
  });
}

const me: AdminHandler = (c) => handleMe(c.env, c.db, c.session);
const attention: AdminHandler = (c) =>
  handleAttention(c.req, c.env, c.db, c.session, [], c.now);
const search: AdminHandler = (c) =>
  handleSearch(c.req, c.env, c.db, c.session, c.now);
const supportCodes: AdminHandler = (c) =>
  handleSupportCodes(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const github: AdminHandler = (c) =>
  handleGithub(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const platform: AdminHandler = (c) =>
  handlePlatform(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const storeConnections: AdminHandler = (c) =>
  handlePlatformStoreConnections(
    c.req,
    c.env,
    c.db,
    c.session,
    c.segments.slice(2),
    c.now,
  );
const registry: AdminHandler = (c) =>
  handleProducts(c.req, c.env, c.db, c.session, c.segments.slice(1), c.now);
const product: AdminHandler = (c) =>
  c.product ? handleProductScoped(c) : Promise.resolve(notFound());

// ── The table ────────────────────────────────────────────────────────────────────────────────

type Opts = Pick<
  AdminRoute,
  "level" | "stepUp" | "tokenScope" | "personalToken" | "personalOnly"
>;

function rows(
  methods: readonly Method[],
  path: string,
  area: AdminRoute["area"],
  handler: AdminHandler,
  opts: Opts = {},
): AdminRoute[] {
  return methods.map((method) => ({ method, path, area, handler, ...opts }));
}

const P = "/products/:slug";
const ALL: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A service's admin surface, by prefix, with the service's fixed area (§2.7). */
function serviceRows(slug: ServiceSlug): AdminRoute[] {
  return rows(ALL, `${P}/${slug}/**`, SERVICE_AREA[slug], product);
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  // ── Membership: what every console member may use ─────────────────────────────────────────
  ...rows(["GET"], "/me", "console", me, { personalToken: true }),
  // LK-FU-2: the operator's own console preferences (session only).
  ...rows(["PUT"], "/me/prefs", "console", (c) =>
    handleMyPrefs(c.db, c.session, c.req, c.now),
  ),
  // ST-30c.3 (SM-3(a), (d)): my own sign-in methods. Session only (break-glass refused in the
  // handler); each write needs a step-up. No removal here: that stays in the Locker account.
  ...rows(["GET"], "/me/methods", "console", handleMyMethods),
  ...rows(["POST"], "/me/passkeys/options", "console", handleMyPasskeyOptions, {
    stepUp: true,
  }),
  ...rows(["POST"], "/me/passkeys", "console", handleMyPasskeyAdd, {
    stepUp: true,
  }),
  ...rows(["POST"], "/me/methods/:id/strong", "console", handleMyMethodStrong, {
    stepUp: true,
  }),
  ...rows(["POST"], "/logout", "console", logout),
  // ST-34.4: the caller's own personal tokens. The list and the id revoke are session-only; `current`
  // is the one row that ends the presenting token (`pkey logout`), personal token only.
  ...rows(["GET"], "/me/personal-tokens", "console", handleMyTokenList),
  ...rows(
    ["DELETE"],
    "/me/personal-tokens/current",
    "console",
    handleMyTokenRevokeCurrent,
    {
      personalToken: true,
      personalOnly: true,
    },
  ),
  ...rows(
    ["DELETE"],
    "/me/personal-tokens/:id",
    "console",
    handleMyTokenRevoke,
  ),
  // Home's Needs attention: composed on the server, filtered by product and by fix area.
  ...rows(["GET"], "/attention", "console", attention),
  // I-41: a support code resolved to {product, subject}; the handler checks the caller's product access.
  ...rows(["GET"], "/support-codes/:code", "console", supportCodes),
  // ST-52: the palette's entity search and pasted-key resolution; each product is held to its own area.
  ...rows(["POST"], "/search", "console", search),
  // The product list, filtered the same way.
  ...rows(["GET"], "/products", "console", registry, { personalToken: true }),
  // NoAccessPage: who can give the caller access to a scope and area.
  ...rows(["GET"], "/access/admins", "console", handleAccessAdmins, {
    personalToken: true,
  }),

  // ── Platform ──────────────────────────────────────────────────────────────────────────────
  ...rows(["GET"], "/github/repositories", "platform", github),
  ...rows(["POST"], "/products", "platform", registry),
  ...rows(["GET"], "/products/slug-check", "platform", registry),
  ...rows(["GET"], "/products/kek", "platform", registry),
  ...rows(["POST"], "/products/kek", "platform", registry, { stepUp: true }),
  ...rows(["POST"], "/products/link-repo", "platform", registry),
  ...rows(["GET"], "/platform/version", "platform", platform),
  ...rows(["GET"], "/platform/ready", "platform", platform),
  ...rows(["GET"], "/platform/deployment", "platform", platform),
  ...rows(["GET"], "/platform/operations", "platform", platform),
  ...rows(["GET"], "/platform/activity", "platform", platform),
  ...rows(["GET"], "/platform/identity-migration", "platform", platform),
  ...rows(["GET"], "/platform/reserved-names", "platform", platform),
  ...rows(["GET"], "/platform/settings", "platform", platform),
  ...rows(["PATCH", "DELETE"], "/platform/settings/:key", "platform", platform),
  ...rows(["GET"], "/platform/settings/:key/reach", "platform", platform),
  ...rows(["GET", "POST"], "/platform/settings/backfill", "platform", platform),
  // ST-27: where operator alerts go. Adding, retargeting or removing a destination changes where alerts
  // go (a stolen session could silence them all), so each needs the step-up; a test send does not.
  ...rows(["GET"], "/platform/alerts", "platform", platform),
  ...rows(["POST"], "/platform/alerts", "platform", platform, { stepUp: true }),
  // PATCH checks the step-up in its handler: only a body that just turns a destination on skips it.
  ...rows(["PATCH"], "/platform/alerts/:id", "platform", platform),
  ...rows(["DELETE"], "/platform/alerts/:id", "platform", platform, {
    stepUp: true,
  }),
  ...rows(["POST"], "/platform/alerts/:id/test", "platform", platform),
  // P0-49: the data-migration runner. Apply and down are step-up writes.
  // A `migrations:report` token (`pkey migrate`) reaches the read side and the dry run; apply and
  // down need a step-up, which a token cannot have, so they refuse every token.
  ...rows(["GET"], "/platform/migrations", "platform", platform, {
    tokenScope: "migrations:report",
    personalToken: true,
  }),
  ...rows(["GET"], "/platform/migrations/runs/:id", "platform", platform, {
    tokenScope: "migrations:report",
    personalToken: true,
  }),
  ...rows(["POST"], "/platform/migrations/dry-run", "platform", platform, {
    tokenScope: "migrations:report",
    personalToken: true,
  }),
  ...rows(["POST"], "/platform/migrations/apply", "platform", platform, {
    stepUp: true,
  }),
  ...rows(["POST"], "/platform/migrations/down", "platform", platform, {
    stepUp: true,
  }),
  ...rows(["POST"], "/platform/feeds/bootstrap", "platform", platform),
  ...rows(["GET", "PUT", "POST"], "/platform/feeds/**", "platform", platform),
  // I-31: the platform's OIDC connections. Reads and the dry checks (discovery, the test) need
  // the platform area; every change is a step-up write. A token reaches none of them.
  ...rows(
    ["GET"],
    "/platform/connections",
    "platform",
    handlePlatformConnections,
  ),
  ...rows(
    ["POST"],
    "/platform/connections",
    "platform",
    handlePlatformConnections,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["POST"],
    "/platform/connections/discover",
    "platform",
    handlePlatformConnections,
  ),
  ...rows(
    ["POST"],
    "/platform/connections/test/start",
    "platform",
    handlePlatformConnections,
  ),
  ...rows(
    ["GET"],
    "/platform/connections/test/result",
    "platform",
    handlePlatformConnections,
  ),
  ...rows(
    ["GET"],
    "/platform/connections/:id",
    "platform",
    handlePlatformConnections,
  ),
  ...rows(
    ["PATCH", "DELETE"],
    "/platform/connections/:id",
    "platform",
    handlePlatformConnections,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["POST"],
    "/platform/connections/:id/domains",
    "platform",
    handlePlatformConnections,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["POST"],
    "/platform/connections/:id/domains/verify",
    "platform",
    handlePlatformConnections,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["PATCH", "DELETE"],
    "/platform/connections/:id/domains/:domain",
    "platform",
    handlePlatformConnections,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["GET", "PUT", "POST", "DELETE"],
    "/platform/store-connections/**",
    "platform",
    storeConnections,
  ),

  // ── Platform: the admin API tokens ────────────────────────────────────────────────────────
  // The machine credential `pkey bundle` presents (`./apiTokens.ts`). No row here names a
  // `tokenScope`, so a token cannot reach them: minting is an interactive act. It also needs a
  // proven sign-in (the step-up), so a stolen session cannot leave behind a credential that
  // outlives it. Revoking narrows authority and does not.
  ...rows(["GET"], "/tokens", "platform", handleApiTokenList),
  ...rows(["POST"], "/tokens", "platform", handleApiTokenMint, {
    stepUp: true,
  }),
  ...rows(["DELETE"], "/tokens/:id", "platform", handleApiTokenRevoke),
  // ── Platform: people's personal tokens (F-33) ─────────────────────────────────────────────
  // A Superadmin lists and revokes (`./handlers/accountTokens.ts`); the person mints, in the
  // portal. Session only, like the roster above.
  ...rows(["GET"], "/account-tokens", "platform", handleAccountTokenList),
  ...rows(
    ["DELETE"],
    "/account-tokens/:id",
    "platform",
    handleAccountTokenRevoke,
  ),

  // ── Platform: the Members roster (ST-31.4) ────────────────────────────────────────────────
  // Read-only here; `./handlers/members.ts`. Session only, like the rosters above.
  ...rows(["GET"], "/members", "members", handleMembersList),
  ...rows(["GET"], "/members/:memberId", "members", handleMemberGet),
  // ST-34.12: sign a member out everywhere. The GET is the dry run; both need `edit` (it names
  // token labels). No step-up: it only narrows (G4). The handler asks the grant rules.
  ...rows(
    ["GET"],
    "/members/:memberId/sign-out",
    "members",
    handleMemberSignOutPreview,
    { level: "edit" },
  ),
  ...rows(
    ["POST"],
    "/members/:memberId/sign-out",
    "members",
    handleMemberSignOut,
  ),
  // ST-31.6: the grant writes (`./handlers/bindings.ts`). A new grant is a step-up write; an edit
  // checks it in the handler, only when the change widens (G4); taking access back needs none.
  // The route table cannot tell a Platform admin from a Superadmin: the handler asks the grant
  // rules (G1 to G3) before it writes anything.
  ...rows(["POST"], "/bindings", "members", handleBindingCreate, {
    stepUp: true,
  }),
  ...rows(["PATCH"], "/bindings/:id", "members", handleBindingEdit),
  ...rows(["DELETE"], "/bindings/:id", "members", handleBindingRevoke),

  // ── One product: the record ───────────────────────────────────────────────────────────────
  // The record every holder of any of the product's areas reads (the shell's name and services);
  // editing it is Core's.
  ...rows(["GET"], P, "anyArea", registry),
  ...rows(["PATCH"], P, "core", registry),
  ...rows(["DELETE"], P, "settings", registry, { stepUp: true }),

  // ST-31.5: who holds this product (bindings, invites) and, read-only, who reaches it from above.
  ...rows(["GET"], `${P}/members`, "members", handleProductMembers),
  // ST-31.6 (D-d): the product-scope twins of the grant writes.
  ...rows(["POST"], `${P}/members`, "members", handleProductMemberCreate, {
    stepUp: true,
  }),
  ...rows(
    ["PATCH"],
    `${P}/members/:bindingId`,
    "members",
    handleProductMemberEdit,
  ),
  ...rows(
    ["DELETE"],
    `${P}/members/:bindingId`,
    "members",
    handleProductMemberRevoke,
  ),
  // ── One product: the services, by prefix ──────────────────────────────────────────────────
  // Approving a minted token's recipe lets the product's signing key mint for every device it
  // names (P0-12, U-31): a sign-in proven in the last five minutes, ahead of Config's prefix.
  ...rows(["POST"], `${P}/config/mint/:id/approve`, "config", product, {
    stepUp: true,
  }),
  // The CI readiness fix writes an environment and a tag ruleset on the customer's repository
  // (Administration write): a sign-in proven in the last five minutes, ahead of Release's prefix.
  ...rows(["POST"], `${P}/release/ci-readiness/fix`, "ship", product, {
    stepUp: true,
  }),
  ...SERVICE_SLUGS.flatMap(serviceRows),
  // A-20.4: the channels read model (Distribution + Commerce facets), composed in the console layer.
  ...rows(["GET"], `${P}/distribution/channels`, "ship", product),
  // The Feeds admin is Ship builds, composed in the console layer.
  ...rows(
    ["GET", "PUT", "POST"],
    `${P}/distribution/feeds/**`,
    "ship",
    product,
  ),

  // ST-34.4: `pkey listing import` presents an admin personal token. The specific row narrows the
  // distribution prefix: same area, `ship`, so the holder's own principal still has to pass it, and
  // only POST exists here (the diff and the confirmed apply are one route).
  ...rows(["POST"], `${P}/distribution/listing/import`, "ship", product, {
    personalToken: true,
  }),

  // ── One product: Core's resources ─────────────────────────────────────────────────────────
  // Every product setting the registry serves (ST-05b); the handler lists only the keys whose
  // area the caller holds, and `byKey` takes a key's own area.
  ...rows(["GET"], `${P}/settings/effective`, "core", product),
  ...rows(["GET"], `${P}/settings/drift`, "core", product),
  ...rows(["GET", "PATCH", "DELETE"], `${P}/settings/:key`, "byKey", product),
  ...rows(["GET", "POST"], `${P}/settings/backfill`, "settings", product),
  ...rows(["GET"], `${P}/settings/backfill/:reportId`, "settings", product),
  ...rows(["DELETE"], `${P}/claims/:key`, "byKey", product),
  // ST-27: this product's alert destinations (the override of the platform's).
  ...rows(["GET"], `${P}/alerts`, "settings", product),
  ...rows(["POST"], `${P}/alerts`, "settings", product, { stepUp: true }),
  ...rows(["PATCH"], `${P}/alerts/:id`, "settings", product),
  ...rows(["DELETE"], `${P}/alerts/:id`, "settings", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/alerts/:id/test`, "settings", product),
  ...rows(["GET", "PATCH"], `${P}/services`, "core", product),
  ...rows(["POST"], `${P}/services/revert`, "core", product),
  ...rows(["GET"], `${P}/activity`, "core", product),
  ...rows(["GET"], `${P}/integration`, "core", handleIntegration, {
    personalToken: true,
  }),
  ...rows(["GET"], `${P}/refusals`, "core", product),
  ...rows(["GET"], `${P}/blob-gc`, "core", product),
  ...rows(["GET"], `${P}/blob-gc/bundles`, "core", product),
  ...rows(["GET"], `${P}/assets`, "core", product),
  ...rows(["GET"], `${P}/assets/usage`, "core", product),
  ...rows(["POST"], `${P}/assets/mirror`, "core", product),
  ...rows(["PATCH", "DELETE"], `${P}/assets/settings/:key`, "core", product),
  ...rows(["POST", "DELETE"], `${P}/assets/:slot`, "core", product),
  ...rows(["GET"], `${P}/devices`, "core", product),
  ...rows(["GET"], `${P}/devices/summary`, "core", product),
  ...rows(["GET"], `${P}/devices/:id`, "core", product),
  ...rows(["POST"], `${P}/devices/:id/deauthorize`, "core", product),
  ...rows(["POST"], `${P}/devices/:id/fingerprint/reset`, "core", product),
  ...rows(["GET"], `${P}/users`, "core", product),
  ...rows(["GET"], `${P}/users/events`, "core", product),
  ...rows(["GET"], `${P}/users/:subject`, "core", product),
  ...rows(["GET"], `${P}/users/:subject/export`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/:subject/data/delete`, "core", product, {
    stepUp: true,
  }),
  ...rows(
    ["POST"],
    `${P}/users/:subject/licenses/:id/detach`,
    "core",
    product,
    {
      stepUp: true,
    },
  ),
  ...rows(
    ["POST"],
    `${P}/users/:subject/licenses/:id/relink`,
    "core",
    product,
    {
      stepUp: true,
    },
  ),
  ...rows(["GET"], `${P}/users/licenses/:id/relinks`, "core", product),
  ...rows(["POST"], `${P}/users/licenses/:id/make-floating`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/licenses/:id/reassign`, "core", product, {
    stepUp: true,
  }),
  ...rows(["POST"], `${P}/users/relinks/:id/undo`, "core", product, {
    stepUp: true,
  }),
  // An account's per-licence overrides are Managed config's.
  ...rows(["GET", "PUT"], `${P}/users/:subject/overrides`, "config", product),
  // Offline activation bundles carry the licence (and config) document. The one row an admin API
  // token reaches: `bundles:mint`, what `pkey bundle` presents.
  ...rows(["POST"], `${P}/bundles`, "license", product, {
    tokenScope: "bundles:mint",
    personalToken: true,
  }),
  // The Polaris Key storefront's panel (PS-06) is Commerce's surface (CM-29 §10).
  ...rows(["GET"], `${P}/storefronts/:store`, "commerce", product),
  ...rows(["POST"], `${P}/storefronts/:store/preview`, "commerce", product),
  ...rows(["GET"], `${P}/storefronts/:store/analytics`, "commerce", product),

  // ── One product: Keys & secrets (credentials and trust anchors) ───────────────────────────
  ...rows(["GET"], `${P}/secrets`, "keys", product),
  ...rows(["PUT"], `${P}/secrets/:name`, "keys", product),
  ...rows(["GET"], `${P}/keys`, "keys", product),
  ...rows(["POST"], `${P}/keys/:action`, "keys", product),
  ...rows(["GET"], `${P}/outlet-credentials`, "keys", product),
  ...rows(["PUT", "DELETE"], `${P}/outlet-credentials/:id`, "keys", product),
  // Claiming or editing the trusted publisher and issuing a static CI token mint a durable
  // credential's authority: a fresh step-up (F-33b.7). Revoking stays without one.
  ...rows(["GET"], `${P}/ci-publisher`, "keys", product),
  ...rows(["PUT"], `${P}/ci-publisher`, "keys", product, { stepUp: true }),
  ...rows(["GET"], `${P}/ci-tokens`, "keys", product),
  ...rows(["POST"], `${P}/ci-tokens`, "keys", product, { stepUp: true }),
  ...rows(["DELETE"], `${P}/ci-tokens/:id`, "keys", product),
];

/** True for a row under `/products/:slug` (product scope). */
export function isProductRoute(route: { path: string }): boolean {
  return route.path === P || route.path.startsWith(`${P}/`);
}

/** A 405 with the methods the path allows. */
export function methodNotAllowed(allow: readonly Method[]): Response {
  const res = err(405, "method_not_allowed", "method not allowed");
  res.headers.set("allow", allow.join(", "));
  return res;
}
