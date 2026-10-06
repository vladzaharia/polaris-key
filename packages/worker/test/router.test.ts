import { describe, expect, it } from "vitest";
import { matchRoute, type Route } from "../src/router.js";
import { SERVICE_SLUGS } from "../src/core/services.js";

describe("matchRoute — platform + manage + portal (matched before product slugs)", () => {
  it("matches the manage SPA + API + auth routes", () => {
    expect(matchRoute("/manage").kind).toBe("adminSpa");
    expect(matchRoute("/manage/settings").kind).toBe("adminSpa");
    expect(matchRoute("/manage/api").kind).toBe("adminApi");
    expect(matchRoute("/manage/api/me").kind).toBe("adminApi");
    expect(matchRoute("/manage/login").kind).toBe("adminLogin");
    expect(matchRoute("/manage/callback").kind).toBe("adminCallback");
  });

  it("matches the products platform routes (more specific than adminApi)", () => {
    expect(matchRoute("/manage/api/products").kind).toBe("products");
    expect(matchRoute("/manage/api/products/djdl/license/licenses").kind).toBe(
      "products",
    );
  });

  it("matches GitHub webhook before product-scoped routes", () => {
    expect(matchRoute("/webhooks/github").kind).toBe("githubWebhook");
  });

  it("never lets a product slug shadow a manage route", () => {
    expect(matchRoute("/manage/config").kind).toBe("adminSpa");
  });

  it("matches root customer portal routes", () => {
    expect(matchRoute("/").kind).toBe("portalSpa");
    expect(matchRoute("/index.html").kind).toBe("portalSpa");
    // The Activate license deep link's path form (PORTAL.md §3.3): the SPA shell, never a
    // product's public download page.
    expect(matchRoute("/activate").kind).toBe("portalSpa");
    expect(matchRoute("/activate/").kind).toBe("portalSpa");
    expect(matchRoute("/assets/portal.js").kind).toBe("portalSpa");
    expect(matchRoute("/api").kind).toBe("portalApi");
    expect(matchRoute("/api/me").kind).toBe("portalApi");
    expect(matchRoute("/login").kind).toBe("portalLogin");
    // I-06: every shape under `/login/` is the provider handler's (which validates provider and
    // step), never a product route — `login` is a reserved slug.
    expect(matchRoute("/login/google").kind).toBe("portalProviderSignIn");
    expect(matchRoute("/login/steam/callback").kind).toBe(
      "portalProviderSignIn",
    );
    expect(matchRoute("/login/apple/notifications").kind).toBe(
      "portalProviderSignIn",
    );
    expect(matchRoute("/login/unknown/x/y").kind).toBe("portalProviderSignIn");
    expect(matchRoute("/callback").kind).toBe("portalCallback");
    expect(matchRoute("/logout").kind).toBe("portalLogout");
    expect(matchRoute("/magic/verify").kind).toBe("portalMagicVerify");
    expect(matchRoute("/download/Ab3-_xyz").kind).toBe("portalDownload");
  });
});

describe("matchRoute — product-scoped routes", () => {
  const cases: Array<[string, Route["kind"]]> = [
    ["/djdl/.well-known/polaris.json", "discovery"],
    ["/djdl/.well-known/jwks.json", "jwks"],
    ["/djdl/devices", "devices"],
    ["/djdl/devices/report", "report"],
    ["/djdl/devices/register", "register"],
  ];

  it.each(cases)("routes %s -> %s", (path, kind) => {
    const r = matchRoute(path);
    expect(r.kind).toBe(kind);
    expect((r as { product?: string }).product).toBe("djdl");
  });

  it("carries the product slug through for hyphenated slugs", () => {
    const r = matchRoute("/my-app/license/document");
    expect(r.kind).toBe("service");
    expect((r as { product: string }).product).toBe("my-app");
  });
});

