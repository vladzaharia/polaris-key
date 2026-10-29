/**
 * Router ↔ OpenAPI coverage — a route can be added but not silently undocumented.
 *
 * Three directions:
 *  1. Every `Route` kind the router SOURCE declares is either mapped to spec paths here or
 *     explicitly listed as narrative-only (browser surfaces the docs site documents in
 *     prose). A new kind fails until someone decides which it is.
 *  2. Every canonical service route (the `services/<slug>/routes.ts` dispatch surface,
 *     pinned as a table here) and every permanent alias (the four pre-namespace spellings and
 *     P2b-04's `/release/…` byte spellings) exist in the spec with the right methods.
 *  3. The spec contains NO path outside the expected set — documentation for routes that do
 *     not exist is drift too.
 *
 * Plus the CORS surface (P0-05): every covered path documents `options` against the one shared
 * `CorsPreflight` response, no excluded path does, and `core/cors.ts` — what the worker actually
 * answers — agrees with the spec path by path.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { matchRoute } from "../src/router.js";
import {
  CORE_ROUTES,
  CORS_SERVICE_PATHS,
  isCorsCoveredRoute,
} from "../src/publicRoutes.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import { matchImgPath } from "../src/core/assets/imgHost.js";
import { FEED_ADAPTERS } from "../src/services/distribution/registry/index.js";
import {
  RELEASE_PUBLISH_OPENAPI,
  RELEASE_REGISTRY_OPENAPI,
} from "../src/services/release/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const spec = parseYaml(
  readFileSync(join(here, "..", "openapi", "polaris-key.v3.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, unknown> & { servers?: unknown }>;
};
const routerSource = readFileSync(join(here, "..", "src", "router.ts"), "utf8");

/** Browser/admin surfaces documented narratively on the docs site, not in the wire spec. */
const NARRATIVE_ONLY = new Set([
  "adminSpa",
  "adminApi",
  "adminLogin",
  "adminDevice",
  "adminCallback",
  "adminPasskey",
  "portalSpa",
  "portalApi",
  "portalLogin",
  "portalProviderSignIn",
  "portalCallback",
  "portalLogout",
  "portalMagicVerify",
  "portalDownload",
  // Not a surface: `badRequest` is what the router answers when a path's percent-escape does not
  // decode, so it documents no endpoint and has no method. It sits here for the same reason
  // `notFound` does.
  "badRequest",
  // `adminApi` and `products` stay narrative as kinds: UX-72's create probes are pinned in
  // ADMIN_KIND_PATHS below; the rest of `/manage/api/*` is documented on the docs site.
  // `portalApi` stays narrative as a kind: its PX-W1 library and product routes are pinned in
  // PORTAL_KIND_PATHS below; the rest of `/api/*` is documented on the docs site.
  "products",
  "githubWebhook",
  "deployHook",
  "docs",
  "notFound",
]);

/** Core route kinds → the spec paths (with methods) that document them: derived from the core
 *  table (`publicRoutes.ts`), so a core route cannot be served and not declared (P0-25b). */
const CORE_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  ...Object.fromEntries(
    CORE_ROUTES.map((r) => [
      r.kind,
      r.surface.map((s): [string, string[]] => [s.path, [...s.methods]]),
    ]),
  ),
};

/**
 * Root portal routes the spec documents (PX-W1, rule 10), by route kind. `portalMedia` is
 * documented whole; `portalApi` is narrative as a kind, and only the routes listed here are in
 * the spec. None of them is product-scoped or CORS-covered: they share this origin with the
 * portal session cookie.
 */
