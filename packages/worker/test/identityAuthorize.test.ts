// I-08 (WIRE-CONTRACT-V4 §12.4, §12.5; plans/I-08.md): app passthrough on an OAuth-shaped
// authorize and token. Each security property has a positive case and a negative control:
//
//   - no redirect happens before client_id and redirect_uri are both valid, and the redirect
//     URI is matched exactly (no prefix, query, dot segment or sibling origin);
//   - PKCE S256 only; a code redeems once, with its own verifier, client_id and redirect_uri;
//     a wrong verifier ends the code;
//   - the code reaches only the browser that holds the request's binder, through the response
//     to a Continue press that carries the session and the CSRF header;
//   - token takes a form body and answers exactly the listed members;
//   - with Identity off every route is refused.

import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { dispatchWith } from "../src/dispatch.js";
import { loadProduct } from "../src/core/products.js";
import {
  serializeServices,
  SERVICE_SLUGS,
  type ServicesMap,
} from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi as portalApi } from "../src/services/identity/portal/api.js";
import { SETTINGS } from "../src/mount.js";
import { portalHooksFor } from "./portalHarness.js";
import { validateRedirectUri } from "../src/services/identity/passthrough/redirectUri.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

/** The portal API as the composition root wires it, settings registry included. */
const handlePortalApi = (
  req: Request,
  e: Env,
  d: SqliteDb,
  path: string,
  now: number,
): Promise<Response> =>
  portalApi(req, e, d, path, now, portalHooksFor(e, d), SETTINGS);

const SLUG = "tidewater";
const BASE = "https://key.plrs.im";
const APP = "https://app.example";
const CB = `${APP}/auth/callback`;
const DEVICE = "I08DEVICEA0000000000000000000001";
const STATE = "s".repeat(24);
const VERIFIER = "v".repeat(48);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let db: SqliteDb;
let env: Env;

async function services(over: Partial<Record<string, boolean>> = {}) {
  const on: Record<string, boolean> = {
    license: true,
    config: true,
    identity: true,
    ...over,
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
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.redirectPaths', ?, 'manifest', ?, 'test')`,
    SLUG,
    JSON.stringify(["/auth/callback"]),
    NOW,
  );
  await services();
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

function authorizeUrl(over: Record<string, string | null> = {}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: CB,
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  return `/${SLUG}/identity/authorize?${q}`;
}

const authorize = (over: Record<string, string | null> = {}, cookie?: string) =>
  route("GET", authorizeUrl(over), cookie ? { headers: { cookie } } : {});

/** authorize, then the handle and binder cookie from the card redirect. */
async function begin(over: Record<string, string | null> = {}) {
  const res = await authorize(over);
  expect(res.status).toBe(303);
  const location = res.headers.get("location")!;
  const handle = new URL(location).searchParams.get("request")!;
  expect(handle).toMatch(/^rq_[A-Za-z0-9_-]{22}$/);
  expect(new URL(location).origin + new URL(location).pathname).toBe(
    `${BASE}/signin`,
  );
  const binder = res.headers.get("set-cookie")!.split(";")[0]!;
  return { handle, binder, res };
}

async function signedIn(email = "ada@example.com") {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
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
  return {
    id: account.id,
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
  };
}

function card(
  path: string,
  s: { cookie: string; csrf: string },
  binder: string | null,
  body?: unknown,
  csrf: string | null = s.csrf,
): Promise<Response> {
  return handlePortalApi(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        cookie: binder ? `${s.cookie}; ${binder}` : s.cookie,
        ...(csrf ? { [PORTAL_CSRF_HEADER]: csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    path,
    NOW,
  );
}

/** Continue and read the redirect it answers. */
async function proceed(
  handle: string,
  s: { cookie: string; csrf: string },
  binder: string,
  body: unknown = {},
) {
  const res = await card(
    `/api/signin/requests/${handle}/continue`,
    s,
    binder,
    body,
  );
  return { res, json: (await res.clone().json()) as Record<string, string> };
}

function codeOf(redirect: string): string {
  return new URL(redirect).searchParams.get("code")!;
}

function tokenReq(
  fields: Record<string, string | null>,
  opts: {
    device?: string | null;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: SLUG,
    code_verifier: VERIFIER,
    redirect_uri: CB,
  });
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) form.delete(k);
    else form.set(k, v);
  }
  return route("POST", `/${SLUG}/identity/token`, {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(opts.device === null
        ? {}
        : { "x-pkey-device": opts.device ?? DEVICE }),
      ...(opts.headers ?? {}),
    },
    body: opts.body ?? form.toString(),
  });
}