// §R1: no product-scoped service path resolves to a route kind of its own any more. They all
// resolve to ONE kind carrying the slug and the remaining segments, and the service's descriptor
// routes them from there — which is what lets a product turn a service off and have its whole
// surface disappear rather than answer 403 per path.
describe("matchRoute — service namespaces (every table slug)", () => {
  const serviceCases: Array<[string, string, string[]]> = [
    ["/djdl/license/activate", "license", ["activate"]],
    ["/djdl/license/enroll", "license", ["enroll"]],
    ["/djdl/license/token", "license", ["token"]],
    ["/djdl/license/deauthorize", "license", ["deauthorize"]],
    ["/djdl/license/document", "license", ["document"]],
    ["/djdl/config/document", "config", ["document"]],
    ["/djdl/config/schema", "config", ["schema"]],
    [
      "/djdl/config/mint/applemusic/token",
      "config",
      ["mint", "applemusic", "token"],
    ],
    [
      "/djdl/config/mint/applemusic/auth",
      "config",
      ["mint", "applemusic", "auth"],
    ],
    ["/djdl/release/changelog", "release", ["changelog"]],
    // P2b-04: byte delivery is Distribution's (the `/release/…` spellings are aliases, pinned in
    // the aliases block below).
    ["/djdl/distribution/install.sh", "distribution", ["install.sh"]],
    [
      "/djdl/distribution/dl/1.2.3/djdl-arm64",
      "distribution",
      ["dl", "1.2.3", "djdl-arm64"],
    ],
    [
      "/djdl/distribution/dl/1.2.3/djdl-arm64.dmg",
      "distribution",
      ["dl", "1.2.3", "djdl-arm64.dmg"],
    ],
    [
      "/djdl/distribution/rollouts/direct/stable/halt",
      "distribution",
      ["rollouts", "direct", "stable", "halt"],
    ],
    ["/djdl/update/appcast.xml", "update", ["appcast.xml"]],
    ["/djdl/update/version", "update", ["version"]],
    ["/djdl/update/beta/appcast.xml", "update", ["beta", "appcast.xml"]],
    ["/djdl/identity/session", "identity", ["session"]],
    ["/djdl/identity/session/license", "identity", ["session", "license"]],
    ["/djdl/identity/auth/start", "identity", ["auth", "start"]],
    ["/djdl/identity/auth/callback", "identity", ["auth", "callback"]],
    ["/djdl/identity/auth/choose", "identity", ["auth", "choose"]],
    ["/djdl/identity/auth/logout", "identity", ["auth", "logout"]],
    [
      "/djdl/identity/auth/device/start",
      "identity",
      ["auth", "device", "start"],
    ],
    [
      "/djdl/identity/auth/device/verify",
      "identity",
      ["auth", "device", "verify"],
    ],
    ["/djdl/identity/auth/device/poll", "identity", ["auth", "device", "poll"]],
  ];

  it.each(SERVICE_SLUGS.map((slug) => [slug]))(
    "routes the %s namespace to its service (SERVICE_NAMESPACES covers the table)",
    (slug) => {
      expect(
        matchRoute(`/djdl/${slug}/anything`),
        `router.ts SERVICE_NAMESPACES does not dispatch "${slug}"`,
      ).toEqual({ kind: "service", slug, product: "djdl", rest: ["anything"] });
    },
  );

  it.each(serviceCases)("routes %s -> %s %j", (path, slug, rest) => {
    expect(matchRoute(path)).toEqual({
      kind: "service",
      slug,
      product: "djdl",
      rest,
    });
  });

  it("hands the bare namespace to the service with no segments", () => {
    // `/djdl/config` used to be the FUSED signed document. It is gone (§R1): the service gets
    // an empty `rest`, matches nothing, and Core answers its single not-found. A route that
    // once returned a signed document must never quietly return one of its halves.
    expect(matchRoute("/djdl/config")).toEqual({
      kind: "service",
      slug: "config",
      product: "djdl",
      rest: [],
    });
    expect(matchRoute("/djdl/license")).toEqual({
      kind: "service",
      slug: "license",
      product: "djdl",
      rest: [],
    });
  });

  it("keeps unknown depth inside the service rather than falling through", () => {
    expect(matchRoute("/djdl/config/report")).toEqual({
      kind: "service",
      slug: "config",
      product: "djdl",
      rest: ["report"],
    });
    expect(matchRoute("/djdl/license/anything/at/all")).toMatchObject({
      kind: "service",
      slug: "license",
    });
  });

  it("lets a service namespace shadow the channel-appcast pattern", () => {
    // `/<p>/<channel>/appcast.xml` would otherwise match `/djdl/license/appcast.xml` with
    // channel "license". Reserved namespaces win, exactly as `/manage` wins over a product slug.
    expect(matchRoute("/djdl/license/appcast.xml")).toMatchObject({
      kind: "service",
      slug: "license",
      rest: ["appcast.xml"],
    });
    expect(matchRoute("/djdl/staging/appcast.xml")).toMatchObject({
      kind: "service",
      slug: "update",
      rest: ["staging", "appcast.xml"],
    });
    // …and a product may not have a channel named after a service, in either direction.
    expect(matchRoute("/djdl/update/appcast.xml")).toMatchObject({
      kind: "service",
      slug: "update",
      rest: ["appcast.xml"],
    });
    expect(matchRoute("/djdl/release/appcast.xml")).toMatchObject({
      kind: "service",
      slug: "release",
      rest: ["appcast.xml"],
    });
  });
});

