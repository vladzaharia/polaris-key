import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type KeyLike,
  SignJWT,
} from "jose";
import type { ManagedPayload } from "../src/core/payload.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedProductSecret } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  applyProvisioning,
  authorizeAndMint,
  activateFromIdentity,
  deviceFlowKey,
  deviceUserKey,
  flowKey,
  handleAuthCallback,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthPoll,
  handleAuthStart,
  normalizeUserCode,
  USER_CODE_ALPHABET,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import { getLicense, getLicenseBySub } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { artefacts, singleUseMock } from "./singleUseMock.js";

// Holder for the IdP public key the mocked `createRemoteJWKSet` should resolve to. jose's
// remote JWKS fetch bypasses globalThis.fetch (uses its own client), so we swap ONLY the
// JWKS getter while keeping the REAL `jwtVerify` (so iss/aud/sig/nonce checks are genuine).
const idpKey = vi.hoisted(() => ({
  getKey: null as null | (() => Promise<unknown>),
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => {
      if (!idpKey.getKey) throw new Error("no test IdP key installed");
      return idpKey.getKey();
    },
  };
});

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["members"],
  claims: { sub: "user-123", vpnSub: "abc123" },
  ...over,
});

async function seedOidc(db: SqliteDb): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
    JSON.stringify({
      members: { role: "user", tier: "pro" },
      admin: { role: "admin" },
    }),
  );
  await db.run(
    "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
    "djdl",
    "pro",
    "Pro",
    null,
    365,
    5,
    null,
    NOW,
  );
  await db.run(
    "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "vpnSub",
    "polarisVpn",
    JSON.stringify(true),
    "proxy.subscriptionUrl",
    "https://vpn.example.com/{claim}",
    JSON.stringify(["vpn.example.com"]),
  );
}

const emptyPayload = (): ManagedPayload => ({
  config: {},
  secrets: {},
  entitlements: {},
});

describe("activateFromIdentity", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("is idempotent on the OIDC subject", async () => {
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    const r2 = await activateFromIdentity(
      db,
      product,
      identity({ name: "Changed Name" }),
      NOW + 100,
    );
    expect(r2).toEqual(r1);
    // Only one license row exists for the sub.
    expect(await getLicenseBySub(db, "djdl", "user-123")).not.toBeNull();
  });

  it("denies an identity whose groups grant nothing", async () => {
    const r = await activateFromIdentity(
      db,
      product,
      identity({ sub: "x", groups: ["randos"] }),
      NOW,
    );
    expect(r).toEqual({ error: "not-entitled" });
  });

  it("selects the tier from the first matching group + stamps expiry", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBe("pro");
    expect(lic?.expires_at).toBe(NOW + 365 * 86400);
  });

  it("leaves expiry null when the matched group has no tier", async () => {
    const r = await activateFromIdentity(
      db,
      product,
      identity({ sub: "adminuser", groups: ["admin"] }),
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBeNull();
    expect(lic?.expires_at).toBeNull();
  });

  it("bakes provisioning overrides into the new license", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    const ov = JSON.parse(lic!.overrides_json!) as ManagedPayload;
    expect(ov.entitlements.polarisVpn?.value).toBe(true);
    expect(ov.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.example.com/abc123",
    );
  });
});

describe("applyProvisioning", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedOidc(db);
  });

  it("fires only when the claim is present and truthy", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x" } }),
      p,
      NOW,
    ); // no vpnSub
    expect(p.entitlements.polarisVpn).toBeUndefined();
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("skips a claim that is explicitly false", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x", vpnSub: false } }),
      p,
      NOW,
    );
    expect(p.entitlements.polarisVpn).toBeUndefined();
  });

  it("drops a templated secret whose host is NOT in the allowlist", async () => {
    // Point the template host off the allowlist.
    await db.run(
      "UPDATE provisioning_config SET secret_url_template = ? WHERE product = 'djdl' AND claim = 'vpnSub'",
      "https://evil.example/{claim}",
    );
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity(), p, NOW);
    // The entitlement still applies, but the disallowed secret is dropped.
    expect(p.entitlements.polarisVpn?.value).toBe(true);
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("URL-encodes the claim value into the secret URL", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x", vpnSub: "a/b c" } }),
      p,
      NOW,
    );
    expect(p.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.example.com/a%2Fb%20c",
    );
    expect(p.secrets["proxy.subscriptionUrl"]?.state).toBe("hidden");
  });
});