/** A full web sign-in up to the code. */
async function codeFor(
  over: Record<string, string | null> = {},
  body: unknown = {},
) {
  const { handle, binder } = await begin(over);
  const s = await signedIn();
  const out = await proceed(handle, s, binder, body);
  expect(out.res.status).toBe(200);
  return {
    code: codeOf(out.json.redirect!),
    s,
    handle,
    binder,
    redirect: out.json.redirect!,
  };
}

describe("validateRedirectUri (the function I-15 widens)", () => {
  const reg = { webOrigins: [APP], redirectPaths: ["/auth/callback"] };
  it("accepts exactly origin + path and answers the client kind", () => {
    expect(validateRedirectUri(reg, CB)).toEqual({
      ok: true,
      kind: "web",
      uri: CB,
    });
  });
  it.each([
    ["a sibling origin", "https://evil.example/auth/callback"],
    ["a subdomain", "https://x.app.example/auth/callback"],
    ["a suffix", "https://app.example.evil.example/auth/callback"],
    ["a path prefix", `${APP}/auth/callback/x`],
    ["a path suffix", `${APP}/auth/callback2`],
    ["a query", `${CB}?a=1`],
    ["an empty query", `${CB}?`],
    ["a fragment", `${CB}#x`],
    ["userinfo", "https://u:p@app.example/auth/callback"],
    ["a dot segment", `${APP}/auth/../auth/callback`],
    ["an encoded dot segment", `${APP}/auth/%2e%2e/auth/callback`],
    ["http", "http://app.example/auth/callback"],
    ["a port", "https://app.example:8443/auth/callback"],
    ["a backslash", `${APP}\\auth\\callback`],
    ["a wildcard path", `${APP}/auth/*`],
    ["nothing", ""],
  ])("refuses %s", (_n, uri) => {
    expect(validateRedirectUri(reg, uri).ok).toBe(false);
  });
  it("refuses everything when the product registered no path", () => {
    expect(
      validateRedirectUri({ webOrigins: [APP], redirectPaths: [] }, CB).ok,
    ).toBe(false);
  });
});