// §R1 / D-07: four pre-namespace paths are kept FOREVER — they are compiled into shipped app
// bundles (`SUFeedURL`) and printed in published `curl … | sh` lines — and so, since P2b-04, are
// Release's old byte paths (SDK-built download URLs, byte URLs discovery advertised). They are implemented by
// REWRITING to the canonical route, which is what makes "byte-identical" a property of the
// router rather than a promise about two handlers.
describe("matchRoute — the permanent aliases", () => {
  const aliases: Array<[string, string]> = [
    ["/djdl/appcast.xml", "/djdl/update/appcast.xml"],
    ["/djdl/beta/appcast.xml", "/djdl/update/beta/appcast.xml"],
    ["/djdl/install.sh", "/djdl/distribution/install.sh"],
    ["/djdl/version", "/djdl/update/version"],
    // P2b-04: Release's byte paths moved to Distribution and stay as permanent aliases.
    ["/djdl/release/install.sh", "/djdl/distribution/install.sh"],
    [
      "/djdl/release/dl/1.2.3/djdl-arm64",
      "/djdl/distribution/dl/1.2.3/djdl-arm64",
    ],
    [
      "/djdl/release/dl/beta/djdl-arm64.dmg",
      "/djdl/distribution/dl/beta/djdl-arm64.dmg",
    ],
    [
      "/djdl/release/builds/stable/macos",
      "/djdl/distribution/builds/stable/macos",
    ],
    [
      "/djdl/release/files/v1.2.3/djdl.dmg",
      "/djdl/distribution/files/v1.2.3/djdl.dmg",
    ],
    [
      `/djdl/release/blobs/sha256/${"a".repeat(64)}`,
      `/djdl/distribution/blobs/sha256/${"a".repeat(64)}`,
    ],
  ];

  it.each(aliases)("routes %s exactly like %s", (aliasPath, canonical) => {
    const aliased = matchRoute(aliasPath);
    const direct = matchRoute(canonical);
    // Identical but for the marker: same kind, same slug, same segments. A handler therefore
    // cannot tell them apart unless it deliberately reads `alias`.
    expect({ ...aliased, alias: undefined }).toEqual({
      ...direct,
      alias: undefined,
    });
    expect((aliased as { alias?: true }).alias).toBe(true);
    expect((direct as { alias?: true }).alias).toBeUndefined();
  });

  it("does NOT alias /<p>/changelog — wire v3 moves it outright", () => {
    // Unlike the four above, `/changelog` was never baked into a shipped binary or a published
    // command line, so there is nothing to keep working.
    expect(matchRoute("/djdl/changelog").kind).toBe("notFound");
  });
});

// §R1 removals: these paths carried real behaviour before wire v3 and must now be dead ends,
// not silent aliases of whatever replaced them.
describe("matchRoute — routes removed by wire v3", () => {
  it.each([
    "/djdl/activate",
    "/djdl/enroll",
    "/djdl/token",
    "/djdl/deauthorize",
    "/djdl/account",
    "/djdl/schema",
    "/djdl/mint/applemusic/token",
    "/djdl/mint/applemusic/auth",
  ])("404s the pre-suite path %s", (path) => {
    expect(matchRoute(path).kind).toBe("notFound");
  });

  // The identity carve (P3) removes the whole pre-namespace identity surface with NO aliases.
  // These are the ones most likely to be re-added by reflex — a browser flow is easy to think
  // of as "a page URL somebody bookmarked" — so they are pinned as dead ends. `/auth/login` is
  // in the list twice over: it was already a redundant spelling of `/auth/start`.
  it.each([
    "/djdl/session",
    "/djdl/session/license",
    "/djdl/auth/start",
    "/djdl/auth/login",
    "/djdl/auth/logout",
    "/djdl/auth/callback",
    "/djdl/auth/poll",
  ])("404s the pre-namespace identity path %s", (path) => {
    expect(matchRoute(path).kind).toBe("notFound");
  });

  // `/djdl/auth/device/*` is three segments deep, so it cannot reach `notFound` the same way:
  // `auth` is read as a channel-or-namespace head and the path simply matches nothing. What
  // matters is that it does not resolve to the identity service — an unnamespaced path must not
  // be dispatched as if it were namespaced.
  it.each([
    "/djdl/auth/device/start",
    "/djdl/auth/device/verify",
    "/djdl/auth/device/poll",
  ])("does not dispatch the pre-namespace device path %s", (path) => {
    const route = matchRoute(path);
    expect(route.kind).toBe("notFound");
  });
});

