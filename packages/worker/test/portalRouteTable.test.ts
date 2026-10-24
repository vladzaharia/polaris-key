/**
 * The root portal's route table (P0-25b): which row takes which path, and that `/login` still
 * starts the platform sign-in. `**` matches zero segments and outranks an absent one, so a
 * `login/**` row beside `login` took `/login` itself until it was given an `accept` guard; the
 * public-route oracle's old environment had no IdP and could not tell.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { dispatchWith } from "../src/dispatch.js";
import { PORTAL_ROUTES } from "../src/services/identity/portal/index.js";
import { bestRow } from "../src/core/http/routes.js";

function rowFor(path: string): string {
  const clean =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = clean === "/" ? [] : clean.slice(1).split("/");
  return bestRow(PORTAL_ROUTES, segments, (r) =>
    r.accept ? r.accept(segments) : true,
  )!.row.path;
}

describe("PORTAL_ROUTES: path to row", () => {
  const cases: [string, string][] = [
    ["/", "**"],
    ["/index.html", "**"],
    ["/activate", "**"],
    ["/assets/x.js", "**"],
    ["/login", "login"],
    ["/login/", "login"],
    ["/login/sso", "login/**"],
    ["/login/sso/c1", "login/sso/:id/**"],
    ["/login/sso/c1/x", "login/sso/:id/**"],
    ["/login/google", "login/**"],
    ["/login/google/callback", "login/**"],
    ["/login/nope", "login/**"],
    ["/callback", "callback"],
    ["/callback/extra", "**"],
    ["/logout", "logout"],
    ["/magic/verify", "magic/verify"],
    ["/magic", "**"],
    ["/api", "api/**"],
    ["/api/me", "api/**"],
    ["/media", "media/**"],
    ["/media/djdl/icon", "media/**"],
    ["/media/avatar", "media/**"],
    ["/media/avatar/", "media/**"],
    ["/media/avatar/a1", "media/avatar/:asset"],
    ["/media/avatar/a1/extra", "media/**"],
    ["/download", "**"],
    ["/download/", "**"],
    ["/download/tok", "download/:token"],
    ["/download/tok/extra", "**"],
  ];
  it.each(cases)("%s is taken by %s", (path, row) => {
    expect(rowFor(path)).toBe(row);
  });

  it("has no duplicate path", () => {
    const paths = PORTAL_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("GET /login starts the platform sign-in", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["/login", "/login/"])("%s is a 302 to the IdP", async (path) => {
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) =>
        (await issuerMetadataResponse(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
          null,
        )) ?? new Response("x", { status: 503 }),
    );
    vi.stubGlobal("caches", {
      default: {
        async match() {
          return undefined;
        },
        async put() {},
      },
    });
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    Object.assign(env, {
      PLATFORM_OIDC_ISSUER: "https://id.platform.example",
      PLATFORM_OIDC_CLIENT_ID: "platform-client",
      PLATFORM_OIDC_CLIENT_SECRET: "platform-secret",
    });
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    const res = await dispatchWith(
      new Request(`https://key.plrs.im${path}`),
      env,
      db,
      NOW,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/id\.platform\.example\/authorize/,
    );
  });
});
