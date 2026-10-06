/**
 * I-26 — the legacy product-OIDC sign-in's licence chooser (plans/I-04.md, "Owner decision
 * (2026-10-05): licence choice at sign-in"; delegated decisions 1, 2 and 13).
 *
 * On a `provider: platform` product, a person whose Polaris Key account already owns a usable
 * licence is shown "Choose a license for this device" instead of being auto-issued a second
 * `sub`-keyed licence. Every flow kind (device code, the legacy state poll, the browser
 * `return_to` flow) mints nothing until the choice; the chooser answers only the browser that
 * started or confirmed the flow (`__Host-pk_lcb`); Replace frees a device through the portal's
 * own `freeAccountDevice` (same audit, email and rate-limit budget). Without the trigger the
 * sign-in is exactly what it was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type KeyLike,
  SignJWT,
} from "jose";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  authorizeAndMint,
  flowKey,
  handleAuthCallback,
  handleAuthChoose,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthPoll,
  handleAuthStart,
} from "../src/services/identity/oidc.js";
import {
  chooserBody,
  compareCandidates,
  legacyLicenseChoices,
  LICENSE_CHOICE_BINDER_COOKIE,
  originLabel,
} from "../src/services/identity/licenseChoice.js";
import { licenseProvenance } from "../src/services/license/provenance.js";
import type { HookContext, ServiceHooks } from "../src/core/hooks.js";
import {
  portalActionLimit,
  DEVICE_DISCONNECT_BUCKET,
  DEVICE_DISCONNECT_LIMIT,
  DEVICE_DISCONNECT_WINDOW,
} from "../src/services/identity/portal/freeDevice.js";
import {
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import { hashKey } from "../src/crypto.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { artefacts } from "./singleUseMock.js";
import { handlePortalApi } from "./portalHarness.js";
import { secureResponse } from "../src/securityHeaders.js";
import { brandPageStyleSource } from "../src/core/brandHtml.js";

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

const ORIGIN = "https://key.plrs.im";
const ISSUER = "https://id.example";
const AUD = "client-djdl";
const REDIRECT = `${ORIGIN}/djdl/identity/auth/callback`;
const SUB = "pk-user-1";
const IP = "198.51.100.7";

let db: SqliteDb;
let env: Env;
let product: Product;
let priv: KeyLike;
let accountId: string;

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(priv);
}

function installIdp(claims: Record<string, unknown>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("/api/oidc/token")) {
        return new Response(
          JSON.stringify({ id_token: await signIdToken(claims) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  );
}

async function seedTier(id: string, label: string, limit: number) {
  await db.run(
    "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
    "djdl",
    id,
    label,
    null,
    null,
    limit,
    null,
    NOW,
  );
}

async function setProvider(provider: "platform" | "custom") {
  await db.run(
    "UPDATE oidc_config SET provider = ?, issuer = ?, client_id = ? WHERE product = ?",
    provider,
    provider === "custom" ? ISSUER : null,
    provider === "custom" ? AUD : null,
    "djdl",
  );
}

async function insertLic(input: {
  id: string;
  tier: string;
  account?: string | null;
  sub?: string | null;
  origin?: string;
  expiresAt?: number | null;
  activatedAt?: number;
  status?: string;
}) {
  await db.run(
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
       expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
       origin, modified_by, modified_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 'test', ?)`,
    "djdl",
    input.id,
    input.status ?? "active",
    input.sub ?? null,
    input.tier,
    input.activatedAt ?? NOW - 1000,
    input.expiresAt ?? null,
    input.origin ?? "admin",
    NOW,
  );
  if (input.account)
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      input.account,
      "djdl",
      input.id,
    );
}

const licenseCount = async () =>
  (await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM licenses WHERE product = 'djdl'",
  ))!.n;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = AUD;
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  await seedProduct(db, "djdl");
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "platform",
    null,
    null,
    null,
    JSON.stringify([REDIRECT]),
    JSON.stringify({ members: { role: "user", tier: "free" } }),
  );
  await seedTier("free", "Free", 2);
  await seedTier("std", "Standard", 3);
  await seedTier("starter", "Starter", 1);
  product = (await loadProduct(env, db, "djdl"))!;
  const account = await insertAccount(
    db,
    {
      primaryEmail: "ada@example.com",
      primaryEmailVerified: true,
      displayName: "Ada",
    },
    NOW,
  );
  accountId = account.id;
  await insertLink(
    db,
    accountId,
    {
      issuerKey: ISSUER,
      tenantScope: "",
      subject: SUB,
      kind: "oidc",
      email: "ada@example.com",
      emailVerified: true,
      displayName: "Ada",
      amr: null,
    },
    NOW,
  );
  const pair = await generateKeyPair("ES256", { extractable: true });
  priv = pair.privateKey;
  const pub = await importJWK(
    { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp" },
    "ES256",
  );
  idpKey.getKey = async () => pub;
});

afterEach(() => {
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

// ── drivers ─────────────────────────────────────────────────────────────────────────────────

/** Every `Set-Cookie` field (Node's undici has `getSetCookie`; the Workers types do not). */
function setCookies(res: Response): string[] {
  return (
    res.headers as unknown as { getSetCookie(): string[] }
  ).getSetCookie();
}

