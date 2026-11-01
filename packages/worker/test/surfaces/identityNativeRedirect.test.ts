/**
 * I-15.3: the redirect URI classes (WIRE-CONTRACT-V5 §12.12), as a pure accept/refuse table.
 * The `request` route and `authorize` with a `request_uri` (I-15.4) follow.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { dispatchWith } from "../../src/dispatch.js";
import { setServices } from "../../src/core/products/store.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../../src/core/services.js";
import type { Env } from "../../src/platform/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { getOrCreateAccountByEmail } from "../../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "../portalSessionRow.js";
import { handlePortalApi as portalApi } from "../../src/services/identity/portal/api.js";
import { SETTINGS } from "../../src/mount.js";
import { portalHooksFor } from "../portalHarness.js";
import { validateRedirectUri } from "../../src/services/identity/passthrough/redirectUri.js";

const APP = "https://app.example";
const reg = {
  webOrigins: [APP],
  redirectPaths: ["/auth/callback"],
  loopback: true,
  schemes: ["com.tidewater.studio"],
  claimedPaths: ["/open"],
};
const native = (r: typeof reg, uri: unknown) =>
  validateRedirectUri(r, uri, "native");

describe("validateRedirectUri: native classes", () => {
  it.each([
    ["an IPv4 loopback", "http://127.0.0.1:49152/pkey/callback", "loopback"],
    ["an IPv6 loopback", "http://[::1]:8123/pkey/callback", "loopback"],
    ["the top port", "http://127.0.0.1:65535/pkey/callback", "loopback"],
    ["a registered scheme", "com.tidewater.studio:/pkey/callback", "scheme"],
    ["a claimed path", `${APP}/open`, "claimed"],
  ])("accepts %s", (_n, uri, redirect) => {
    expect(native(reg, uri)).toEqual({
      ok: true,
      kind: "native",
      redirect,
      uri,
    });
  });

  it.each([
    ["localhost", "http://localhost:4000/pkey/callback"],
    ["another loopback address", "http://127.0.0.2:4000/pkey/callback"],
    ["https loopback", "https://127.0.0.1:4000/pkey/callback"],
    ["no port", "http://127.0.0.1/pkey/callback"],
    ["port 80", "http://127.0.0.1:80/pkey/callback"],
    ["port 0", "http://127.0.0.1:0/pkey/callback"],
    ["a leading-zero port", "http://127.0.0.1:04000/pkey/callback"],
    ["a port over 65535", "http://127.0.0.1:65536/pkey/callback"],
    ["another path", "http://127.0.0.1:4000/cb"],
    ["a percent-encoded path", "http://127.0.0.1:4000/pkey/%63allback"],
    ["a trailing slash", "http://127.0.0.1:4000/pkey/callback/"],
    ["a query", "http://127.0.0.1:4000/pkey/callback?a=1"],
    ["a fragment", "http://127.0.0.1:4000/pkey/callback#x"],
    ["userinfo", "http://u@127.0.0.1:4000/pkey/callback"],
    ["an IDN host", "http://ｌｏｃａｌｈｏｓｔ:4000/pkey/callback"],
    ["an unregistered scheme", "com.other.app:/pkey/callback"],
    ["a scheme with an authority", "com.tidewater.studio://pkey/callback"],
    ["a scheme with another path", "com.tidewater.studio:/other"],
    ["an upper-case scheme", "COM.TIDEWATER.STUDIO:/pkey/callback"],
    ["an unlisted claimed path", `${APP}/other`],
    ["a claimed path on another origin", "https://evil.example/open"],
    ["a claimed path with a query", `${APP}/open?x=1`],
    ["a web path (not claimed)", `${APP}/auth/callback`],
    ["nothing", ""],
  ])("refuses %s", (_n, uri) => {
    expect(native(reg, uri).ok).toBe(false);
  });

  it("refuses loopback when the product turned it off, and keeps the other classes", () => {
    const off = { ...reg, loopback: false };
    expect(native(off, "http://127.0.0.1:4000/pkey/callback").ok).toBe(false);
    expect(native(off, "com.tidewater.studio:/pkey/callback").ok).toBe(true);
  });

  it("refuses a claimed path that is also a web path", () => {
    const both = { ...reg, claimedPaths: ["/auth/callback"] };
    expect(native(both, `${APP}/auth/callback`).ok).toBe(false);
  });

  it("refuses a scheme when none is registered", () => {
    expect(
      native({ ...reg, schemes: [] }, "com.tidewater.studio:/pkey/callback").ok,
    ).toBe(false);
  });

  it("accepts a native URI only from a caller that asks for native", () => {
    for (const uri of [
      "http://127.0.0.1:4000/pkey/callback",
      "com.tidewater.studio:/pkey/callback",
      `${APP}/open`,
    ])
      expect(validateRedirectUri(reg, uri).ok).toBe(false);
  });

  it("does not take a web URI from a native caller", () => {
    expect(native(reg, `${APP}/auth/callback`).ok).toBe(false);
    expect(validateRedirectUri(reg, `${APP}/auth/callback`).ok).toBe(true);
  });
});

// ── I-15.4: the pushed request and `authorize` with a `request_uri` ────────────────────────────

const SLUG = "tidewater";
const BASE = "https://key.plrs.im";
const LOOP = "http://127.0.0.1:49152/pkey/callback";
const SCHEME = "com.tidewater.studio:/pkey/callback";
const DEVICE = "I15DEVICEA0000000000000000000001";
const STATE = "s".repeat(24);
const CHALLENGE = createHash("sha256")
  .update("v".repeat(48))
  .digest("base64url");

let db: SqliteDb;
let env: Env;

async function setting(key: string, value: unknown) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, ?, ?, 'manifest', ?, 'test')`,
    SLUG,
    key,
    JSON.stringify(value),
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([APP]),
    SLUG,
  );
  await setting("identity.redirectPaths", ["/auth/callback"]);
  await setting("identity.nativeRedirect.schemes", ["com.tidewater.studio"]);
  await setting("identity.nativeRedirect.claimedPaths", ["/open"]);
  const on: Record<string, boolean> = {
    license: true,
    config: true,
    identity: true,
  };
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: on[s] === true }]),
  ) as ServicesMap;
  await setServices(
    db,
    SLUG,
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
});

function route(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return dispatchWith(
    new Request(`${BASE}${path}`, {
      method,
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    }) as unknown as Request,
    env,
    db,
    NOW,
  );
}

function push(
  over: Record<string, string | null> = {},
  opts: { device?: string | null; json?: boolean } = {},
): Promise<Response> {
  const form = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: LOOP,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    device_name: "Ada's Mac",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) form.delete(k);
    else form.set(k, v);
  }
  return route("POST", `/${SLUG}/identity/request`, {
    headers: {
      "content-type": opts.json
        ? "application/json"
        : "application/x-www-form-urlencoded",
      ...(opts.device === null
        ? {}
        : { "x-pkey-device": opts.device ?? DEVICE }),
    },
    body: form.toString(),
  });
}

async function pushed(
  over: Record<string, string | null> = {},
): Promise<string> {
  const res = await push(over);
  expect(res.status).toBe(201);
  return ((await res.json()) as { request_uri: string }).request_uri;
}

const authorizeWith = (q: Record<string, string>) =>
  route("GET", `/${SLUG}/identity/authorize?${new URLSearchParams(q)}`);

describe("POST /<p>/identity/request (§12.12)", () => {
  it.each([
    ["loopback", LOOP],
    ["a registered scheme", SCHEME],
    ["a claimed path", `${APP}/open`],
  ])(
    "pushes %s and answers a request_uri, no-store, no CORS",
    async (_n, uri) => {
      const res = await push({ redirect_uri: uri });
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.expires_in).toBe(600);
      expect(body.request_uri).toMatch(
        /^urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}$/,
      );
    },
  );

  it.each([
    ["localhost", { redirect_uri: "http://localhost:4000/pkey/callback" }],
    [
      "an unregistered scheme",
      { redirect_uri: "com.other.app:/pkey/callback" },
    ],
    ["a web redirect uri", { redirect_uri: `${APP}/auth/callback` }],
    ["a loopback with a query", { redirect_uri: `${LOOP}?x=1` }],
    ["no redirect_uri", { redirect_uri: null }],
  ])("refuses %s with redirect_uri_mismatch", async (_n, over) => {
    const res = await push(over);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "redirect_uri_mismatch" });
  });

  it("refuses loopback when the product turned it off", async () => {
    await setting("identity.nativeRedirect.loopback", false);
    expect((await push()).status).toBe(400);
    expect((await push({ redirect_uri: SCHEME })).status).toBe(201);
  });

  it("applies authorize's checks and flat errors", async () => {
    for (const [over, status, error] of [
      [{ code_challenge_method: "plain" }, 400, "invalid_request"],
      [{ state: "short" }, 400, "invalid_request"],
      [{ scope: "openid" }, 400, "invalid_scope"],
      [{ client_id: "other" }, 401, "invalid_client"],
    ] as const) {
      const res = await push(over);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error });
    }
  });

  it("needs a device id, a form body, and a registered scheme as return_uri", async () => {
    expect((await push({}, { device: null })).status).toBe(400);
    expect((await push({}, { json: true })).status).toBe(400);
    expect((await push({ return_uri: SCHEME })).status).toBe(201);
    expect((await push({ return_uri: LOOP })).status).toBe(400);
    expect(
      (await push({ return_uri: "com.other.app:/pkey/callback" })).status,
    ).toBe(400);
  });

  it("is POST only and rate limited per device", async () => {
    expect((await route("GET", `/${SLUG}/identity/request`)).status).toBe(405);
    let last = 201;
    for (let i = 0; i < 11; i++) last = (await push()).status;
    expect(last).toBe(429);
  });
});

describe("authorize with a request_uri (§12.4, §12.12)", () => {
  it("resolves it to the card, and again on a reopen", async () => {
    const uri = await pushed();
    for (let i = 0; i < 2; i++) {
      const res = await authorizeWith({ client_id: SLUG, request_uri: uri });
      expect(res.status).toBe(303);
      const to = new URL(res.headers.get("location")!);
      expect(to.pathname).toBe("/signin");
      expect(to.searchParams.get("request")).toMatch(/^rq_/);
      expect(res.headers.get("set-cookie")).toContain("__Host-pk_req=");
      expect(to.toString()).not.toContain(STATE);
    }
  });

  it.each([
    [
      "an unknown URI",
      "urn:ietf:params:oauth:request_uri:AAAAAAAAAAAAAAAAAAAAAA",
    ],
    ["a malformed URI", "urn:x"],
    ["an empty URI", ""],
  ])(
    "renders the invalid_request_uri page for %s, with no redirect",
    async (_n, uri) => {
      const res = await authorizeWith({ client_id: SLUG, request_uri: uri });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("sign-in link has expired");
    },
  );

  it("refuses another client_id", async () => {
    const uri = await pushed();
    const res = await authorizeWith({ client_id: "other", request_uri: uri });
    expect(res.status).toBe(401);
  });

  it("redirects any other parameter as invalid_request and keeps the record", async () => {
    const uri = await pushed();
    const res = await authorizeWith({
      client_id: SLUG,
      request_uri: uri,
      redirect_uri: LOOP,
    });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(LOOP);
    expect(to.searchParams.get("error")).toBe("invalid_request");
    expect(to.searchParams.get("state")).toBe(STATE);
    const again = await authorizeWith({ client_id: SLUG, request_uri: uri });
    expect(again.status).toBe(303);
  });

  it("does not take a native redirect_uri straight on authorize", async () => {
    for (const uri of [LOOP, SCHEME, `${APP}/open`]) {
      const res = await authorizeWith({
        response_type: "code",
        client_id: SLUG,
        redirect_uri: uri,
        state: STATE,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

// ── I-15.5 and I-15.6: the code, Continue and Cancel, the view, discovery and the return page ──

const VERIFIER = "v".repeat(48);
const OTHER_DEVICE = "I15DEVICEB0000000000000000000002";

async function begin(uri: string) {
  const res = await authorizeWith({ client_id: SLUG, request_uri: uri });
  expect(res.status).toBe(303);
  const handle = new URL(res.headers.get("location")!).searchParams.get(
    "request",
  )!;
  const binder = res.headers.get("set-cookie")!.split(";")[0]!;
  return { handle, binder };
}

async function signedIn() {
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

function card(
  path: string,
  s: { cookie: string; csrf: string } | null,
  binder: string,
  method = "POST",
  body: unknown = {},
): Promise<Response> {
  return portalApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        cookie: s ? `${s.cookie}; ${binder}` : binder,
        ...(s ? { [PORTAL_CSRF_HEADER]: s.csrf } : {}),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    path,
    NOW,
    portalHooksFor(env, db),
    SETTINGS,
  );
}

const proceed = (
  h: string,
  s: Awaited<ReturnType<typeof signedIn>>,
  b: string,
) => card(`/api/signin/requests/${h}/continue`, s, b);

function redeem(code: string, device: string, redirectUri = LOOP) {
  return route("POST", `/${SLUG}/identity/token`, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-pkey-device": device,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: SLUG,
      code,
      code_verifier: VERIFIER,
      redirect_uri: redirectUri,
    }).toString(),
  });
}

describe("Continue, Cancel and token for a pushed request", () => {
  it("a loopback code carries request=, and only the pushing device redeems it", async () => {
    const { handle, binder } = await begin(await pushed());
    const s = await signedIn();
    const res = await proceed(handle, s, binder);
    expect(res.status).toBe(200);
    const to = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(to.origin + to.pathname).toBe(LOOP);
    expect(to.searchParams.get("request")).toBe(handle);
    expect(to.searchParams.get("state")).toBe(STATE);
    const code = to.searchParams.get("code")!;
    const wrong = await redeem(code, OTHER_DEVICE);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    // The wrong device spent it.
    expect((await redeem(code, DEVICE)).status).toBe(400);
  });

  it("the pushing device signs in, and the redirect uri is compared exactly", async () => {
    const { handle, binder } = await begin(await pushed());
    const s = await signedIn();
    const out = (await (await proceed(handle, s, binder)).json()) as {
      redirect: string;
    };
    const code = new URL(out.redirect).searchParams.get("code")!;
    const other = await redeem(
      code,
      DEVICE,
      "http://127.0.0.1:49153/pkey/callback",
    );
    expect(other.status).toBe(400);
    const again = await begin(await pushed());
    const out2 = (await (
      await proceed(again.handle, s, again.binder)
    ).json()) as {
      redirect: string;
    };
    const ok = await redeem(
      new URL(out2.redirect).searchParams.get("code")!,
      DEVICE,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token_type: "Bearer" });
  });

  it("one pushed request yields at most one code across reopened handles", async () => {
    const uri = await pushed();
    const a = await begin(uri);
    const b = await begin(uri);
    const s = await signedIn();
    expect((await proceed(a.handle, s, a.binder)).status).toBe(200);
    expect((await proceed(b.handle, s, b.binder)).status).toBe(404);
    // Taken: the URI is gone.
    const res = await authorizeWith({ client_id: SLUG, request_uri: uri });
    expect(res.status).toBe(400);
  });

  it("Cancel on loopback carries request= and takes the pushed request", async () => {
    const uri = await pushed();
    const { handle, binder } = await begin(uri);
    const s = await signedIn();
    const res = await card(`/api/signin/requests/${handle}/cancel`, s, binder);
    const to = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("request")).toBe(handle);
    expect(
      (await authorizeWith({ client_id: SLUG, request_uri: uri })).status,
    ).toBe(400);
  });

  it("a scheme redirect has no request= and the view names the class and return uri", async () => {
    const { handle, binder } = await begin(
      await pushed({ redirect_uri: SCHEME, return_uri: SCHEME }),
    );
    const view = await card(
      `/api/signin/requests/${handle}`,
      null,
      binder,
      "GET",
    );
    expect(view.status).toBe(200);
    const body = (await view.json()) as Record<string, unknown>;
    expect(body.redirect).toBe("scheme");
    expect(body.returnUri).toBe(SCHEME);
    expect(body.deviceLabel).toBe("Ada's Mac");
    expect((body.client as { kind: string }).kind).toBe("native");
    const s = await signedIn();
    const res = await proceed(handle, s, binder);
    const to = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(to.protocol).toBe("com.tidewater.studio:");
    expect(to.searchParams.has("request")).toBe(false);
  });

  it("a web request's view has neither member", async () => {
    const res = await authorizeWith({
      response_type: "code",
      client_id: SLUG,
      redirect_uri: `${APP}/auth/callback`,
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    const handle = new URL(res.headers.get("location")!).searchParams.get(
      "request",
    )!;
    const binder = res.headers.get("set-cookie")!.split(";")[0]!;
    const body = (await (
      await card(`/api/signin/requests/${handle}`, null, binder, "GET")
    ).json()) as Record<string, unknown>;
    expect("redirect" in body).toBe(false);
    expect("returnUri" in body).toBe(false);
  });
});

describe("discovery, the return page and association files", () => {
  it("discovery names request, signinReturn and the registered classes", async () => {
    const res = await route("GET", `/${SLUG}/.well-known/polaris.json`);
    const id = (
      (await res.json()) as { services: { identity: Record<string, any> } }
    ).services.identity;
    expect(id.endpoints.request).toBe(`${BASE}/${SLUG}/identity/request`);
    expect(id.endpoints.signinReturn).toBe(`${BASE}/signin/return`);
    expect(id.nativeRedirect).toEqual({
      loopback: true,
      schemes: [SCHEME],
      claimedHttps: [`${APP}/open`],
    });
  });

  it("serves the card shell for a well-formed handle only, GET and HEAD", async () => {
    const handle = `rq_${"A".repeat(22)}`;
    const ok = await route("GET", `/signin/return?request=${handle}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      (await route("GET", `/signin/return?request=${handle}&cancelled=1`))
        .status,
    ).toBe(200);
    expect(
      (await route("HEAD", `/signin/return?request=${handle}`)).status,
    ).toBe(200);
    expect((await route("GET", `/signin/return`)).status).toBe(404);
    expect((await route("GET", `/signin/return?request=rq_x`)).status).toBe(
      404,
    );
    expect(
      (await route("GET", `/signin/return?request=${handle}&cancelled=2`))
        .status,
    ).toBe(404);
    expect(
      (await route("POST", `/signin/return?request=${handle}`)).status,
    ).toBe(405);
  });

  it("never serves association files on the API host", async () => {
    for (const p of [
      "/.well-known/apple-app-site-association",
      "/.well-known/assetlinks.json",
      `/${SLUG}/.well-known/apple-app-site-association`,
      `/${SLUG}/.well-known/assetlinks.json`,
    ])
      expect((await route("GET", p)).status, p).toBe(404);
  });
});