const PORTAL_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  // The platform device-code entry pages: a code typed here finds its product's page.
  signInEntry: [["/signin", ["get"]]],
  // F-37.1b: the key host's hops into Polaris Locker.
  lockerLink: [
    ["/approve", ["get"]],
    ["/account/packages", ["get"]],
  ],
  // LK-05: WebAuthn Related Origin Requests, on the console host.
  webauthnOrigins: [["/.well-known/webauthn", ["get", "head"]]],
  helpAlias: [["/help", ["get", "head"]]],
  // UK-04b: the Elements CDN module, `/elements/<major|version>/<file>` (`elements` is reserved).
  elements: [
    ["/elements/{version}/{file}", ["get", "head"]],
    ["/elements/{version}/chunks/{file}", ["get", "head"]],
    ["/elements/{version}/fonts/{file}", ["get", "head"]],
  ],
  deviceEntry: [
    ["/device", ["get"]],
    ["/tv", ["get"]],
  ],
  // The approval after sign-in, on the customer host (LXF-DEV; the product is found by the binder).
  deviceApprove: [["/device/approve", ["get", "post"]]],
  portalMedia: [
    ["/media/{product}/{asset}", ["get"]],
    // I-07, PX-W16: account pictures, re-encoded (`avatar` is a reserved product slug).
    ["/media/avatar/{asset}", ["get"]],
  ],
  portalApi: [
    ["/api/library", ["get"]],
    ["/api/products/{product}", ["get"]],
    // I-11: one product's export, and "Remove my data from this product".
    ["/api/products/{product}/export", ["get"]],
    ["/api/products/{product}/data", ["delete"]],
    // I-11: "Get a support code" on the product page.
    ["/api/products/{product}/support-code", ["post"]],
    // PX-W10 (G24, G25): Discover's offers and "Add to library".
    ["/api/discover", ["get"]],
    ["/api/discover/{product}/claim", ["post"]],
    // PS-04: the storefront product page, and removing a library entry.
    ["/api/discover/{product}", ["get"]],
    ["/api/library/{product}", ["delete"]],
    // I-07: the login card's pre-authentication routes and the account sessions.
    ["/api/signin/email/start", ["post"]],
    ["/api/signin/email/verify", ["post"]],
    // PX-W4: the code step's "Send a new code".
    ["/api/signin/email/resend", ["post"]],
    // PX-12: GET reads the flow (the code step after the expired page's form POST).
    ["/api/signin/flow", ["get", "post"]],
    ["/api/signin/confirm-email", ["get", "post"]],
    ["/api/signin/confirm-email/verify", ["post"]],
    ["/api/signin/confirm-email/join", ["post"]],
    ["/api/signin/confirm-email/cancel", ["post"]],
    ["/api/signin/confirm-email/picture", ["get"]],
    ["/api/sessions", ["get"]],
    ["/api/sessions/{sessionId}", ["delete"]],
    ["/api/sessions/sign-out-everywhere", ["post"]],
    // I-11: account deletion stays reversible for fourteen days before the hard-erasure sweep.
    ["/api/me", ["get", "delete"]],
    ["/api/me/deletion/cancel", ["post"]],
    // I-11: the full account export.
    ["/api/me/export", ["get"]],
    // PX-W16 (G32, G33): Account → Profile and picture uploads.
    ["/api/me/profile", ["get", "patch"]],
    ["/api/me/profile/picture", ["post"]],
    // PX-W9 (§12.2 rule 8): the login card's signed-out key preview.
    ["/api/key/preview", ["post"]],
    // LK-12d: the signed-out card's product name and icon (Discover-visible products only).
    ["/api/storefront/{product}", ["get"]],
    // PX-W14 (G29): sign in with another device.
    ["/api/device-login/start", ["post"]],
    ["/api/device-login/lookup", ["post"]],
    ["/api/device-login/approve", ["post"]],
    ["/api/device-login/{requestId}", ["get"]],
    // PX-W13 (G28): the sign-in request the card renders, and its app-consent view.
    ["/api/signin/requests/{request}", ["get"]],
    ["/api/signin/requests/{request}/consent", ["get"]],
    ["/api/signin/requests/{request}/licenses", ["get"]],
    ["/api/signin/requests/{request}/licenses/{licenseId}/devices", ["get"]],
    ["/api/signin/requests/{request}/continue", ["post"]],
    ["/api/signin/requests/{request}/cancel", ["post"]],
    // I-16: passkeys on the login card, and the account's passkeys.
    ["/api/signin/passkey/options", ["post"]],
    ["/api/signin/passkey/verify", ["post"]],
    ["/api/me/passkeys", ["get", "post"]],
    ["/api/me/passkeys/options", ["post"]],
    ["/api/me/passkeys/{passkeyId}", ["delete", "patch"]],
    // PX-23 (S-24 D19): Remove from my library. The licence detail GET stays narrative.
    ["/api/licenses/{product}/{licenseId}", ["delete"]],
    // PX-W12 (G27): sign-in methods, and Link an existing account with its 72-hour undo.
    ["/api/me/methods", ["get"]],
    ["/api/me/methods/{kind}/start", ["post"]],
    ["/api/me/methods/email/verify", ["post"]],
    ["/api/me/methods/{methodId}", ["delete"]],
    ["/api/me/methods/{methodId}/primary", ["post"]],
    ["/api/me/link", ["get"]],
    ["/api/me/link/start", ["post"]],
    ["/api/me/link/confirm", ["post"]],
    ["/api/me/link/cancel", ["post"]],
    ["/api/me/link/undo", ["post"]],
    // F-33: Account → Packages, the person's own `pkeyp_` tokens.
    ["/api/me/tokens", ["get", "post"]],
    ["/api/me/tokens/{tokenId}", ["delete"]],
  ],
};

/**
 * Admin API routes the spec documents (rule 10): the New Product wizard's create probes
 * (FLOWS.md §3.11 W22 to W24) and the admin API-token roster. `adminApi` and `products` are
 * narrative as kinds, and only the routes listed here are in the spec, tagged `admin`. None is
 * product-scoped or CORS-covered: they share the console origin with the admin session cookie.
 * Both directions are pinned: a listed path missing from the spec fails the kind's test below,
 * and a spec path missing from this table fails "the spec documents no path that does not exist".
 */
