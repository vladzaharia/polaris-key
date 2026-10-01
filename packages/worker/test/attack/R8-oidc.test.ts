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
 * R8-02's two residuals (the device code in `verificationUri`, and `userCode` derived from it)
 * were closed by P1-06's RFC 8628 user-code page; their PoCs below now assert the fix. P1-06's
 * security review found that the public user code then sufficed to confirm someone else's flow
 * and, through the callback's enrolled-license merge, claim or retire the victim device's
 * anonymous license; the callback no longer merges, and `R8-02 / P1-06 a user-code holder
 * cannot claim…` asserts it. P1-07 brought the merge back as an opt-in only the device-code
 * holder can make at `/device/poll`, after the device was shown the signed-in identity; the same
 * block asserts a user-code holder still cannot trigger it (claim and migrate).
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
import { FINGERPRINT_COMPONENT_LENGTH } from "@polaris-key/protocol";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  NOW,
  seedProduct,
  DJDL_CATALOG,
  TEST_KID,
  TEST_PUB,
  mkReq,
} from "../seed.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import {
  activateFromIdentity,
  applyProvisioning,
  handleAuthCallback,
  handleAuthDevicePoll,
  handleAuthDeviceEntry,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthPoll,
  handleAuthStart,
  flowKey,
  deviceFlowKey,
  deviceUserKey,
} from "../../src/services/identity/oidc.js";
import { handleLicenseDocument } from "../../src/services/license/document.js";
// Wire v3 split `validateDeviceToken` in two: core answers "is this token a live device row",
// and `requireLicensedDevice` adds back the licence-usability check core used to apply inline.
// The latter is the exact behavioural equivalent of the pre-split core function, so it is what
// these tests assert against.
import { requireLicensedDevice } from "../../src/services/license/auth.js";
import { authorizeDevice } from "../../src/core/authz.js";
import {
  countActiveDevices,
  getDevice,
  getLicense,
  getLicenseBySub,
} from "../../src/repo.js";
import { handleEnroll } from "../../src/services/license/enroll.js";
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

    // 5. P1-06: a device-code flow does not redeem on /auth/poll at all, not even for the
    //    device that started it — `state` plus the device id is not a credential. The
    //    legitimate device completes where it always polled: /auth/device/poll, with the
    //    secret device code. The fix closes the hole, not the flow.
    const viaState = (await (await poll(ctx, state, "victim-cli")).json()) as {
      status: string;
      token?: string;
    };
    expect(viaState.status).toBe("error");
    expect(viaState.token).toBeUndefined();
    const victim = (await (
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
    await counted("authDeviceEntry", () =>
      handleAuthDeviceEntry(
        req(`${ORIGIN}/djdl/identity/auth/device?user_code=BCDF-GHJK`),
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
    // FIXED (P1-06; was the documented residual): the "show the user a URL" values are the
    // RFC 8628 user-code page, which never carries the secret device code. The human types
    // (or scans) the independent user code; the lookup stays server-side.
    expect(verificationUri).not.toBe(verificationUriComplete);
    expect(verificationUri).toBe(`${ORIGIN}/djdl/identity/auth/device`);
    expect(verificationUriComplete).toMatch(
      /\/djdl\/identity\/auth\/device\?user_code=[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    for (const uri of [verificationUri, verificationUriComplete]) {
      expect(uri).not.toContain(deviceCode);
      expect(uri).not.toContain(encodeURIComponent(deviceCode));
    }
    // …and the page a QR scan lands on shows the flow without ever echoing the device code.
    const scanned = await handleAuthDeviceEntry(
      req(verificationUriComplete),
      ctx.env,
      ctx.product,
    );
    expect(scanned.status).toBe(200);
    const scannedHtml = await scanned.text();
    expect(scannedHtml).not.toContain(deviceCode);
    expect(scannedHtml).not.toContain("device_code");

    // The legacy by-device-code page below is kept for flows in flight across the deploy; its
    // own hardening is unchanged.

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

  // P1-06 review: the user code is shown large and rendered as a QR code, so it must not be a
  // path to the victim's token. The chain was: the page shows the raw device id when no
  // deviceName was sent; a POST with the page's csrf 303s to the authorize URL, which carries
  // `state`; and /auth/poll redeemed exactly `state` + device id once the victim signed in.
  it("ATTACK: holding only the user code, an attacker reads the device id and `state` off the page and steals the victim's token on /auth/poll", async () => {
    const started = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "victim-cli" }), // no deviceName
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const { deviceCode, userCode } = (await started.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const ENTRY = `${ORIGIN}/djdl/identity/auth/device`;
    const entryPost = (fields: Record<string, string>, ip: string) =>
      handleAuthDeviceEntry(
        req(ENTRY, {
          method: "POST",
          // What a browser sends from this no-referrer page.
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "null",
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": ip,
          },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx.env,
        ctx.product,
      );

    // 1. The attacker (a stream viewer, a photo of the QR code, a lucky guess) opens the page.
    //    FIXED: it no longer shows the raw device id.
    const attackerPage = await handleAuthDeviceEntry(
      req(`${ENTRY}?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "198.51.100.66" },
      }),
      ctx.env,
      ctx.product,
    );
    expect(attackerPage.status).toBe(200);
    const attackerHtml = await attackerPage.text();
    expect(attackerHtml).not.toContain("victim-cli");
    expect(attackerHtml).toContain("Unnamed device");

    // 2. The victim confirms on their own phone and goes on to the IdP.
    const victimPage = await handleAuthDeviceEntry(
      req(`${ENTRY}?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "203.0.113.20" },
      }),
      ctx.env,
      ctx.product,
    );
    const csrf = (await victimPage.text()).match(
      /name="csrf" value="([^"]+)"/,
    )![1]!;
    const confirmed = await entryPost(
      { user_code: userCode, csrf },
      "203.0.113.20",
    );
    expect(confirmed.status).toBe(303);
    const authorize = new URL(confirmed.headers.get("location")!);

    // 3. FIXED: after confirmation the code is retired. The attacker can no longer re-render
    //    the page, re-mint a csrf token, or be 303'd to the authorize URL.
    const again = await handleAuthDeviceEntry(
      req(`${ENTRY}?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "198.51.100.66" },
      }),
      ctx.env,
      ctx.product,
    );
    expect(again.status).toBe(404);
    expect(await again.text()).not.toContain('name="csrf"');
    expect(
      (await entryPost({ user_code: userCode }, "198.51.100.66")).status,
    ).toBe(404);

    // 4. Grant the attacker the strongest position anyway: `state` (as if they had confirmed
    //    first and been 303'd) AND the device id. The victim signs in at the IdP.
    const state = authorize.searchParams.get("state")!;
    installFetchMock(
      await signIdToken(ctx, {
        sub: "victim-sub",
        email: "victim@corp.com",
        email_verified: true,
        groups: ["family"],
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    expect((await callback(ctx, state)).status).toBe(200);

    // 5. FIXED: /auth/poll refuses a device-code flow outright — generic error, no token.
    const stolen = (await (await poll(ctx, state, "victim-cli")).json()) as {
      status: string;
      token?: string;
    };
    expect(stolen.status).toBe("error");
    expect(stolen.token).toBeUndefined();

    // 6. The flow is intact, and the real device — holding the device code — gets its token.
    const real = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "victim-cli" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token?: string };
    expect(real.status).toBe("ready");
    expect(real.token?.startsWith("pkeyt_")).toBe(true);
  });

  // OPEN — R1-07 (Fixed-partial) rooted in R8-03. This PoC asserts the GAP, not a fix: the
  // user-code page does not stop the flow's STARTER, who can confirm their own flow with no
  // browser at all and phish the resulting IdP authorize URL. Neither the Fetch Metadata /
  // Origin check nor the single-use csrf token is a control here — the starter mints the token.
  it("OPEN (R1-07 / R8-03): the starter confirms its own flow from curl, phishes the authorize URL, and polls a token on the victim's license", async () => {
    const started = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "attacker-device" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const { deviceCode, userCode } = (await started.json()) as {
      deviceCode: string;
      userCode: string;
    };
    const ENTRY = `${ORIGIN}/djdl/identity/auth/device`;
    // 1. The attacker reads the csrf token off the page for their OWN code…
    const page = await handleAuthDeviceEntry(
      req(`${ENTRY}?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "198.51.100.66" },
      }),
      ctx.env,
      ctx.product,
    );
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1]!;
    // 2. …and POSTs it with no Origin and no Sec-Fetch-Site, as curl does. It confirms.
    const confirmed = await handleAuthDeviceEntry(
      req(ENTRY, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.66",
        },
        body: new URLSearchParams({ user_code: userCode, csrf }).toString(),
      }),
      ctx.env,
      ctx.product,
    );
    expect(confirmed.status).toBe(303);
    // 3. The attacker now holds the IdP authorize URL (state, nonce, PKCE challenge).
    const authorize = new URL(confirmed.headers.get("location")!);
    expect(authorize.origin).toBe("https://id.example");
    // 4. A victim who signs in at that URL (or is silently SSO'd) never sees the Polaris page.
    installFetchMock(
      await signIdToken(ctx, {
        sub: "victim-sub",
        email: "victim@corp.com",
        email_verified: true,
        groups: ["family"],
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    expect(
      (await callback(ctx, authorize.searchParams.get("state")!)).status,
    ).toBe(200);
    // 5. GAP: the attacker's device, with its own device code, receives a token on the
    //    victim's license. Fix direction (unowned): bind a viaDeviceCode flow's callback to the
    //    browser that confirmed it (a __Host- SameSite=Lax cookie set on the confirmation 303).
    const stolen = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "attacker-device" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token?: string };
    expect(stolen.status).toBe("ready");
    expect(stolen.token?.startsWith("pkeyt_")).toBe(true);
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
    // FIXED (P1-06; was the documented residual): the user code is drawn independently from
    // RFC 8628 §6.1's consonant alphabet, so it reveals nothing about the device code.
    //
    // Assert against the exact OLD construction rather than stripping dashes: `deviceCode` is
    // base64url, whose alphabet INCLUDES `-`, so a dash-stripping comparison flaked whenever
    // the first 8 characters happened to contain one.
    const head = body.deviceCode.slice(0, 8).toUpperCase();
    expect(body.userCode).not.toBe(`${head.slice(0, 4)}-${head.slice(4, 8)}`);
    expect(body.userCode).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    // Only the peppered hash of the code names its index key (R12-04).
    const normalised = body.userCode.replace("-", "");
    expect(
      await ctx.env.HOT.get(await deviceUserKey(ctx.env, "djdl", normalised)),
    ).toBe(body.deviceCode);
    for (const key of ctx.kv.keys()) expect(key).not.toContain(normalised);
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
// R8-02 / P1-06 — a user-code holder must not claim or retire the device's license
// ═══════════════════════════════════════════════════════════════════════════════
// P1-06 security review: once the RFC 8628 page made the PUBLIC user code enough to confirm a
// device-code flow, the callback's merge (`enrolledLicenseId` from `flow.deviceId`) let whoever
// confirmed first and signed in under their OWN identity take the victim device's anonymous
// enrolled license (Case 1: `sub` rewritten to the attacker) or retire it into theirs (Case 2:
// devices migrated, row disabled, `enroll_hwid` kept so the machine could never enrol again).
// FIXED (fail closed): the callback applies no enrolled license at all. A device-code sign-in
// yields only what an ordinary sign-in for that identity yields.
describe("R8-02 / P1-06 a user-code holder cannot claim the device's anonymous license", () => {
  let ctx: Ctx;
  const VICTIM_MACHINE = {
    machineUuid: "uuid-victim".padEnd(FINGERPRINT_COMPONENT_LENGTH, "x"),
    boardSerial: "board-victim".padEnd(FINGERPRINT_COMPONENT_LENGTH, "x"),
    cpuModel: "cpu-victim".padEnd(FINGERPRINT_COMPONENT_LENGTH, "x"),
  };
  const ATTACKER = {
    sub: "attacker-sub",
    email: "attacker@evil.example",
    name: "Attacker",
    groups: ["family"],
    claims: {} as Record<string, unknown>,
  };

  beforeEach(async () => {
    ctx = await makeCtx();
    // Anonymous enrolment on, landing on the seeded `pro` tier.
    await ctx.db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "pro", mode: "both" }),
      "djdl",
    );
    ctx.product = (await loadProduct(ctx.env, ctx.db, "djdl"))!;
  });

  const enroll = (deviceId: string) =>
    handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": deviceId },
        { fingerprint: { components: VICTIM_MACHINE, hwid: "ignored" } },
      ),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );

  /** The reviewer's PoC up to the callback: the victim's enrolled game starts a device-code
   *  flow; the attacker, holding ONLY the user code, GETs the page, POSTs its csrf with no
   *  Origin (curl), and completes the IdP login as `attacker-sub`. */
  function attackerConfirmsVictimFlow(): Promise<VictimFlow> {
    return confirmVictimFlowAs(ATTACKER);
  }

  interface VictimFlow {
    victimLicense: string;
    /** The victim game's device token on its anonymous enrolled licence. */
    victimToken: string;
    deviceCode: string;
    /** The flow's `state`, which the confirming browser saw on the authorize URL. */
    state: string;
  }

  /** The same flow, confirmed by user code and signed in as `who` — the attacker above, or the
   *  player themselves (P1-07's legitimate attach). */
  async function confirmVictimFlowAs(
    who: {
      sub: string;
      email: string;
      groups: string[];
    },
    callbackStatus = 200,
  ): Promise<VictimFlow> {
    const enrolled = await enroll("victim-game");
    expect(enrolled.status).toBe(200);
    const enrolledBody = (await enrolled.json()) as {
      license: { id: string };
      token: string;
    };
    const victimLicense = enrolledBody.license.id;

    const started = await handleAuthDeviceStart(
      req(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        body: JSON.stringify({ deviceId: "victim-game" }),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
    );
    const { deviceCode, userCode } = (await started.json()) as {
      deviceCode: string;
      userCode: string;
    };

    const ENTRY = `${ORIGIN}/djdl/identity/auth/device`;
    const page = await handleAuthDeviceEntry(
      req(`${ENTRY}?user_code=${userCode}`, {
        headers: { "cf-connecting-ip": "198.51.100.66" },
      }),
      ctx.env,
      ctx.product,
    );
    const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1]!;
    const confirmed = await handleAuthDeviceEntry(
      req(ENTRY, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.66",
        },
        body: new URLSearchParams({ user_code: userCode, csrf }).toString(),
      }),
      ctx.env,
      ctx.product,
    );
    expect(confirmed.status).toBe(303);
    const authorize = new URL(confirmed.headers.get("location")!);
    installFetchMock(
      await signIdToken(ctx, {
        sub: who.sub,
        email: who.email,
        email_verified: true,
        groups: who.groups,
        nonce: authorize.searchParams.get("nonce")!,
      }),
    );
    const state = authorize.searchParams.get("state")!;
    expect((await callback(ctx, state)).status).toBe(callbackStatus);
    return {
      victimLicense,
      victimToken: enrolledBody.token,
      deviceCode,
      state,
    };
  }

  async function expectVictimUntouched(victimLicense: string): Promise<void> {
    const row = await getLicense(ctx.db, "djdl", victimLicense);
    expect(row?.sub).toBeNull();
    expect(row?.origin).toBe("enroll");
    expect(row?.status).toBe("active");
    expect(row?.email).toBeNull();
    // Its device was not migrated off it.
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      victimLicense,
    );
    expect(await countActiveDevices(ctx.db, "djdl", victimLicense)).toBe(1);
    // No merge was audited.
    const merges = await ctx.db.all(
      "SELECT id FROM audit WHERE product = 'djdl' AND action = 'license.merge'",
    );
    expect(merges).toHaveLength(0);
    // The victim machine can still enrol: it gets its own anonymous license back, not
    // `enroll_claimed` (Case 1) or a disabled row (Case 2).
    const again = await enroll("victim-game-reinstalled");
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { license: { id: string } }).license.id,
    ).toBe(victimLicense);
  }

  it("ATTACK (Case 1): an attacker with no license of their own confirms by user code and signs in — the victim's anonymous license is NOT re-subjected to them", async () => {
    const { victimLicense } = await attackerConfirmsVictimFlow();
    await expectVictimUntouched(victimLicense);

    // P1-07: a device-code callback activates nothing at all — the activation waits for the
    // device-code holder's poll — so the attacker does not even get a licence row from it.
    expect(await getLicenseBySub(ctx.db, "djdl", ATTACKER.sub)).toBeNull();
    // An ordinary sign-in from the attacker's own devices gets a NEW licence of their own and
    // never reaches the victim's row.
    const later = await activateFromIdentity(
      ctx.db,
      ctx.product,
      ATTACKER,
      NOW,
    );
    expect("licenseId" in later && later.licenseId).not.toBe(victimLicense);
    const own = await getLicenseBySub(ctx.db, "djdl", ATTACKER.sub);
    expect(own!.id).not.toBe(victimLicense);
    expect(own!.sub).toBe(ATTACKER.sub);
  });

  it("ATTACK (Case 2): an attacker who already has a license confirms by user code — the victim's devices are NOT migrated and the victim's license is NOT disabled", async () => {
    const pre = await activateFromIdentity(ctx.db, ctx.product, ATTACKER, NOW);
    const attackerLicense = (pre as { licenseId: string }).licenseId;

    const { victimLicense } = await attackerConfirmsVictimFlow();
    await expectVictimUntouched(victimLicense);

    // The attacker's license is still just theirs, with none of the victim's devices on it.
    expect((await getLicenseBySub(ctx.db, "djdl", ATTACKER.sub))?.id).toBe(
      attackerLicense,
    );
    expect(await countActiveDevices(ctx.db, "djdl", attackerLicense)).toBe(0);
  });

  it("the attacker holds no device code, so nothing redeems the flow for them; only the device-code holder can complete it, onto the attacker's OWN license", async () => {
    const { victimLicense, deviceCode } = await attackerConfirmsVictimFlow();
    // A guessed device code redeems nothing.
    const guessed = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({
            deviceCode: "not-the-device-code",
            deviceId: "attacker-device",
          }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token?: string };
    expect(guessed.token).toBeUndefined();
    // The real device code, presented with another device id, redeems nothing either.
    const wrongDevice = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "attacker-device" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as { status: string; token?: string };
    expect(wrongDevice.token).toBeUndefined();
    // And the victim's license is still theirs, anonymous and active.
    const row = await getLicense(ctx.db, "djdl", victimLicense);
    expect(row?.sub).toBeNull();
    expect(row?.status).toBe("active");

    // RESIDUAL (documented in THREAT-MODEL.md): the victim's own game, which holds the device
    // code, keeps polling and is signed in to the ATTACKER's own license — a mis-binding the
    // player sees on the device, bound only through the device-code holder. It moves that one
    // device; it never touches the victim's license, which stays anonymous, active and
    // re-enrollable, and it hands the attacker no token.
    const polled = (await (
      await handleAuthDevicePoll(
        req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
          method: "POST",
          body: JSON.stringify({ deviceCode, deviceId: "victim-game" }),
        }),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      )
    ).json()) as {
      status: string;
      token?: string;
      identity?: { name?: string; email?: string };
      attached?: string;
    };
    expect(polled.status).toBe("ready");
    // P1-07: the ready answer names who the device is now signed in as, so the player sees the
    // mis-binding on the device; and with no opt-in nothing was attached.
    expect(polled.identity?.email).toBe(ATTACKER.email);
    expect(polled.attached).toBeUndefined();
    const attackerLicense = (await getLicenseBySub(
      ctx.db,
      "djdl",
      ATTACKER.sub,
    ))!.id;
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      attackerLicense,
    );
    const after = await getLicense(ctx.db, "djdl", victimLicense);
    expect(after?.sub).toBeNull();
    expect(after?.origin).toBe("enroll");
    expect(after?.status).toBe("active");
    const reenrolled = await enroll("victim-game");
    expect(reenrolled.status).toBe(200);
    expect(
      ((await reenrolled.json()) as { license: { id: string } }).license.id,
    ).toBe(victimLicense);
  });

  // ── P1-07: the opt-in "attach this device's anonymous licence to my account" ────────────
  //
  // The merge P1-06 removed from the callback comes back as an explicit opt-in that only the
  // device-code holder can make, at `/device/poll`: the device asks to be shown the signed-in
  // identity (`confirmIdentity`), the player accepts it ON THE DEVICE, and only then does a
  // poll carrying `attachLicense: true` and the device's own token apply the claim or migrate.

  type PollBody = {
    status: string;
    token?: string;
    interval?: number;
    identity?: { name?: string; email?: string };
    attachable?: boolean;
    attached?: string;
  };

  async function devicePoll(
    body: Record<string, unknown>,
    at: number,
    token?: string,
  ): Promise<{ status: number; body: PollBody }> {
    const res = await handleAuthDevicePoll(
      req(`${ORIGIN}/djdl/identity/auth/device/poll`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      }),
      ctx.env,
      ctx.db,
      ctx.product,
      at,
    );
    return { status: res.status, body: (await res.json()) as PollBody };
  }

  const PLAYER = {
    sub: "player-sub",
    email: "player@example.com",
    name: "Player",
    groups: ["family"],
    claims: {} as Record<string, unknown>,
  };

  async function expectNoMerge(victimLicense: string): Promise<void> {
    const row = await getLicense(ctx.db, "djdl", victimLicense);
    expect(row?.sub).toBeNull();
    expect(row?.origin).toBe("enroll");
    expect(row?.status).toBe("active");
    const merges = await ctx.db.all(
      "SELECT id FROM audit WHERE product = 'djdl' AND action = 'license.merge'",
    );
    expect(merges).toHaveLength(0);
  }

  it("ATTACK (claim, P1-07): a user-code holder with no licence who signed in as themselves can reach no surface that applies the attach", async () => {
    const { victimLicense, state } = await attackerConfirmsVictimFlow();
    // The `state` surface — the one half of a credential the confirming browser holds — refuses
    // a device-code flow outright, whatever the attach fields say.
    for (const extra of ["", "&confirmIdentity=true&attachLicense=true"]) {
      const res = await handleAuthPoll(
        req(
          `${ORIGIN}/djdl/identity/auth/poll?state=${encodeURIComponent(state)}&device=victim-game${extra}`,
        ),
        ctx.env,
        ctx.db,
        ctx.product,
        NOW,
      );
      expect(await res.json()).toEqual({ status: "error" });
    }
    // `/device/poll` needs the device code, which never left the victim's game: a guessed one
    // with the attach fields and the attacker's own enrolled token is an unknown flow.
    const own = await enroll("attacker-box");
    const ownToken = ((await own.json()) as { token: string }).token;
    for (const deviceId of ["victim-game", "attacker-box"]) {
      const guessed = await devicePoll(
        {
          deviceCode: "not-the-device-code",
          deviceId,
          confirmIdentity: true,
          attachLicense: true,
        },
        NOW,
        ownToken,
      );
      expect(guessed.body.status).toBe("timeout");
      expect(guessed.body.token).toBeUndefined();
    }
    await expectNoMerge(victimLicense);
    // The attacker's sign-in created no licence at all: nothing is activated until the
    // device-code holder polls.
    expect(await getLicenseBySub(ctx.db, "djdl", ATTACKER.sub)).toBeNull();
  });

  it("ATTACK (migrate, P1-07): a user-code holder who already has a licence can reach no surface that applies the attach, and an ordinary poll by the victim device migrates nothing", async () => {
    const pre = await activateFromIdentity(ctx.db, ctx.product, ATTACKER, NOW);
    const attackerLicense = (pre as { licenseId: string }).licenseId;
    const { victimLicense, deviceCode, state } =
      await attackerConfirmsVictimFlow();
    const statePoll = await handleAuthPoll(
      req(
        `${ORIGIN}/djdl/identity/auth/poll?state=${encodeURIComponent(state)}&device=victim-game&attachLicense=true`,
      ),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    expect(await statePoll.json()).toEqual({ status: "error" });
    await expectNoMerge(victimLicense);
    expect(await countActiveDevices(ctx.db, "djdl", attackerLicense)).toBe(0);

    // The victim's game polls WITHOUT the opt-in (or never accepts): an ordinary completion.
    // Its one device row signs in to the attacker's licence (the documented residual, shown to
    // the player through `identity`), but the victim's licence is not retired and keeps its
    // other devices.
    const second = await enroll("victim-game-2");
    expect(second.status).toBe(200);
    const done = await devicePoll({ deviceCode, deviceId: "victim-game" }, NOW);
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBeUndefined();
    expect(done.body.identity?.email).toBe(ATTACKER.email);
    await expectNoMerge(victimLicense);
    expect((await getDevice(ctx.db, "djdl", "victim-game-2"))?.license_id).toBe(
      victimLicense,
    );
  });

  it("P1-07: an attach decision is not honoured before the device was shown the identity", async () => {
    const { victimLicense, victimToken, deviceCode } =
      await confirmVictimFlowAs(PLAYER);
    const skipped = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW,
      victimToken,
    );
    // Instead of merging, the device is shown the identity; nothing is minted.
    expect(skipped.body).toEqual({
      status: "confirm",
      identity: { name: PLAYER.email, email: PLAYER.email },
      attachable: true,
    });
    await expectNoMerge(victimLicense);
    expect(await getLicenseBySub(ctx.db, "djdl", PLAYER.sub)).toBeNull();
  });

  it("P1-07: the attach names only a licence the flow's OWN device holds a token on", async () => {
    const { victimLicense, deviceCode } = await confirmVictimFlowAs(PLAYER);
    // Another machine's token (an enrolled licence the device-code holder might also hold)
    // is not attachable to this flow: the token must belong to the device the flow was
    // started for.
    const other = await handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": "other-box" },
        {
          fingerprint: {
            components: {
              machineUuid: "uuid-other".padEnd(
                FINGERPRINT_COMPONENT_LENGTH,
                "x",
              ),
              boardSerial: "board-other".padEnd(
                FINGERPRINT_COMPONENT_LENGTH,
                "x",
              ),
              cpuModel: "cpu-other".padEnd(FINGERPRINT_COMPONENT_LENGTH, "x"),
            },
            hwid: "ignored",
          },
        },
      ),
      ctx.env,
      ctx.db,
      ctx.product,
      NOW,
    );
    const otherBody = (await other.json()) as {
      token: string;
      license: { id: string };
    };
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      otherBody.token,
    );
    expect(shown.body).toMatchObject({ status: "confirm", attachable: false });
    // Asking to attach anyway re-shows the identity with nothing attachable; no merge.
    const refused = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      otherBody.token,
    );
    expect(refused.body).toMatchObject({
      status: "confirm",
      attachable: false,
    });
    await expectNoMerge(victimLicense);
    await expectNoMerge(otherBody.license.id);
  });

  it("P1-07 (claim): the player accepts the shown identity on the device and attaches — the anonymous licence becomes the account's, in place", async () => {
    const { victimLicense, victimToken, deviceCode } =
      await confirmVictimFlowAs(PLAYER);
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      victimToken,
    );
    expect(shown.body).toEqual({
      status: "confirm",
      identity: { name: PLAYER.email, email: PLAYER.email },
      attachable: true,
    });
    // Still nothing merged while the player decides.
    await expectNoMerge(victimLicense);
    // The decision is a poll like any other: inside the interval it is told to slow down.
    const early = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 1,
      victimToken,
    );
    expect(early.status).toBe(429);
    const done = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      victimToken,
    );
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBe("claimed");
    expect(done.body.identity?.email).toBe(PLAYER.email);
    const row = await getLicense(ctx.db, "djdl", victimLicense);
    expect(row?.sub).toBe(PLAYER.sub);
    expect(row?.status).toBe("active");
    expect((await getLicenseBySub(ctx.db, "djdl", PLAYER.sub))?.id).toBe(
      victimLicense,
    );
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      victimLicense,
    );
    const valid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      done.body.token!,
      NOW + 2,
    );
    expect("error" in valid).toBe(false);
  });

  it("P1-07 (migrate): a player who already has a licence attaches — the device moves onto it and the anonymous licence is retired", async () => {
    const pre = await activateFromIdentity(ctx.db, ctx.product, PLAYER, NOW);
    const playerLicense = (pre as { licenseId: string }).licenseId;
    const { victimLicense, victimToken, deviceCode } =
      await confirmVictimFlowAs(PLAYER);
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      victimToken,
    );
    expect(shown.body).toMatchObject({ status: "confirm", attachable: true });
    const done = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      victimToken,
    );
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBe("migrated");
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      playerLicense,
    );
    expect((await getLicense(ctx.db, "djdl", victimLicense))?.status).toBe(
      "disabled",
    );
  });

  it("P1-07: the deferred callback still refuses an identity it would not activate, at once, and the flow is gone", async () => {
    // No mapped group and no oidcDefault tier: activation would refuse, so the callback does.
    await ctx.db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({ enabled: true, tierId: "pro", mode: "enroll" }),
      "djdl",
    );
    ctx.product = (await loadProduct(ctx.env, ctx.db, "djdl"))!;
    const { victimLicense, victimToken, deviceCode } =
      await confirmVictimFlowAs({ ...PLAYER, groups: ["randos"] }, 403);
    const polled = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      victimToken,
    );
    expect(polled.body.status).toBe("timeout");
    await expectNoMerge(victimLicense);
  });

  it("P1-07: declining the attach signs in without touching the anonymous licence", async () => {
    const { victimLicense, victimToken, deviceCode } =
      await confirmVictimFlowAs(PLAYER);
    await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      victimToken,
    );
    const done = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: false },
      NOW + 2,
      victimToken,
    );
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBeUndefined();
    await expectNoMerge(victimLicense);
    const own = await getLicenseBySub(ctx.db, "djdl", PLAYER.sub);
    expect(own!.id).not.toBe(victimLicense);
    // Still re-enrollable: the machine gets its anonymous licence back.
    const again = await enroll("victim-game-reinstalled");
    expect(
      ((await again.json()) as { license: { id: string } }).license.id,
    ).toBe(victimLicense);
  });

  // ── P1-07 under R1-07: the flow's STARTER makes the attach decision ─────────────────────
  //
  // Everything above bounds a party holding someone else's user code. R1-07 is the other way
  // round and is still open: the starter confirms its own flow and phishes the authorize URL,
  // and the victim's sign-in completes the starter's flow. The starter holds the device code
  // AND its own device's token, so the opt-in is reachable without any decision by the victim.
  // In the helper below the enrolled device and the device code are the starter's, and the
  // identity is the phished victim's.

  const PHISHED = {
    sub: "victim-sub",
    email: "victim@corp.com",
    name: "Victim",
    groups: ["family"],
    claims: {} as Record<string, unknown>,
  };

  /** The phished victim already has a licence holding one of their own devices. */
  async function victimLicenceWithOwnDevice(): Promise<string> {
    const pre = await activateFromIdentity(ctx.db, ctx.product, PHISHED, NOW);
    const victimLicence = (pre as { licenseId: string }).licenseId;
    const authorized = await authorizeDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      (await getLicense(ctx.db, "djdl", victimLicence))!,
      "victim-own-device",
      NOW,
    );
    expect("error" in authorized).toBe(false);
    return victimLicence;
  }

  it("OPEN (R1-07 / R8-03, P1-07 claim): the starter who phished its own flow also accepts the attach — the victim's identity takes over the starter's anonymous row", async () => {
    const {
      victimLicense: starterLicence,
      victimToken: starterToken,
      deviceCode,
    } = await confirmVictimFlowAs(PHISHED);
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      starterToken,
    );
    expect(shown.body).toMatchObject({ status: "confirm", attachable: true });
    // GAP (R1-07): nothing on the victim's side was asked. The starter accepts for them.
    const done = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      starterToken,
    );
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBe("claimed");
    const row = await getLicense(ctx.db, "djdl", starterLicence);
    expect(row?.sub).toBe(PHISHED.sub);
    expect((await getLicenseBySub(ctx.db, "djdl", PHISHED.sub))?.id).toBe(
      starterLicence,
    );
    // What it adds over the plain R1-07 poll: every device already on the starter's row now
    // holds the victim's entitlements. Those devices were admitted by that row's own seat check.
    expect(await countActiveDevices(ctx.db, "djdl", starterLicence)).toBe(1);
  });

  it("OPEN (R1-07 / R8-03, P1-07 migrate): the starter's attach moves every device on its anonymous licence onto the victim's, while they fit the victim's seat limit", async () => {
    const victimLicence = await victimLicenceWithOwnDevice();
    const {
      victimLicense: starterLicence,
      victimToken: starterToken,
      deviceCode,
    } = await confirmVictimFlowAs(PHISHED);
    await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      starterToken,
    );
    const done = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      starterToken,
    );
    expect(done.body.status).toBe("ready");
    expect(done.body.attached).toBe("migrated");
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      victimLicence,
    );
    expect(await countActiveDevices(ctx.db, "djdl", starterLicence)).toBe(0);
    expect(await countActiveDevices(ctx.db, "djdl", victimLicence)).toBe(2);
    expect((await getLicense(ctx.db, "djdl", starterLicence))?.status).toBe(
      "disabled",
    );
  });

  it("P1-07 (R1-07 bound): the attach is not offered when the migrate would push the destination licence past its seat limit", async () => {
    // One seat per licence: the victim's own device fills theirs, the starter's fills its own.
    await ctx.db.run(
      "UPDATE tiers SET policy_device_limit = 1 WHERE product = 'djdl' AND id = 'pro'",
    );
    const victimLicence = await victimLicenceWithOwnDevice();
    const {
      victimLicense: starterLicence,
      victimToken: starterToken,
      deviceCode,
    } = await confirmVictimFlowAs(PHISHED);
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      starterToken,
    );
    expect(shown.body).toMatchObject({ status: "confirm", attachable: false });
    // Sending the attach anyway is answered with the identity again; nothing moves.
    const forced = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      starterToken,
    );
    expect(forced.body).toMatchObject({
      status: "confirm",
      attachable: false,
    });
    expect(forced.body.token).toBeUndefined();
    await expectNoMerge(starterLicence);
    expect(await countActiveDevices(ctx.db, "djdl", victimLicence)).toBe(1);
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      starterLicence,
    );
  });

  // ── P1-07: the attach never commits when the mint would be refused ──────────────────────
  //
  // The merge runs before the mint and nothing undoes it. A device-code mint presents no
  // fingerprint, so a `strict` tier refuses it every time (`fingerprint_required`). Offering
  // the attach there would turn a flow the Worker refuses into a takeover of the victim's
  // entitlements under R1-07, and would claim or retire an honest player's anonymous licence
  // while the poll answers `error`.

  const VIP = { ...PHISHED, groups: ["vip"] };

  /** Map the `vip` group to a `gold` tier. `strict` applies the tier's fingerprint mode now;
   *  otherwise it stays `normal` until `makeGoldStrict`. */
  async function goldTier(): Promise<void> {
    await ctx.db.run(
      `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days,
         policy_device_limit, policy_fingerprint, modified_by, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      "djdl",
      "gold",
      "Gold",
      null,
      365,
      50,
      "normal",
      null,
      NOW,
    );
    await ctx.db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({
        family: { role: "user", tier: "pro" },
        vip: { role: "user", tier: "gold" },
      }),
    );
  }
  const makeGoldStrict = (): Promise<unknown> =>
    ctx.db.run(
      "UPDATE tiers SET policy_fingerprint = 'strict' WHERE product = 'djdl' AND id = 'gold'",
    );

  /** The starter's token still resolves to its own anonymous licence, on its own tier. */
  async function expectStarterOnOwnLicence(
    starterToken: string,
    starterLicence: string,
  ): Promise<void> {
    const valid = await requireLicensedDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      starterToken,
      NOW + 4,
    );
    if ("error" in valid) throw new Error(`token refused: ${valid.error}`);
    expect(valid.license.id).toBe(starterLicence);
    expect(valid.license.sub).toBeNull();
    expect(valid.license.tier_id).not.toBe("gold");
    expect((await getDevice(ctx.db, "djdl", "victim-game"))?.license_id).toBe(
      starterLicence,
    );
  }

  /** Confirm, force the attach, then decline: the attach is never offered, the forced attach
   *  is answered with the identity again, and the decline is the refused mint it always was. */
  async function attachRefusedOnStrictTier(
    deviceCode: string,
    starterToken: string,
  ): Promise<void> {
    const shown = await devicePoll(
      { deviceCode, deviceId: "victim-game", confirmIdentity: true },
      NOW,
      starterToken,
    );
    expect(shown.body).toMatchObject({ status: "confirm", attachable: false });
    const forced = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: true },
      NOW + 2,
      starterToken,
    );
    expect(forced.body).toMatchObject({
      status: "confirm",
      attachable: false,
    });
    expect(forced.body.token).toBeUndefined();
    const declined = await devicePoll(
      { deviceCode, deviceId: "victim-game", attachLicense: false },
      NOW + 4,
      starterToken,
    );
    expect(declined.body).toEqual({ status: "error" });
  }

  it("P1-07 (R1-07, claim on a strict tier): the attach is not offered when the mint would be refused, so the victim's identity never takes over the starter's row", async () => {
    await goldTier();
    await makeGoldStrict();
    const {
      victimLicense: starterLicence,
      victimToken: starterToken,
      deviceCode,
    } = await confirmVictimFlowAs(VIP);
    await attachRefusedOnStrictTier(deviceCode, starterToken);
    await expectNoMerge(starterLicence);
    await expectStarterOnOwnLicence(starterToken, starterLicence);
  });

  it("P1-07 (R1-07, migrate on a strict tier): the attach is not offered when the mint would be refused, so no device moves and the anonymous licence stays active", async () => {
    await goldTier();
    // The victim's licence and own device exist before the tier turns strict.
    const pre = await activateFromIdentity(ctx.db, ctx.product, VIP, NOW);
    const victimLicence = (pre as { licenseId: string }).licenseId;
    const authorized = await authorizeDevice(
      ctx.env,
      ctx.db,
      ctx.product,
      (await getLicense(ctx.db, "djdl", victimLicence))!,
      "victim-own-device",
      NOW,
    );
    expect("error" in authorized).toBe(false);
    await makeGoldStrict();
    const {
      victimLicense: starterLicence,
      victimToken: starterToken,
      deviceCode,
    } = await confirmVictimFlowAs(VIP);
    await attachRefusedOnStrictTier(deviceCode, starterToken);
    await expectNoMerge(starterLicence);
    await expectStarterOnOwnLicence(starterToken, starterLicence);
    expect(await countActiveDevices(ctx.db, "djdl", victimLicence)).toBe(1);
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