function cookieOf(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const [pair] = c.split(";");
    const [k, v] = pair!.split("=");
    if (k === name) return v ?? "";
  }
  return null;
}

interface DeviceFlow {
  deviceCode: string;
  binder: string | null;
  state: string;
  nonce: string;
}

/** `/device/start`, the user-code page, and its confirmation, as the player's browser does. */
async function startDeviceFlow(
  deviceId = "dev-new",
  deviceName = "Steam Deck",
): Promise<DeviceFlow> {
  const started = await handleAuthDeviceStart(
    new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId, deviceName }),
    }) as unknown as Request,
    env,
    db,
    product,
  );
  const { deviceCode, userCode } = (await started.json()) as {
    deviceCode: string;
    userCode: string;
  };
  const page = await handleAuthDeviceEntry(
    new Request(
      `${ORIGIN}/djdl/identity/auth/device?user_code=${userCode}`,
    ) as unknown as Request,
    env,
    product,
  );
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const confirmed = await handleAuthDeviceEntry(
    new Request(`${ORIGIN}/djdl/identity/auth/device`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ user_code: userCode, csrf }).toString(),
    }) as unknown as Request,
    env,
    product,
  );
  expect(confirmed.status).toBe(303);
  const authorize = new URL(confirmed.headers.get("location")!);
  return {
    deviceCode,
    binder: cookieOf(confirmed, LICENSE_CHOICE_BINDER_COOKIE),
    state: authorize.searchParams.get("state")!,
    nonce: authorize.searchParams.get("nonce")!,
  };
}

async function callback(
  state: string,
  nonce: string,
  binder: string | null,
  sub = SUB,
): Promise<Response> {
  installIdp({
    sub,
    groups: ["members"],
    nonce,
    email: "ada@example.com",
    email_verified: true,
  });
  return handleAuthCallback(
    new Request(`${ORIGIN}/djdl/identity/auth/callback?code=c&state=${state}`, {
      headers: binder
        ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
        : {},
    }) as unknown as Request,
    env,
    db,
    product,
    NOW,
  );
}