const ADMIN_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  adminApi: [
    ["/manage/api/github/repositories", ["get"]],
    // Home's Needs attention (UX-12) and Platform ready (UX-67).
    ["/manage/api/attention", ["get"]],
    // I-41: a support code resolved to its product and user.
    ["/manage/api/search", ["post"]],
    ["/manage/api/support-codes/{code}", ["get"]],
    ["/manage/api/platform/ready", ["get"]],
    // ST-29, ST-31.5: who can give the caller access to an area.
    ["/manage/api/access/admins", ["get"]],
    // ST-32.5: the SSO rules' preview and the admin_group conversion offers.
    // ST-32.7: the rule list's read and replace.
    ["/manage/api/access/rules", ["get", "put"]],
    ["/manage/api/access/rules/preview", ["post"]],
    ["/manage/api/access/offers", ["get", "post"]],
    ["/manage/api/access/offers/{slug}", ["post"]],
    // ST-30c.3 (SM-3(a), (d)): the signed-in operator's own sign-in methods.
    ["/manage/api/me/prefs", ["put"]],
    ["/manage/api/me/methods", ["get"]],
    ["/manage/api/me/methods/{id}/strong", ["post"]],
    ["/manage/api/me/passkeys", ["post"]],
    ["/manage/api/me/passkeys/options", ["post"]],
    // U-03: the licence-override migration (notes/S-17 §5.12, decision 21).
    // P0-49: the data-migration runner.
    ["/manage/api/platform/migrations", ["get"]],
    ["/manage/api/platform/migrations/runs/{runId}", ["get"]],
    ["/manage/api/platform/migrations/dry-run", ["post"]],
    ["/manage/api/platform/migrations/apply", ["post"]],
    ["/manage/api/platform/migrations/down", ["post"]],
    // The admin API-token roster: the credential a PROGRAM presents (`pkey bundle`, from a
    // terminal and from CI, sends `Authorization: Bearer pkeya_…` to the bundle mint), documented
    // here, machine-readable, and not only in prose. The roster itself stays session-only: no
    // token reaches it.
    ["/manage/api/tokens", ["get", "post"]],
    ["/manage/api/tokens/{tokenId}", ["delete"]],
    // ST-27: where operator alerts go (platform scope).
    ["/manage/api/platform/alerts", ["get", "post"]],
    ["/manage/api/platform/alerts/{id}", ["patch", "delete"]],
    ["/manage/api/platform/alerts/{id}/test", ["post"]],
    ["/manage/api/account-tokens", ["get"]],
    ["/manage/api/account-tokens/{tokenId}", ["delete"]],
    // ST-31.4: the Platform Members roster (platform scope, area `members`).
    ["/manage/api/members", ["get"]],
    ["/manage/api/members/{memberId}", ["get"]],
    // ST-34.12: sign a member out everywhere (the GET is the dry run).
    ["/manage/api/members/{memberId}/sign-out", ["get", "post"]],
    // ST-31.6: grant, edit and take back a console role (area `members`; Superadmin-only cases are
    // the handler's, through the grant rules).
    ["/manage/api/bindings", ["post"]],
    ["/manage/api/bindings/{id}", ["patch", "delete"]],
    // ST-34.4: the caller's own personal tokens, and the one row that ends the presenting token.
    ["/manage/api/me/personal-tokens", ["get"]],
    ["/manage/api/me/personal-tokens/{id}", ["delete"]],
    ["/manage/api/me/personal-tokens/current", ["delete"]],
  ],
  // `/manage/api/products[/…]` routes as its own kind (the product registry), narrative too.
  products: [
    // The registry read, with the console logo's `presentation.icon` (console product card).
    ["/manage/api/products", ["get", "post"]],
    ["/manage/api/products/link-repo", ["post"]],
    ["/manage/api/products/slug-check", ["get"]],
    // ST-40: the Integration read model (prerequisites, facts, Verified per platform).
    ["/manage/api/products/{product}/integration", ["get"]],
    // A-20.4: the channel read model (delivery and commerce facets per channel).
    ["/manage/api/products/{product}/distribution/channels", ["get"]],
    // A-32.3: the CI readiness read (the checks a `v*` tag needs).
    ["/manage/api/products/{product}/release/ci-readiness", ["get"]],
    // A-32.6: create the `release` environment and the `v*` tag ruleset.
    ["/manage/api/products/{product}/release/ci-readiness/fix", ["post"]],
    // A-32.5: the setup pull request (state, and write + open or update).
    [
      "/manage/api/products/{product}/release/setup/pull-request",
      ["get", "post"],
    ],
    // ST-34.4: the store-listing import `pkey listing import` calls (session or admin token).
    ["/manage/api/products/{product}/distribution/listing/import", ["post"]],
    // HA-05: the hosted-asset status read the console's Presentation page uses.
    ["/manage/api/products/{product}/assets", ["get"]],
    // HA-06: the Presentation page's upload (claims the slot), Revert and delete-a-copy.
    ["/manage/api/products/{product}/assets/{slot}", ["post", "delete"]],
    // HA-08: the operator's "mirror now" for release files.
    ["/manage/api/products/{product}/assets/mirror", ["post"]],
    // HA-10: usage against the hosting quotas, and the product's hosted-asset settings.
    ["/manage/api/products/{product}/assets/usage", ["get"]],
    [
      "/manage/api/products/{product}/assets/settings/{key}",
      ["patch", "delete"],
    ],
    // ST-31.5: who holds this product (Members area at product scope).
    ["/manage/api/products/{product}/members", ["get", "post"]],
    // ST-31.6 (D-d): the product twins of the grant writes.
    ["/manage/api/products/{product}/members/{bindingId}", ["patch", "delete"]],
    // ST-27: a product's alert destinations (the override of the platform's).
    ["/manage/api/products/{product}/alerts", ["get", "post"]],
    ["/manage/api/products/{product}/alerts/{id}", ["patch", "delete"]],
    ["/manage/api/products/{product}/alerts/{id}/test", ["post"]],
    // LX-26: the licence reads and writes that carry the derived holder (DELETE stays narrative).
    ["/manage/api/products/{product}/license/licenses", ["get", "post"]],
    [
      "/manage/api/products/{product}/license/licenses/{licenseId}",
      ["get", "patch"],
    ],
    // LX-27: a new key emailed to the licence's address.
    [
      "/manage/api/products/{product}/license/licenses/{licenseId}/send-key",
      ["post"],
    ],
    // LX-27c: an invitation (no key) emailed to a waiting licence.
    [
      "/manage/api/products/{product}/license/licenses/{licenseId}/send-invite",
      ["post"],
    ],
    // LX-28: bulk floating keys, the batch reads and Disable unused keys.
    ["/manage/api/products/{product}/license/batches", ["get", "post"]],
    ["/manage/api/products/{product}/license/batches/{batchId}", ["get"]],
    [
      "/manage/api/products/{product}/license/batches/{batchId}/disable-unused",
      ["post"],
    ],
    // LX-06: the first slice of S-18 §4.7's generic settings API (row-backed claimable keys).
    ["/manage/api/products/{product}/settings/effective", ["get"]],
    // ST-17: the claims against the last applied manifest, and the last apply's plan.
    ["/manage/api/products/{product}/settings/drift", ["get"]],
    [
      "/manage/api/products/{product}/settings/{key}",
      ["get", "patch", "delete"],
    ],
    // U-03: the licence override batch (entitlements only from the migration's run), and one
    // user's account overrides under I-12's Users routes.
    [
      "/manage/api/products/{product}/license/licenses/{licenseId}/overrides",
      ["put"],
    ],
    [
      "/manage/api/products/{product}/users/{subject}/overrides",
      ["get", "put"],
    ],
    // LX-30: the relink tool's two holder moves, keyed by the licence, and its move history.
    [
      "/manage/api/products/{product}/users/licenses/{licenseId}/make-floating",
      ["post"],
    ],
    [
      "/manage/api/products/{product}/users/licenses/{licenseId}/reassign",
      ["post"],
    ],
    [
      "/manage/api/products/{product}/users/licenses/{licenseId}/relinks",
      ["get"],
    ],
  ],
};

