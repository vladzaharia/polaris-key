/**
 * RED TEAM R8 — OIDC / OAuth / identity-bootstrap attacks. **REMEDIATED — INVERTED.**
 *
 * Every `it()` here was originally the attacker's claim, and a passing test meant the attack
 * WORKED. The titles are unchanged so the mapping to docs/security/findings/R8-oidc.md
 * survives, but each body now asserts the attack FAILS: this file is the regression suite for
 * the R8 fixes in src/oidc.ts. Each block names the finding id it locks down.
 *
 * Two findings are deliberately NOT fixed and their tests still assert the (unchanged)
 * behaviour: R8-03 (no browser binding on any of the three flows) and R8-07
 * (`redirect_uris_json` fails open on NULL). See the Remediation section of the finding doc.
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
import { makeTestDb } from "../helpers.js";
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
  flowKey,
  deviceFlowKey,
} from "../../src/services/identity/oidc.js";
import { handleLicenseDocument } from "../../src/services/license/document.js";
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
  portalFlowKey,
  portalMagicKey,
} from "../../src/services/identity/portal/auth.js";
import { handleAdminCallback, handleAdminLogin } from "../../src/admin/auth.js";
import { hashKey, randomId } from "../../src/crypto.js";
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

const callback = (ctx: Ctx, state: string, code = "auth-code") =>
  handleAuthCallback(
    req(`${ORIGIN}/djdl/identity/auth/callback?code=${code}&state=${state}`),
    ctx.env,
    ctx.db,
    ctx.product,
    NOW,
  );

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
      await deviceFlowKey(ctx.env, "djdl", "DC"),
      JSON.stringify({
        state: "S",
        deviceId: "victim-cli",
        userCode: "AAAA-BBBB",
        authorizeUrl: `${ISSUER}/authorize?state=S`,
      }),
    );
    const r = await activateFromIdentity(
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify(flow),
    );

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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ ...flow, confirmedAt: NOW }),
    );
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
    const { deviceCode, verificationUri, verificationUriComplete } =
      (await start.json()) as {
        deviceCode: string;
        verificationUri: string;
        verificationUriComplete: string;
      };
    // NOT FIXED (documented residual): the "show the user a URL" value is still the secret
    // device code — splitting it into an independent user code is an RFC 8628 redesign that
    // would change the public device-flow contract.
    expect(verificationUri).toBe(verificationUriComplete);
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
    const stored = JSON.parse(
      (await ctx.env.HOT.get(
        await deviceFlowKey(ctx.env, "djdl", deviceCode),
      ))!,
    ) as { confirmedAt?: number };
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
    const after = JSON.parse(
      (await ctx.env.HOT.get(
        await deviceFlowKey(ctx.env, "djdl", deviceCode),
      ))!,
    ) as { confirmedAt?: number };
    expect(after.confirmedAt).toBeTruthy();
  });

  // R8-02 — the confirmation page no longer leaks the device code through the Referer chain.
  it("ATTACK: the confirmation page ships no security headers and no referrer policy while the URL holds the device code", async () => {
    await ctx.env.HOT.put(
      await deviceFlowKey(ctx.env, "djdl", "DC"),
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
    // NOT FIXED (documented residual): the user code is still derived from the device code.
    //
    // Assert against the exact construction rather than stripping dashes. `deviceCode` is
    // base64url, whose alphabet INCLUDES `-`, so `userCode.replace("-", "")` removed whichever
    // dash came first — sometimes one belonging to the code itself rather than the separator.
    // That made this test fail roughly whenever the first 8 characters happened to contain a
    // dash: a real flake, not a real regression.
    const head = body.deviceCode.slice(0, 8).toUpperCase();
    expect(body.userCode).toBe(`${head.slice(0, 4)}-${head.slice(4, 8)}`);
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
// R8-03 — login CSRF: no flow is bound to the visitor's browser
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

    // Nothing browser-derived was persisted: no cookie, no IP, no UA, no CSRF nonce.
    const flow = JSON.parse(
      (await ctx.env.HOT.get(await flowKey(ctx.env, "djdl", state)))!,
    ) as Record<string, unknown>;
    expect(Object.keys(flow).sort()).toEqual([
      "nonce",
      "redirectUri",
      "returnTo",
      "verifier",
    ]);

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
    expect(res.status).toBe(302);
    // The victim's browser is now logged in as the ATTACKER's license.
    expect(res.headers.get("set-cookie")).toContain("pkey_djdl_session=");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/djdl/app`);
  });

  it("ATTACK: safeReturnTo lets the PRODUCT flow land on /manage paths that the portal twin explicitly forbids", async () => {
    const res = await handleAuthStart(
      req(
        `${ORIGIN}/djdl/auth/start?return_to=${encodeURIComponent(`${ORIGIN}/manage/products/djdl`)}`,
      ),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    expect(res.status).toBe(302); // portal/auth.ts:100 would have rejected this
    const state = new URL(res.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const flow = JSON.parse(
      (await ctx.env.HOT.get(await flowKey(ctx.env, "djdl", state)))!,
    ) as {
      returnTo: string;
    };
    expect(flow.returnTo).toBe(`${ORIGIN}/manage/products/djdl`);
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
    const adminKey = `admin:flow:${await hashKey(state, ctx.env.KEY_HASH_PEPPER)}`;
    expect(adminKey).not.toContain(state);

    // The admin flow record holds only PKCE material — nothing tied to the browser.
    const flow = JSON.parse((await ctx.env.HOT.get(adminKey))!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(flow).sort()).toEqual([
      "nonce",
      "redirectUri",
      "verifier",
    ]);

    // Replaying the attacker's callback from a DIFFERENT browser still issues the cookie.
    const res = await handleAdminCallback(
      req(`${ORIGIN}/manage/callback?code=c&state=${state}`, {
        headers: { cookie: "unrelated=1", "user-agent": "VictimBrowser/1.0" },
      }),
      ctx.env,
      ctx.db,
      NOW,
      {
        verify: async () => ({
          sub: "attacker-admin",
          email: "attacker@evil.test",
          name: "Mallory",
          groups: ["platform-admins"],
        }),
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("pkey_admin=");
    expect(res.headers.get("location")).toBe("/manage/");
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
    const flow = JSON.parse(
      (await ctx.env.HOT.get(await portalFlowKey(ctx.env, state)))!,
    ) as Record<string, unknown>;
    expect(Object.keys(flow).sort()).toEqual([
      "nonce",
      "redirectUri",
      "verifier",
    ]);

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
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("pkey_portal=");
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
      await ctx.env.HOT.put(
        await flowKey(ctx.env, "djdl", state),
        JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
      );
      vi.restoreAllMocks();
      installFetchMock(
        await signIdToken(ctx, { email, groups: ["family"], nonce: "N" }), // no `sub`
      );
      // FIXED: the product flow now matches admin (admin/auth.ts:216) and portal
      // (portal/auth.ts:280) — a generic 401, indistinguishable from any other bad token.
      const res = await callback(ctx, state);
      expect(res.status).toBe(401);
      // The flow is consumed on failure, so the poller cannot learn the reason either.
      expect(
        await ctx.env.HOT.get(await flowKey(ctx.env, "djdl", state)),
      ).toBeNull();
    }
    const rows = await ctx.db.all<{ id: string; sub: string; email: string }>(
      "SELECT id, sub, email FROM licenses WHERE product = 'djdl'",
    );
    expect(rows).toHaveLength(0);

    // A non-string `sub` is not coerced into one either (123 must not collide with "123").
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "s-typed"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
    vi.restoreAllMocks();
    installFetchMock(
      await signIdToken(ctx, { sub: 123, groups: ["family"], nonce: "N" }),
    );
    expect((await callback(ctx, "s-typed")).status).toBe(401);
  });

  // R8-05b — only a verified email is persisted or signed.
  it("ATTACK: an UNVERIFIED `email` claim is signed into the config document's identity profile", async () => {
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S2"),
      JSON.stringify({
        verifier: "v",
        nonce: "N",
        redirectUri: REDIRECT,
        deviceId: "dev-1",
        confirmedAt: NOW,
        licenseId: lic!.id,
      }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S3"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S-fresh"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
// R8-08 — magic link: 72-bit token, unhashed KV key (fixed, R12-04), no verify rate limit
// ═══════════════════════════════════════════════════════════════════════════════
describe("R8-08 portal magic link", () => {
  it("ATTACK: the magic token is 72 bits (FIXED R12-04: it is no longer its own KV key name)", async () => {
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

    // The secret is in the QUERY STRING of the emailed link.
    const token = new URL(sent.link!).searchParams.get("token")!;
    expect(token.startsWith("magic_")).toBe(true);
    // randomId => 9 random bytes = 72 bits (crypto.ts:42-44). Compare: browser-session and
    // download tokens are 256-bit AND peppered-hashed at rest.
    expect(token.slice("magic_".length).length).toBe(12); // 9 bytes b64url

    // FIXED (R12-04): the KV key is `portal:magic:<hashKey(token, pepper)>`, so a listing of
    // the HOT namespace no longer yields a working token. The value still names the target
    // email (the record shape is unchanged).
    expect(kv.keys().some((k) => k.includes(token))).toBe(false);
    const magicKey = await portalMagicKey(env, token);
    expect(kv.keys()).toContain(magicKey);
    expect(await kv.get(magicKey)).toContain("victim@corp.com");

    // The emailed token itself still signs the holder in.
    const verified = await handleMagicVerify(
      req(
        `https://key.plrs.im/magic/verify?token=${encodeURIComponent(token)}`,
      ),
      env,
      db,
      NOW,
    );
    expect(verified.status).toBe(302);
    expect(verified.headers.get("set-cookie")).toContain("pkey_portal=");
  });

  it("ATTACK: /magic/verify has NO rate limit, unlike /magic/start", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.PORTAL_SESSION_SECRET = "s";
    await seedProduct(db, "djdl");
    const rlSpy = vi.spyOn(env.RL, "get");
    for (let i = 0; i < 100; i++) {
      const res = await handleMagicVerify(
        req(`https://key.plrs.im/magic/verify?token=${randomId("magic")}`),
        env,
        db,
        NOW,
      );
      expect(res.status).toBe(400); // "expired", never 429
    }
    expect(rlSpy).not.toHaveBeenCalled();

    // Control: the START surface IS limited.
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
    expect(rlSpy).toHaveBeenCalled();
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
    installFetchMock(await signIdToken(ctx, { sub: "u", groups: ["family"] }));
    expect((await callback(ctx, "S")).status).toBe(401);
  });

  it("REFUTED: HMAC-signed ID tokens are rejected (asymmetric algs only)", async () => {
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({ verifier: "v", nonce: "N", redirectUri: REDIRECT }),
    );
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
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({
        verifier: "v",
        nonce: "N",
        redirectUri: REDIRECT,
        deviceId: "dev-1",
        confirmedAt: NOW,
        licenseId: r.licenseId,
      }),
    );
    const out = (await (await poll(ctx, "S", "dev-1")).json()) as {
      status: string;
    };
    expect(out.status).toBe("error");
    expect(await getLicense(ctx.db, "djdl", r.licenseId)).toBeTruthy();
  });

  it("REFUTED: the poll surface never echoes an IdP failure reason", async () => {
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({
        verifier: "v",
        nonce: "N",
        redirectUri: REDIRECT,
        error: "id-token-invalid",
      }),
    );
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
      ctx.db,
      ctx.product,
      { sub: "u", groups: ["family"], claims: {} },
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    await ctx.env.HOT.put(
      await flowKey(ctx.env, "djdl", "S"),
      JSON.stringify({
        verifier: "v",
        nonce: "N",
        redirectUri: REDIRECT,
        licenseId: r.licenseId,
      }),
    );
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