async function devicePoll(
  flow: DeviceFlow,
  at: number,
  deviceId = "dev-new",
  extra: Record<string, unknown> = {},
): Promise<{ status: string; token?: string; identity?: unknown }> {
  const res = await handleAuthDevicePoll(
    new Request(`${ORIGIN}/djdl/identity/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: flow.deviceCode, deviceId, ...extra }),
    }) as unknown as Request,
    env,
    db,
    product,
    at,
  );
  return res.json() as Promise<{ status: string; token?: string }>;
}

async function getChooser(binder: string | null): Promise<Response> {
  return handleAuthChoose(
    new Request(`${ORIGIN}/djdl/identity/auth/choose`, {
      headers: {
        "cf-connecting-ip": IP,
        ...(binder
          ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
          : {}),
      },
    }) as unknown as Request,
    env,
    db,
    product,
    NOW,
  );
}

async function postChooser(
  binder: string | null,
  form: Record<string, string>,
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Promise<Response> {
  return handleAuthChoose(
    new Request(`${ORIGIN}/djdl/identity/auth/choose`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": IP,
        ...headers,
        ...(binder
          ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
          : {}),
      },
      body: new URLSearchParams(form).toString(),
    }) as unknown as Request,
    env,
    db,
    product,
    NOW,
  );
}

/** GET the chooser and read its token and the rows it shows. */
async function readChooser(binder: string) {
  const res = await getChooser(binder);
  const html = await res.text();
  return {
    res,
    html,
    token: /name="choice" value="([^"]+)"/.exec(html)?.[1] ?? "",
    rows: [
      ...html.matchAll(
        /<input type="radio" name="license" value="([^"]+)"( checked)?( disabled)?>/g,
      ),
    ].map((m) => ({ id: m[1]!, checked: !!m[2], disabled: !!m[3] })),
  };
}

const deviceLicense = async (deviceId: string) =>
  (
    await db.first<{ license_id: string; status: string }>(
      "SELECT license_id, status FROM devices WHERE product = 'djdl' AND device_id = ?",
      deviceId,
    )
  )?.license_id ?? null;

// ── the device-code flow ────────────────────────────────────────────────────────────────────

describe("I-26 device-code flow", () => {
  it("shows the chooser instead of minting, and binds the device to the pick", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const before = await licenseCount();
    const flow = await startDeviceFlow();
    expect(flow.binder).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cb = await callback(flow.state, flow.nonce, flow.binder);
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe(
      `${ORIGIN}/djdl/identity/auth/choose`,
    );
    expect(await licenseCount()).toBe(before);

    // The poll waits, with the same body as before the callback; asking for the identity too.
    expect((await devicePoll(flow, NOW + 10)).status).toBe("pending");
    expect(
      (await devicePoll(flow, NOW + 20, "dev-new", { confirmIdentity: true }))
        .status,
    ).toBe("pending");

    const page = await readChooser(flow.binder!);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain("Choose a license for this device");
    expect(page.html).toContain("Steam Deck");
    expect(page.html).toContain('<span class="tag">Standard</span>');
    expect(page.html).toContain("Named by the device");
    expect(page.html).toContain("0 of 3 devices");
    expect(page.html).toContain("Lifetime");
    // The page never names the flow.
    expect(page.html).not.toContain(flow.state);
    expect(page.rows).toEqual([
      { id: "lic_std", checked: true, disabled: false },
    ]);

    const chosen = await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "lic_std",
    });
    expect(chosen.status).toBe(200);
    expect(await chosen.text()).toContain("You&#x27;re signed in");
    expect(cookieOf(chosen, LICENSE_CHOICE_BINDER_COOKIE)).toBe("");

    const ready = await devicePoll(flow, NOW + 30);
    expect(ready.status).toBe("ready");
    expect(ready.token).toMatch(/^pkeyt_/);
    expect(await deviceLicense("dev-new")).toBe("lic_std");
    expect(await licenseCount()).toBe(before);
    const audit = await db.first<{ target_id: string; summary: string }>(
      "SELECT target_id, summary FROM audit WHERE product = 'djdl' AND action = 'identity.signin.license_chosen'",
    );
    expect(audit).toEqual({
      target_id: "lic_std",
      summary: "Chose this license to sign in Steam Deck",
    });
  });

  it("refuses a licence that is not the account's, or no longer usable, and stays open", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    await insertLic({ id: "lic_other", tier: "std", account: null });
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);

    let page = await readChooser(flow.binder!);
    const foreign = await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "lic_other",
    });
    expect(foreign.status).toBe(303);
    page = await readChooser(flow.binder!);
    expect(page.html).toContain("That license can't take this device any more");
    expect((await devicePoll(flow, NOW + 10)).status).toBe("pending");

    // Disabled between the render and the submit: re-checked, refused.
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE id = 'lic_std'",
    );
    const gone = await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "lic_std",
    });
    expect(gone.status).toBe(303);
    expect((await devicePoll(flow, NOW + 20)).status).toBe("pending");
    expect(await deviceLicense("dev-new")).toBeNull();
  });

  it("a page's token is single-use: a resubmit changes nothing", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    await postChooser(flow.binder, { choice: page.token, action: "back" });
    const again = await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "lic_std",
    });
    expect(again.status).toBe(303);
    expect((await devicePoll(flow, NOW + 10)).status).toBe("pending");
  });

  it("choosing the identity's own licence runs today's activation", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    await insertLic({ id: "lic_own", tier: "free", sub: SUB, origin: "oidc" });
    const before = await licenseCount();
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    expect(page.rows.map((r) => r.id).sort()).toEqual(["lic_own", "lic_std"]);
    // Owner decision (2026-10-05): no "Account-wide" label; the origin is plain words.
    expect(page.html).toContain("0 of 2 devices");
    expect(page.html).toContain("From signing in · Lifetime");
    expect(page.html).not.toContain("Account-wide");
    await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "lic_own",
    });
    const ready = await devicePoll(flow, NOW + 10);
    expect(ready.status).toBe("ready");
    expect(await deviceLicense("dev-new")).toBe("lic_own");
    expect(await licenseCount()).toBe(before);
  });
});

// ── the other flow kinds ────────────────────────────────────────────────────────────────────

describe("I-26 browser and state-poll flows", () => {
  it("return_to flow: no new licence, then a browser session on the pick", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const before = await licenseCount();
    const start = await handleAuthStart(
      new Request(
        `${ORIGIN}/djdl/identity/auth/start?return_to=${encodeURIComponent(`${ORIGIN}/djdl/app`)}`,
      ) as unknown as Request,
      env,
      db,
      product,
    );
    expect(start.status).toBe(302);
    const binder = cookieOf(start, LICENSE_CHOICE_BINDER_COOKIE)!;
    expect(setCookies(start)[0]).toMatch(
      /^__Host-pk_lcb=[^;]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    const authorize = new URL(start.headers.get("location")!);
    const cb = await callback(
      authorize.searchParams.get("state")!,
      authorize.searchParams.get("nonce")!,
      binder,
    );
    expect(cb.status).toBe(303);
    expect(await licenseCount()).toBe(before);

    const page = await readChooser(binder);
    expect(page.html).toContain("This browser");
    const done = await postChooser(binder, {
      choice: page.token,
      action: "use",
      license: "lic_std",
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/djdl/app`);
    const set = setCookies(done);
    expect(set.some((c) => c.startsWith("pkey_djdl_session="))).toBe(true);
    expect(cookieOf(done, LICENSE_CHOICE_BINDER_COOKIE)).toBe("");
    expect(await deviceLicense("browser:lic_std")).toBe("lic_std");
    expect(await licenseCount()).toBe(before);
  });

  it("state poll: pending while choosing, ready on the pick", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const binder = "legacy-binder-value-0123456789abcdef";
    await artefacts(env).put(
      await flowKey(env, "djdl", "st-1"),
      JSON.stringify({
        verifier: "v",
        nonce: "the-nonce",
        redirectUri: REDIRECT,
        deviceId: "dev-legacy",
        confirmedAt: NOW,
        binderEligible: true,
        binder: await hashKey(binder, env.KEY_HASH_PEPPER),
      }),
    );
    const before = await licenseCount();
    const cb = await callback("st-1", "the-nonce", binder);
    expect(cb.status).toBe(303);
    const poll = async () =>
      (
        (await (
          await handleAuthPoll(
            new Request(
              `${ORIGIN}/djdl/identity/auth/poll?state=st-1&device=dev-legacy`,
            ) as unknown as Request,
            env,
            db,
            product,
            NOW,
          )
        ).json()) as { status: string }
      ).status;
    expect(await poll()).toBe("pending");
    const page = await readChooser(binder);
    await postChooser(binder, {
      choice: page.token,
      action: "use",
      license: "lic_std",
    });
    expect(await poll()).toBe("ready");
    expect(await deviceLicense("dev-legacy")).toBe("lic_std");
    expect(await licenseCount()).toBe(before);
  });
});