/**
 * The canonical service surface, DERIVED from the composition root: each mounted service's
 * `ServiceDescriptor.surface`. The `service` route kind carries every one of these; documenting
 * the KIND means documenting this table. This used to be a hand-written literal transcribing each
 * `services/<slug>/routes.ts`, so it compared one copy of the spec against another copy of the
 * spec; a service added to or removed from `mount.ts` now changes what this test demands without
 * anybody editing this file. `mount.ts` is the one table both dispatchers use, so a service that
 * is declared but never mounted contributes nothing here.
 */
const SERVICE_PATHS: Array<[string, string[]]> = [...SERVICES.values()].flatMap(
  (descriptor) =>
    descriptor.surface.map((route): [string, string[]] => [
      route.path,
      [...route.methods],
    ]),
);

/**
 * The permanent aliases: the four pre-namespace spellings (D-07) and Release's old byte paths,
 * which P2b-04 moved to Distribution (download URLs SDKs build, byte URLs discovery advertised).
 */
const ALIAS_PATHS: Array<[string, string[]]> = [
  ["/{product}/appcast.xml", ["get"]],
  ["/{product}/{channel}/appcast.xml", ["get"]],
  ["/{product}/install.sh", ["get"]],
  ["/{product}/version", ["get"]],
  ["/{product}/release/install.sh", ["get"]],
  ["/{product}/release/dl/{version}/{asset}", ["get"]],
  ["/{product}/release/builds/{selector}/{buildId}", ["get"]],
  ["/{product}/release/files/{releaseId}/{name}", ["get"]],
  ["/{product}/release/blobs/sha256/{sha256}", ["get"]],
  // P2b-06: the short link to the download page (served on the bytes host only).
  ["/{product}", ["get"]],
];

/**
 * The registry host's paths (F-02, plans/F-01.md §6.10): `pkg.plrs.im` answers only these, each
 * documented under a path-level `servers` override with tag `registry`. The third column names
 * what answers: `host` for the dispatcher's own fixed answers (the landing page, OCI's `/v2/`
 * root), else the `REGISTRY_ROUTES` or `REGISTRY_OWNERLESS_ROUTES` entry by name (F-21: Swift's
 * login and OCI's token service are routes now).
 *
 * The feed rows are each feed adapter's own `openapi` declaration (`FeedAdapter.openapi`, the
 * feed-adapter contract): a feed adds its paths there, in its own directory, and every check
 * below runs against them unchanged. `test/surfaces/feedAdapters.test.ts` checks each adapter's rows
 * against its own routes. F-23's push rows are Release's (`RELEASE_REGISTRY_OPENAPI`), checked
 * the same way by `test/surfaces/registryPush.test.ts`.
 */
const REGISTRY_SERVER = "https://pkg.plrs.im";
/**
 * F-22: the native publish routes (Release's, `RELEASE_PUBLISH_OPENAPI`) write to paths their
 * feed also reads (npm's packument, Swift's release, Maven's layout), so the rows are merged by
 * path: one row per path, with every method and every route answering it.
 */
function mergeRegistryRows(
  rows: readonly (readonly [string, readonly string[], string])[],
): Array<[string, string[], string[]]> {
  const byPath = new Map<
    string,
    { methods: Set<string>; owners: Set<string> }
  >();
  for (const [path, methods, owner] of rows) {
    const e = byPath.get(path) ?? { methods: new Set(), owners: new Set() };
    for (const m of methods) e.methods.add(m);
    e.owners.add(owner);
    byPath.set(path, e);
  }
  return [...byPath].map(([path, e]) => [path, [...e.methods], [...e.owners]]);
}
const REGISTRY_PATHS: Array<[string, string[], string[]]> = mergeRegistryRows([
  ["/", ["get", "head"], "host"],
  ["/v2/", ["get", "head"], "host"],
  ...FEED_ADAPTERS.flatMap((a) => a.openapi),
  ...RELEASE_PUBLISH_OPENAPI,
  // F-23: Release's push routes (native `docker push`), declared beside their code.
  ...RELEASE_REGISTRY_OPENAPI,
]);

/**
 * The image host's paths (HA-02, notes/S-20 §6.5): `img.plrs.im` answers only these, each
 * documented under a path-level `servers` override with tag `img`. They are Core's own routes
 * (`core/assets/imgHost.ts` `matchImgPath`), not a service's and not a route table's, so the check
 * runs a concrete request path of each through the host's own parser and pins the parsed kind.
 */