describe("handleAuthPoll states", () => {
  let db: SqliteDb;
  let env: Env;
  let kv: KvMock;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  const poll = (state: string, device = "dev-1") =>
    handleAuthPoll(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/poll?state=${state}&device=${device}`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  /** A flow record shaped the way beginAuthFlow + device confirmation write it: bound to the
   *  device that started it and stamped confirmed. Both are authorization inputs on the poll
   *  surfaces (R8-01), so a fixture without them is not a pollable flow. */
  async function putFlow(
    state: string,
    flow: Record<string, unknown>,
  ): Promise<void> {
    await artefacts(env).put(
      await flowKey(env, "djdl", state),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: "r",
        deviceId: "dev-1",
        confirmedAt: NOW,
        ...flow,
      }),
    );
  }

  it("returns timeout when the flow record is gone", async () => {
    const res = await poll("missing");
    expect(((await res.json()) as { status: string }).status).toBe("timeout");
  });

  it("requires state + device query params", async () => {
    const res = await handleAuthPoll(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/poll?state=x",
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(400);
  });

  it("returns pending while the flow has neither error nor licenseId", async () => {
    await putFlow("s1", {});
    expect(
      ((await (await poll("s1")).json()) as { status: string }).status,
    ).toBe("pending");
  });

  it("returns a generic error with NO IdP reason (no failure enumeration)", async () => {
    // Even if a flow somehow carries an error reason, the poll surface must not echo it.
    await putFlow("s2", { error: "id-token-invalid" });
    const res = await poll("s2");
    const body = (await res.clone().json()) as {
      status: string;
      reason?: string;
    };
    expect(body.status).toBe("error");
    expect(body.reason).toBeUndefined();
    // The raw response body must not leak any IdP failure string either.
    expect(await res.text()).not.toContain("id-token-invalid");
  });

  it("returns ready with a token once the license is set, then consumes the flow", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow("s3", { licenseId: r.licenseId });
    const body = (await (await poll("s3")).json()) as {
      status: string;
      token: string;
    };
    expect(body.status).toBe("ready");
    expect(body.token.startsWith("pkeyt_")).toBe(true);
    // The flow record is deleted after a ready poll → a second poll times out.
    expect(
      ((await (await poll("s3")).json()) as { status: string }).status,
    ).toBe("timeout");
  });

  it("starts a JSON device flow with a poll handle", async () => {
    const res = await handleAuthDeviceStart(
      new Request("https://key.plrs.im/djdl/identity/auth/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev-json" }),
      }) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      pollUrl: string;
      expiresIn: number;
      interval: number;
    };
    expect(body.deviceCode).toBeTruthy();
    // Still the XXXX-XXXX shape older callers match, now drawn from RFC 8628 §6.1's alphabet.
    expect(body.userCode).toMatch(/^[A-Z0-9_-]{4}-[A-Z0-9_-]{4}$/);
    expect(body.userCode).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    // The human-facing URL is the code-entry page; it no longer carries the device code.
    expect(body.verificationUri).toBe(
      "https://key.plrs.im/djdl/identity/auth/device",
    );
    expect(body.pollUrl).toBe(
      "https://key.plrs.im/djdl/identity/auth/device/poll",
    );
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBeGreaterThan(0);
    expect(
      await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ),
    ).toBeTruthy();
  });

  it("polls a JSON device flow and mints through the shared authorizer", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow("oauth-state", {
      licenseId: r.licenseId,
      deviceId: "dev-json",
    });
    await artefacts(env).put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({
        state: "oauth-state",
        deviceId: "dev-json",
        userCode: "ABCD-EFGH",
        authorizeUrl: "https://id.example/authorize",
        confirmedAt: NOW,
      }),
    );
    const res = await handleAuthDevicePoll(
      new Request("https://key.plrs.im/djdl/identity/auth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: "device-code",
          deviceId: "dev-json",
        }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    const body = (await res.json()) as { status: string; token: string };
    expect(body.status).toBe("ready");
    expect(body.token.startsWith("pkeyt_")).toBe(true);
  });

  it("renders and confirms the JSON device verification page", async () => {
    await putFlow("oauth-state", { deviceId: "dev-json" });
    await artefacts(env).put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({
        state: "oauth-state",
        deviceId: "dev-json",
        userCode: "ABCD-EFGH",
        authorizeUrl: "https://id.example/authorize",
        deviceName: "Studio Mac",
      }),
    );
    const page = await handleAuthDeviceVerify(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/device/verify?device_code=device-code",
      ) as unknown as Request,
      env,
      product,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Studio Mac");
    // The GET renders only; confirmation is a POST carrying the token minted here (R8-02).
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;

    const confirm = await handleAuthDeviceVerify(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/device/verify?device_code=device-code",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://key.plrs.im",
          },
          body: new URLSearchParams({ csrf }).toString(),
        },
      ) as unknown as Request,
      env,
      product,
    );
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("location")).toBe(
      "https://id.example/authorize",
    );
    const stored = JSON.parse(
      (await artefacts(env).get(
        await deviceFlowKey(env, "djdl", "device-code"),
      ))!,
    ) as { confirmedAt?: number };
    expect(stored.confirmedAt).toBeTruthy();
    // …and the confirmation is recorded on the flow the poll surfaces actually read.
    const flow = JSON.parse(
      (await artefacts(env).get(await flowKey(env, "djdl", "oauth-state")))!,
    ) as {
      confirmedAt?: number;
    };
    expect(flow.confirmedAt).toBeTruthy();
  });

  it("rejects JSON device polls from a different device id", async () => {
    await putFlow("oauth-state", {});
    await artefacts(env).put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({ state: "oauth-state", deviceId: "dev-json" }),
    );
    const res = await handleAuthDevicePoll(
      new Request("https://key.plrs.im/djdl/identity/auth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: "device-code",
          deviceId: "other-device",
        }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });
});

// ── RFC 8628 user-code page: GET/POST /<p>/identity/auth/device (P1-06) ──────────
describe("the RFC 8628 user-code page", () => {
  let db: SqliteDb;
  let env: Env;
  let kv: KvMock;
  let product: Product;

  const ORIGIN = "https://key.plrs.im";
  const ENTRY = `${ORIGIN}/djdl/identity/auth/device`;
  const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  interface StartBody {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }

  async function start(deviceName?: string): Promise<StartBody> {
    const res = await handleAuthDeviceStart(
      new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "steamdeck-1", deviceName }),
      }) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as StartBody;
  }

  const entry = (
    url: string,
    init?: RequestInit & { ip?: string },
  ): Promise<Response> =>
    handleAuthDeviceEntry(
      new Request(url, {
        ...init,
        headers: {
          "cf-connecting-ip": init?.ip ?? "203.0.113.7",
          ...(init?.headers as Record<string, string> | undefined),
        },
      }) as unknown as Request,
      env,
      product,
    );

  const postForm = (
    fields: Record<string, string>,
    origin: string | null = ORIGIN,
  ): Promise<Response> =>
    entry(ENTRY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin ? { origin } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });

  /** A form POST with exactly these headers (no default Origin): the header shapes a browser
   *  actually sends, rather than the `origin: ORIGIN` shorthand `postForm` uses. */
  const postWith = (
    fields: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<Response> =>
    entry(ENTRY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });

  const csrfOf = (html: string): string =>
    html.match(/name="csrf" value="([^"]+)"/)![1]!;

  const expectStaticHtmlHeaders = (res: Response): void => {
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  const poll = (deviceCode: string, now: number) =>
    handleAuthDevicePoll(
      new Request(`${ORIGIN}/djdl/identity/auth/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode, deviceId: "steamdeck-1" }),
      }) as unknown as Request,
      env,
      db,
      product,
      now,
    );

  it("normalises what a human types, and refuses anything outside the alphabet", () => {
    expect(USER_CODE_ALPHABET).toBe("BCDFGHJKLMNPQRSTVWXZ");
    expect(normalizeUserCode("wdjb-mjht")).toBe("WDJBMJHT");
    expect(normalizeUserCode(" wdjb mjht ")).toBe("WDJBMJHT");
    expect(normalizeUserCode("WD-JB-MJ-HT")).toBe("WDJBMJHT");
    expect(normalizeUserCode("ZK8L-QR8N")).toBeNull(); // digits are not in the alphabet
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull(); // nor are vowels
    expect(normalizeUserCode("WDJB-MJH")).toBeNull(); // too short
    expect(normalizeUserCode("WDJB-MJHTB")).toBeNull(); // too long
    expect(normalizeUserCode("")).toBeNull();
    expect(normalizeUserCode(null)).toBeNull();
  });

  it("issues an independent user code and two URLs that never carry the device code", async () => {
    const body = await start();
    expect(body.userCode).toMatch(USER_CODE_RE);
    // Not derived from the device code: the old construction was its first 8 chars, folded.
    const head = body.deviceCode.slice(0, 8).toUpperCase();
    expect(body.userCode).not.toBe(`${head.slice(0, 4)}-${head.slice(4, 8)}`);
    expect(body.verificationUri).toBe(ENTRY);
    expect(body.verificationUriComplete).toBe(
      `${ENTRY}?user_code=${body.userCode}`,
    );
    expect(body.verificationUri).not.toBe(body.verificationUriComplete);
    for (const uri of [body.verificationUri, body.verificationUriComplete]) {
      expect(uri).not.toContain(body.deviceCode);
      expect(uri).not.toContain(encodeURIComponent(body.deviceCode));
    }
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(2);

    // The index maps the peppered hash of the NORMALISED code to the device code, for the
    // flow's lifetime.
    const normalised = body.userCode.replace("-", "");
    const indexKey = await deviceUserKey(env, "djdl", normalised);
    expect(await artefacts(env).get(indexKey)).toBe(body.deviceCode);
    expect(singleUseMock(env).ttlOf(indexKey)).toBe(600);
    // R12-04: no stored key NAME carries the user code (in either spelling) or the device code.
    for (const key of [...kv.keys(), ...singleUseMock(env).keys()]) {
      expect(key).not.toContain(normalised);
      expect(key).not.toContain(body.userCode);
      expect(key).not.toContain(body.deviceCode);
    }
  });

  it("draws a different code for every flow", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await start()).userCode);
    expect(codes.size).toBe(20);
  });

  it("GET with no code renders the entry form: static-HTML CSP, no-store, no-referrer, no script", async () => {
    const res = await entry(ENTRY);
    expect(res.status).toBe(200);
    expectStaticHtmlHeaders(res);
    // The entry form posts only to this origin: `form-action` is exactly `'self'`.
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self';",
    );
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`<form method="post" action="${ENTRY}">`);
    expect(html).toContain('name="user_code"');
    expect(html).not.toContain('name="csrf"');
    expect(html).not.toContain('role="alert"');
  });

  it("GET ?user_code= (lower-case, space) renders the confirmation page for the right flow, without the device code", async () => {
    await start("Other device"); // a second live flow the lookup must not land on
    const body = await start("Steam Deck");
    const typed = body.userCode.toLowerCase().replace("-", " ");
    const res = await entry(`${ENTRY}?user_code=${encodeURIComponent(typed)}`);
    expect(res.status).toBe(200);
    expectStaticHtmlHeaders(res);
    // The confirmation POST 303s to the IdP, and browsers apply `form-action` to that
    // redirect: the page allows exactly that one extra origin.
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://id.example;",
    );
    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(body.userCode);
    expect(html).toContain("Steam Deck");
    expect(html).not.toContain("Other device");
    expect(html).not.toContain(body.deviceCode);
    expect(html).not.toContain("device_code");
    // The form posts the user code back to this route, never the device code.
    expect(html).toContain(`<form method="post" action="${ENTRY}">`);
    expect(html).toContain(
      `<input type="hidden" name="user_code" value="${body.userCode}">`,
    );
    const stored = JSON.parse(
      (await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ))!,
    ) as { csrf?: string; confirmedAt?: number };
    expect(stored.csrf).toBe(csrfOf(html));
    // Rendering is side-effect free as far as the flow is concerned.
    expect(stored.confirmedAt).toBeUndefined();
  });

  it("POST from the entry form (a code, no csrf field) renders the confirmation page", async () => {
    const body = await start("Steam Deck");
    const res = await postForm({ user_code: body.userCode.toLowerCase() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Steam Deck");
    expect(html).toContain('name="csrf"');
    expect(html).not.toContain(body.deviceCode);
  });

  it("POST with the page's csrf confirms (303 to the IdP) and the flow then completes on poll", async () => {
    const body = await start("Steam Deck");
    const page = await entry(`${ENTRY}?user_code=${body.userCode}`);
    const csrf = csrfOf(await page.text());

    const confirm = await postForm({ user_code: body.userCode, csrf });
    expect(confirm.status).toBe(303);
    const location = new URL(confirm.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://id.example/authorize",
    );
    expect(confirm.headers.get("referrer-policy")).toBe("no-referrer");
    expect(confirm.headers.get("cache-control")).toBe("no-store");

    // confirmedAt is stamped on BOTH records — the flow the pollers read, and the device one.
    const state = location.searchParams.get("state")!;
    const flow = JSON.parse(
      (await artefacts(env).get(await flowKey(env, "djdl", state)))!,
    ) as {
      confirmedAt?: number;
      deviceId?: string;
    };
    expect(flow.confirmedAt).toBeTruthy();
    expect(flow.deviceId).toBe("steamdeck-1");
    const device = JSON.parse(
      (await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ))!,
    ) as { confirmedAt?: number; csrf?: string };
    expect(device.confirmedAt).toBeTruthy();
    expect(device.csrf).toBeUndefined(); // single-use

    // Confirmation retires the user code at once: it no longer resolves, so nobody else who
    // learns it can re-render the page, re-mint the csrf or read the authorize URL.
    const indexKey = await deviceUserKey(
      env,
      "djdl",
      body.userCode.replace("-", ""),
    );
    expect(await artefacts(env).get(indexKey)).toBeNull();
    expect((await entry(`${ENTRY}?user_code=${body.userCode}`)).status).toBe(
      404,
    );

    // Confirmed but the IdP has not called back yet: the poll waits on the IdP.
    expect(
      ((await (await poll(body.deviceCode, NOW)).json()) as { status: string })
        .status,
    ).toBe("pending");
    // The IdP callback lands and binds a licence to the flow (what handleAuthCallback writes).
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await artefacts(env).put(
      await flowKey(env, "djdl", state),
      JSON.stringify({ ...flow, licenseId: r.licenseId }),
    );
    const ready = (await (await poll(body.deviceCode, NOW + 5)).json()) as {
      status: string;
      token?: string;
    };
    expect(ready.status).toBe("ready");
    expect(ready.token?.startsWith("pkeyt_")).toBe(true);

    // Ready deletes the flow; the user-code index stays gone.
    expect(await artefacts(env).get(indexKey)).toBeNull();
    expect(
      await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ),
    ).toBeNull();
    expect((await entry(`${ENTRY}?user_code=${body.userCode}`)).status).toBe(
      404,
    );
  });

  it("refuses a confirmation POST with no csrf, a reused csrf, or a foreign Origin (403)", async () => {
    const body = await start();
    const csrf = csrfOf(
      await (await entry(`${ENTRY}?user_code=${body.userCode}`)).text(),
    );

    // No csrf: the confirmation form's field is present but empty.
    expect(
      (await postForm({ user_code: body.userCode, csrf: "" })).status,
    ).toBe(403);
    // A token that is not the one the page minted.
    expect(
      (await postForm({ user_code: body.userCode, csrf: "forged" })).status,
    ).toBe(403);
    // A foreign Origin, even carrying the real token…
    expect(
      (
        await postForm(
          { user_code: body.userCode, csrf },
          "https://evil.attacker.test",
        )
      ).status,
    ).toBe(403);
    // …and a foreign Origin cannot even drive the lookup-and-render half.
    expect(
      (
        await postForm(
          { user_code: body.userCode },
          "https://evil.attacker.test",
        )
      ).status,
    ).toBe(403);
    // None of that confirmed anything.
    const before = JSON.parse(
      (await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ))!,
    ) as { confirmedAt?: number };
    expect(before.confirmedAt).toBeUndefined();

    // The real token works once…
    expect((await postForm({ user_code: body.userCode, csrf })).status).toBe(
      303,
    );
    // …and a replay of it is refused.
    expect((await postForm({ user_code: body.userCode, csrf })).status).toBe(
      403,
    );
  });

  it("accepts the POSTs a real browser sends from these no-referrer pages (Origin: null, Sec-Fetch-Site: same-origin)", async () => {
    // Both pages are served with `referrer-policy: no-referrer`; under that policy the Fetch
    // standard serialises a same-origin form POST's Origin as the string "null".
    const browser = { origin: "null", "sec-fetch-site": "same-origin" };
    const body = await start("Steam Deck");

    // Typing the code into the entry form: the lookup POST renders the confirmation page.
    const looked = await postWith({ user_code: body.userCode }, browser);
    expect(looked.status).toBe(200);
    const csrf = csrfOf(await looked.text());

    // Pressing "Continue to sign in": the confirmation POST 303s to the IdP.
    const confirm = await postWith({ user_code: body.userCode, csrf }, browser);
    expect(confirm.status).toBe(303);
    expect(new URL(confirm.headers.get("location")!).origin).toBe(
      "https://id.example",
    );

    // The same header shape on the legacy `/device/verify` page, which shares the check.
    const other = await start();
    const verifyUrl = `${ORIGIN}/djdl/identity/auth/device/verify?device_code=${encodeURIComponent(other.deviceCode)}`;
    const verifyPage = await handleAuthDeviceVerify(
      new Request(verifyUrl) as unknown as Request,
      env,
      product,
    );
    const verifyCsrf = csrfOf(await verifyPage.text());
    const verified = await handleAuthDeviceVerify(
      new Request(verifyUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.8",
          ...browser,
        },
        body: new URLSearchParams({ csrf: verifyCsrf }).toString(),
      }) as unknown as Request,
      env,
      product,
    );
    expect(verified.status).toBe(303);
  });

  it("refuses a cross-site POST by Fetch Metadata, even with the real csrf and this Origin", async () => {
    const body = await start();
    const csrf = csrfOf(
      await (await entry(`${ENTRY}?user_code=${body.userCode}`)).text(),
    );
    for (const site of ["cross-site", "same-site", "none"]) {
      for (const origin of [ORIGIN, "null"]) {
        expect(
          (
            await postWith(
              { user_code: body.userCode, csrf },
              { origin, "sec-fetch-site": site },
            )
          ).status,
          `sec-fetch-site ${site}, origin ${origin}`,
        ).toBe(403);
      }
      expect(
        (
          await postWith(
            { user_code: body.userCode },
            { origin: ORIGIN, "sec-fetch-site": site },
          )
        ).status,
      ).toBe(403);
    }
    // Nothing was confirmed, and the token is still good for the real page.
    expect(
      (
        await postWith(
          { user_code: body.userCode, csrf },
          { origin: "null", "sec-fetch-site": "same-origin" },
        )
      ).status,
    ).toBe(303);
  });

  it("without Fetch Metadata, refuses a foreign Origin and leaves an absent or null Origin to the csrf check", async () => {
    const body = await start();
    const csrf = csrfOf(
      await (await entry(`${ENTRY}?user_code=${body.userCode}`)).text(),
    );
    expect(
      (
        await postWith(
          { user_code: body.userCode, csrf },
          { origin: "https://evil.attacker.test" },
        )
      ).status,
    ).toBe(403);
    // A null Origin passes the header check but not the csrf check…
    expect(
      (
        await postWith(
          { user_code: body.userCode, csrf: "forged" },
          { origin: "null" },
        )
      ).status,
    ).toBe(403);
    // …and with the real token it confirms, as does a request with no Origin at all.
    expect(
      (await postWith({ user_code: body.userCode, csrf }, { origin: "null" }))
        .status,
    ).toBe(303);
    const other = await start();
    const otherCsrf = csrfOf(
      await (await postWith({ user_code: other.userCode }, {})).text(),
    );
    expect(
      (await postWith({ user_code: other.userCode, csrf: otherCsrf }, {}))
        .status,
    ).toBe(303);
  });

  it("labels a device that sent no deviceName generically, never with its device id", async () => {
    const body = await start();
    const html = await (
      await entry(`${ENTRY}?user_code=${body.userCode}`)
    ).text();
    expect(html).toContain("Unnamed device");
    expect(html).not.toContain("steamdeck-1");
  });

  it("answers an unknown, malformed or expired code with the one generic 404 page", async () => {
    const body = await start();
    const unknown = await entry(`${ENTRY}?user_code=BCDF-GHJK`);
    const malformed = await entry(`${ENTRY}?user_code=ZK8L-QR8N`);
    // Expired: the index outlived the flow record (or vice versa) — still just "not valid".
    await artefacts(env).delete(
      await deviceFlowKey(env, "djdl", body.deviceCode),
    );
    const expired = await entry(`${ENTRY}?user_code=${body.userCode}`);
    const posted = await postForm({ user_code: "BCDF-GHJK" });

    const pages: string[] = [];
    for (const res of [unknown, malformed, expired, posted]) {
      expect(res.status).toBe(404);
      expectStaticHtmlHeaders(res);
      const html = await res.text();
      expect(html).toContain("That code isn't valid or has expired.");
      expect(html).not.toMatch(/<script/i);
      pages.push(html);
    }
    // One message, whatever the reason: the page never says WHICH.
    expect(new Set(pages).size).toBe(1);
    // A confirmation for a code that has gone away is a refused confirmation, not a page.
    expect((await postForm({ user_code: "BCDF-GHJK", csrf: "x" })).status).toBe(
      403,
    );
  });

  it("rate-limits the page per IP (429), independently for each IP", async () => {
    let first429 = -1;
    for (let i = 0; i < 40 && first429 < 0; i++) {
      const res = await entry(`${ENTRY}?user_code=BCDF-GHJK`, {
        ip: "198.51.100.9",
      });
      if (res.status === 429) first429 = i;
    }
    expect(first429).toBe(30);
    // A different client is unaffected: there is no product-wide bucket to exhaust.
    expect((await entry(ENTRY, { ip: "198.51.100.10" })).status).toBe(200);
  });

  it("rate-limits an IPv6 client per /64, so rotating addresses inside it buys nothing", async () => {
    // R10-04b: a host routed a /64 holds 2^64 addresses. Every one of them draws on one budget.
    for (let i = 0; i < 30; i++) {
      const res = await entry(`${ENTRY}?user_code=BCDF-GHJK`, {
        ip: `2001:db8:77:1:${i.toString(16)}::1`,
      });
      expect(res.status).toBe(404);
    }
    expect(
      (await entry(ENTRY, { ip: "2001:db8:77:1:ffff:ffff:ffff:fffe" })).status,
    ).toBe(429);
    // The next /64 over is someone else.
    expect((await entry(ENTRY, { ip: "2001:db8:77:2::1" })).status).toBe(200);
  });

  it("treats a JSON body that is not an object as an empty form, never a crash", async () => {
    for (const raw of ["1", '"x"', "true", "null", "[]"]) {
      const res = await entry(ENTRY, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: raw,
      });
      // No user_code and no csrf field: the entry form, as for an empty POST.
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="user_code"');
    }
    // A JSON object still works, and a csrf field in it still means "confirm".
    const body = await start();
    const res = await entry(ENTRY, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ user_code: body.userCode, csrf: "forged" }),
    });
    expect(res.status).toBe(403);
  });

  it("fails CLOSED when the limiter is unavailable", async () => {
    env.RL = {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({
        fetch: async () => {
          throw new Error("Durable Object reset because its code was updated");
        },
      }),
    } as unknown as DurableObjectNamespace;
    expect((await entry(ENTRY)).status).toBe(429);
  });

  it("deletes the index when the poll reports a timeout", async () => {
    const body = await start();
    const page = await entry(`${ENTRY}?user_code=${body.userCode}`);
    const csrf = csrfOf(await page.text());
    const confirm = await postForm({ user_code: body.userCode, csrf });
    const state = new URL(confirm.headers.get("location")!).searchParams.get(
      "state",
    )!;
    // The OIDC flow record expires first (it is what a timeout means to the poller).
    await artefacts(env).delete(await flowKey(env, "djdl", state));
    expect(
      ((await (await poll(body.deviceCode, NOW)).json()) as { status: string })
        .status,
    ).toBe("timeout");
    expect(
      await artefacts(env).get(
        await deviceUserKey(env, "djdl", body.userCode.replace("-", "")),
      ),
    ).toBeNull();
    expect(
      await artefacts(env).get(
        await deviceFlowKey(env, "djdl", body.deviceCode),
      ),
    ).toBeNull();
  });

  it("still completes a flow started before the user code existed (prefix-style code, no index)", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await artefacts(env).put(
      await flowKey(env, "djdl", "legacy-state"),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: "r",
        deviceId: "steamdeck-1",
        confirmedAt: NOW,
        licenseId: r.licenseId,
      }),
    );
    await artefacts(env).put(
      await deviceFlowKey(env, "djdl", "legacy-code"),
      JSON.stringify({
        state: "legacy-state",
        deviceId: "steamdeck-1",
        userCode: "ZK8L-QR8N",
        authorizeUrl: "https://id.example/authorize",
        confirmedAt: NOW,
      }),
    );
    const res = (await (await poll("legacy-code", NOW)).json()) as {
      status: string;
    };
    expect(res.status).toBe("ready");
  });

  it("answers anything but GET and POST with 405", async () => {
    expect((await entry(ENTRY, { method: "PUT" })).status).toBe(405);
  });
});

