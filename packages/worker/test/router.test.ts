import { describe, expect, it } from "vitest";
import { matchRoute, type Route } from "../src/router.js";

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
    expect(matchRoute("/manage/api/products/djdl/licenses").kind).toBe(
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
    expect(matchRoute("/assets/portal.js").kind).toBe("portalSpa");
    expect(matchRoute("/api").kind).toBe("portalApi");
    expect(matchRoute("/api/me").kind).toBe("portalApi");
    expect(matchRoute("/login").kind).toBe("portalLogin");
    expect(matchRoute("/callback").kind).toBe("portalCallback");
    expect(matchRoute("/logout").kind).toBe("portalLogout");
    expect(matchRoute("/magic/verify").kind).toBe("portalMagicVerify");
    expect(matchRoute("/download/pkeyt_abc").kind).toBe("portalDownload");
  });
});

describe("matchRoute — product-scoped routes", () => {
  const cases: Array<[string, Route["kind"]]> = [
    ["/djdl/.well-known/polaris.json", "discovery"],
    ["/djdl/.well-known/jwks.json", "jwks"],
    ["/djdl/devices", "devices"],
    ["/djdl/devices/report", "report"],
    ["/djdl/session", "browserSession"],
    ["/djdl/session/license", "browserSessionLicense"],
    ["/djdl/auth/start", "authStart"],
    ["/djdl/auth/login", "authLogin"],
    ["/djdl/auth/logout", "authLogout"],
    ["/djdl/auth/device/start", "authDeviceStart"],
    ["/djdl/auth/device/verify", "authDeviceVerify"],
    ["/djdl/auth/device/poll", "authDevicePoll"],
    ["/djdl/auth/callback", "authCallback"],
    ["/djdl/auth/poll", "authPoll"],
    ["/djdl/appcast.xml", "appcast"],
    ["/djdl/install.sh", "install"],
    ["/djdl/version", "version"],
    ["/djdl/changelog", "changelog"],
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

// §R1: `/<p>/license/*` and `/<p>/config/*` no longer resolve to a route kind of their own.
// They resolve to ONE kind carrying the slug and the remaining segments, and the service's
// descriptor routes them from there — which is what lets a product turn a service off and have
// its whole surface disappear rather than answer 403 per path.
describe("matchRoute — service namespaces (license, config)", () => {
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
  ];

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
      kind: "appcast",
      channel: "staging",
    });
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
});

describe("matchRoute — cli / dmg / appcast(channel)", () => {
  it("routes a cli binary by version + arch (and aliases)", () => {
    expect(matchRoute("/djdl/cli/1.2.3/djdl-arm64")).toMatchObject({
      kind: "cli",
      product: "djdl",
      version: "1.2.3",
      arch: "arm64",
    });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-aarch64")).toMatchObject({
      kind: "cli",
      arch: "aarch64",
    });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-x86_64")).toMatchObject({
      kind: "cli",
      arch: "x86_64",
    });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-amd64")).toMatchObject({
      kind: "cli",
      arch: "amd64",
    });
  });

  it("routes a dmg download by version + arch", () => {
    expect(matchRoute("/djdl/dmg/1.2.3/djdl-arm64.dmg")).toMatchObject({
      kind: "dmg",
      product: "djdl",
      version: "1.2.3",
      arch: "arm64",
    });
  });

  it("routes a channel-suffixed appcast", () => {
    const r = matchRoute("/djdl/staging/appcast.xml");
    expect(r).toMatchObject({
      kind: "appcast",
      product: "djdl",
      channel: "staging",
    });
  });

  it("routes a specific device management endpoint", () => {
    expect(matchRoute("/djdl/devices/dev-1")).toMatchObject({
      kind: "devices",
      product: "djdl",
      deviceId: "dev-1",
    });
  });

  it("rejects a cli path with an unknown arch", () => {
    expect(matchRoute("/djdl/cli/1.2.3/djdl-sparc").kind).toBe("notFound");
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
    expect(matchRoute("/djdl").kind).toBe("notFound"); // product with no rest
  });

  it("returns notFound for an uppercase / illegal slug", () => {
    expect(matchRoute("/DJDL/config/document").kind).toBe("notFound");
  });
});
