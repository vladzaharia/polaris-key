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
import { CORS_SERVICE_PATHS, isCorsCoveredRoute } from "../src/core/cors.js";
import { REGISTRY_OWNERLESS_ROUTES, REGISTRY_ROUTES } from "../src/mount.js";
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
  "adminCallback",
  "portalSpa",
  "portalApi",
  "portalLogin",
  "portalCallback",
  "portalLogout",
  "portalMagicVerify",
  "portalDownload",
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

/** Core route kinds → the spec paths (with methods) that document them. */
const CORE_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  discovery: [["/{product}/.well-known/polaris.json", ["get"]]],
  jwks: [["/{product}/.well-known/jwks.json", ["get"]]],
  trustManifest: [["/{product}/.well-known/polaris-trust.jws", ["get"]]],
  devices: [
    ["/{product}/devices", ["get"]],
    ["/{product}/devices/{deviceId}", ["get", "patch", "delete"]],
  ],
  report: [["/{product}/devices/report", ["post"]]],
  register: [["/{product}/devices/register", ["post"]]],
  attestChallenge: [["/{product}/devices/attest/challenge", ["post"]]],
  attest: [["/{product}/devices/attest", ["post"]]],
};

/**
 * Root portal routes the spec documents (PX-W1, rule 10), by route kind. `portalMedia` is
 * documented whole; `portalApi` is narrative as a kind, and only the routes listed here are in
 * the spec. None of them is product-scoped or CORS-covered: they share this origin with the
 * portal session cookie.
 */
const PORTAL_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  portalMedia: [["/media/{product}/{asset}", ["get"]]],
  portalApi: [
    ["/api/library", ["get"]],
    ["/api/products/{product}", ["get"]],
    // PX-W10 (G24, G25): Discover's offers and "Add to library".
    ["/api/discover", ["get"]],
    ["/api/discover/{product}/claim", ["post"]],
  ],
};

/**
 * Admin API routes the spec documents (UX-72, rule 10): the New Product wizard's create probes
 * (FLOWS.md §3.11 W22 to W24). `adminApi` and `products` are narrative as kinds, and only the
 * routes listed here are in the spec, tagged `admin`. None is product-scoped or CORS-covered: they share the console
 * origin with the admin session cookie.
 */
const ADMIN_KIND_PATHS: Record<string, Array<[string, string[]]>> = {
  adminApi: [["/manage/api/github/repositories", ["get"]]],
  // `/manage/api/products[/…]` routes as its own kind (the product registry), narrative too.
  products: [
    ["/manage/api/products/link-repo", ["post"]],
    ["/manage/api/products/slug-check", ["get"]],
  ],
};

/**
 * The canonical service surface — mirrors each `services/<slug>/routes.ts`. The `service`
 * route kind carries every one of these; documenting the KIND means documenting this table.
 */
