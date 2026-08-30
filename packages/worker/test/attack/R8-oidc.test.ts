/**
 * RED TEAM R8 — OIDC / OAuth / identity-bootstrap attacks. **REMEDIATED — INVERTED.**
 *
 * Every `it()` here was originally the attacker's claim, and a passing test meant the attack
 * WORKED. The titles are unchanged so the mapping to docs/security/findings/R8-oidc.md
 * survives, but each body now asserts the attack FAILS: this file is the regression suite for
 * the R8 fixes in src/oidc.ts. Each block names the finding id it locks down.
 *
 * ── WHAT THE A3 LANE CHANGED HERE ───────────────────────────────────────────────────────────
 *
 * R8-03 used to be one of two deliberately-unfixed findings, and its four tests asserted the
 * unbound behaviour. A3-06 fixed it on all three realms, so those four are inverted in place:
 * same names, and each now proves the victim's browser is REFUSED while the originating browser
 * still completes. R8-02's "the user code is a prefix of the device code" and R8-08's "the magic
 * token is 72 bits, unhashed, with the email in the value" residuals went the same way, under
 * A3-03 and B3-06/B7-03.
 *
 * R8-07 (`redirect_uris_json` fails open on NULL) remains the one finding here that is
 * deliberately not fixed; its test still asserts the unchanged behaviour.
 *
 * ── WHY SO MANY `productFlowKey(...)` CALLS ─────────────────────────────────────────────────
 *
 * B7-03 hashed the KV key names for the product flow `state` and the device code, so a test can
 * no longer plant a flow record by pasting the credential into the key. `test/helpers.ts` states
 * the mapping once and every suite reads it from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type KeyLike,
  SignJWT,
} from "jose";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { verifyJws } from "@polaris-key/jws";
import {
  flowCookie,
  makeTestDb,
  portalFlowKey,
  portalMagicKey,
  productDeviceFlowKey,
  productFlowKey,
} from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  NOW,
  seedProduct,
  DJDL_CATALOG,
  TEST_KID,
  TEST_PUB,
} from "../seed.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import {
  activateFromIdentity,
  applyProvisioning,
  handleAuthCallback,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthPoll,
  handleAuthStart,
} from "../../src/services/identity/oidc.js";
import { handleLicenseDocument } from "../../src/services/license/document.js";
import { authorizeDevice } from "../../src/core/authz.js";
import {
  createBrowserSession,
  handleBrowserSession,
} from "../../src/services/identity/browserSession.js";
// Wire v3 split `validateDeviceToken` in two: core answers "is this token a live device row",
// and `requireLicensedDevice` adds back the licence-usability check core used to apply inline.
// The latter is the exact behavioural equivalent of the pre-split core function, so it is what
// these tests assert against.
import { requireLicensedDevice } from "../../src/services/license/auth.js";
import { getDevice, getLicense } from "../../src/repo.js";
import {
  handleMagicStart,
  handleMagicVerify,
  handlePortalCallback,
  handlePortalLogin,
} from "../../src/services/identity/portal/auth.js";
import { handleAdminCallback, handleAdminLogin } from "../../src/admin/auth.js";
import { sessionFromRequest } from "../../src/admin/session.js";
import { handlePortalApi } from "../../src/services/identity/portal/api.js";
import { hashKey, mintOpaqueToken } from "../../src/crypto.js";
import type { Env } from "../../src/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";

// Same JWKS shim the in-tree oidcEdge suite uses: swap ONLY the remote key getter so the
// REAL jwtVerify (iss/aud/alg/sig/nonce) still runs.
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

const ISSUER = "https://id.example";
const AUD = "client-djdl";
const ORIGIN = "https://key.plrs.im";
const REDIRECT = `${ORIGIN}/djdl/identity/auth/callback`;

async function seedOidc(db: SqliteDb): Promise<void> {
  await db.run(
    `INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret,
       redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)`,
    "djdl",
    "custom",
    ISSUER,
    AUD,
    null,
    JSON.stringify([REDIRECT]),
    JSON.stringify({ family: { role: "user", tier: "pro" } }),
  );
  await db.run(
    `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days,
       policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)`,
    "djdl",
    "pro",
    "Pro",
    null,
    365,
    50,
    null,
    NOW,
  );
}

interface Ctx {
  db: SqliteDb;
  env: Env;
  kv: KvMock;
  product: Product;
  priv: KeyLike;
}

async function makeCtx(): Promise<Ctx> {
  const db = makeTestDb();
  const kv = new KvMock();
  const env = makeEnv(kv, ["djdl"]);
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  await seedOidc(db);
  const product = (await loadProduct(env, db, "djdl"))!;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "ES256",
    kid: "test-idp",
    use: "sig",
  };
  const pub = await importJWK(jwk, "ES256");
  idpKey.getKey = async () => pub;
  return { db, env, kv, product, priv: pair.privateKey };
}

function signIdToken(
  ctx: Ctx,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(ctx.priv);
}

/** Route the IdP token endpoint to a canned id_token. */
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

const req = (url: string, init?: RequestInit): Request =>
  new Request(url, init) as unknown as Request;

/**
 * Every `Set-Cookie` on a response, as a list.
 *
 * A3-06 made several responses emit TWO of them (the session it just issued, and the retirement
 * of the flow binding it consumed), and `headers.get("set-cookie")` folds those into one comma-
 * joined string. `getSetCookie` is the undici method that keeps them apart; the cast is because
 * this package types `Headers` from `@cloudflare/workers-types`, which does not declare it.
 */
const setCookies = (res: Response): string[] =>
  (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();

/** Drive the product callback. `cookie` carries the A3-06 browser binding when the flow under
 *  test has one; a hand-planted device/loopback flow has none and needs no cookie. */
const callback = (
  ctx: Ctx,
  state: string,
  code = "auth-code",
  cookie?: string,
) =>
  handleAuthCallback(
    req(`${ORIGIN}/djdl/identity/auth/callback?code=${code}&state=${state}`, {
      ...(cookie ? { headers: { cookie } } : {}),
    }),
    ctx.env,
    ctx.db,
    ctx.product,
    NOW,
  );

/** Plant a flow record the way the handlers would store it (B7-03: hashed key name). */
const putFlow = async (
  ctx: Ctx,
  state: string,
  flow: Record<string, unknown>,
): Promise<void> => {
  await ctx.env.HOT.put(
    await productFlowKey(ctx.env, "djdl", state),
    JSON.stringify(flow),
  );
};

const getFlow = async (ctx: Ctx, state: string): Promise<string | null> =>
  ctx.env.HOT.get(await productFlowKey(ctx.env, "djdl", state));

const getDeviceFlow = async (
  ctx: Ctx,
  deviceCode: string,
): Promise<string | null> =>
  ctx.env.HOT.get(await productDeviceFlowKey(ctx.env, "djdl", deviceCode));

const poll = (ctx: Ctx, state: string, device: string) =>
  handleAuthPoll(
    req(
      `${ORIGIN}/djdl/auth/poll?state=${encodeURIComponent(state)}&device=${encodeURIComponent(device)}`,
    ),
    ctx.env,
    ctx.db,
    ctx.product,
    NOW,
  );

const deviceStart = async (ctx: Ctx, deviceId: string): Promise<string> => {
  const res = await handleAuthDeviceStart(
    req(`${ORIGIN}/djdl/auth/device/start`, {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    }),
    ctx.env,
    ctx.db,
    ctx.product,
  );
  return ((await res.json()) as { deviceCode: string }).deviceCode;
};

const verifyUrl = (deviceCode: string): string =>
  `${ORIGIN}/djdl/auth/device/verify?device_code=${encodeURIComponent(deviceCode)}`;

/** Drive device confirmation the way the rendered page does: GET to mint the CSRF token,
 *  then POST it back (R8-02 — the GET is side-effect free and leaks nothing). */
const confirmDevice = async (
  ctx: Ctx,
  deviceCode: string,
): Promise<Response> => {
  const page = await handleAuthDeviceVerify(
    req(verifyUrl(deviceCode)),
    ctx.env,
    ctx.product,
  );
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1]!;
  return handleAuthDeviceVerify(
    req(verifyUrl(deviceCode), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ csrf }).toString(),
    }),
    ctx.env,
    ctx.product,
  );
};