const IMG_SERVER = "https://img.plrs.im";
const IMG_PATHS: Array<[string, string[], "asset" | "alias"]> = [
  ["/{product}/a/{sha256}", ["get", "head"], "asset"],
  ["/{product}/a/{sha256}/{w}.webp", ["get", "head"], "asset"],
  ["/{product}/icon", ["get", "head"], "alias"],
  ["/{product}/header", ["get", "head"], "alias"],
  ["/{product}/screenshots/{n}", ["get", "head"], "alias"],
];

/**
 * The customer host's own paths (LK-03, plans/LK-00.md §7.13): `polaris.locker` answers these
 * itself (`core/customerHost.ts`), each documented under a path-level `servers` override with tag
 * `customer`. Its other routes are the root portal's and the platform entry pages, already
 * covered above.
 */
const CUSTOMER_SERVER = "https://polaris.locker";
const CUSTOMER_PATHS: Array<[string, string[]]> = [
  ["/.well-known/polaris-host.json", ["get", "head"]],
  ["/robots.txt", ["get", "head"]],
];

function specMethods(path: string): string[] {
  const entry = spec.paths[path];
  if (!entry) return [];
  return Object.keys(entry).filter((k) =>
    ["get", "head", "post", "put", "patch", "delete"].includes(k),
  );
}