// ── rows: full, create ──────────────────────────────────────────────────────────────────────

describe("I-26 rows", () => {
  it("lists a full licence disabled with the free-device link and Replace", async () => {
    await insertLic({
      id: "lic_std",
      tier: "std",
      account: accountId,
      expiresAt: NOW + 86_400 * 30,
    });
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    // Rank-first: no expiry first, but the full one cannot be preselected.
    expect(page.rows).toEqual([
      { id: "lic_start", checked: false, disabled: true },
      { id: "lic_std", checked: true, disabled: false },
    ]);
    expect(page.html).toContain("No free devices");
    expect(page.html).toContain("1 of 1 device");
    expect(page.html).toContain(
      `href="${ORIGIN}/#/p/djdl/free-device?license=lic_start&amp;for=Steam%20Deck"`,
    );
    expect(page.html).toContain("<summary>Replace a device</summary>");
    expect(page.html).not.toContain("Create a new free license");
  });

  it("offers Create a new free licence only when the policy grants and every row is full", async () => {
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    const before = await licenseCount();
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    expect(page.html).toContain("Create a new free license");
    expect(page.html).toContain("A new free license for this device");
    expect(page.html).not.toContain("free free");
    expect(page.rows).toContainEqual({
      id: "create",
      checked: true,
      disabled: false,
    });
    await postChooser(flow.binder, {
      choice: page.token,
      action: "use",
      license: "create",
    });
    const ready = await devicePoll(flow, NOW + 10);
    expect(ready.status).toBe("ready");
    expect(await licenseCount()).toBe(before + 1);
  });

  it('a grant with no tier reads "A new free license for this device"', async () => {
    await db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({ members: { role: "user" } }),
    );
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    expect(page.html).toContain(
      '<span class="choice-seats">Create a new free license</span>',
    );
    expect(page.html).toContain("A new free license for this device");
    expect(page.html).not.toContain("free free");
  });

  it("ends the chooser when the account is disabled meanwhile", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      accountId,
    );
    const res = await getChooser(flow.binder);
    expect(res.status).toBe(403);
    expect((await devicePoll(flow, NOW + 10)).status).toBe("timeout");
    expect(
      await db.first(
        "SELECT 1 FROM audit WHERE action = 'identity.signin.license_chosen'",
      ),
    ).toBeNull();
  });

  it("no Create when the policy grants nothing", async () => {
    await db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({ admins: { role: "admin" } }),
    );
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    const flow = await startDeviceFlow();
    const cb = await callback(flow.state, flow.nonce, flow.binder);
    // A purchased licence works from the app even when the group map entitles nothing.
    expect(cb.status).toBe(303);
    const page = await readChooser(flow.binder!);
    expect(page.html).not.toContain("Create a new free license");
    expect(page.html).not.toContain('value="use"');
  });

  it("is a branded, script-free page under the branded CSP, never cached", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const served = secureResponse(await getChooser(flow.binder));
    const csp = served.headers.get("content-security-policy")!;
    const html = await served.text();
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(served.headers.get("referrer-policy")).toBe("no-referrer");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain(`style-src ${brandPageStyleSource()}`);
    expect(csp).not.toMatch(/unsafe-inline|script-src/);
    expect([...html.matchAll(/<style>/g)]).toHaveLength(1);
    expect(html).not.toMatch(/\sstyle=|<script|\son\w+=/i);
  });

  it("orders candidates rank-first: no expiry, then the latest expiry, then the oldest", () => {
    const rows = [
      { id: "a", expiresAt: 100, activatedAt: 1 },
      { id: "b", expiresAt: null, activatedAt: 5 },
      { id: "c", expiresAt: 200, activatedAt: 1 },
      { id: "d", expiresAt: null, activatedAt: 2 },
    ];
    expect(rows.sort(compareCandidates).map((r) => r.id)).toEqual([
      "d",
      "b",
      "c",
      "a",
    ]);
  });
});