const SERVICE_PATHS: Array<[string, string[]]> = [
  ["/{product}/license/activate", ["post"]],
  ["/{product}/license/enroll", ["post"]],
  ["/{product}/license/token", ["post"]],
  ["/{product}/license/deauthorize", ["post"]],
  ["/{product}/license/document", ["get"]],
  ["/{product}/config/document", ["get"]],
  ["/{product}/config/schema", ["get"]],
  ["/{product}/config/mint/{mintId}/token", ["get", "post"]],
  ["/{product}/config/mint/{mintId}/auth", ["get"]],
  ["/{product}/release/changelog", ["get"]],
  // P2-05: the CI policy routes.
  ["/{product}/release/channels/{channel}/promote", ["post"]],
  ["/{product}/release/channels/{channel}/pin", ["post"]],
  ["/{product}/release/channels/{channel}/unpin", ["post"]],
  ["/{product}/release/releases/{releaseId}/yank", ["post"]],
  // P2-02: trusted publishing.
  ["/{product}/release/publish/token", ["post"]],
  ["/{product}/release/publish/uploads", ["post"]],
  ["/{product}/release/publish/submit", ["post"]],
  // P4-02: a stage round of a pack's objects.
  ["/{product}/release/publish/stage", ["post"]],
  // P4-19: the product's delegations, for `pkey release delegate`.
  ["/{product}/release/publish/delegations", ["post"]],
  // P3-03: a CI-signed release record by its hash.
  ["/{product}/release/records/{sha256}", ["get"]],
  // P2b-04: all byte delivery is Distribution's (the installer, the download and P2-05's three
  // byte routes, the last three also on the bytes host), plus the CI rollout routes.
  ["/{product}/distribution/install.sh", ["get"]],
  ["/{product}/distribution/dl/{version}/{asset}", ["get"]],
  ["/{product}/distribution/builds/{selector}/{buildId}", ["get"]],
  ["/{product}/distribution/files/{releaseId}/{name}", ["get"]],
  ["/{product}/distribution/blobs/sha256/{sha256}", ["get", "head"]],
  // P4-18: a pack's decoded container payload, with Compression Dictionary Transport.
  [
    "/{product}/distribution/packs/{pack}/{variant}/payload/{sha256}",
    ["get", "head"],
  ],
  ["/{product}/distribution/rollouts/{outlet}/{channel}", ["post"]],
  ["/{product}/distribution/rollouts/{outlet}/{channel}/pause", ["post"]],
  ["/{product}/distribution/rollouts/{outlet}/{channel}/resume", ["post"]],
  ["/{product}/distribution/rollouts/{outlet}/{channel}/halt", ["post"]],
  ["/{product}/distribution/rollouts/{outlet}/{channel}/complete", ["post"]],
  // P2b-03: the CI report of availability, submissions and signing keys.
  ["/{product}/distribution/report", ["post"]],
  // A-18h: a CI-plane store's projection of the listing model.
  ["/{product}/distribution/listing/{store}", ["get"]],
  // A-18i: a PR-plane generator's inputs.
  ["/{product}/distribution/pr/{store}", ["get"]],
  // P5-02: the App Store Connect webhook (Apple → Worker, HMAC-signed).
  ["/{product}/distribution/hooks/asc", ["post"]],
  // P6-03: the Sentry alert webhook (Sentry → Worker, HMAC-signed); opens halt candidates.
  ["/{product}/distribution/hooks/sentry", ["post"]],
  // P6-01: the commerce bridge — the binding and claim routes (device token) and the two store
  // notification hooks (Apple-signed JWS; Google OIDC push).
  ["/{product}/distribution/commerce/binding", ["get"]],
  ["/{product}/distribution/commerce/claim", ["post"]],
  ["/{product}/distribution/hooks/app-store", ["post"]],
  ["/{product}/distribution/hooks/play-rtdn", ["post"]],
  // P2b-05: the storefront feeds, the F-Droid relay and its CI route.
  ["/{product}/distribution/altstore/{channel}/source.json", ["get"]],
  ["/{product}/distribution/altstore-pal/{channel}/source.json", ["get"]],
  ["/{product}/distribution/obtainium/{channel}.json", ["get"]],
  ["/{product}/distribution/fdroid/{channel}/repo/{path}", ["get"]],
  ["/{product}/distribution/scoop/{channel}.json", ["get"]],
  ["/{product}/distribution/flathub/{channel}.json", ["get"]],
  ["/{product}/distribution/feeds/fdroid/{channel}", ["get", "post"]],
  // A-18d: the listing assets CI derived, registered into the listing model.
  ["/{product}/distribution/listing/assets", ["post"]],
  // P2b-06: the public download page's model (console host) and the page (bytes host only).
  ["/{product}/distribution/download.json", ["get"]],
  ["/{product}/distribution/download", ["get"]],
  ["/{product}/update/appcast.xml", ["get"]],
  ["/{product}/update/{channel}/appcast.xml", ["get"]],
  // P3-03: the signed channel feed.
  ["/{product}/update/{channel}/feed.jws", ["get"]],
  // P3-09: the app-updater feeds.
  ["/{product}/update/{channel}/winsparkle.xml", ["get"]],
  [
    "/{product}/update/{channel}/velopack/releases.{velopackChannel}.json",
    ["get"],
  ],
  // S-11 §5.1: the package a bare Velopack `FileName` resolves to (a 302 to its delivery URL).
  ["/{product}/update/{channel}/velopack/{fileName}", ["get"]],
  ["/{product}/update/{channel}/app.appinstaller", ["get"]],
  ["/{product}/update/{channel}/{buildId}.AppImage.zsync", ["get"]],
  ["/{product}/update/version", ["get"]],
  ["/{product}/identity/session", ["get"]],
  ["/{product}/identity/session/license", ["post"]],
  ["/{product}/identity/auth/start", ["get"]],
  ["/{product}/identity/auth/callback", ["get"]],
  ["/{product}/identity/auth/poll", ["get"]],
  ["/{product}/identity/auth/logout", ["post"]],
  ["/{product}/identity/auth/device", ["get", "post"]],
  ["/{product}/identity/auth/device/start", ["post"]],
  ["/{product}/identity/auth/device/verify", ["get", "post"]],
  ["/{product}/identity/auth/device/poll", ["post"]],
  // I-26: the legacy sign-in's licence chooser (server-rendered HTML).
  ["/{product}/identity/auth/choose", ["get", "post"]],
];

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
 * below runs against them unchanged. `test/feedAdapters.test.ts` checks each adapter's rows
 * against its own routes. F-23's push rows are Release's (`RELEASE_REGISTRY_OPENAPI`), checked
 * the same way by `test/registryPush.test.ts`.
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
    for (const [path, entry] of Object.entries(spec.paths)) {
      if (registry.has(path)) continue;
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
  "/{product}/identity/auth/choose",
  "/{product}/config/mint/{mintId}/auth",
  // P2-05: CI routes, authenticated by a `pkeyci_` bearer — never called from a browser page.
  "/{product}/release/channels/{channel}/promote",
  "/{product}/release/channels/{channel}/pin",
  "/{product}/release/channels/{channel}/unpin",
  "/{product}/release/releases/{releaseId}/yank",
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
  // P5-02: a store webhook, called server-to-server by App Store Connect.
  "/{product}/distribution/hooks/asc",
  // P6-02: device attestation — only a native iOS or Android build can attest, never a page.
  "/{product}/devices/attest/challenge",
  "/{product}/devices/attest",
  // P6-03: the Sentry alert webhook, called server-to-server by Sentry.
  "/{product}/distribution/hooks/sentry",
  // P6-01: the commerce bridge. The claim and binding routes serve store builds (App Store,
  // Play, Steam), never a browser page; the two hooks are called server-to-server by the stores.
  "/{product}/distribution/commerce/binding",
  "/{product}/distribution/commerce/claim",
  "/{product}/distribution/hooks/app-store",
  "/{product}/distribution/hooks/play-rtdn",
  // P2b-05: the F-Droid CI route, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/feeds/fdroid/{channel}",
  // A-18d: the listing assets register, authenticated by a `pkeyci_` bearer.
  "/{product}/distribution/listing/assets",
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