describe("matchRoute — downloads and devices", () => {
  it("removes the pre-suite /cli and /dmg paths outright", () => {
    // `/release/dl` unifies them (§R1). They are NOT aliased: the only URL that ever carried a
    // DMG path was inside a generated appcast, which this release regenerates, so there is no
    // installed client holding one.
    for (const path of [
      "/djdl/cli/1.2.3/djdl-arm64",
      "/djdl/cli/1.2.3/djdl-x86_64",
      "/djdl/dmg/1.2.3/djdl-arm64.dmg",
    ]) {
      expect(matchRoute(path).kind).toBe("notFound");
    }
  });

  it("hands the whole dl path to the download route, arch and all", () => {
    // The router no longer parses the arch: the service does, because the arch aliases it
    // accepts (`aarch64`, `amd64`) are an asset-naming concern and `assets.ts` owns them.
    // P2b-04: the route is Distribution's; `/release/dl/…` is its permanent alias.
    for (const leaf of [
      "djdl-arm64",
      "djdl-aarch64",
      "djdl-x86_64",
      "djdl-amd64",
      "djdl-sparc",
    ]) {
      expect(matchRoute(`/djdl/release/dl/1.2.3/${leaf}`)).toEqual({
        kind: "service",
        slug: "distribution",
        product: "djdl",
        rest: ["dl", "1.2.3", leaf],
        alias: true,
      });
    }
  });

  it("routes a specific device management endpoint", () => {
    expect(matchRoute("/djdl/devices/dev-1")).toMatchObject({
      kind: "devices",
      product: "djdl",
      deviceId: "dev-1",
    });
  });

  it("never reads `report` or `register` as a device id", () => {
    // Both sit under `/devices/`, so the literal cases have to be matched before the
    // `/devices/<id>` pattern — otherwise a device could be created with the id `register`
    // and shadow the route.
    expect(matchRoute("/djdl/devices/register").kind).toBe("register");
    expect(matchRoute("/djdl/devices/report").kind).toBe("report");
    // …and a device id that merely resembles one is still a device id.
    expect(matchRoute("/djdl/devices/registered")).toMatchObject({
      kind: "devices",
      deviceId: "registered",
    });
  });
});

describe("matchRoute — normalization + notFound", () => {
  it("strips a single trailing slash before matching", () => {
    expect(matchRoute("/djdl/config/document/")).toMatchObject({
      kind: "service",
      slug: "config",
      rest: ["document"],
    });
    expect(matchRoute("/manage/").kind).toBe("adminSpa");
  });

  it("keeps the root path as the portal", () => {
    expect(matchRoute("/").kind).toBe("portalSpa");
  });

  it("returns notFound for an unknown product sub-path", () => {
    expect(matchRoute("/djdl/unknown-thing").kind).toBe("notFound");
    expect(matchRoute("/djdl/activation").kind).toBe("notFound");
  });

  it("/<product> alone is the download page's alias (P2b-06), which only the bytes host serves", () => {
    // Rewritten like every permanent alias; on the console host the Distribution route answers
    // `null` for `download`, so the console still serves nothing at `/<product>`.
    expect(matchRoute("/djdl")).toEqual({
      kind: "service",
      slug: "distribution",
      product: "djdl",
      rest: ["download"],
      alias: true,
    });
    expect(matchRoute("/djdl/")).toEqual(matchRoute("/djdl"));
    expect(matchRoute("/DJDL").kind).toBe("notFound");
    expect(matchRoute("/djdl.html").kind).toBe("notFound");
    // A reserved slug is never a product.
    for (const reserved of ["/download", "/webhooks", "/magic", "/assets"])
      expect(matchRoute(reserved).kind, reserved).toBe("notFound");
  });

  it("returns notFound for an uppercase / illegal slug", () => {
    expect(matchRoute("/DJDL/config/document").kind).toBe("notFound");
  });
});