// ── the binder ──────────────────────────────────────────────────────────────────────────────

describe("I-26 browser binder", () => {
  it("without the binder the callback refuses and mints nothing", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const before = await licenseCount();
    const flow = await startDeviceFlow();
    const cb = await callback(flow.state, flow.nonce, null);
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain("Start again on your device");
    expect(await licenseCount()).toBe(before);
    expect((await devicePoll(flow, NOW + 10)).status).toBe("timeout");
  });

  it("a different browser's binder is refused too", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    const cb = await callback(
      flow.state,
      flow.nonce,
      "another-browsers-binder-value-xyz",
    );
    expect(cb.status).toBe(403);
    expect(await licenseCount()).toBe(1);
  });

  it("the chooser refuses a request with no binder, and a cross-site POST", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    expect((await getChooser(null)).status).toBe(403);
    const page = await readChooser(flow.binder!);
    const cross = await postChooser(
      flow.binder,
      { choice: page.token, action: "use", license: "lic_std" },
      { "sec-fetch-site": "cross-site" },
    );
    expect(cross.status).toBe(403);
    expect((await devicePoll(flow, NOW + 10)).status).toBe("pending");
  });

  it("Cancel drops the flow", async () => {
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    const page = await readChooser(flow.binder!);
    const res = await postChooser(flow.binder, {
      choice: page.token,
      action: "cancel",
    });
    expect(await res.text()).toContain("Sign-in cancelled");
    expect((await devicePoll(flow, NOW + 10)).status).toBe("timeout");
  });
});