describe("authorizeAndMint", () => {
  it("authorizes the device and writes a usable token record", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const token = await authorizeAndMint(
      env,
      db,
      product,
      r.licenseId,
      "dev-oidc",
      NOW,
    );
    expect(token.startsWith("pkeyt_")).toBe(true);
    // The KV token record is product-scoped.
    expect(kv.keys().some((k) => k.startsWith("p:djdl:token:"))).toBe(true);
  });
});

// ── D7: redirect-URI allowlist ────────────────────────────────────────────────
describe("handleAuthStart redirect-URI allowlist (D7)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db); // allowlists https://key.plrs.im/djdl/identity/auth/callback
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("starts the flow when the computed redirect URI is allow-listed", async () => {
    const req = new Request(
      "https://key.plrs.im/djdl/identity/auth/start",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(302);
  });

  it("returns 400 when the computed redirect URI is NOT allow-listed", async () => {
    // A request arriving at a different origin computes an off-allowlist redirect URI.
    const req = new Request(
      "https://evil.example/djdl/identity/auth/start",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin browser return_to redirects", async () => {
    const req = new Request(
      "https://key.plrs.im/djdl/auth/login?return_to=https%3A%2F%2Fapp.example%2Fdone",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(400);
  });
});

describe("handleAuthStart platform OIDC provider", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO oidc_config
         (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "platform",
      null,
      null,
      null,
      JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
      JSON.stringify({ members: { role: "user", tier: "pro" } }),
    );
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("uses PLATFORM_OIDC issuer/client for product auth start", async () => {
    env.PLATFORM_OIDC_ISSUER = "https://platform-id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    const res = await handleAuthStart(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/start",
      ) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://platform-id.example");
    expect(location.searchParams.get("client_id")).toBe("platform-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://key.plrs.im/djdl/identity/auth/callback",
    );
  });

  it("fails clearly when platform OIDC env is missing", async () => {
    const res = await handleAuthStart(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/start",
      ) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("platform oidc is not configured");
  });
});

