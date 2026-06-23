import { describe, expect, it } from "vitest";
import { matchRoute, type Route } from "../src/router.js";

describe("matchRoute — platform + admin (matched before product slugs)", () => {
  it("matches the admin SPA + API + auth routes", () => {
    expect(matchRoute("/admin").kind).toBe("adminSpa");
    expect(matchRoute("/admin/settings").kind).toBe("adminSpa");
    expect(matchRoute("/admin/api").kind).toBe("adminApi");
    expect(matchRoute("/admin/api/me").kind).toBe("adminApi");
    expect(matchRoute("/admin/login").kind).toBe("adminLogin");
    expect(matchRoute("/admin/callback").kind).toBe("adminCallback");
  });

  it("matches the products platform routes (more specific than adminApi)", () => {
    expect(matchRoute("/admin/api/products").kind).toBe("products");
    expect(matchRoute("/admin/api/products/djdl/licenses").kind).toBe("products");
  });

  it("never lets a product slug shadow an admin route", () => {
    // A product literally named "admin" still resolves to the admin SPA, not a product route.
    expect(matchRoute("/admin/config").kind).toBe("adminSpa");
  });
});

describe("matchRoute — product-scoped routes", () => {
  const cases: Array<[string, Route["kind"]]> = [
    ["/djdl/.well-known/jwks.json", "jwks"],
    ["/djdl/schema", "schema"],
    ["/djdl/enroll", "enroll"],
    ["/djdl/token", "token"],
    ["/djdl/deauthorize", "deauthorize"],
    ["/djdl/config", "config"],
    ["/djdl/config/report", "configReport"],
    ["/djdl/config/subscribe", "configSubscribe"],
    ["/djdl/auth/start", "authStart"],
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
    expect(t).toMatchObject({ kind: "mintToken", product: "djdl", mintId: "applemusic" });
    const a = matchRoute("/djdl/mint/applemusic/auth");
    expect(a).toMatchObject({ kind: "mintAuth", product: "djdl", mintId: "applemusic" });
  });

  it("routes a cli binary by version + arch (and aliases)", () => {
    expect(matchRoute("/djdl/cli/1.2.3/djdl-arm64")).toMatchObject({
      kind: "cli", product: "djdl", version: "1.2.3", arch: "arm64",
    });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-aarch64")).toMatchObject({ kind: "cli", arch: "aarch64" });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-x86_64")).toMatchObject({ kind: "cli", arch: "x86_64" });
    expect(matchRoute("/djdl/cli/1.2.3/djdl-amd64")).toMatchObject({ kind: "cli", arch: "amd64" });
  });

  it("routes a dmg download by version + arch", () => {
    expect(matchRoute("/djdl/dmg/1.2.3/djdl-arm64.dmg")).toMatchObject({
      kind: "dmg", product: "djdl", version: "1.2.3", arch: "arm64",
    });
  });

  it("routes a channel-suffixed appcast", () => {
    const r = matchRoute("/djdl/staging/appcast.xml");
    expect(r).toMatchObject({ kind: "appcast", product: "djdl", channel: "staging" });
  });

  it("rejects a cli path with an unknown arch", () => {
    expect(matchRoute("/djdl/cli/1.2.3/djdl-sparc").kind).toBe("notFound");
  });
});

describe("matchRoute — normalization + notFound", () => {
  it("strips a single trailing slash before matching", () => {
    expect(matchRoute("/djdl/config/").kind).toBe("config");
    expect(matchRoute("/admin/").kind).toBe("adminSpa");
  });

  it("keeps the root path intact", () => {
    expect(matchRoute("/").kind).toBe("notFound");
  });

  it("returns notFound for an unknown product sub-path", () => {
    expect(matchRoute("/djdl/unknown-thing").kind).toBe("notFound");
    expect(matchRoute("/djdl").kind).toBe("notFound"); // product with no rest
  });

  it("returns notFound for an uppercase / illegal slug", () => {
    expect(matchRoute("/DJDL/config").kind).toBe("notFound");
  });
});