// ── outside the trigger: unchanged ──────────────────────────────────────────────────────────

describe("I-26 outside the trigger", () => {
  async function signsInAsToday(): Promise<void> {
    const before = await licenseCount();
    const flow = await startDeviceFlow();
    const cb = await callback(flow.state, flow.nonce, flow.binder);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain("You&#x27;re signed in");
    const ready = await devicePoll(flow, NOW + 10);
    expect(ready.status).toBe("ready");
    // Today's behaviour: the identity's own `sub`-keyed licence, minted.
    expect(await licenseCount()).toBe(before + 1);
    const own = await db.first<{ id: string }>(
      "SELECT id FROM licenses WHERE product = 'djdl' AND sub = ?",
      SUB,
    );
    expect(await deviceLicense("dev-new")).toBe(own!.id);
  }

  it("no account link", async () => {
    await db.run("DELETE FROM account_links");
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    await signsInAsToday();
  });

  it("no usable licence on the account", async () => {
    await insertLic({
      id: "lic_std",
      tier: "std",
      account: accountId,
      status: "disabled",
    });
    await insertLic({
      id: "lic_exp",
      tier: "std",
      account: accountId,
      expiresAt: NOW - 1,
    });
    await signsInAsToday();
  });

  it("auto-linking turned off for the product", async () => {
    await db.run(
      "INSERT INTO portal_product_settings (product, auto_link_enabled, created_at, modified_at) VALUES ('djdl', 0, ?, ?)",
      NOW,
      NOW,
    );
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    await signsInAsToday();
  });

  it("a provider: custom product: no binder cookie, no chooser", async () => {
    await setProvider("custom");
    product = (await loadProduct(env, db, "djdl"))!;
    await insertLic({ id: "lic_std", tier: "std", account: accountId });
    const flow = await startDeviceFlow();
    expect(flow.binder).toBeNull();
    const before = await licenseCount();
    const cb = await callback(flow.state, flow.nonce, null);
    expect(cb.status).toBe(200);
    expect((await devicePoll(flow, NOW + 10)).status).toBe("ready");
    expect(await licenseCount()).toBe(before + 1);
  });
});

// ── Replace a device ────────────────────────────────────────────────────────────────────────

