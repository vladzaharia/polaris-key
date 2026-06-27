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
    ["/djdl/schema", "schema"],
    ["/djdl/activate", "activate"],
    ["/djdl/token", "token"],
    ["/djdl/account", "account"],
    ["/djdl/devices", "devices"],
    ["/djdl/deauthorize", "deauthorize"],
    ["/djdl/config", "config"],
    ["/djdl/config/report", "configReport"],
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
    const r = matchRoute("/my-app/config");
    expect(r.kind).toBe("config");
    expect((r as { product: string }).product).toBe("my-app");
  });
});

describe("matchRoute — mint / cli / dmg / appcast(channel)", () => {
  it("routes mint token + auth recipes", () => {
    const t = matchRoute("/djdl/mint/applemusic/token");
    expect(t).toMatchObject({
      kind: "mintToken",
      product: "djdl",
      mintId: "applemusic",
    });
    const a = matchRoute("/djdl/mint/applemusic/auth");
    expect(a).toMatchObject({
      kind: "mintAuth",
      product: "djdl",
      mintId: "applemusic",
    });
  });

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
    expect(matchRoute("/djdl/config/").kind).toBe("config");
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
    expect(matchRoute("/DJDL/config").kind).toBe("notFound");
  });
});