afterEach(() => {
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-01 — /auth/poll mints a device token for an ATTACKER-CHOSEN device id
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-01 /auth/poll device-id confusion", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  // R8-01 — pollAuthFlow now requires flow.deviceId === presented device AND flow.confirmedAt.
  it("ATTACK: knowing only `state`, an attacker mints a LIVE device token on the victim's license bound to the attacker's own device id", async () => {
    // 1. The victim's CLI starts a device flow bound to device "victim-cli".
    const deviceCode = await deviceStart(ctx, "victim-cli");

    // 2. `state` is still NOT a secret — it rides on the authorize and callback URLs. Grant
    //    the attacker the strongest realistic position: they hold it in full.
    const confirm = await confirmDevice(ctx, deviceCode);
    const authorize = new URL(confirm.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;
    expect(state).toBeTruthy();

    // 3. The victim finishes sign-in at the IdP; the callback lands and binds the license.
    installFetchMock(
      await signIdToken(ctx, {
        sub: "victim-sub",
        email: "victim@corp.com",
        email_verified: true,
        groups: ["family"],
        nonce,
      }),
    );
    expect((await callback(ctx, state)).status).toBe(200);

    // 4. FIXED: the poll is bound to the device that STARTED the flow, so a device id the
    //    caller chose gets the generic error and no credential at all.
    const stolen = (await (
      await poll(ctx, state, "ATTACKER-DEVICE")
    ).json()) as { status: string; token?: string };
    expect(stolen.status).toBe("error");
    expect(stolen.token).toBeUndefined();
    // No seat was taken and no device row exists for the attacker's device.
    expect(await getDevice(ctx.db, "djdl", "ATTACKER-DEVICE")).toBeNull();

    // 5. The legitimate device still completes — the fix closes the hole, not the flow.
    const victim = (await (await poll(ctx, state, "victim-cli")).json()) as {
      status: string;
      token: string;
    };
    expect(victim.status).toBe("ready");
    const valid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      victim.token,
      NOW,
    );
    if ("error" in valid) throw new Error("expected a valid token");
    expect(valid.device.device_id).toBe("victim-cli");
    expect(valid.license.sub).toBe("victim-sub");
    expect(valid.license.email).toBe("victim@corp.com");

    // 6. …and it unlocks the signed license document for its rightful owner.
    const cfg = await handleLicenseDocument(
      req(`${ORIGIN}/djdl/license/document`, {
        headers: {
          authorization: `Bearer ${victim.token}`,
          "x-pkey-version": "1.2.3",
        },
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    expect(cfg.status).toBe(200);
    const doc = await verifyJws<LicenseDoc>(await cfg.text(), {
      [TEST_KID]: TEST_PUB,
    });
    expect(doc!.payload.entitlements["license.tier"]?.value).toBe("pro");
  });

  // R8-01 — /auth/poll enforces the same two guards as /auth/device/poll.
  it("ATTACK: /auth/poll is an unauthenticated bypass of BOTH guards /auth/device/poll enforces (device binding AND user confirmation)", async () => {
    // Seed a device flow that the user has NOT confirmed.
    await ctx.env.HOT.put(
      await productDeviceFlowKey(ctx.env, "djdl", "DC"),
      JSON.stringify({
        state: "S",
        deviceId: "victim-cli",
        userCode: "AAAA-BBBB",
        authorizeUrl: `${ISSUER}/authorize?state=S`,
      }),
    );
    const r = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "victim", groups: ["family"], claims: { sub: "victim" } },
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    const flow = {
      verifier: "v",
      nonce: "n",
      redirectUri: REDIRECT,
      deviceId: "victim-cli",
      licenseId: r.licenseId,
    };
    await putFlow(ctx, "S", flow);

    // The hardened surface refuses a foreign device id (oidc.ts:903-904)…
    const guarded = await handleAuthDevicePoll(
      req(`${ORIGIN}/djdl/auth/device/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: "DC", deviceId: "ATTACKER" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    expect(guarded.status).toBe(401);

    // …and also refuses an unconfirmed flow even for the RIGHT device (oidc.ts:905).
    const unconfirmed = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode: "DC", deviceId: "victim-cli" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string };
    expect(unconfirmed.status).toBe("pending");

    // FIXED: /auth/poll now enforces BOTH. A foreign device gets the generic error…
    const bypass = (await (await poll(ctx, "S", "ATTACKER")).json()) as {
      status: string;
      token?: string;
    };
    expect(bypass.status).toBe("error");
    expect(bypass.token).toBeUndefined();

    // …and the right device on an unconfirmed flow is still only "pending".
    const early = (await (await poll(ctx, "S", "victim-cli")).json()) as {
      status: string;
      token?: string;
    };
    expect(early.status).toBe("pending");
    expect(early.token).toBeUndefined();

    // Once the human confirms, the bound device — and only it — completes.
    await putFlow(ctx, "S", { ...flow, confirmedAt: NOW });
    const ok = (await (await poll(ctx, "S", "victim-cli")).json()) as {
      status: string;
      token: string;
    };
    expect(ok.status).toBe("ready");
    expect(ok.token.startsWith("pkeyt_")).toBe(true);
  });

  // R8-10 — every oidc.ts handler now consults the Durable-Object limiter.
  it("ATTACK: repeated /auth/poll guesses are never rate limited (the Durable Object limiter is never consulted)", async () => {
    const rlSpy = vi.spyOn(ctx.env.RL, "get");
    let throttled = 0;
    for (let i = 0; i < 200; i++) {
      const res = await poll(ctx, `guess-${i}`, "ATTACKER");
      if (res.status === 429) throttled++;
    }
    // FIXED: the limiter runs on every call and an unbounded state sweep is cut off.
    expect(rlSpy).toHaveBeenCalled();
    expect(throttled).toBeGreaterThan(0);

    // Same for every other oidc.ts surface: each one consults the limiter.
    const counted = async (label: string, run: () => Promise<unknown>) => {
      const before = rlSpy.mock.calls.length;
      await run();
      expect(
        rlSpy.mock.calls.length,
        `${label} did not consult the rate limiter`,
      ).toBeGreaterThan(before);
    };
    await counted("authStart", () =>
      handleAuthStart(
        req(`${ORIGIN}/djdl/auth/start`),
        ctx.env,
        ctx.db,
        ctx.product,
      ),
    );
    await counted("authDeviceStart", () =>
      handleAuthDeviceStart(
        req(`${ORIGIN}/djdl/auth/device/start`, {
          method: "POST",
          body: JSON.stringify({ deviceId: "d" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
      ),
    );
    await counted("authDeviceVerify", () =>
      handleAuthDeviceVerify(
        req(`${ORIGIN}/djdl/auth/device/verify?device_code=nope`),
        ctx.env,
        ctx.product,
      ),
    );
    await counted("authDevicePoll", () =>
      handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode: "x", deviceId: "y" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      ),
    );
    await counted("authCallback", () => callback(ctx, "nope"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-02 — device-code flow: state disclosure + CSRF-able GET confirmation
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-02 device-code flow weaknesses", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  // R8-02 — the GET is side-effect free; confirmation is a POST bound to a CSRF token.
  it("ATTACK: an unauthenticated GET turns a device_code into the OAuth state+nonce AND silently marks the flow user-confirmed", async () => {
    const start = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "victim-cli" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const { deviceCode, userCode, verificationUri, verificationUriComplete } =
      (await start.json()) as {
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
      };
    // FIXED (A3-03): `verificationUriComplete` used to be emitted BYTE-EQUAL to
    // `verificationUri`, which made it a field that told a client nothing and told a reader
    // something false. RFC 8628 §3.3.1 defines it as the verification URI with the user code
    // included, and it now carries one.
    expect(verificationUriComplete).not.toBe(verificationUri);
    expect(verificationUriComplete).toContain(
      `user_code=${encodeURIComponent(userCode)}`,
    );
    expect(verificationUri).toContain(encodeURIComponent(deviceCode));

    // FIXED: `?confirm=1` on a GET no longer mutates anything and no longer hands back a
    // Location at all — an <img src>/prefetch gets a plain HTML page.
    const res = await handleAuthDeviceVerify(
      req(`${verifyUrl(deviceCode)}&confirm=1`),
      ctx.env,
      ctx.product,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("nonce=");
    const stored = JSON.parse((await getDeviceFlow(ctx, deviceCode))!) as {
      confirmedAt?: number;
    };
    expect(stored.confirmedAt).toBeUndefined();

    // A POST with no CSRF token — the blind cross-site form submission — is refused…
    const noToken = await handleAuthDeviceVerify(
      req(verifyUrl(deviceCode), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      ctx.env,
      ctx.product,
    );
    expect(noToken.status).toBe(403);

    // …as is one from a foreign origin, even carrying the real token.
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    const crossSite = await handleAuthDeviceVerify(
      req(verifyUrl(deviceCode), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.attacker.test",
        },
        body: new URLSearchParams({ csrf }).toString(),
      }),
      ctx.env,
      ctx.product,
    );
    expect(crossSite.status).toBe(403);

    // The same-origin POST confirms, and the redirect that DOES carry state+nonce is marked
    // no-referrer / no-store so it cannot leak onward.
    const ok = await confirmDevice(ctx, deviceCode);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const after = JSON.parse((await getDeviceFlow(ctx, deviceCode))!) as {
      confirmedAt?: number;
    };
    expect(after.confirmedAt).toBeTruthy();
  });

  // R8-02 — the confirmation page no longer leaks the device code through the Referer chain.
  it("ATTACK: the confirmation page ships no security headers and no referrer policy while the URL holds the device code", async () => {
    await ctx.env.HOT.put(
      await productDeviceFlowKey(ctx.env, "djdl", "DC"),
      JSON.stringify({
        state: "S",
        deviceId: "d",
        userCode: "AAAA-BBBB",
        authorizeUrl: `${ISSUER}/authorize?state=S`,
      }),
    );
    const page = await handleAuthDeviceVerify(
      req(`${ORIGIN}/djdl/auth/device/verify?device_code=DC`),
      ctx.env,
      ctx.product,
    );
    expect(page.status).toBe(200);
    // FIXED: the device code in the address bar can no longer ride along as a Referer, and
    // no shared cache may keep the page.
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    // ALSO FIXED (R1-07b / R9-12): the page now carries the full static-HTML bundle from the
    // handler itself, not only from the `secureResponse` dispatcher backstop.
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  // R8-02 — `interval` is enforced server-side and the poll surface is rate limited.
  it("ATTACK: userCode is a case-folded PREFIX of the device code, and `interval`/`slow_down` are advertised but never enforced", async () => {
    const start = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "d" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const body = (await start.json()) as {
      deviceCode: string;
      userCode: string;
      interval: number;
    };
    // FIXED (A3-03): the user code has its OWN entropy. It used to be
    // `deviceCode.slice(0, 8).toUpperCase()` with a dash inserted, so the value a user is asked
    // to read aloud — onto a support call, into a screenshot, over a shoulder — was 48 bits of
    // the secret that redeems the flow. The two answer different questions and now have
    // independent lifetimes.
    const head = body.deviceCode.slice(0, 8).toUpperCase();
    expect(body.userCode).not.toBe(`${head.slice(0, 4)}-${head.slice(4, 8)}`);
    // Shape: `XXXX-XXXX` over the read-aloud alphabet (no I/O/S/B/U/V, no 0/1/5).
    const alphabet = "[ACDEFGHJKLMNPQRTWXYZ2346789]";
    expect(body.userCode).toMatch(
      new RegExp(`^${alphabet}{4}-${alphabet}{4}$`),
    );
    // Two starts with the same inputs must not produce the same code either.
    const second = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "d" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const other = (await second.json()) as { userCode: string };
    expect(other.userCode).not.toBe(body.userCode);
    expect(body.interval).toBe(2);

    // FIXED: a second poll inside the advertised interval is told to slow down.
    const first = await handleAuthDevicePoll(
      req(`${ORIGIN}/djdl/auth/device/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: body.deviceCode, deviceId: "d" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    expect(((await first.json()) as { status: string }).status).toBe("pending");
    const tooFast = await handleAuthDevicePoll(
      req(`${ORIGIN}/djdl/auth/device/poll`, {
        method: "POST",
        body: JSON.stringify({ deviceCode: body.deviceCode, deviceId: "d" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW + 1,
    );
    expect(tooFast.status).toBe(429);
    expect(((await tooFast.json()) as { status: string }).status).toBe(
      "slow_down",
    );

    // FIXED: and a 50-deep burst against one device code trips the per-code limiter.
    let throttled = 0;
    for (let i = 0; i < 50; i++) {
      const res = await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode: "guess", deviceId: "d" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      );
      if (res.status === 429) throttled++;
    }
    expect(throttled).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-03 — login CSRF: no flow is bound to the visitor's browser. **FIXED (A3-06).**
//
// These four were the file's standing "documented residual": every `it()` below asserted that a
// flow record was a bearer credential keyed on `state`, so an attacker who ran the IdP leg under
// their own account could hand the resulting callback URL to a victim and plant a session in the
// victim's browser. All four are inverted in place — same names, and each now proves the
// victim's browser is refused AND that the originating browser still completes.
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-03 login CSRF / flow-fixation", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it("ATTACK: the product flow record carries NO browser binding, so an attacker-completed callback drops an attacker session cookie into any visitor's browser", async () => {
    // The attacker starts a flow (from their own browser) and reads state+nonce.
    const startRes = await handleAuthStart(
      req(
        `${ORIGIN}/djdl/auth/start?return_to=${encodeURIComponent(`${ORIGIN}/djdl/app`)}`,
      ),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const authorize = new URL(startRes.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;

    // FIXED: the 302 now carries a `__Host-` binding cookie, and the flow record holds its
    // HASH — never the value handed to the browser.
    const setCookie = startRes.headers.get("set-cookie")!;
    expect(setCookie).toContain("__Host-pkey_flow=");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const flow = JSON.parse((await getFlow(ctx, state))!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(flow).sort()).toEqual([
      "flowHash",
      "nonce",
      "redirectUri",
      "returnTo",
      "verifier",
    ]);
    const bound = flowCookie(startRes);
    expect(bound).not.toContain(String(flow.flowHash));

    // The attacker finishes the IdP leg, then feeds the resulting callback URL to a victim.
    installFetchMock(
      await signIdToken(ctx, {
        sub: "attacker-sub",
        email: "attacker@evil.test",
        groups: ["family"],
        nonce,
      }),
    );
    const victimBrowser = req(
      `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${state}`,
      { headers: { cookie: "unrelated=1", "user-agent": "VictimBrowser/1.0" } },
    );
    const res = await handleAuthCallback(
      victimBrowser,
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    // FIXED: the victim's browser holds no binding, so it gets the same generic answer an
    // unknown state gets — and no session cookie at all.
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unknown state");
    expect(res.headers.get("set-cookie")).toBeNull();
    // Nothing was minted on the attacker's identity either: the callback refused before the
    // token exchange.
    expect(
      await ctx.db.first("SELECT id FROM licenses WHERE sub = 'attacker-sub'"),
    ).toBeNull();

    // Control: the browser that STARTED the flow still completes it end to end.
    const ok = await handleAuthCallback(
      req(`${ORIGIN}/djdl/identity/auth/callback?code=c&state=${state}`, {
        headers: { cookie: bound },
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    expect(ok.status).toBe(302);
    expect(setCookies(ok).join("; ")).toContain("pkey_djdl_session=");
    expect(ok.headers.get("location")).toBe(`${ORIGIN}/djdl/app`);
  });

  it("ATTACK: safeReturnTo lets the PRODUCT flow land on /manage paths that the portal twin explicitly forbids", async () => {
    // FIXED (A3-04): one `safeReturnTo` in `core/returnTo.ts`, taking the strictest union of
    // the four that existed. The product copy checked the origin and nothing else, so a product
    // sign-in could be aimed at the admin console; the portal copy already refused `/manage` by
    // name. Both customer realms refuse it now.
    const res = await handleAuthStart(
      req(
        `${ORIGIN}/djdl/auth/start?return_to=${encodeURIComponent(`${ORIGIN}/manage/products/djdl`)}`,
      ),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("return_to not allowed");
    // No flow was written at all, so there is nothing to complete against.
    expect(ctx.kv.keys().filter((k) => k.includes(":flow:"))).toHaveLength(0);

    // Control: an ordinary same-origin target is still accepted and still round-trips —
    // including its query and fragment, which the portal SPA legitimately sends.
    const target = `${ORIGIN}/djdl/app?tab=settings#/downloads`;
    const good = await handleAuthStart(
      req(`${ORIGIN}/djdl/auth/start?return_to=${encodeURIComponent(target)}`),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(good.status).toBe(302);
    const state = new URL(good.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const flow = JSON.parse((await getFlow(ctx, state))!) as {
      returnTo: string;
    };
    expect(flow.returnTo).toBe(target);
  });

  it("ATTACK: the ADMIN flow (/manage/callback) is equally unbound — an attacker-supplied state+code hands the victim's browser an admin cookie", async () => {
    ctx.env.ADMIN_SESSION_SECRET = "admin-secret";
    ctx.env.PLATFORM_ADMIN_GROUP = "platform-admins";
    ctx.env.PLATFORM_OIDC_ISSUER = ISSUER;
    ctx.env.PLATFORM_OIDC_CLIENT_ID = AUD;

    const login = await handleAdminLogin(
      req(`${ORIGIN}/manage/login`),
      ctx.env,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    // FIXED (R12-04): the KV key is now `admin:flow:<hashKey(state, pepper)>`, so a listing of
    // the HOT namespace no longer dumps live OIDC `state` values as key names.
    expect(await ctx.env.HOT.get(`admin:flow:${state}`)).toBeNull();
    const flowKey = `admin:flow:${await hashKey(state, ctx.env.KEY_HASH_PEPPER)}`;
    expect(flowKey).not.toContain(state);

    // FIXED (A3-06): the record now carries a browser binding beside the PKCE material.
    const flow = JSON.parse((await ctx.env.HOT.get(flowKey))!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(flow).sort()).toEqual([
      "flowHash",
      "nonce",
      "redirectUri",
      "verifier",
    ]);
    expect(login.headers.get("set-cookie")).toContain("__Host-pkey_flow=");

    const asAdmin = {
      verify: async () => ({
        sub: "attacker-admin",
        email: "attacker@evil.test",
        name: "Mallory",
        groups: ["platform-admins"],
      }),
    };
    // Replaying the attacker's callback from a DIFFERENT browser is refused, with the same
    // message an expired flow gets — and no console session is planted.
    const res = await handleAdminCallback(
      req(`${ORIGIN}/manage/callback?code=c&state=${state}`, {
        headers: { cookie: "unrelated=1", "user-agent": "VictimBrowser/1.0" },
      }),
      ctx.env,
      ctx.db,
      NOW,
      asAdmin,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();

    // Control: the originating browser still signs in. (A fresh flow, because the refused
    // callback consumed the first one — the single-use property is unchanged.)
    const login2 = await handleAdminLogin(
      req(`${ORIGIN}/manage/login`),
      ctx.env,
    );
    const state2 = new URL(login2.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const ok = await handleAdminCallback(
      req(`${ORIGIN}/manage/callback?code=c&state=${state2}`, {
        headers: { cookie: flowCookie(login2) },
      }),
      ctx.env,
      ctx.db,
      NOW,
      asAdmin,
    );
    expect(ok.status).toBe(302);
    expect(setCookies(ok).join("; ")).toContain("__Host-pkey_admin=");
    expect(ok.headers.get("location")).toBe("/manage/");
  });

  it("ATTACK: the PORTAL flow (/callback) is equally unbound", async () => {
    ctx.env.PORTAL_SESSION_SECRET = "portal-secret";
    ctx.env.PLATFORM_OIDC_ISSUER = ISSUER;
    ctx.env.PLATFORM_OIDC_CLIENT_ID = AUD;

    const login = await handlePortalLogin(
      req(`${ORIGIN}/login`),
      ctx.env,
      ctx.db,
    );
    const authorize = new URL(login.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;
    // FIXED (B7-03): the portal flow key is hashed too, so `portal:oidc-flow:<state>` is not a
    // key that exists any more.
    expect(await ctx.env.HOT.get(`portal:oidc-flow:${state}`)).toBeNull();
    const flow = JSON.parse(
      (await ctx.env.HOT.get(await portalFlowKey(ctx.env, state)))!,
    ) as Record<string, unknown>;
    // FIXED (A3-06): browser-bound, like the other two realms.
    expect(Object.keys(flow).sort()).toEqual([
      "flowHash",
      "nonce",
      "redirectUri",
      "verifier",
    ]);
    expect(login.headers.get("set-cookie")).toContain("__Host-pkey_flow=");

    installFetchMock(
      await signIdToken(ctx, {
        sub: "attacker-portal",
        email: "attacker@evil.test",
        email_verified: true,
        nonce,
      }),
    );
    const res = await handlePortalCallback(
      req(`${ORIGIN}/callback?code=c&state=${state}`, {
        headers: { cookie: "unrelated=1", "user-agent": "VictimBrowser/1.0" },
      }),
      ctx.env,
      ctx.db,
      NOW,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    // No portal account was created for the attacker's identity out of the refused callback.
    expect(
      await ctx.db.first(
        "SELECT account_id FROM portal_account_identities WHERE subject = 'attacker-portal'",
      ),
    ).toBeNull();

    // Control: the originating browser still signs in.
    const login2 = await handlePortalLogin(
      req(`${ORIGIN}/login`),
      ctx.env,
      ctx.db,
    );
    const state2 = new URL(login2.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const nonce2 = new URL(login2.headers.get("location")!).searchParams.get(
      "nonce",
    )!;
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, {
        sub: "honest-portal",
        email: "ada@corp.example",
        email_verified: true,
        nonce: nonce2,
      }),
    );
    const ok = await handlePortalCallback(
      req(`${ORIGIN}/callback?code=c&state=${state2}`, {
        headers: { cookie: flowCookie(login2) },
      }),
      ctx.env,
      ctx.db,
      NOW,
    );
    expect(ok.status).toBe(302);
    expect(setCookies(ok).join("; ")).toContain("pkey_portal=");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-04 — OIDC state is NOT single-use on the loopback path → flow injection
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-04 non-single-use state / flow injection", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  // R8-04 — a flow record accepts at most one successful callback.
  it("ATTACK: a second callback on the same state overwrites the bound license, silently activating the victim's app on the ATTACKER's identity", async () => {
    const deviceCode = await deviceStart(ctx, "victim-cli");
    const confirm = await confirmDevice(ctx, deviceCode);
    const authorize = new URL(confirm.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const nonce = authorize.searchParams.get("nonce")!;

    // Victim completes sign-in.
    installFetchMock(
      await signIdToken(ctx, {
        sub: "victim-sub",
        groups: ["family"],
        nonce,
      }),
    );
    expect((await callback(ctx, state)).status).toBe(200);
    vi.restoreAllMocks();

    // FIXED: the state is single-use. The attacker — who scraped state+nonce off the
    // authorize URL and ran the IdP leg under their OWN account — is refused, with the same
    // generic answer an unknown state gets.
    installFetchMock(
      await signIdToken(ctx, {
        sub: "attacker-sub",
        groups: ["family"],
        nonce,
      }),
    );
    const replay = await callback(ctx, state, "attacker-code");
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("unknown state");

    // The victim's CLI still receives a token for the VICTIM's license.
    const out = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "victim-cli" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token: string };
    expect(out.status).toBe("ready");
    const valid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      out.token,
      NOW,
    );
    if ("error" in valid) throw new Error("expected a valid token");
    expect(valid.license.sub).toBe("victim-sub");
    // The attacker's identity never got a license row out of the replay.
    expect(
      await ctx.db.first("SELECT id FROM licenses WHERE sub = 'attacker-sub'"),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-05 — claim trust: empty `sub` collapses identities; `email_verified` ignored
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-05 claim trust", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  // R8-05a — a subject-less ID token is refused, so nothing converges on sub = "".
  it("ATTACK: an ID token with NO `sub` is accepted by the product flow and converges every such identity onto ONE license row", async () => {
    for (const [state, email] of [
      ["s-alice", "alice@corp.com"],
      ["s-mallory", "mallory@evil.test"],
    ] as const) {
      await putFlow(ctx, state, {
        verifier: "v",
        nonce: "N",
        redirectUri: REDIRECT,
      });
      vi.restoreAllMocks();
      installFetchMock(
        await signIdToken(ctx, { email, groups: ["family"], nonce: "N" }), // no `sub`
      );
      // FIXED: the product flow now matches admin (admin/auth.ts:216) and portal
      // (portal/auth.ts:280) — a generic 401, indistinguishable from any other bad token.
      const res = await callback(ctx, state);
      expect(res.status).toBe(401);
      // The flow is consumed on failure, so the poller cannot learn the reason either.
      expect(await getFlow(ctx, state)).toBeNull();
    }
    const rows = await ctx.db.all<{ id: string; sub: string; email: string }>(
      "SELECT id, sub, email FROM licenses WHERE product = 'djdl'",
    );
    expect(rows).toHaveLength(0);

    // A non-string `sub` is not coerced into one either (123 must not collide with "123").
    await putFlow(ctx, "s-typed", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, { sub: 123, groups: ["family"], nonce: "N" }),
    );
    expect((await callback(ctx, "s-typed")).status).toBe(401);
  });

  // R8-05b — only a verified email is persisted or signed.
  it("ATTACK: an UNVERIFIED `email` claim is signed into the config document's identity profile", async () => {
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    installFetchMock(
      await signIdToken(ctx, {
        sub: "mallory",
        email: "ceo@victim-corp.com",
        email_verified: false,
        groups: ["family"],
        nonce: "N",
      }),
    );
    expect((await callback(ctx, "S")).status).toBe(200);

    // FIXED: sign-in still succeeds, but the unverified address is not written anywhere.
    const lic = await ctx.db.first<{ id: string; email: string | null }>(
      "SELECT id, email FROM licenses WHERE product = 'djdl' AND sub = 'mallory'",
    );
    expect(lic!.email).toBeNull();

    // …so it cannot reach the SIGNED doc that products authorize on. Wire v3 moved the
    // identity profile onto the LICENSE document; the title keeps the finding-doc mapping.
    await putFlow(ctx, "S2", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
      deviceId: "dev-1",
      confirmedAt: NOW,
      licenseId: lic!.id,
    });
    const { token } = (await (await poll(ctx, "S2", "dev-1")).json()) as {
      token: string;
    };
    const cfg = await handleLicenseDocument(
      req(`${ORIGIN}/djdl/license/document`, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-pkey-version": "1.2.3",
        },
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    const doc = await verifyJws<LicenseDoc>(await cfg.text(), {
      [TEST_KID]: TEST_PUB,
    });
    expect(doc!.payload.profile?.email).toBe("");

    // …and the portal's email auto-linker (portal/repo.ts:276) finds nothing to link.
    const matches = await ctx.db.all<{ id: string }>(
      "SELECT id FROM licenses WHERE lower(email) = ?",
      "ceo@victim-corp.com",
    );
    expect(matches).toHaveLength(0);

    // Control: the SAME address with email_verified = true is persisted as before.
    await putFlow(ctx, "S3", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, {
        sub: "honest",
        email: "ada@corp.com",
        email_verified: true,
        groups: ["family"],
        nonce: "N",
      }),
    );
    expect((await callback(ctx, "S3")).status).toBe(200);
    const ok = await ctx.db.first<{ email: string }>(
      "SELECT email FROM licenses WHERE product = 'djdl' AND sub = 'honest'",
    );
    expect(ok!.email).toBe("ada@corp.com");
  });

  // R8-05c — provisioning requires a real `true` or a meaningful string, not truthiness.
  it('ATTACK: provisioning hooks are truthiness-only — "false", 0-as-string, [] and {} all switch an entitlement ON', async () => {
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "isPro",
      "proFeatures",
      JSON.stringify(true),
      null,
      null,
      null,
    );
    // FIXED: none of these enable the hook any more.
    for (const claimVal of [
      "false",
      "0",
      0,
      [],
      {},
      "null",
      "",
      "  ",
      1,
      "FALSE",
    ] as unknown[]) {
      const payload = { config: {}, secrets: {}, entitlements: {} };
      await applyProvisioning(
        ctx.env,
        ctx.db,
        "djdl",
        { sub: "u", groups: [], claims: { isPro: claimVal } },
        payload,
        NOW,
      );
      expect(
        (payload.entitlements as Record<string, { value: unknown }>)
          .proFeatures,
        `claim value ${JSON.stringify(claimVal)} must not grant`,
      ).toBeUndefined();
    }
    // Control: a genuine boolean true and a meaningful string still do.
    for (const claimVal of [true, "abc123"] as unknown[]) {
      const payload = { config: {}, secrets: {}, entitlements: {} };
      await applyProvisioning(
        ctx.env,
        ctx.db,
        "djdl",
        { sub: "u", groups: [], claims: { isPro: claimVal } },
        payload,
        NOW,
      );
      expect(
        (payload.entitlements as Record<string, { value: unknown }>).proFeatures
          ?.value,
      ).toBe(true);
    }
  });

  // R8-05d — maxTokenAge + clockTolerance are enforced. azp/at_hash/hd remain unchecked.
  it("ATTACK: no maxTokenAge/clockTolerance/azp/at_hash/hd check — an ID token minted long ago still activates", async () => {
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    const stale = await new SignJWT({
      sub: "stale-user",
      groups: ["family"],
      nonce: "N",
      azp: "some-other-client",
      hd: "attacker.test",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 86_400 * 30) // iat: 30 days ago
      .setExpirationTime("1h")
      .sign(ctx.priv);
    installFetchMock(stale);
    // FIXED: freshness is ours to enforce, not the IdP's — a stale `iat` is a generic 401.
    expect((await callback(ctx, "S")).status).toBe(401);
    expect(
      await ctx.db.first("SELECT id FROM licenses WHERE sub = 'stale-user'"),
    ).toBeNull();

    // Control: the same claims minted now (azp/hd still unchecked — see the finding doc) are
    // accepted, so the age check is what rejected the stale one.
    await putFlow(ctx, "S-fresh", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, {
        sub: "fresh-user",
        groups: ["family"],
        nonce: "N",
        azp: "some-other-client",
        hd: "attacker.test",
      }),
    );
    expect((await callback(ctx, "S-fresh")).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-06 — unguarded JSON.parse on config columns crashes the callback
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-06 unguarded JSON.parse in the sign-in path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  // R8-06 — every JSON config column on the sign-in path parses defensively and fails closed.
  it("ATTACK: malformed allowed_hosts_json throws out of applyProvisioning and escapes handleAuthCallback uncaught", async () => {
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "sub",
      null,
      null,
      "proxy.url",
      "https://vpn.example/{claim}",
      "not-json",
    );
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    installFetchMock(
      await signIdToken(ctx, {
        sub: "u",
        groups: ["family"],
        nonce: "N",
      }),
    );
    // FIXED: sign-in completes normally and the unparseable hook is dropped, rather than the
    // whole product's sign-in path wedging on an uncaught SyntaxError.
    expect((await callback(ctx, "S")).status).toBe(200);
    const lic = await ctx.db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE product = 'djdl' AND sub = 'u'",
    );
    const overrides = JSON.parse(lic!.overrides_json) as {
      secrets: Record<string, unknown>;
    };
    expect(overrides.secrets["proxy.url"]).toBeUndefined();
  });

  it("ATTACK: malformed group_role_map_json / entitlement_value_json do the same", async () => {
    await ctx.db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      "{oops",
    );
    // FIXED: an unparseable group map grants nothing instead of throwing.
    expect(
      await activateFromIdentity(
        ctx.env,
        ctx.db,
        ctx.product,
        { sub: "u", groups: ["family"], claims: {} },
        NOW,
      ),
    ).toEqual({ error: "not-entitled" });

    await ctx.db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({ family: { role: "user" } }),
    );
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "sub",
      "ent",
      "{bad",
      null,
      null,
      null,
    );
    // FIXED: an unparseable entitlement value drops that hook, no exception.
    const r = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "u", groups: ["family"], claims: { sub: "u" } },
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(ctx.db, "djdl", r.licenseId);
    const overrides = JSON.parse(lic!.overrides_json!) as {
      entitlements: Record<string, unknown>;
    };
    expect(overrides.entitlements.ent).toBeUndefined();
  });

  it("ATTACK: a NULL allowed_hosts_json disables the templated-secret host allowlist entirely", async () => {
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "sub",
      null,
      null,
      "proxy.url",
      "https://exfil.attacker.test/{claim}",
      null,
    );
    const payload = { config: {}, secrets: {}, entitlements: {} };
    await applyProvisioning(
      ctx.env,
      ctx.db,
      "djdl",
      { sub: "u", groups: [], claims: { sub: "u" } },
      payload,
      NOW,
    );
    // FIXED: a templated secret with no allowlist now fails CLOSED — nothing is emitted.
    expect(
      (payload.secrets as Record<string, { value: string }>)["proxy.url"],
    ).toBeUndefined();
  });

  it("BUG: String.replace with a string pattern substitutes only the FIRST {claim}", async () => {
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "sub",
      null,
      null,
      "proxy.url",
      "https://vpn.example/{claim}/token/{claim}",
      JSON.stringify(["vpn.example"]),
    );
    const payload = { config: {}, secrets: {}, entitlements: {} };
    await applyProvisioning(
      ctx.env,
      ctx.db,
      "djdl",
      { sub: "u", groups: [], claims: { sub: "u" } },
      payload,
      NOW,
    );
    // FIXED: every placeholder is substituted, so no literal {claim} ships inside a secret.
    expect(
      (payload.secrets as Record<string, { value: string }>)["proxy.url"]
        ?.value,
    ).toBe("https://vpn.example/u/token/u");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-07 — redirect_uris_json fails open when the column is NULL
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-07 redirect-URI allowlist fail-open", () => {
  // NOT FIXED — still asserts the vulnerable behaviour. `redirectUriAllowed` keeps its
  // `if (!oidc.redirect_uris_json) return true`: no shipped writer produces NULL
  // (repo.ts:452 always writes at least "[]", which fails closed) and three other lanes'
  // fixtures depend on the NULL-permissive path. See the Remediation section of the finding.
  it("ATTACK: with redirect_uris_json NULL, any Host header produces an accepted redirect_uri", async () => {
    const ctx = await makeCtx();
    await ctx.db.run(
      "UPDATE oidc_config SET redirect_uris_json = NULL WHERE product = 'djdl'",
    );
    const res = await handleAuthStart(
      req("https://evil.attacker.test/djdl/auth/start"),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(res.status).toBe(302); // allow-listed origin check silently skipped
    const authorize = new URL(res.headers.get("location")!);
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://evil.attacker.test/djdl/identity/auth/callback",
    );
    // Control: with the column populated it fails closed.
    await ctx.db.run(
      "UPDATE oidc_config SET redirect_uris_json = ? WHERE product = 'djdl'",
      JSON.stringify([REDIRECT]),
    );
    const closed = await handleAuthStart(
      req("https://evil.attacker.test/djdl/auth/start"),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(closed.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R8-08 — magic link: 72-bit token, unhashed KV key, no verify rate limit.
// **FIXED (B3-06 / B7-03 / B5-11).** Both tests are inverted in place.
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-08 portal magic link", () => {
  it("ATTACK: the magic token is 72 bits, stored UNHASHED as its own KV key with the email as the value", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    env.PORTAL_SESSION_SECRET = "s";
    const sent: { link?: string } = {};
    env.EMAIL = {
      send: async (m: { text: string }) => {
        sent.link = /https:\/\/\S+/.test(m.text)
          ? m.text.split(/\s+/).filter((w) => w.startsWith("https://"))[0]
          : undefined;
      },
    } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl");

    const res = await handleMagicStart(
      req("https://key.plrs.im/api/auth/magic", {
        method: "POST",
        body: JSON.stringify({ email: "victim@corp.com" }),
      }),
      env,
      db,
    );
    expect(res.status).toBe(200);

    // The secret is still in the QUERY STRING of the emailed link — that is the design of a
    // magic link. What changed is everything about the value itself.
    const token = new URL(sent.link!).searchParams.get("token")!;
    // FIXED (B3-06): `mintOpaqueToken`, not `randomId("magic")`. 256 bits, matching every
    // sibling credential (device tokens, browser-session cookies, download tokens) instead of
    // the 72 that made an offline guess plausible.
    expect(token.startsWith("magic_")).toBe(false);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // FIXED (B7-03): the KV key is the peppered hash, so a namespace listing yields nothing
    // redeemable — R12-04 was marked "Fixed" while covering only `admin/auth.ts`, and this is
    // one of the four sites it missed.
    const keys = kv.keys().filter((k) => k.startsWith("portal:magic:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(token);
    expect(keys[0]).toBe(await portalMagicKey(env, token));
    expect(keys[0]!.slice("portal:magic:".length)).toMatch(/^[0-9a-f]{64}$/);

    // FIXED (B7-03): and the VALUE no longer names the target. The plaintext address was what
    // turned a KV dump from "a list of hashes" into an account-takeover primitive; it is now
    // sealed under the platform KEK, bound by AAD to this one token hash.
    const value = (await kv.get(keys[0]!))!;
    expect(value).not.toContain("victim@corp.com");
    expect(value).not.toContain("victim");
    expect(JSON.parse(value)).toMatchObject({
      email: expect.stringContaining('"ct"') as string,
    });

    // Control: the real link still works, so none of the above cost the feature anything.
    const verified = await handleMagicVerify(
      req(
        `https://key.plrs.im/magic/verify?token=${encodeURIComponent(token)}`,
      ),
      env,
      db,
      NOW,
    );
    expect(verified.status).toBe(302);
    expect(setCookies(verified).join("; ")).toContain("pkey_portal=");
    // …and exactly once: delete-on-consume is unchanged.
    expect(kv.keys().filter((k) => k.startsWith("portal:magic:"))).toHaveLength(
      0,
    );
    expect(
      await db.first(
        "SELECT email FROM portal_account_emails WHERE email = ?",
        "victim@corp.com",
      ),
    ).toBeTruthy();
  });

  it("ATTACK: /magic/verify has NO rate limit, unlike /magic/start", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.PORTAL_SESSION_SECRET = "s";
    await seedProduct(db, "djdl");
    const rlSpy = vi.spyOn(env.RL, "get");
    // FIXED (B5-11 / MG-01): the REDEMPTION surface is the online oracle, and it is the one
    // that had no budget while the surface that merely sends the mail was capped at 8/min.
    let throttled = 0;
    for (let i = 0; i < 100; i++) {
      const res = await handleMagicVerify(
        req(`https://key.plrs.im/magic/verify?token=${mintOpaqueToken()}`),
        env,
        db,
        NOW,
      );
      if (res.status === 429) throttled++;
      else expect(res.status).toBe(400);
    }
    expect(rlSpy).toHaveBeenCalled();
    expect(throttled).toBeGreaterThan(0);

    // Control: the START surface is still limited too.
    const before = rlSpy.mock.calls.length;
    for (let i = 0; i < 12; i++) {
      await handleMagicStart(
        req("https://key.plrs.im/api/auth/magic", {
          method: "POST",
          body: JSON.stringify({ email: "a@b.co" }),
        }),
        env,
        db,
      );
    }
    expect(rlSpy.mock.calls.length).toBeGreaterThan(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3-01 (HIGH) — device-flow `deviceId` was an AUTHORIZATION input
//
// `handleAuthDeviceStart` takes `deviceId` from an unauthenticated request body and the callback
// used it to look up a device row and hand its `license_id` to `activateFromIdentity` as
// `enrolledLicenseId`. But `X-PKey-Device` is, in `core/devices.ts`'s own words, "a client-chosen
// string with no uniqueness requirement" — and it is DISCLOSED: the portal lists it to every
// co-owner of a licence, the console shows it, and for the browser realm it is literally
// `browser:<licenseId>`. Naming one victim device id was therefore enough to have the victim's
// licence row rewritten onto the attacker's identity.
// ═══════════════════════════════════════════════════════════════════════════════
describe("A3-01 device-flow deviceId is not a credential", () => {
  let ctx: Ctx;
  /** The victim's auto-issued licence and the live token their CLI holds for it. */
  let victim: { licenseId: string; token: string };

  beforeEach(async () => {
    ctx = await makeCtx();
    const licenseId = "lic_victim_enrolled";
    await ctx.db.run(
      `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id,
         activated_at, expires_at, max_offline_days, overrides_json, channels_json,
         min_version, max_version, origin, enroll_hwid, modified_by, modified_at)
       VALUES ('djdl', ?, 'active', NULL, NULL, NULL, NULL, 'pro', ?, NULL, NULL, NULL,
               NULL, NULL, NULL, 'enroll', 'HW-VICTIM', 'enroll', ?)`,
      licenseId,
      NOW,
      NOW,
    );
    const license = (await getLicense(ctx.db, "djdl", licenseId))!;
    const auth = await authorizeDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      license,
      "victim-cli",
      NOW,
    );
    if ("error" in auth) throw new Error("expected the victim device to bind");
    victim = { licenseId, token: auth.token };
  });

  /** Run a whole device flow for `deviceId`, optionally presenting a device token at start. */
  const runDeviceFlow = async (
    deviceId: string,
    identity: { sub: string; email: string },
    deviceToken?: string,
  ): Promise<void> => {
    const start = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        ...(deviceToken
          ? { headers: { authorization: `Bearer ${deviceToken}` } }
          : {}),
        body: JSON.stringify({ deviceId }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const { deviceCode } = (await start.json()) as { deviceCode: string };
    const confirm = await confirmDevice(ctx, deviceCode);
    const authorize = new URL(confirm.headers.get("location")!);
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, {
        sub: identity.sub,
        email: identity.email,
        email_verified: true,
        groups: ["family"],
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    expect(
      (await callback(ctx, authorize.searchParams.get("state")!)).status,
    ).toBe(200);
  };

  it("ATTACK: naming the victim's device id at device-flow start transfers the victim's licence to the attacker", async () => {
    // The attacker knows only `victim-cli` — a string the portal would have shown them, or that
    // they guessed. They hold no device token for it and never touch the victim's machine.
    await runDeviceFlow("victim-cli", {
      sub: "attacker-sub",
      email: "attacker@evil.test",
    });

    // FIXED: the victim's licence row is untouched. Every column the takeover used to overwrite
    // still holds its pre-attack value.
    const after = (await getLicense(ctx.db, "djdl", victim.licenseId))!;
    expect(after.sub).toBeNull();
    expect(after.email).toBeNull();
    expect(after.origin).toBe("enroll");
    expect(after.status).toBe("active");
    expect(after.modified_by).toBe("enroll");

    // The victim's live device token still works, so their machine was not silently revoked.
    const stillValid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      victim.token,
      NOW,
    );
    if ("error" in stillValid) throw new Error("victim token was revoked");
    expect(stillValid.license.id).toBe(victim.licenseId);

    // The attacker did land entitled — that is allowed, anyone who can sign in may have a
    // licence — but on a licence OF THEIR OWN, not the victim's.
    const mine = await ctx.db.first<{ id: string }>(
      "SELECT id FROM licenses WHERE product = 'djdl' AND sub = 'attacker-sub'",
    );
    expect(mine).toBeTruthy();
    expect(mine!.id).not.toBe(victim.licenseId);
    // …and the victim's device did not move onto it.
    expect((await getDevice(ctx.db, "djdl", "victim-cli"))!.license_id).toBe(
      victim.licenseId,
    );
  });

  it("REGRESSION: the victim's OWN client, presenting its device token, still claims its enrolled licence in place", async () => {
    await runDeviceFlow(
      "victim-cli",
      { sub: "victim-sub", email: "ada@corp.example" },
      victim.token,
    );

    // The whole point of the claim path: the SAME row becomes the identity's licence, so the
    // user's devices, overrides and local state survive.
    const claimed = (await getLicense(ctx.db, "djdl", victim.licenseId))!;
    expect(claimed.sub).toBe("victim-sub");
    expect(claimed.email).toBe("ada@corp.example");
    expect(claimed.origin).toBe("oidc");
    // No second licence was minted for the identity.
    expect(
      await ctx.db.all(
        "SELECT id FROM licenses WHERE product = 'djdl' AND sub = 'victim-sub'",
      ),
    ).toHaveLength(1);
  });

  it("ATTACK: a device token for a DIFFERENT device id is not proof for this one", async () => {
    // The attacker holds a perfectly valid token — for their own device, on their own licence —
    // and presents it while naming the victim's device id.
    const mineLicense = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "attacker-sub", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in mineLicense)) throw new Error("expected a licence");
    const mine = await authorizeDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      (await getLicense(ctx.db, "djdl", mineLicense.licenseId))!,
      "attacker-box",
      NOW,
    );
    if ("error" in mine)
      throw new Error("expected the attacker device to bind");

    await runDeviceFlow(
      "victim-cli",
      { sub: "attacker2-sub", email: "attacker2@evil.test" },
      mine.token,
    );
    const after = (await getLicense(ctx.db, "djdl", victim.licenseId))!;
    expect(after.sub).toBeNull();
    expect(after.origin).toBe("enroll");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3-02 — the product session cookie has no `__Host-` prefix and was read first-match
// ═══════════════════════════════════════════════════════════════════════════════
describe("A3-02 product session cookie shadowing", () => {
  it("ATTACK: a duplicate pkey_<slug>_session cookie shadows the real one and is served instead", async () => {
    const ctx = await makeCtx();
    const victim = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      {
        sub: "victim",
        email: "ada@corp.example",
        groups: ["family"],
        claims: {},
      },
      NOW,
    );
    const attacker = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "mallory", email: "m@evil.test", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in victim) || !("licenseId" in attacker)) {
      throw new Error("expected two licences");
    }
    const cookieOf = async (licenseId: string): Promise<string> => {
      const session = await createBrowserSession(
        ctx.env,
        ctx.db,
        ctx.product,
        (await getLicense(ctx.db, "djdl", licenseId))!,
        NOW,
      );
      if (!session.ok) throw new Error("expected a session");
      return session.cookie.split(";")[0]!;
    };
    const victimCookie = await cookieOf(victim.licenseId);
    const attackerCookie = await cookieOf(attacker.licenseId);

    const read = (cookie: string) =>
      handleBrowserSession(
        req(`${ORIGIN}/djdl/identity/session`, { headers: { cookie } }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      );

    // Control: each cookie alone resolves to its own licence.
    const alone = (await (await read(victimCookie)).json()) as {
      authenticated: boolean;
    };
    expect(alone.authenticated).toBe(true);

    // FIXED: a Cookie header carrying TWO values for this name is refused outright. RFC 6265
    // §5.4 sends the longest-`Path` cookie first, so a first-match reader picks up exactly the
    // duplicate a sibling subdomain (`Domain=plrs.im`) or a `Path=/djdl/deeper` write plants —
    // and `__Host-` cannot be used here, because it demands `Path=/` and this cookie is
    // deliberately scoped per product. The ambiguity is resolved by failing closed.
    for (const header of [
      `${attackerCookie}; ${victimCookie}`,
      `${victimCookie}; ${attackerCookie}`,
      `${victimCookie}; other=1; ${attackerCookie}`,
    ]) {
      const shadowed = (await (await read(header)).json()) as {
        authenticated: boolean;
        doc: unknown;
      };
      expect(shadowed.authenticated, header).toBe(false);
      expect(shadowed.doc, header).toBeNull();
    }

    // A duplicate that AGREES byte-for-byte is not an attack and still resolves.
    const benign = (await (
      await read(`${victimCookie}; ${victimCookie}`)
    ).json()) as { authenticated: boolean };
    expect(benign.authenticated).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B4-02 — IdP group names were resolved against a plain object, so `Object.prototype` answered
// ═══════════════════════════════════════════════════════════════════════════════
describe("B4-02 prototype pollution in the group→role map", () => {
  it("ATTACK: an IdP group named `constructor` matches Object.prototype and grants entitlement", async () => {
    const ctx = await makeCtx();
    // The product's map names exactly one group: `family` (see seedOidc). Nothing else may
    // resolve — least of all a key that exists on every object in the language.
    for (const group of [
      "constructor",
      "__proto__",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      expect(
        await activateFromIdentity(
          ctx.env,
          ctx.db,
          ctx.product,
          { sub: `u-${group}`, groups: [group], claims: {} },
          NOW,
        ),
        `group ${group} must not grant`,
      ).toEqual({ error: "not-entitled" });
    }
    expect(
      await ctx.db.all("SELECT id FROM licenses WHERE product = 'djdl'"),
    ).toHaveLength(0);

    // Control: the one group the operator DID name still grants, with its tier.
    const ok = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "ada", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in ok)) throw new Error("expected a licence");
    expect((await getLicense(ctx.db, "djdl", ok.licenseId))!.tier_id).toBe(
      "pro",
    );

    // …and an operator who genuinely maps a group called `constructor` is still obeyed: the fix
    // is "own properties only", not "these names are banned".
    await ctx.db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({ constructor: { role: "user", tier: "pro" } }),
    );
    expect(
      await activateFromIdentity(
        ctx.env,
        ctx.db,
        ctx.product,
        { sub: "mapped", groups: ["constructor"], claims: {} },
        NOW,
      ),
    ).toMatchObject({ licenseId: expect.any(String) as string });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION — the three sign-in paths are the platform's ONLY auth paths
//
// A3-06 put a mandatory cookie in front of every browser callback, A3-04 tightened where each
// may land, B7-03 renamed every KV key the flows use and B3-06/B7-03 rebuilt the magic link. Any
// one of those could have closed the hole by breaking the feature. These four drive each realm
// the way a browser does and assert the resulting session ACTUALLY WORKS — not merely that a
// `Set-Cookie` came back.
// ═══════════════════════════════════════════════════════════════════════════════
describe("REGRESSION ordinary sign-in still works end to end", () => {
  /** The `Cookie:` header for one named cookie out of a response's Set-Cookie list. */
  const cookieNamed = (res: Response, name: string): string => {
    const hit = setCookies(res).find(
      (c) => c.startsWith(`${name}=`) && !c.includes("Max-Age=0"),
    );
    if (!hit) throw new Error(`no live ${name} cookie`);
    return hit.split(";")[0]!;
  };

  it("product: /identity/auth/start -> IdP -> /identity/auth/callback -> a usable browser session", async () => {
    const ctx = await makeCtx();
    const target = `${ORIGIN}/djdl/app#/settings`;
    const start = await handleAuthStart(
      req(`${ORIGIN}/djdl/auth/start?return_to=${encodeURIComponent(target)}`),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    installFetchMock(
      await signIdToken(ctx, {
        sub: "ada",
        email: "ada@corp.example",
        email_verified: true,
        groups: ["family"],
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    const done = await callback(
      ctx,
      authorize.searchParams.get("state")!,
      "auth-code",
      flowCookie(start),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(target);
    // The binding cookie is retired in the same response that issues the session.
    expect(setCookies(done).join("; ")).toContain("__Host-pkey_flow=;");

    const session = await handleBrowserSession(
      req(`${ORIGIN}/djdl/identity/session`, {
        headers: { cookie: cookieNamed(done, "pkey_djdl_session") },
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    const body = (await session.json()) as {
      authenticated: boolean;
      doc: { licenseId: string; profile?: { email?: string } } | null;
    };
    expect(body.authenticated).toBe(true);
    expect(body.doc?.profile?.email).toBe("ada@corp.example");
  });

  it("product: the device/loopback flow is untouched — it stays cross-browser by design", async () => {
    const ctx = await makeCtx();
    const deviceCode = await deviceStart(ctx, "ada-cli");
    // Confirmed in a completely different browser, carrying no binding cookie at all.
    const confirm = await confirmDevice(ctx, deviceCode);
    const authorize = new URL(confirm.headers.get("location")!);
    installFetchMock(
      await signIdToken(ctx, {
        sub: "ada",
        groups: ["family"],
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    expect(
      (await callback(ctx, authorize.searchParams.get("state")!)).status,
    ).toBe(200);
    const polled = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "ada-cli" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token: string };
    expect(polled.status).toBe("ready");
    const valid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      polled.token,
      NOW,
    );
    if ("error" in valid) throw new Error("expected a valid device token");
    expect(valid.license.sub).toBe("ada");
  });

  it("admin: /manage/login -> /manage/callback -> a session the console verifies", async () => {
    const ctx = await makeCtx();
    ctx.env.ADMIN_SESSION_SECRET = "admin-secret";
    ctx.env.PLATFORM_ADMIN_GROUP = "platform-admins";
    ctx.env.PLATFORM_OIDC_ISSUER = ISSUER;
    ctx.env.PLATFORM_OIDC_CLIENT_ID = AUD;
    const login = await handleAdminLogin(
      req(
        `${ORIGIN}/manage/login?returnTo=${encodeURIComponent("/docs/start/concepts/")}`,
      ),
      ctx.env,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const done = await handleAdminCallback(
      req(`${ORIGIN}/manage/callback?code=c&state=${state}`, {
        headers: { cookie: flowCookie(login) },
      }),
      ctx.env,
      ctx.db,
      NOW,
      {
        verify: async () => ({
          sub: "op-1",
          email: "op@plrs.im",
          name: "Operator",
          groups: ["platform-admins"],
        }),
      },
    );
    expect(done.status).toBe(302);
    // A3-04 kept the docs-gate destination working, which is what `returnTo` exists for.
    expect(done.headers.get("location")).toBe("/docs/start/concepts/");
    const session = await sessionFromRequest(
      ctx.env,
      req(`${ORIGIN}/manage/api/products`, {
        headers: { cookie: cookieNamed(done, "__Host-pkey_admin") },
      }),
      NOW,
    );
    expect(session?.sub).toBe("op-1");
    expect(session?.groups).toContain("platform-admins");
  });

  it("portal: both /login -> /callback and the magic link land a session /api/me answers", async () => {
    const ctx = await makeCtx();
    ctx.env.PORTAL_SESSION_SECRET = "portal-secret";
    ctx.env.PLATFORM_OIDC_ISSUER = ISSUER;
    ctx.env.PLATFORM_OIDC_CLIENT_ID = AUD;

    const login = await handlePortalLogin(
      req(`${ORIGIN}/login`),
      ctx.env,
      ctx.db,
    );
    const authorize = new URL(login.headers.get("location")!);
    installFetchMock(
      await signIdToken(ctx, {
        sub: "ada",
        email: "ada@corp.example",
        email_verified: true,
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    const done = await handlePortalCallback(
      req(
        `${ORIGIN}/callback?code=c&state=${authorize.searchParams.get("state")!}`,
        { headers: { cookie: flowCookie(login) } },
      ),
      ctx.env,
      ctx.db,
      NOW,
    );
    expect(done.status).toBe(302);
    const me = await handlePortalApi(
      req(`${ORIGIN}/api/me`, {
        headers: { cookie: cookieNamed(done, "__Host-pkey_portal") },
      }),
      ctx.env,
      ctx.db,
      "/api/me",
      NOW,
    );
    expect(me.status).toBe(200);
    expect((await me.json()) as { account: { email: string } }).toMatchObject({
      account: { email: "ada@corp.example" },
    });

    // …and the magic link, which has no flow binding at all (it is not a redirect flow).
    const sent: { link?: string } = {};
    ctx.env.EMAIL = {
      send: async (m: { text: string }) => {
        sent.link = m.text.split(/\s+/).find((w) => w.startsWith("https://"));
      },
    } as unknown as Env["EMAIL"];
    expect(
      (
        await handleMagicStart(
          req(`${ORIGIN}/api/magic/start`, {
            method: "POST",
            body: JSON.stringify({ email: "grace@corp.example" }),
          }),
          ctx.env,
          ctx.db,
        )
      ).status,
    ).toBe(200);
    const verified = await handleMagicVerify(
      req(sent.link!),
      ctx.env,
      ctx.db,
      NOW,
    );
    expect(verified.status).toBe(302);
    const magicMe = await handlePortalApi(
      req(`${ORIGIN}/api/me`, {
        headers: { cookie: cookieNamed(verified, "__Host-pkey_portal") },
      }),
      ctx.env,
      ctx.db,
      "/api/me",
      NOW,
    );
    expect(
      (await magicMe.json()) as { account: { email: string } },
    ).toMatchObject({ account: { email: "grace@corp.example" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REFUTED — hypotheses that did NOT hold
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8 refuted", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await makeCtx();
  });

  it("REFUTED: the nonce binding is real — a token without a nonce is rejected", async () => {
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    installFetchMock(await signIdToken(ctx, { sub: "u", groups: ["family"] }));
    expect((await callback(ctx, "S")).status).toBe(401);
  });

  it("REFUTED: HMAC-signed ID tokens are rejected (asymmetric algs only)", async () => {
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
    });
    const hs = await new SignJWT({ sub: "u", groups: ["family"], nonce: "N" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("0123456789abcdef0123456789abcdef"));
    installFetchMock(hs);
    expect((await callback(ctx, "S")).status).toBe(401);
  });

  it("REFUTED: a claim value cannot hijack the templated-secret HOST — encodeURIComponent blocks / : @", async () => {
    await ctx.db.run(
      `INSERT INTO provisioning_config (product, claim, entitlement_key,
         entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "s",
      null,
      null,
      "proxy.url",
      "https://vpn.example/{claim}",
      JSON.stringify(["vpn.example"]),
    );
    const payload = { config: {}, secrets: {}, entitlements: {} };
    await applyProvisioning(
      ctx.env,
      ctx.db,
      "djdl",
      { sub: "u", groups: [], claims: { s: "@evil.test/x" } },
      payload,
      NOW,
    );
    const v = (payload.secrets as Record<string, { value: string }>)[
      "proxy.url"
    ]!.value;
    expect(new URL(v).host).toBe("vpn.example");
  });

  it("REFUTED: /auth/poll cannot mint on a license that is disabled or expired", async () => {
    const r = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "u", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    await ctx.db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = 'djdl' AND id = ?",
      r.licenseId,
    );
    // Bound + confirmed, so the poll gets all the way to the mint and it is `licenseUsable`
    // — not the R8-01 device binding — that refuses.
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
      deviceId: "dev-1",
      confirmedAt: NOW,
      licenseId: r.licenseId,
    });
    const out = (await (await poll(ctx, "S", "dev-1")).json()) as {
      status: string;
    };
    expect(out.status).toBe("error");
    expect(await getLicense(ctx.db, "djdl", r.licenseId)).toBeTruthy();
  });

  it("REFUTED: the poll surface never echoes an IdP failure reason", async () => {
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
      error: "id-token-invalid",
    });
    const res = await poll(ctx, "S", "ATTACKER");
    expect(await res.text()).not.toContain("id-token-invalid");
  });

  it("REFUTED: cross-product state confusion is blocked by the product-scoped KV namespace", async () => {
    await seedProduct(ctx.db, "other");
    await ctx.db.run(
      `INSERT INTO oidc_config (product, provider, issuer, client_id,
         client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)`,
      "other",
      "custom",
      ISSUER,
      AUD,
      null,
      JSON.stringify([`${ORIGIN}/other/identity/auth/callback`]),
      JSON.stringify({ family: { role: "user" } }),
    );
    const other = (await loadProduct(ctx.env, ctx.db, "other"))!;
    const r = await activateFromIdentity(
      ctx.env,
      ctx.db,
      ctx.product,
      { sub: "u", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow(ctx, "S", {
      verifier: "v",
      nonce: "N",
      redirectUri: REDIRECT,
      licenseId: r.licenseId,
    });
    const res = await handleAuthPoll(
      req(`${ORIGIN}/other/auth/poll?state=S&device=ATTACKER`),
      ctx.env,
      ctx.db,
      other,
      NOW,
    );
    expect(((await res.json()) as { status: string }).status).toBe("timeout");
  });
});