describe("I-26 Replace a device", () => {
  async function fullFlow() {
    await insertLic({ id: "lic_start", tier: "starter", account: accountId });
    await authorizeAndMint(env, db, product, "lic_start", "work-laptop", NOW);
    await db.run(
      "UPDATE devices SET label = 'Work laptop' WHERE device_id = 'work-laptop'",
    );
    // Policy grants nothing, so no Create row competes.
    await db.run(
      "UPDATE oidc_config SET group_role_map_json = ? WHERE product = 'djdl'",
      JSON.stringify({}),
    );
    const flow = await startDeviceFlow();
    await callback(flow.state, flow.nonce, flow.binder);
    return flow;
  }

  it("frees the least recent device through the portal's rules and binds the new one", async () => {
    const flow = await fullFlow();
    let page = await readChooser(flow.binder!);
    expect(page.html).toMatch(
      /name="device:lic_start" value="work-laptop" checked>.*Work laptop<span class="tag">Least recent<\/span><span class="tag">Active now<\/span>/,
    );
    const staged = await postChooser(flow.binder, {
      choice: page.token,
      action: "replace:lic_start",
      "device:lic_start": "work-laptop",
    });
    expect(staged.status).toBe(303);
    page = await readChooser(flow.binder!);
    expect(page.html).toContain("Replace Work laptop?");
    expect(page.html).toContain("Work laptop will need to sign in again.");
    // Nothing is written before Replace and continue.
    expect(
      (await db.first<{ status: string }>(
        "SELECT status FROM devices WHERE device_id = 'work-laptop'",
      ))!.status,
    ).toBe("authorized");
    const done = await postChooser(flow.binder, {
      choice: page.token,
      action: "replace",
    });
    expect(done.status).toBe(200);
    expect(
      (await db.first<{ status: string }>(
        "SELECT status FROM devices WHERE device_id = 'work-laptop'",
      ))!.status,
    ).toBe("deauthorized");
    const audit = await db.first<{ summary: string }>(
      "SELECT summary FROM portal_audit WHERE action = 'portal.device.disconnect'",
    );
    expect(audit!.summary).toBe(
      "Disconnected device work-laptop to sign in Steam Deck",
    );
    const ready = await devicePoll(flow, NOW + 10);
    expect(ready.status).toBe("ready");
    expect(await deviceLicense("dev-new")).toBe("lic_start");
  });

  it("Back returns to the chooser without freeing anything", async () => {
    const flow = await fullFlow();
    let page = await readChooser(flow.binder!);
    await postChooser(flow.binder, {
      choice: page.token,
      action: "replace:lic_start",
      "device:lic_start": "work-laptop",
    });
    page = await readChooser(flow.binder!);
    await postChooser(flow.binder, { choice: page.token, action: "back" });
    page = await readChooser(flow.binder!);
    expect(page.html).toContain("Choose a license for this device");
  });

  it("shares the portal's portalDeviceDisconnect budget", async () => {
    const flow = await fullFlow();
    // Spend the budget the way the portal's Remove would, from the same account and IP.
    const req = new Request(`${ORIGIN}/x`, {
      headers: { "cf-connecting-ip": IP },
    }) as unknown as Request;
    const { shard, rl } = portalActionLimit(
      req,
      accountId,
      DEVICE_DISCONNECT_BUCKET,
      DEVICE_DISCONNECT_LIMIT,
      "djdl",
      DEVICE_DISCONNECT_WINDOW,
    );
    for (let i = 0; i < DEVICE_DISCONNECT_LIMIT; i++)
      expect(await rateLimitOk(env, shard, rl, NOW)).toBe(true);

    let page = await readChooser(flow.binder!);
    await postChooser(flow.binder, {
      choice: page.token,
      action: "replace:lic_start",
      "device:lic_start": "work-laptop",
    });
    page = await readChooser(flow.binder!);
    const limited = await postChooser(flow.binder, {
      choice: page.token,
      action: "replace",
    });
    expect(limited.status).toBe(303);
    page = await readChooser(flow.binder!);
    const wait = DEVICE_DISCONNECT_WINDOW - (NOW % DEVICE_DISCONNECT_WINDOW);
    expect(page.html).toContain(
      `Too many device changes. Try again in ${wait} seconds.`,
    );
    expect(
      (await db.first<{ status: string }>(
        "SELECT status FROM devices WHERE device_id = 'work-laptop'",
      ))!.status,
    ).toBe("authorized");

    // …and the portal's own DELETE is out of budget too: one budget for both surfaces.
    const { token: portalToken, session } = await issuePortalSessionRow(
      env,
      db,
      { accountId, email: "ada@example.com", name: "Ada" },
      NOW,
    );
    const path = "/api/licenses/djdl/lic_start/devices/work-laptop";
    const del = await handlePortalApi(
      new Request(`${ORIGIN}${path}`, {
        method: "DELETE",
        headers: {
          cookie: `${PORTAL_COOKIE}=${portalToken}`,
          [PORTAL_CSRF_HEADER]: session.csrf,
          "cf-connecting-ip": IP,
        },
      }) as unknown as Request,
      env,
      db,
      path,
      NOW,
    );
    expect(del.status).toBe(429);
  });
});