describe("router → spec", () => {
  it("every Route kind is documented or explicitly narrative-only", () => {
    const kinds = [...routerSource.matchAll(/kind: "([a-zA-Z]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(kinds.length).toBeGreaterThan(15);
    const documented = new Set([
      ...Object.keys(CORE_KIND_PATHS),
      ...Object.keys(PORTAL_KIND_PATHS),
      ...Object.keys(ADMIN_KIND_PATHS),
      "service",
    ]);
    const unhandled = [...new Set(kinds)].filter(
      (kind) => !documented.has(kind) && !NARRATIVE_ONLY.has(kind),
    );
    expect(
      unhandled,
      `route kinds neither documented nor narrative-only: ${unhandled.join(", ")}`,
    ).toEqual([]);
  });

  for (const [kind, paths] of Object.entries(CORE_KIND_PATHS)) {
    it(`core kind "${kind}" is documented`, () => {
      for (const [path, methods] of paths) {
        for (const method of methods) {
          expect(specMethods(path), `${method} ${path}`).toContain(method);
        }
      }
    });
  }

  for (const [kind, paths] of Object.entries(PORTAL_KIND_PATHS)) {
    it(`portal kind "${kind}" routes are documented, tagged portal, and route there`, () => {
      for (const [path, methods] of paths) {
        expect(specMethods(path).sort(), path).toEqual([...methods].sort());
        for (const method of methods) {
          const op = spec.paths[path]![method] as { tags?: string[] };
          expect(op.tags, `${method} ${path}`).toEqual(["portal"]);
        }
        expect(spec.paths[path]?.options, path).toBeUndefined();
        const route = matchRoute(concrete(path));
        expect(route.kind, path).toBe(kind);
        expect(isCorsCoveredRoute(route), path).toBe(false);
      }
    });
  }

  for (const [kind, paths] of Object.entries(ADMIN_KIND_PATHS)) {
    it(`admin kind "${kind}" routes are documented, tagged admin, and route there`, () => {
      for (const [path, methods] of paths) {
        expect(specMethods(path).sort(), path).toEqual([...methods].sort());
        for (const method of methods) {
          const op = spec.paths[path]![method] as { tags?: string[] };
          expect(op.tags, `${method} ${path}`).toEqual(["admin"]);
        }
        expect(spec.paths[path]?.options, path).toBeUndefined();
        const route = matchRoute(concrete(path));
        expect(route.kind, path).toBe(kind);
        expect(isCorsCoveredRoute(route), path).toBe(false);
      }
    });
  }

  it("every canonical service route is documented", () => {
    for (const [path, methods] of SERVICE_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
      }
    }
  });

  it("every mounted service declares a surface", () => {
    // A service with no HTTP route yet declares `[]` (and is listed here, so the day it gains a
    // route its surface must be declared with it).
    const ROUTELESS = new Set<string>();
    for (const [slug, descriptor] of SERVICES) {
      expect(
        Array.isArray(descriptor.surface),
        `${slug} declares no surface`,
      ).toBe(true);
      expect(
        descriptor.surface.length === 0,
        `${slug}: an empty surface means no routes`,
      ).toBe(ROUTELESS.has(slug));
      for (const route of descriptor.surface) {
        // The one exception: Commerce's two store hooks are canonical at their stores' URLs
        // under `/distribution/hooks/` (CM-29 D1; `core/stores/hooks.ts`), not aliases.
        const storeHook =
          slug === "commerce" &&
          /^\/\{product\}\/distribution\/hooks\/(app-store|play-rtdn)$/.test(
            route.path,
          );
        if (storeHook) continue;
        expect(route.path, `${slug}: ${route.path}`).toMatch(
          new RegExp(`^/\\{product\\}/${slug}(/|$)`),
        );
        expect(route.methods.length, `${slug}: ${route.path}`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  /**
   * A DECLARED path must be one the core router actually dispatches to that service. Without
   * this the surface would be prose in a different file: a service could declare a path it does
   * not serve and the spec would faithfully document a 404. Templates are instantiated with
   * concrete segments (`concrete`) because `matchRoute` works on real pathnames.
   */
  it("every declared service route is dispatched to its own service", () => {
    for (const [slug, descriptor] of SERVICES) {
      for (const route of descriptor.surface) {
        const pathname = concrete(route.path);
        const matched = matchRoute(pathname);
        expect(matched.kind, `${route.path} → ${pathname}`).toBe("service");
        expect(
          matched.kind === "service" ? matched.slug : null,
          `${route.path} → ${pathname}`,
        ).toBe(slug);
      }
    }
  });

  it("every permanent alias is documented", () => {
    for (const [path, methods] of ALIAS_PATHS) {
      for (const method of methods) {
        expect(specMethods(path), `${method} ${path}`).toContain(method);
      }
    }
  });
});

describe("spec → router", () => {
  it("the spec documents no path that does not exist", () => {
    const expected = new Set(
      [
        ...Object.values(CORE_KIND_PATHS).flat(),
        ...SERVICE_PATHS,
        ...ALIAS_PATHS,
        ...REGISTRY_PATHS,
        ...IMG_PATHS,
        ...CUSTOMER_PATHS,
        ...Object.values(PORTAL_KIND_PATHS).flat(),
        ...Object.values(ADMIN_KIND_PATHS).flat(),
      ].map(([path]) => path),
    );
    const phantom = Object.keys(spec.paths).filter(
      (path) => !expected.has(path),
    );
    expect(
      phantom,
      `spec paths with no corresponding route: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("alias operations are marked as aliases and rewrite targets exist", () => {
    for (const [path] of ALIAS_PATHS) {
      const op = spec.paths[path]?.get as
        | { tags?: string[]; summary?: string }
        | undefined;
      expect(op?.tags, path).toContain("aliases");
      // Every alias names its canonical target in the summary; that target must be a
      // documented path too (rewrites cannot point at nothing).
      const target = op?.summary?.match(/→ (\/\S+)/)?.[1];
      expect(target, `${path} summary must name its target`).toBeTruthy();
      expect(spec.paths[target!], `${path} → ${target}`).toBeTruthy();
    }
  });
});

describe("registry host (F-02, rule 10)", () => {
  it("every registry path is documented on the registry server with tag registry", () => {
    // One path may have several rows (F-23: the pull manifest route's GET/HEAD and the push
    // route's PUT): the spec documents exactly their union.
    const union = new Map<string, Set<string>>();
    for (const [path, methods] of REGISTRY_PATHS)
      for (const m of methods)
        union.set(path, (union.get(path) ?? new Set()).add(m));
    for (const [path, methods] of REGISTRY_PATHS) {
      expect(spec.paths[path]?.servers, path).toEqual([
        expect.objectContaining({ url: REGISTRY_SERVER }),
      ]);
      expect(specMethods(path).sort(), path).toEqual(
        [...union.get(path)!].sort(),
      );
      for (const method of methods) {
        const op = spec.paths[path]![method] as { tags?: string[] };
        expect(op.tags, `${method} ${path}`).toEqual(["registry"]);
      }
    }
  });

  it("only registry paths carry the registry server or the registry tag", () => {
    const registry = new Set(REGISTRY_PATHS.map(([p]) => p));
    const img = new Set(IMG_PATHS.map(([p]) => p));
    const customer = new Set(CUSTOMER_PATHS.map(([p]) => p));
    for (const [path, entry] of Object.entries(spec.paths)) {
      if (registry.has(path) || customer.has(path)) continue;
      // The image host's paths carry their own server (checked below), never the registry's.
      if (img.has(path)) {
        for (const method of specMethods(path)) {
          const op = entry[method] as { tags?: string[] };
          expect(op.tags ?? [], `${method} ${path}`).not.toContain("registry");
        }
        continue;
      }
      expect(entry.servers, path).toBeUndefined();
      for (const method of specMethods(path)) {
        const op = entry[method] as { tags?: string[] };
        expect(op.tags ?? [], `${method} ${path}`).not.toContain("registry");
      }
    }
  });

  it("REGISTRY_PATHS and the registry routes (owned and owner-less) agree in both directions", () => {
    const routeNames = [
      ...REGISTRY_ROUTES.map((r) => r.name),
      ...REGISTRY_OWNERLESS_ROUTES.map((r) => r.name),
    ];
    const documented = new Set(
      REGISTRY_PATHS.flatMap(([, , owners]) => owners).filter(
        (o) => o !== "host",
      ),
    );
    for (const name of routeNames)
      expect(
        documented.has(name),
        `route ${name} has no REGISTRY_PATHS row`,
      ).toBe(true);
    for (const name of documented)
      expect(routeNames, `REGISTRY_PATHS names ${name}`).toContain(name);
  });

  it("registry paths are outside the CORS surface and document no preflight", () => {
    for (const [path] of REGISTRY_PATHS) {
      expect(CORS_SERVICE_PATHS as readonly string[], path).not.toContain(path);
      expect(spec.paths[path]?.options, path).toBeUndefined();
    }
  });
});

describe("customer host (LK-03, rule 10)", () => {
  it("every customer path is documented on the customer server with tag customer", () => {
    for (const [path, methods] of CUSTOMER_PATHS) {
      expect(spec.paths[path]?.servers, path).toEqual([
        expect.objectContaining({ url: CUSTOMER_SERVER }),
      ]);
      expect(specMethods(path).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        const op = spec.paths[path]![method] as { tags?: string[] };
        expect(op.tags, `${method} ${path}`).toEqual(["customer"]);
      }
      expect(spec.paths[path]?.options, path).toBeUndefined();
    }
  });

  it("only customer paths carry the customer server or the customer tag", () => {
    const customer = new Set(CUSTOMER_PATHS.map(([p]) => p));
    for (const [path, entry] of Object.entries(spec.paths)) {
      if (customer.has(path)) continue;
      expect(JSON.stringify(entry.servers ?? []), path).not.toContain(
        CUSTOMER_SERVER,
      );
      for (const method of specMethods(path)) {
        const op = entry[method] as { tags?: string[] };
        expect(op.tags ?? [], `${method} ${path}`).not.toContain("customer");
      }
    }
  });
});

describe("image host (HA-02, rule 10)", () => {
  it("every image path is documented on the image server with tag img and exactly its methods", () => {
    for (const [path, methods] of IMG_PATHS) {
      expect(spec.paths[path]?.servers, path).toEqual([
        expect.objectContaining({ url: IMG_SERVER }),
      ]);
      expect(specMethods(path).sort(), path).toEqual([...methods].sort());
      for (const method of methods) {
        const op = spec.paths[path]![method] as { tags?: string[] };
        expect(op.tags, `${method} ${path}`).toEqual(["img"]);
      }
      // A public image is a simple GET: no preflight is documented or answered.
      expect(spec.paths[path]?.options, path).toBeUndefined();
    }
  });

  it("only image paths carry the image server or the img tag", () => {
    const img = new Set(IMG_PATHS.map(([p]) => p));
    for (const [path, entry] of Object.entries(spec.paths)) {
      if (img.has(path)) continue;
      expect(JSON.stringify(entry.servers ?? []), path).not.toContain(
        IMG_SERVER,
      );
      for (const method of specMethods(path)) {
        const op = entry[method] as { tags?: string[] };
        expect(op.tags ?? [], `${method} ${path}`).not.toContain("img");
      }
    }
  });

  it("IMG_PATHS and the host's own path parser agree in both directions", () => {
    const samples: Record<string, string> = {
      product: "acme",
      sha256: "a".repeat(64),
      w: "256",
      n: "3",
    };
    for (const [path, , kind] of IMG_PATHS) {
      const concretePath = path.replace(
        /\{(\w+)\}/g,
        (_, name: string) => samples[name]!,
      );
      expect(matchImgPath(concretePath)?.kind, path).toBe(kind);
    }
    // Every shape the parser accepts is one of the documented templates: a path one segment
    // off any of them is refused.
    for (const path of [
      "/acme",
      "/acme/a",
      `/acme/a/${"a".repeat(64)}/256`,
      "/acme/screenshots",
      "/acme/icons",
      "/acme/a/x/y/z",
    ])
      expect(matchImgPath(path), path).toBeNull();
  });
});

/**
 * The product routes that must NEVER answer CORS (P0-05): they set or read the per-product
 * browser-session cookie, or they are top-level navigations to the IdP or an HTML page. They stay
 * first-party. Everything else in the three tables above is covered.
 */
const CORS_EXCLUDED = new Set([
  "/{product}/identity/session",
  "/{product}/identity/session/license",
  "/{product}/identity/auth/start",
  "/{product}/identity/auth/callback",
  "/{product}/identity/auth/logout",
  "/{product}/identity/auth/device",
  "/{product}/identity/auth/device/verify",
  "/{product}/identity/auth/device/approve",
  "/{product}/identity/auth/choose",
  // I-08: `authorize` is a browser navigation to the card; only `token` is a page's `fetch`.
  "/{product}/identity/authorize",
  // CC-07.3: a WebSocket upgrade, which has no preflight; the single-use ticket is the credential.
  "/{product}/connect/relay",
  "/{product}/config/mint/{mintId}/auth",
  // P2-05: CI routes, authenticated by a `pkeyci_` bearer — never called from a browser page.
  "/{product}/release/channels/{channel}/promote",
  "/{product}/release/channels/{channel}/pin",
  "/{product}/release/channels/{channel}/unpin",
  "/{product}/release/releases/{releaseId}/yank",
  "/{product}/release/packages/prune",
  // P2-02: the trusted-publishing routes, called by CI with an OIDC or `pkeyci_` credential.
  "/{product}/release/publish/token",
  "/{product}/release/publish/uploads",
  "/{product}/release/publish/submit",
  "/{product}/release/publish/stage",
  "/{product}/release/publish/delegations",
  // P2b-04: the CI rollout routes, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/rollouts/{outlet}/{channel}",
  "/{product}/distribution/rollouts/{outlet}/{channel}/pause",
  "/{product}/distribution/rollouts/{outlet}/{channel}/resume",
  "/{product}/distribution/rollouts/{outlet}/{channel}/halt",
  "/{product}/distribution/rollouts/{outlet}/{channel}/complete",
  // P2b-03: the CI report route, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/report",
  // A-18h: the CI listing read, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/listing/{store}",
  // A-18i: the PR-plane inputs read, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/pr/{store}",
  "/{product}/distribution/pr/github-token",
  // P5-02: a store webhook, called server-to-server by App Store Connect.
  "/{product}/distribution/hooks/asc",
  // P6-02: device attestation — only a native iOS or Android build can attest, never a page.
  // CC-03.2: key registration — a native device, never a page.
  "/{product}/devices/keys",
  "/{product}/devices/attest/challenge",
  "/{product}/devices/attest",
  // P6-03: the Sentry alert webhook, called server-to-server by Sentry.
  "/{product}/distribution/hooks/sentry",
  // P6-01: the commerce bridge's two store hooks, called server-to-server by the stores. (The
  // binding and claim routes take the device bearer and are covered since SP-16, for a
  // bearer-mode page.)
  "/{product}/distribution/hooks/app-store",
  "/{product}/distribution/hooks/play-rtdn",
  // P2b-05: the F-Droid CI route, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/feeds/fdroid/{channel}",
  // A-18d: the listing assets register, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/listing/assets",
  // HA-06: the hosted-asset push, authenticated by a `pkeyci_` bearer.
  "/{product}/assets",
  // P2b-06: the download page and its alias — HTML on the bytes host, a top-level navigation.
  "/{product}/distribution/download",
  "/{product}",
  // P3-09: the app-updater feeds are read by native updaters (WinSparkle, Velopack, App
  // Installer, AppImageUpdate), never by a browser page; no CORS is added for them (the brief:
  // the only CORS is P0-05's allowlist, on the routes it already covers).
  "/{product}/update/{channel}/winsparkle.xml",
  "/{product}/update/{channel}/velopack/releases.{velopackChannel}.json",
  "/{product}/update/{channel}/velopack/{fileName}",
  "/{product}/update/{channel}/app.appinstaller",
  "/{product}/update/{channel}/{buildId}.AppImage.zsync",
]);

/** Every product path the router serves, from the three tables above. */
const ALL_PRODUCT_PATHS = [
  ...Object.values(CORE_KIND_PATHS).flat(),
  ...SERVICE_PATHS,
  ...ALIAS_PATHS,
].map(([path]) => path);

/** A concrete request path for a spec template, so the real router can classify it. */
function concrete(template: string): string {
  const samples: Record<string, string> = {
    product: "acme",
    deviceId: "dev-1",
    mintId: "applemusic",
    version: "1.2.3",
    asset: "acme-arm64",
    channel: "beta",
    selector: "stable",
    buildId: "macos",
    releaseId: "v1.2.3",
    name: "acme.dmg",
    sha256: "a".repeat(64),
    outlet: "direct",
    path: "entry.jar",
    velopackChannel: "win-x64",
    fileName: "Acme-1.2.3-full.nupkg",
    pack: "acme.core",
    variant: "default",
    store: "snap",
    key: "0123456789abcdef0123456789abcdef",
    sessionId: "f".repeat(64),
    requestId: `dl_${"A".repeat(43)}`,
    request: `rq_${"A".repeat(22)}`,
    licenseId: "lic_1",
    batchId: "batch_1",
    passkeyId: "A".repeat(43),
    slot: encodeURIComponent("listing.screenshot:3"),
    kind: "google",
    methodId: "lnk_AAAAAAAAAAAA",
    subject: `ps_${"A".repeat(22)}`,
    tokenId: "apitok_AAAAAAAAAAAA",
    memberId: "mbr_AAAAAAAAAAAAAAAAAAAAAA",
    bindingId: "crb_AAAAAAAAAAAAAAAAAAAAAA",
    id: "dst_AAAAAAAAAAAA",
    runId: "mig_AAAAAAAAAAAA",
    code: "K7M-4QX-9TZ",
    // ST-32.5: an admin_group offer's product.
    slug: "acme",
    // UK-04b: the Elements CDN module's file.
    file: "pk.js",
  };
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = samples[name];
    if (!value) throw new Error(`no sample for {${name}} in ${template}`);
    return value;
  });
}

describe("CORS preflight (P0-05)", () => {
  it("the excluded set names only real routes", () => {
    for (const path of CORS_EXCLUDED) {
      expect(ALL_PRODUCT_PATHS, path).toContain(path);
    }
  });

  it("every covered path documents options with the shared CorsPreflight response", () => {
    const missing = ALL_PRODUCT_PATHS.filter(
      (path) => !CORS_EXCLUDED.has(path),
    ).filter((path) => {
      const op = spec.paths[path]?.options as
        | { responses?: Record<string, { $ref?: string }> }
        | undefined;
      return (
        op?.responses?.["204"]?.$ref !== "#/components/responses/CorsPreflight"
      );
    });
    expect(
      missing,
      `covered paths without an options → CorsPreflight operation: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no excluded path documents options", () => {
    const leaked = [...CORS_EXCLUDED].filter(
      (path) => spec.paths[path]?.options !== undefined,
    );
    expect(
      leaked,
      `excluded paths documenting options: ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  it("core/cors.ts covers exactly the paths the spec documents options for", () => {
    for (const path of ALL_PRODUCT_PATHS) {
      const route = matchRoute(concrete(path));
      expect(route.kind, path).not.toBe("notFound");
      expect(isCorsCoveredRoute(route), path).toBe(
        spec.paths[path]?.options !== undefined,
      );
    }
  });

  it("the worker's covered service table names only documented service paths", () => {
    const documented = new Set(SERVICE_PATHS.map(([path]) => path));
    for (const rel of CORS_SERVICE_PATHS) {
      expect(documented, rel).toContain(`/{product}/${rel}`);
    }
  });

  it("no platform surface is covered, whatever its path", () => {
    for (const path of [
      "/manage/api/me",
      "/manage",
      "/api/capabilities",
      "/",
      "/docs/",
      "/webhooks/github",
      "/download/tok",
      "/media/acme/icon",
      "/api/library",
    ]) {
      expect(isCorsCoveredRoute(matchRoute(path)), path).toBe(false);
    }
  });
});

describe("aliases resolve to their canonical routes (P2b-04)", () => {
  // Rewriting, not a second handler: an alias yields the SAME `{kind:"service"}` route as the
  // canonical spelling its summary names, so the two cannot drift.
  for (const [path] of ALIAS_PATHS) {
    it(`${path} routes exactly like its target`, () => {
      const op = spec.paths[path]?.get as { summary?: string } | undefined;
      const target = op?.summary?.match(/→ (\/\S+)/)?.[1];
      expect(target, path).toBeTruthy();
      const aliased = matchRoute(concrete(path));
      const direct = matchRoute(concrete(target!));
      expect({ ...aliased, alias: undefined }).toEqual({
        ...direct,
        alias: undefined,
      });
      expect((aliased as { alias?: true }).alias).toBe(true);
    });
  }
});