describe("GET /<p>/identity/authorize (§12.4)", () => {
  it("303s to the card with a binder; the app's state and challenge reach no URL", async () => {
    const { res, handle } = await begin();
    const location = res.headers.get("location")!;
    expect(location).not.toContain(STATE);
    expect(location).not.toContain(CHALLENGE);
    const cookie = res.headers.get("set-cookie")!;
    for (const attr of [
      "__Host-pk_req=",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
    ])
      expect(cookie).toContain(attr);
    expect(handle).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["a wrong client_id", { client_id: "other" }],
    ["no client_id", { client_id: null }],
  ])("renders invalid_client for %s and never redirects", async (_n, over) => {
    const res = await authorize(over);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("App not recognised");
  });

  it.each([
    [
      "an unlisted origin",
      { redirect_uri: "https://evil.example/auth/callback" },
    ],
    ["an unlisted path", { redirect_uri: `${APP}/other` }],
    ["a prefix", { redirect_uri: `${CB}/x` }],
    ["no redirect_uri", { redirect_uri: null }],
  ])(
    "renders redirect_uri_mismatch for %s and never redirects",
    async (_n, over) => {
      const res = await authorize(over);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("Return address not allowed");
    },
  );

  it("checks client_id and redirect_uri before anything else, even with every other parameter wrong", async () => {
    const res = await authorize({
      redirect_uri: "https://evil.example/cb",
      code_challenge_method: "plain",
      state: "x",
      response_type: "token",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each([
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["no method", { code_challenge_method: null }, "invalid_request"],
    ["no challenge", { code_challenge: null }, "invalid_request"],
    ["a short challenge", { code_challenge: "abc" }, "invalid_request"],
    ["a short state", { state: "short" }, "invalid_request"],
    ["response_type token", { response_type: "token" }, "invalid_request"],
    ["openid", { scope: "openid profile" }, "invalid_scope"],
    ["only unknown scopes", { scope: "admin" }, "invalid_scope"],
    ["a bad purpose", { purpose: "x" }, "invalid_request"],
    ["a bad license_choice", { license_choice: "x" }, "invalid_request"],
    ["a long nonce", { nonce: "n".repeat(256) }, "invalid_request"],
    ["a request_uri", { request_uri: "urn:x" }, "invalid_request"],
  ] as const)("302s %s back to the app with iss", async (_n, over, error) => {
    const res = await authorize(over);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(CB);
    expect(to.searchParams.get("error")).toBe(error);
    expect(to.searchParams.get("iss")).toBe(`${BASE}/${SLUG}/identity`);
    expect(to.searchParams.has("code")).toBe(false);
  });

  it("echoes state in an error redirect only when it is present", async () => {
    const withState = await authorize({ scope: "openid" });
    expect(
      new URL(withState.headers.get("location")!).searchParams.get("state"),
    ).toBe(STATE);
    const without = await authorize({ scope: "openid", state: null });
    expect(
      new URL(without.headers.get("location")!).searchParams.has("state"),
    ).toBe(false);
  });

  it("refuses a repeated parameter", async () => {
    const res = await route("GET", `${authorizeUrl()}&state=${"t".repeat(24)}`);
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("invalid_request");
  });

  it("carries the hints and the extensions to the card, which verify nothing", async () => {
    const { handle, binder } = await begin({
      login_hint: "Ada@Example.com",
      name_hint: "Ada",
      purpose: "attach",
      license_choice: "app",
      scope: "profile email",
    });
    const view = await handlePortalApi(
      new Request(`${BASE}/api/signin/requests/${handle}`, {
        headers: { cookie: binder },
      }),
      env,
      db,
      `/api/signin/requests/${handle}`,
      NOW,
    );
    const body = (await view.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      purpose: "attach",
      licenseChoice: "app",
      scope: ["profile", "email"],
      loginHint: "ada@example.com",
      nameHint: "Ada",
    });
    expect((body.client as { kind: string }).kind).toBe("web");
  });

  it("drops a hint that does not normalise instead of failing", async () => {
    const { handle, binder } = await begin({ login_hint: "not an email" });
    const view = await handlePortalApi(
      new Request(`${BASE}/api/signin/requests/${handle}`, {
        headers: { cookie: binder },
      }),
      env,
      db,
      `/api/signin/requests/${handle}`,
      NOW,
    );
    expect(
      ((await view.json()) as { loginHint: string | null }).loginHint,
    ).toBeNull();
  });

  it("is refused as an unknown route while Identity is off (a JSON caller), the card for a browser", async () => {
    await services({ identity: false });
    const json = await authorize();
    expect(json.status).toBe(404);
    const nav = await route("GET", authorizeUrl(), {
      headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
    });
    expect(nav.status).toBe(303);
    expect(nav.headers.get("location")).toContain("error=identity_disabled");
  });
});

describe("Continue and Cancel (§12.4)", () => {
  it("Continue answers the redirect with code, state and iss; the request is then gone", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const { res, json } = await proceed(handle, s, binder);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const to = new URL(json.redirect!);
    expect(to.origin + to.pathname).toBe(CB);
    expect(to.searchParams.get("state")).toBe(STATE);
    expect(to.searchParams.get("iss")).toBe(`${BASE}/${SLUG}/identity`);
    expect(to.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Never a token in a URL or fragment.
    expect(json.redirect).not.toMatch(/pkeyt_|access_token|#/);
    // One press, one code.
    const again = await proceed(handle, s, binder);
    expect(again.res.status).toBe(404);
  });

  it("records app consent: the claims granted, and the hash of what was asked", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    await proceed(handle, s, binder, { consent: { claims: ["profile"] } });
    const row = await db.first<{ claims_json: string; scope_hash: string }>(
      "SELECT claims_json, scope_hash FROM account_product_grants WHERE account_id = ? AND product = ?",
      s.id,
      SLUG,
    );
    expect(JSON.parse(row!.claims_json)).toEqual(["profile"]);
    expect(row!.scope_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a consent that names a claim the request did not ask for", async () => {
    const { handle, binder } = await begin({ scope: "profile" });
    const s = await signedIn();
    const { res } = await proceed(handle, s, binder, {
      consent: { claims: ["email"] },
    });
    expect(res.status).toBe(400);
  });

  it("needs the session, the CSRF header and the binder (login CSRF / R1-07)", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const path = `/api/signin/requests/${handle}/continue`;
    // No session.
    const anon = await handlePortalApi(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { cookie: binder },
      }),
      env,
      db,
      path,
      NOW,
    );
    expect(anon.status).toBe(401);
    // No CSRF header.
    expect((await card(path, s, binder, {}, null)).status).toBe(403);
    // A wrong CSRF header.
    expect((await card(path, s, binder, {}, "x".repeat(20))).status).toBe(403);
    // Another browser: no binder, or someone else's.
    expect((await card(path, s, null, {})).status).toBe(404);
    const other = await begin();
    expect((await card(path, s, other.binder, {})).status).toBe(404);
    // None of those burnt the request.
    expect((await card(path, s, binder, {})).status).toBe(200);
  });

  it("refuses a cross-site POST (Sec-Fetch-Site)", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const path = `/api/signin/requests/${handle}/continue`;
    const res = await handlePortalApi(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          cookie: `${s.cookie}; ${binder}`,
          [PORTAL_CSRF_HEADER]: s.csrf,
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
      db,
      path,
      NOW,
    );
    expect(res.status).toBe(400);
  });

  it("Cancel answers access_denied with state and iss, and takes the request", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const path = `/api/signin/requests/${handle}/cancel`;
    const res = await card(path, s, binder);
    expect(res.status).toBe(200);
    const to = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe(STATE);
    expect(to.searchParams.get("iss")).toBe(`${BASE}/${SLUG}/identity`);
    expect(to.searchParams.has("code")).toBe(false);
    expect((await card(path, s, binder)).status).toBe(404);
    expect((await proceed(handle, s, binder)).res.status).toBe(404);
  });

  it("is refused when Identity is switched off after authorize", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    await services({ identity: false });
    expect((await proceed(handle, s, binder)).res.status).toBe(404);
  });

  it("asks for the licence choice when the account holds licences, and never picks silently", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      s.id,
      SLUG,
      licenseId,
    );
    const none = await proceed(handle, s, binder);
    expect(none.res.status).toBe(409);
    expect(none.json.error).toBe("license_choice_required");
    const wrong = await proceed(handle, s, binder, {
      choice: { licenseId: "lic_nope" },
    });
    expect(wrong.res.status).toBe(409);
    // The refusals consumed nothing.
    const ok = await proceed(handle, s, binder, { choice: { licenseId } });
    expect(ok.res.status).toBe(200);
  });

  it("asks for the product's terms once per version, and records the acceptance", async () => {
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
       VALUES (?, 'identity.terms', ?, 'manifest', ?, 'test')`,
      SLUG,
      JSON.stringify({ version: "2026-01", url: "https://app.example/terms" }),
      NOW,
    );
    const { handle, binder } = await begin();
    const s = await signedIn();
    const refused = await proceed(handle, s, binder);
    expect(refused.res.status).toBe(409);
    expect(refused.json.error).toBe("terms_required");
    expect(
      (await proceed(handle, s, binder, { terms: "2025-01" })).res.status,
    ).toBe(409);
    expect(
      (await proceed(handle, s, binder, { terms: "2026-01" })).res.status,
    ).toBe(200);
    const row = await db.first<{ version: string }>(
      "SELECT version FROM account_terms_acceptances WHERE account_id = ? AND product = ?",
      s.id,
      SLUG,
    );
    expect(row?.version).toBe("2026-01");
    // A second sign-in with the version accepted asks nothing.
    const next = await begin();
    expect((await proceed(next.handle, s, next.binder)).res.status).toBe(200);
  });
});

describe("POST /<p>/identity/token (§12.5)", () => {
  it("redeems the code: exactly the listed members, a pkeyt_ device token, bound to the account", async () => {
    const { code, s } = await codeFor();
    const res = await tokenReq({ code });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "access_token",
        "device",
        "license",
        "schemaVersion",
        "scope",
        "subject",
        "token_type",
      ].sort(),
    );
    expect(body.access_token).toMatch(/^pkeyt_[A-Za-z0-9_-]{43}$/);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("profile email");
    expect(body.license).toBeNull();
    expect(body.subject).toMatch(/^ps_/);
    expect((body.device as { id: string }).id).toBe(DEVICE);
    // No expires_in, no refresh_token before I-21; the token is not also named `token`.
    expect(body).not.toHaveProperty("expires_in");
    expect(body).not.toHaveProperty("refresh_token");
    expect(body).not.toHaveProperty("token");
    const device = await db.first<{
      subject: string;
      bound_by: string;
      license_id: string;
    }>(
      "SELECT subject, bound_by, license_id FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    expect(device).toMatchObject({
      subject: body.subject,
      bound_by: "signin",
      license_id: "",
    });
    expect(s.id).toBeTruthy();
  });

  it("binds the licence the person chose, seat-checked, and answers it", async () => {
    const { handle, binder } = await begin();
    const s = await signedIn();
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      s.id,
      SLUG,
      licenseId,
    );
    const out = await proceed(handle, s, binder, { choice: { licenseId } });
    const res = await tokenReq({ code: codeOf(out.json.redirect!) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      license: { id: string };
      device: { licenseId: string };
    };
    expect(body.license.id).toBe(licenseId);
    expect(body.device.licenseId).toBe(licenseId);
  });

  it("a replayed code is invalid_grant", async () => {
    const { code } = await codeFor();
    expect((await tokenReq({ code })).status).toBe(200);
    const again = await tokenReq({ code });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("a wrong verifier is invalid_grant and ends the code (no guessing)", async () => {
    const { code } = await codeFor();
    const wrong = await tokenReq({ code, code_verifier: "w".repeat(48) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    // The right verifier no longer works.
    expect(await (await tokenReq({ code })).json()).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("another redirect_uri is invalid_grant", async () => {
    const { code } = await codeFor();
    const res = await tokenReq({ code, redirect_uri: `${APP}/auth/other` });
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("another client_id is invalid_client", async () => {
    const { code } = await codeFor();
    const res = await tokenReq({ code, client_id: "other" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
    // It never reached the code.
    expect((await tokenReq({ code })).status).toBe(200);
  });

  it("redirect_uri may be omitted (compared exactly when sent)", async () => {
    const { code } = await codeFor();
    expect((await tokenReq({ code, redirect_uri: null })).status).toBe(200);
  });

  it("a malformed device id, or none, is invalid_request and keeps the code", async () => {
    const { code } = await codeFor();
    for (const device of [null, "bad:id", "x".repeat(200)]) {
      const res = await tokenReq({ code }, { device });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    }
    expect((await tokenReq({ code })).status).toBe(200);
  });

  it("a JSON body is invalid_request", async () => {
    const { code } = await codeFor();
    const res = await route("POST", `/${SLUG}/identity/token`, {
      headers: { "content-type": "application/json", "x-pkey-device": DEVICE },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: SLUG,
        code,
        code_verifier: VERIFIER,
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a repeated parameter, a missing grant_type and any other grant", async () => {
    const { code } = await codeFor();
    const dup = await tokenReq(
      {},
      {
        body: `grant_type=authorization_code&client_id=${SLUG}&code=${code}&code=${code}&code_verifier=${VERIFIER}`,
      },
    );
    expect(await dup.json()).toMatchObject({ error: "invalid_request" });
    expect(
      await (await tokenReq({ grant_type: null, code })).json(),
    ).toMatchObject({ error: "invalid_request" });
    for (const g of [
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "password",
    ]) {
      const res = await tokenReq({ grant_type: g, code });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "unsupported_grant_type",
      });
    }
  });

  it("a code issued by another product's authorize does not redeem here", async () => {
    const { code } = await codeFor();
    // The code is addressed by product: the same string under another slug finds nothing.
    await seedProduct(db, "other");
    const res = await route("POST", `/other/identity/token`, {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-pkey-device": DEVICE,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "other",
        code,
        code_verifier: VERIFIER,
      }).toString(),
    });
    expect([400, 404]).toContain(res.status);
    expect((await tokenReq({ code })).status).toBe(200);
  });

  it("is refused for an account disabled between Continue and token", async () => {
    const { code, s } = await codeFor();
    await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", s.id);
    const res = await tokenReq({ code });
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("answers CORS for the product's web origin only, never with credentials", async () => {
    const { code } = await codeFor();
    const res = await tokenReq({ code }, { headers: { origin: APP } });
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const { code: code2 } = await codeFor();
    const other = await tokenReq(
      { code: code2 },
      { headers: { origin: "https://evil.example" }, device: DEVICE + "" },
    );
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await route("OPTIONS", `/${SLUG}/identity/token`, {
      headers: { origin: APP, "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(APP);
  });

  it("owes a licence choice when the account holds licences and none was made", async () => {
    // The code is issued while the account holds none; a licence arrives before token.
    const { code, s } = await codeFor();
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      s.id,
      SLUG,
      licenseId,
    );
    const res = await tokenReq({ code });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "license_choice_required",
    });
  });

  it("never takes over a device id that already runs on a licence", async () => {
    const { licenseId, key } = await seedLicenseWithKey(db, SLUG, {
      id: "lic_other",
    });
    const act = await route("POST", `/${SLUG}/license/activate`, {
      headers: { authorization: `Bearer ${key}`, "x-pkey-device": DEVICE },
    });
    expect(act.status).toBe(200);
    const { handle, binder } = await begin();
    const bob = await signedIn("bob@example.com");
    const out = await proceed(handle, bob, binder);
    expect(out.res.status).toBe(200);
    const res = await tokenReq({ code: codeOf(out.json.redirect!) });
    expect(res.status).toBe(409);
    expect(licenseId).toBe("lic_other");
    const device = await db.first<{ license_id: string }>(
      "SELECT license_id FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    expect(device?.license_id).toBe("lic_other");
  });

  it("keeps the licence a device runs on when it presents its own token, and answers that token", async () => {
    const { licenseId, key } = await seedLicenseWithKey(db, SLUG, {
      id: "lic_key",
    });
    const act = await route("POST", `/${SLUG}/license/activate`, {
      headers: { authorization: `Bearer ${key}`, "x-pkey-device": DEVICE },
    });
    const held = ((await act.json()) as { token: string }).token;
    const { handle, binder } = await begin();
    const bob = await signedIn("bob@example.com");
    const out = await proceed(handle, bob, binder);
    const res = await tokenReq(
      { code: codeOf(out.json.redirect!) },
      { headers: { authorization: `Bearer ${held}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      license: { id: string };
      subject: string;
    };
    expect(body.access_token).toBe(held);
    expect(body.license.id).toBe(licenseId);
    const device = await db.first<{
      subject: string;
      license_id: string;
      bound_by: string;
    }>(
      "SELECT subject, license_id, bound_by FROM devices WHERE product = ? AND device_id = ?",
      SLUG,
      DEVICE,
    );
    // The binding is written; the licence and how the device was bound are untouched.
    expect(device).toEqual({
      subject: body.subject,
      license_id: licenseId,
      bound_by: "key",
    });
  });

  it("a token that is not the device's own proves nothing", async () => {
    const { key } = await seedLicenseWithKey(db, SLUG, { id: "lic_key" });
    await route("POST", `/${SLUG}/license/activate`, {
      headers: { authorization: `Bearer ${key}`, "x-pkey-device": DEVICE },
    });
    const { handle, binder } = await begin();
    const bob = await signedIn("bob@example.com");
    const out = await proceed(handle, bob, binder);
    const res = await tokenReq(
      { code: codeOf(out.json.redirect!) },
      { headers: { authorization: `Bearer pkeyt_${"Z".repeat(43)}` } },
    );
    expect(res.status).toBe(409);
  });

  it("rate-limits per device id and answers a flat 429", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 12; i++)
      last = await tokenReq({ code: "c".repeat(43) });
    expect(last!.status).toBe(429);
    expect(await last!.json()).toMatchObject({
      error: "rate_limited",
      retryAfter: 60,
    });
  });

  it("does not exist while Identity is off", async () => {
    const { code } = await codeFor();
    await services({ identity: false });
    const res = await tokenReq({ code });
    expect(res.status).toBe(404);
  });
});