// ── origins (owner, 2026-10-05) ─────────────────────────────────────────────────────────────

describe("I-26 row origins name the store with the key, never a licence type", () => {
  it("words every origin in plain words", () => {
    expect(originLabel("sign_in", null, false)).toBe("From signing in");
    expect(originLabel("store", "steam", true)).toBe("Steam key");
    expect(originLabel("store", "steam", false)).toBe("From Steam");
    expect(originLabel("store", "app-store", false)).toBe("From the App Store");
    expect(originLabel("developer", null, true)).toBe("Added with a key");
    expect(originLabel("developer", null, false)).toBe("From the developer");
    expect(originLabel("free", null, false)).toBe("Free");
  });

  /** The chooser's rows with License's real provenance hook over this test's DB. */
  async function rowsHtml(): Promise<string> {
    const hooks = {
      licenseProvenance: () =>
        licenseProvenance({ db, product, now: NOW } as unknown as HookContext),
    } as unknown as ServiceHooks;
    const view = await legacyLicenseChoices(db, product, {
      accountId,
      sub: SUB,
      deviceId: "dev-new",
      grantTierId: null,
      hooks,
      origin: "https://keys.example",
      deviceLabel: "Studio Mac",
      now: NOW,
    });
    return chooserBody({
      productName: "DJDL",
      deviceLabel: "Studio Mac",
      action: "/choose",
      token: "t",
      view,
      now: NOW,
    });
  }

  async function steamGrant(licenseId: string, hash: string): Promise<void> {
    await db.run(
      `INSERT INTO license_store_grants (product, license_id, flag, store, purchase_key_hash,
         state, granted_at)
       VALUES ('djdl', ?, 'extras.skins', 'steam', ?, 'active', ?)`,
      licenseId,
      hash,
      NOW,
    );
  }

  it('a Steam-bound key licence reads "Steam key"; no order id or purchase hash shows', async () => {
    await insertLic({ id: "lic_steam", tier: "std", account: accountId });
    await db.run(
      `INSERT INTO keys_index (product, key_hash, license_id, status, created_at)
       VALUES ('djdl', 'kh_steam', 'lic_steam', 'active', ?)`,
      NOW,
    );
    await steamGrant("lic_steam", "ph_secret_steam");
    const html = await rowsHtml();
    expect(html).toContain("Steam key · Lifetime");
    expect(html).not.toContain("ph_secret_steam");
    expect(html).not.toContain("kh_steam");
    expect(html).not.toContain("Account-wide");
  });

  it('a store-bound licence with no key reads "From Steam"', async () => {
    await insertLic({ id: "lic_bound", tier: "std", account: accountId });
    await steamGrant("lic_bound", "ph_bound");
    const html = await rowsHtml();
    expect(html).toContain("From Steam · Lifetime");
    expect(html).not.toContain("ph_bound");
  });
});