// ── D9 + D8: full callback with a signed ID token (nonce + failure enumeration) ──
describe("handleAuthCallback ID-token verification (D9/D8)", () => {
  let db: SqliteDb;
  let env: Env;
  let kv: KvMock;
  let product: Product;
  let priv: KeyLike;

  const ISSUER = "https://id.example";
  const AUD = "client-djdl";
  const REDIRECT = "https://key.plrs.im/djdl/identity/auth/callback";

  /** Route globalThis.fetch: the token endpoint returns our signed id_token. (JWKS is
   *  resolved by the mocked `createRemoteJWKSet`, not via fetch.) */
  function installFetchMock(idToken: string): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );
  }

  async function signIdToken(claims: Record<string, unknown>): Promise<string> {
    // jose validates exp/iat against the REAL wall clock; use it so only nonce/iss/aud
    // (the properties under test) decide acceptance.
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(priv);
  }

  /** Seed a flow record the way handleAuthDeviceStart + confirmation would: known nonce and
   *  redirect URI, bound to `dev-1` and confirmed, so `poll()` below can complete it. */
  async function seedFlow(state: string, nonce: string): Promise<void> {
    await artefacts(env).put(
      await flowKey(env, "djdl", state),
      JSON.stringify({
        verifier: "v",
        nonce,
        redirectUri: REDIRECT,
        deviceId: "dev-1",
        confirmedAt: NOW,
      }),
    );
  }

  const callback = (state: string, code = "auth-code") =>
    handleAuthCallback(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/callback?code=${code}&state=${state}`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  const poll = (state: string) =>
    handleAuthPoll(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/poll?state=${state}&device=dev-1`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
    const pair = await generateKeyPair("ES256", { extractable: true });
    priv = pair.privateKey;
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "ES256",
      kid: "test-idp",
      use: "sig",
    };
    const pub = await importJWK(jwk, "ES256");
    idpKey.getKey = async () => pub;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    idpKey.getKey = null;
  });

  it("rejects an ID token with NO nonce claim (D9)", async () => {
    await seedFlow("n1", "the-nonce");
    installFetchMock(
      await signIdToken({ sub: "user-123", groups: ["members"] }),
    ); // no nonce
    const res = await callback("n1");
    expect(res.status).toBe(401);
    // Failure deletes the flow → poll cannot enumerate a reason (D8).
    const body = (await poll("n1").then((r) => r.json())) as {
      status: string;
      reason?: string;
    };
    expect(body.status).toBe("timeout");
    expect(body.reason).toBeUndefined();
  });

  it("rejects an ID token whose nonce does NOT match the flow (D9)", async () => {
    await seedFlow("n2", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "user-123",
        groups: ["members"],
        nonce: "WRONG",
      }),
    );
    const res = await callback("n2");
    expect(res.status).toBe(401);
  });

  it("accepts a matching nonce and mints a license (control)", async () => {
    await seedFlow("n3", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "user-123",
        groups: ["members"],
        nonce: "the-nonce",
      }),
    );
    const res = await callback("n3");
    expect(res.status).toBe(200);
    const body = (await poll("n3").then((r) => r.json())) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("uses platform OIDC env during callback and still mints a product license", async () => {
    await db.run(
      `UPDATE oidc_config
          SET provider = ?, issuer = NULL, client_id = NULL, client_secret_secret = NULL
        WHERE product = ?`,
      "platform",
      "djdl",
    );
    env.PLATFORM_OIDC_ISSUER = ISSUER;
    env.PLATFORM_OIDC_CLIENT_ID = AUD;
    await seedFlow("n-platform", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "platform-user",
        groups: ["members"],
        nonce: "the-nonce",
      }),
    );
    const res = await callback("n-platform");
    expect(res.status).toBe(200);
    const lic = await getLicenseBySub(db, "djdl", "platform-user");
    expect(lic?.product).toBe("djdl");
  });

  it("does NOT leak a failure reason via poll after a failed callback (D8)", async () => {
    // An entitled-nothing identity: activation fails, the flow must be deleted (no reason).
    await seedFlow("n4", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "nobody",
        groups: ["randos"],
        nonce: "the-nonce",
      }),
    );
    const cb = await callback("n4");
    expect(cb.status).toBe(403);
    const res = await poll("n4");
    const body = (await res.clone().json()) as {
      status: string;
      reason?: string;
    };
    // Flow gone ⇒ generic timeout; crucially, no "not-entitled"/IdP reason is exposed.
    expect(body.reason).toBeUndefined();
    expect(await res.text()).not.toContain("not-entitled");
  });

  // ── P4 regression: confidential-client fail-closed ──────────────────────────
  // When oidc_config DECLARES a `client_secret_secret` name but no matching product_secrets
  // row exists (or it can't be unsealed), the callback MUST fail closed with 500
  // "misconfigured" — it must NEVER silently fall through and exchange the code as a PUBLIC
  // client (which would let a mis-provisioned confidential client be downgraded).
  it("fails closed (500 misconfigured) when a declared client secret is missing — no public exchange", async () => {
    // Declare a secret name, but seed NO product_secrets row for it.
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedFlow("c1", "the-nonce");

    // Track whether the token endpoint is ever called — it must NOT be, since we bail before
    // the exchange. A valid id_token is staged so a (wrongly) public exchange would 200.
    let tokenExchangeCalled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          tokenExchangeCalled = true;
          const idToken = await signIdToken({
            sub: "user-123",
            groups: ["members"],
            nonce: "the-nonce",
          });
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    const res = await callback("c1");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
    // Proof it did NOT silently downgrade to a public client: the code was never exchanged.
    expect(tokenExchangeCalled).toBe(false);

    // The flow is consumed on the fail-closed path ⇒ a subsequent poll just times out.
    const body = (await poll("c1").then((r) => r.json())) as { status: string };
    expect(body.status).toBe("timeout");
  });

  it("succeeds for the SAME config once the declared secret is sealed in product_secrets (control)", async () => {
    // The confidential client is correctly provisioned: declare the name AND seal a value.
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedProductSecret(
      db,
      "djdl",
      "OIDC_CLIENT_SECRET",
      "shhh-confidential",
    );
    await seedFlow("c2", "the-nonce");

    let sentClientSecret: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          const params = new URLSearchParams(String(init?.body ?? ""));
          sentClientSecret = params.get("client_secret");
          const idToken = await signIdToken({
            sub: "user-123",
            groups: ["members"],
            nonce: "the-nonce",
          });
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    const res = await callback("c2");
    expect(res.status).toBe(200);
    // The unsealed secret was forwarded to the IdP as a confidential-client credential.
    expect(sentClientSecret).toBe("shhh-confidential");
  });

  // P0-12 — usage scoping runs both ways. The OIDC path asks for a GENERAL secret, so a secret an
  // operator marked as edge-mint key material reads as missing here: it fails closed exactly
  // like the missing-secret case above, and is never unsealed or sent to the IdP.
  it("fails closed when the declared client secret is marked edge-mint (P0-12)", async () => {
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedProductSecret(
      db,
      "djdl",
      "OIDC_CLIENT_SECRET",
      "shhh-confidential",
      "edge-mint",
    );
    await seedFlow("c3", "the-nonce");
    let tokenExchangeCalled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) tokenExchangeCalled = true;
        throw new Error(`unexpected fetch: ${u}`);
      },
    );
    const res = await callback("c3");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
    expect(tokenExchangeCalled).toBe(false);
  });
});
