/**
 * I-17: moving `provider: platform` end users off the platform IdP by claim at next sign-in
 * (`services/identity/accounts/platformMigration.ts`; S-16 §8 I-17, §9 risk 11).
 *
 *   - Off by default: with `PLATFORM_OIDC_MIGRATION` unset every platform-IdP sign-in is exactly
 *     what it was (no account, the `sub`-keyed licence floating).
 *   - `claim`: a verified email lands on ONE account (the address as its primary email and email
 *     method, the subject as the temporary `oidc` method) and the licence joins it; an address
 *     another account uses is a join offer that writes nothing, and joining needs that account
 *     proven in the same browser (the email step, I-07's gate); an address on two accounts is
 *     ambiguous and nothing is offered; a subject with no email keeps the temporary method only.
 *   - `operators-only`: only subjects that already moved sign in through the platform IdP.
 *   - Past `PLATFORM_OIDC_SUNSET`: nobody does, and the card stops offering single sign-on.
 *   - The email-less count: `GET /manage/api/platform/identity-migration`, counts only.
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
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleAuthCallback,
  handleAuthChoose,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthStart,
} from "../src/services/identity/oidc.js";
import { LICENSE_CHOICE_BINDER_COOKIE } from "../src/services/identity/licenseChoice.js";
import { EMAIL_GATE_LANDING } from "../src/services/identity/card/gate.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accountCookies.js";
import {
  EMAIL_ISSUER,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import {
  deleteAccount,
  disableAccount,
} from "../src/services/identity/accounts/deletion.js";
import {
  handleBrowserLogout,
  handleBrowserSession,
} from "../src/services/identity/browserSession.js";
import { handleRegister } from "../src/core/register.js";
import { SERVICES } from "../src/mount.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  parseSunsetDate,
  platformMigrationReport,
  platformOidcMigration,
  platformSignInPolicy,
  RECENT_USE_SECONDS,
} from "../src/services/identity/accounts/platformMigration.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";

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
const AUD = "client-platform";
const REDIRECT = `${ORIGIN}/djdl/identity/auth/callback`;
const SUB = "pocket-user-1";
const ADA = "ada@example.com";
/** A day well before NOW (2023-11-14) and one well after it. */
const PAST = "2023-01-01";
const FUTURE = "2030-01-01";

let priv: KeyLike;
/** Every URL the stubbed `fetch` was asked for. */
let fetched: string[] = [];

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  priv = pair.privateKey;
  const pub = await importJWK(
    { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp" },
    "ES256",
  );
  idpKey.getKey = async () => pub;
  fetched = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

/** The platform IdP: the token endpoint answers an ID token carrying `claims`. */
function installIdp(claims: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetched.push(u);
    if (u === `${ISSUER}/api/oidc/token`) {
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(priv);
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function platformEnv(env: Env, extra: Partial<Env> = {}): Env {
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = AUD;
  env.PORTAL_SESSION_SECRET = env.PORTAL_SESSION_SECRET ?? "portal-secret";
  Object.assign(env, extra);
  return env;
}

async function count(db: Db, sql: string, ...params: unknown[]) {
  return (await db.first<{ n: number }>(sql, ...(params as never[])))?.n ?? 0;
}

async function linksOf(db: Db, accountId: string): Promise<string[]> {
  return (
    await db.all<{ kind: string; issuer_key: string; subject: string }>(
      "SELECT kind, issuer_key, subject FROM account_links WHERE account_id = ? ORDER BY kind, subject",
      accountId,
    )
  ).map((l) => `${l.kind}:${l.issuer_key}:${l.subject}`);
}

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

/** An account whose email sign-in method is `email`. */
async function emailAccount(db: Db, email: string): Promise<string> {
  const a = await insertAccount(
    db,
    { primaryEmail: email, primaryEmailVerified: true, displayName: null },
    NOW,
  );
  await insertLink(
    db,
    a.id,
    {
      issuerKey: EMAIL_ISSUER,
      tenantScope: "",
      subject: email,
      kind: "email",
      email,
      emailVerified: true,
      displayName: null,
      amr: null,
    },
    NOW,
  );
  return a.id;
}

/** An account whose only method is the platform IdP's subject `sub`. */
async function platformLinkedAccount(
  db: Db,
  sub: string,
  opts: { lastUsedAt?: number; email?: string } = {},
): Promise<string> {
  const a = await insertAccount(
    db,
    { primaryEmail: null, primaryEmailVerified: false, displayName: null },
    NOW,
  );
  await insertLink(
    db,
    a.id,
    {
      issuerKey: ISSUER,
      tenantScope: "",
      subject: sub,
      kind: "oidc",
      email: null,
      emailVerified: false,
      displayName: null,
      amr: null,
    },
    opts.lastUsedAt ?? NOW,
  );
  if (opts.email) {
    await insertLink(
      db,
      a.id,
      {
        issuerKey: EMAIL_ISSUER,
        tenantScope: "",
        subject: opts.email,
        kind: "email",
        email: opts.email,
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
  }
  return a.id;
}

async function insertSubLicense(
  db: Db,
  product: string,
  id: string,
  sub: string,
  opts: { email?: string | null; account?: string | null } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
       expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
       origin, modified_by, modified_at)
     VALUES (?, ?, 'active', ?, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL,
       'oidc', 'test', ?)`,
    product,
    id,
    sub,
    opts.email ?? null,
    NOW - 1000,
    NOW,
  );
  if (opts.account)
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      opts.account,
      product,
      id,
    );
}

// ── the switch ───────────────────────────────────────────────────────────────────────────────

describe("the switch (deploy-time; off by default)", () => {
  it("reads unset, empty and unrecognised modes as off, and flags the unrecognised", () => {
    const env = makeEnv(new KvMock(), []);
    expect(platformOidcMigration(env)).toEqual({
      mode: "off",
      modeUnrecognised: false,
      sunset: null,
      sunsetInvalid: false,
    });
    env.PLATFORM_OIDC_MIGRATION = "operator-only";
    expect(platformOidcMigration(env).mode).toBe("off");
    expect(platformOidcMigration(env).modeUnrecognised).toBe(true);
    env.PLATFORM_OIDC_MIGRATION = " Claim ";
    expect(platformOidcMigration(env).mode).toBe("claim");
    env.PLATFORM_OIDC_MIGRATION = "operators-only";
    expect(platformOidcMigration(env).mode).toBe("operators-only");
  });

  it("takes only a real UTC day as the sunset; anything else reads as unset", () => {
    expect(parseSunsetDate("2027-03-01")).toBe(Date.UTC(2027, 2, 1) / 1000);
    for (const bad of ["2027-02-30", "2027-13-01", "27-03-01", "2027-3-1", "x"])
      expect(parseSunsetDate(bad)).toBeNull();
    const env = makeEnv(new KvMock(), []);
    env.PLATFORM_OIDC_SUNSET = "2027-02-30";
    expect(platformOidcMigration(env)).toEqual(
      expect.objectContaining({ sunset: null, sunsetInvalid: true }),
    );
  });

  it("ignores the sunset while off; ends sign-in from 00:00 UTC of the day otherwise", () => {
    const env = makeEnv(new KvMock(), []);
    env.PLATFORM_OIDC_SUNSET = PAST;
    expect(platformSignInPolicy(env, NOW)).toEqual({ kind: "as-before" });
    env.PLATFORM_OIDC_MIGRATION = "claim";
    expect(platformSignInPolicy(env, NOW)).toEqual({ kind: "ended" });
    env.PLATFORM_OIDC_SUNSET = "2023-11-15"; // NOW is 2023-11-14T22:13:20Z
    expect(platformSignInPolicy(env, NOW)).toEqual({
      kind: "claim",
      linkedOnly: false,
    });
    expect(platformSignInPolicy(env, Date.UTC(2023, 10, 15) / 1000)).toEqual({
      kind: "ended",
    });
    env.PLATFORM_OIDC_MIGRATION = "operators-only";
    env.PLATFORM_OIDC_SUNSET = FUTURE;
    expect(platformSignInPolicy(env, NOW)).toEqual({
      kind: "claim",
      linkedOnly: true,
    });
  });
});

// ── product sign-in (`provider: platform`) ───────────────────────────────────────────────────

describe("claim at next sign-in through a provider: platform product", () => {
  let db: ReturnType<typeof makeTestDb>;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = platformEnv(makeEnv(new KvMock(), ["djdl"]));
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
    await db.run(
      "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
      "djdl",
      "free",
      "Free",
      null,
      null,
      3,
      null,
      NOW,
    );
    product = (await loadProduct(env, db, "djdl"))!;
  });

  /** The browser flow (no `return_to`): start, the IdP, the callback's "signed in" page. */
  async function browserSignIn(
    claims: Record<string, unknown> = { email: ADA, email_verified: true },
    sub = SUB,
    /** Runs between the start and the callback (e.g. the sunset passing meanwhile). */
    meanwhile: () => void = () => {},
  ): Promise<Response> {
    const start = await handleAuthStart(
      new Request(`${ORIGIN}/djdl/identity/auth/start`) as unknown as Request,
      env,
      db,
      product,
    );
    expect(start.status).toBe(302);
    const binder = cookieOf(start, LICENSE_CHOICE_BINDER_COOKIE);
    const authorize = new URL(start.headers.get("location")!);
    installIdp({
      sub,
      groups: ["members"],
      nonce: authorize.searchParams.get("nonce"),
      ...claims,
    });
    meanwhile();
    return handleAuthCallback(
      new Request(
        `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
        {
          headers: binder
            ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
            : {},
        },
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
  }

  const licenseOf = (sub = SUB) =>
    db.first<{ id: string; account_id: string | null }>(
      "SELECT id, account_id FROM licenses WHERE product = 'djdl' AND sub = ?",
      sub,
    );

  it("off by default: the sign-in writes no account and its licence stays floating", async () => {
    const res = await browserSignIn();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("already uses");
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM account_links")).toBe(0);
    expect((await licenseOf())?.account_id).toBeNull();
  });

  it("a verified email lands on one account on next sign-in, with the licence", async () => {
    // Before the rollout: the old sign-in made a floating `sub`-keyed licence.
    expect((await browserSignIn()).status).toBe(200);
    const before = await licenseOf();
    expect(before?.account_id).toBeNull();

    env.PLATFORM_OIDC_MIGRATION = "claim";
    expect((await browserSignIn()).status).toBe(200);
    const account = await db.first<{
      id: string;
      primary_email: string;
      primary_email_verified_at: number | null;
    }>("SELECT * FROM accounts");
    expect(account?.primary_email).toBe(ADA);
    expect(account?.primary_email_verified_at).toBe(NOW);
    expect(await linksOf(db, account!.id)).toEqual([
      `email:email:${ADA}`,
      `oidc:${ISSUER}:${SUB}`,
    ]);
    const after = await licenseOf();
    expect(after?.id).toBe(before?.id);
    expect(after?.account_id).toBe(account!.id);
    // The product sees the person through a pairwise subject.
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM account_product_subjects WHERE account_id = ? AND product = 'djdl'",
        account!.id,
      ),
    ).toBe(1);

    // Every later sign-in is the same account, which now owns the licence: I-26's chooser asks
    // which licence this browser uses instead of minting a second one.
    const later = await browserSignIn();
    expect(later.status).toBe(303);
    expect(later.headers.get("location")).toBe(
      `${ORIGIN}/djdl/identity/auth/choose`,
    );
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM licenses WHERE sub = ?", SUB),
    ).toBe(1);
  });

  it("device code: the licence the poll mints joins the claimed account", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const started = await handleAuthDeviceStart(
      new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev-1", deviceName: "Steam Deck" }),
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
    const authorize = new URL(confirmed.headers.get("location")!);
    const binder = cookieOf(confirmed, LICENSE_CHOICE_BINDER_COOKIE);
    installIdp({
      sub: SUB,
      groups: ["members"],
      nonce: authorize.searchParams.get("nonce"),
      email: ADA,
      email_verified: true,
    });
    const cb = await handleAuthCallback(
      new Request(
        `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
        {
          headers: binder
            ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
            : {},
        },
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(cb.status).toBe(200);
    // The callback made the account; no licence exists until the device-code holder polls.
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
    expect(await licenseOf()).toBeNull();
    const poll = await handleAuthDevicePoll(
      new Request(`${ORIGIN}/djdl/identity/auth/device/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode, deviceId: "dev-1" }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(((await poll.json()) as { status: string }).status).toBe("ready");
    const account = await db.first<{ id: string }>("SELECT id FROM accounts");
    expect((await licenseOf())?.account_id).toBe(account!.id);
  });

  it("an email another account uses gets the join offer and is never joined silently", async () => {
    const other = await emailAccount(db, ADA);
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const res = await browserSignIn();
    expect(res.status).toBe(200);
    const html = await res.text();
    // The offer: the address the person's own IdP just asserted, and where to join.
    expect(html).toContain(`A Polaris Key account already uses ${ADA}.`);
    expect(html).toContain('href="/login"');
    // Nothing joined: no second account, no new method on the other one, the licence floats.
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
    expect(await linksOf(db, other)).toEqual([`email:email:${ADA}`]);
    expect((await licenseOf())?.account_id).toBeNull();
  });

  it("an address on two accounts is ambiguous: nothing is written and nothing offered", async () => {
    await emailAccount(db, ADA);
    await insertAccount(
      db,
      { primaryEmail: ADA, primaryEmailVerified: true, displayName: null },
      NOW,
    );
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const res = await browserSignIn();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("already uses");
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(2);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM account_links WHERE kind = 'oidc'",
      ),
    ).toBe(0);
    expect((await licenseOf())?.account_id).toBeNull();
  });

  it("an unverified email is not an address: the subject gets an email-less account", async () => {
    await emailAccount(db, ADA);
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const res = await browserSignIn({ email: ADA, email_verified: false });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("already uses");
    const mine = await db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE kind = 'oidc' AND subject = ?",
      SUB,
    );
    expect(await linksOf(db, mine!.account_id)).toEqual([
      `oidc:${ISSUER}:${SUB}`,
    ]);
  });

  it("an email-less subject keeps signing in through the temporary method until the sunset", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    expect((await browserSignIn({})).status).toBe(200);
    const account = await db.first<{ id: string; primary_email: null }>(
      "SELECT * FROM accounts",
    );
    expect(account?.primary_email).toBeNull();
    expect(await linksOf(db, account!.id)).toEqual([`oidc:${ISSUER}:${SUB}`]);
    expect((await licenseOf())?.account_id).toBe(account!.id);

    // Operators-only: it already moved, so the temporary method still signs it in.
    env.PLATFORM_OIDC_MIGRATION = "operators-only";
    env.PLATFORM_OIDC_SUNSET = FUTURE;
    await db.run("UPDATE accounts SET last_sign_in_at = 0");
    const again = await browserSignIn({});
    // Signed in to its account, which owns the licence: on to I-26's chooser, as any owner.
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(
      `${ORIGIN}/djdl/identity/auth/choose`,
    );
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
    const last = await db.first<{ last_sign_in_at: number }>(
      "SELECT last_sign_in_at FROM accounts WHERE id = ?",
      account!.id,
    );
    expect(last?.last_sign_in_at).toBe(NOW);

    // Past the sunset it does not: a flow started before the day is refused at the callback, and
    // no code is exchanged for it.
    const ended = await browserSignIn({}, SUB, () => {
      env.PLATFORM_OIDC_SUNSET = PAST;
      fetched = [];
    });
    expect(ended.status).toBe(403);
    expect(await ended.text()).toContain("This way of signing in has ended");
    expect(fetched).toEqual([]);
  });

  it("operators-only refuses a subject that never moved, and writes nothing", async () => {
    env.PLATFORM_OIDC_MIGRATION = "operators-only";
    const res = await browserSignIn();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("This way of signing in has ended");
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(0);
    expect(await licenseOf()).toBeNull();
  });

  it("past the sunset /auth/start and /device/start refuse before sending anyone to the IdP", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    env.PLATFORM_OIDC_SUNSET = PAST;
    const start = await handleAuthStart(
      new Request(`${ORIGIN}/djdl/identity/auth/start`) as unknown as Request,
      env,
      db,
      product,
    );
    expect(start.status).toBe(403);
    expect(start.headers.get("location")).toBeNull();
    expect(await start.text()).toContain("This way of signing in has ended");
    const device = await handleAuthDeviceStart(
      new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev-1" }),
      }) as unknown as Request,
      env,
      db,
      product,
    );
    expect(device.status).toBe(404);
    expect(((await device.json()) as { error: string }).error).toBe("disabled");
    // Before the day both start as usual.
    env.PLATFORM_OIDC_SUNSET = FUTURE;
    expect(
      (
        await handleAuthStart(
          new Request(
            `${ORIGIN}/djdl/identity/auth/start`,
          ) as unknown as Request,
          env,
          db,
          product,
        )
      ).status,
    ).toBe(302);
  });

  it("a licence the I-26 chooser activates joins the claimed account", async () => {
    // The person's account already owns a licence here, so the sign-in asks which to use; their
    // own floating `sub`-keyed licence is a row, and choosing it activates it.
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const account = await platformLinkedAccount(db, SUB);
    await insertSubLicense(db, "djdl", "lic-owned", "someone-else", {
      account,
    });
    await db.run("UPDATE licenses SET tier_id = 'free' WHERE id = 'lic-owned'");
    await insertSubLicense(db, "djdl", "lic-own", SUB);
    await db.run("UPDATE licenses SET tier_id = 'free' WHERE id = 'lic-own'");

    const start = await handleAuthStart(
      new Request(`${ORIGIN}/djdl/identity/auth/start`) as unknown as Request,
      env,
      db,
      product,
    );
    const binder = cookieOf(start, LICENSE_CHOICE_BINDER_COOKIE)!;
    const authorize = new URL(start.headers.get("location")!);
    installIdp({
      sub: SUB,
      groups: ["members"],
      nonce: authorize.searchParams.get("nonce"),
    });
    const cb = await handleAuthCallback(
      new Request(
        `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
        { headers: { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` } },
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(cb.status).toBe(303);
    expect((await licenseOf())?.account_id).toBeNull();

    const chooser = (method: string, form?: Record<string, string>) =>
      handleAuthChoose(
        new Request(`${ORIGIN}/djdl/identity/auth/choose`, {
          method,
          headers: {
            cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}`,
            ...(form
              ? {
                  "content-type": "application/x-www-form-urlencoded",
                  "sec-fetch-site": "same-origin",
                }
              : {}),
          },
          body: form ? new URLSearchParams(form).toString() : undefined,
        }) as unknown as Request,
        env,
        db,
        product,
        NOW,
      );
    const page = await (await chooser("GET")).text();
    const token = /name="choice" value="([^"]+)"/.exec(page)![1]!;
    expect(page).toContain('value="lic-own"');
    const done = await chooser("POST", {
      choice: token,
      action: "use",
      license: "lic-own",
    });
    expect(done.status).toBe(200);
    expect((await licenseOf())?.account_id).toBe(account);
  });

  it("a provider address another account uses is kept unverified on the method, so it attaches nothing", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const mine = await platformLinkedAccount(db, SUB);
    await emailAccount(db, ADA);
    // A licence waiting on ADA's address (no subject): it belongs to whoever proves ADA.
    await insertSubLicense(db, "djdl", "lic-waiting", "unused", { email: ADA });
    await db.run(
      "UPDATE licenses SET sub = NULL, origin = 'admin' WHERE id = 'lic-waiting'",
    );

    expect((await browserSignIn()).status).toBe(200);
    const link = await db.first<{ email: string; email_verified: number }>(
      "SELECT email, email_verified FROM account_links WHERE account_id = ? AND kind = 'oidc'",
      mine,
    );
    expect(link).toEqual({ email: ADA, email_verified: 0 });
    const waiting = await db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-waiting'",
    );
    expect(waiting?.account_id).toBeNull();
    // Its own licence, from this sign-in, joins it as usual.
    expect((await licenseOf())?.account_id).toBe(mine);
  });

  it("a custom-issuer product never claims, whatever the mode", async () => {
    await db.run(
      "UPDATE oidc_config SET provider = 'custom', issuer = ?, client_id = ? WHERE product = 'djdl'",
      ISSUER,
      AUD,
    );
    product = (await loadProduct(env, db, "djdl"))!;
    env.PLATFORM_OIDC_MIGRATION = "operators-only";
    env.PLATFORM_OIDC_SUNSET = PAST;
    const res = await browserSignIn();
    expect(res.status).toBe(200);
    expect(await count(db, "SELECT COUNT(*) AS n FROM accounts")).toBe(0);
    expect((await licenseOf())?.account_id).toBeNull();
  });

  // ── N9 (the I-17 review): a disabled account does not sign in to a product ────────────────

  describe("a subject whose account can no longer sign in (N9)", () => {
    const ctx = () => ({ db, env, now: NOW, origin: ORIGIN });

    /** Everything a refused sign-in must leave as it was: no licence, no device, no account or
     *  method touched, no audit row. */
    async function snapshot() {
      return {
        licenses: await count(db, "SELECT COUNT(*) AS n FROM licenses"),
        devices: await count(db, "SELECT COUNT(*) AS n FROM devices"),
        accounts: await db.all(
          "SELECT id, status, last_sign_in_at, modified_at FROM accounts ORDER BY id",
        ),
        links: await db.all(
          "SELECT id, account_id, issuer_key, last_used_at, email FROM account_links ORDER BY id",
        ),
        subjects: await count(
          db,
          "SELECT COUNT(*) AS n FROM account_product_subjects",
        ),
        portalAudit: await count(db, "SELECT COUNT(*) AS n FROM portal_audit"),
        audit: await count(db, "SELECT COUNT(*) AS n FROM audit"),
      };
    }

    async function expectRefusedPage(res: Response): Promise<void> {
      expect(res.status).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      expect(html).toMatch(/This account can(&#39;|&#x27;|')t sign in/);
      expect(html).toContain("Contact Polaris Key support.");
    }

    /** A device-code flow up to its callback; `poll` is then the device-code holder's poll. */
    async function deviceSignIn(sub = SUB): Promise<{
      callback: Response;
      poll: () => Promise<{ status: string; token?: string }>;
    }> {
      const started = await handleAuthDeviceStart(
        new Request(`${ORIGIN}/djdl/identity/auth/device/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: "dev-1", deviceName: "Steam Deck" }),
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
      const authorize = new URL(confirmed.headers.get("location")!);
      const binder = cookieOf(confirmed, LICENSE_CHOICE_BINDER_COOKIE);
      installIdp({
        sub,
        groups: ["members"],
        nonce: authorize.searchParams.get("nonce"),
      });
      const callback = await handleAuthCallback(
        new Request(
          `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
          {
            headers: binder
              ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
              : {},
          },
        ) as unknown as Request,
        env,
        db,
        product,
        NOW,
      );
      let at = NOW;
      const poll = async () => {
        // Past the advertised interval each time, so no poll is told to slow down.
        at += 5;
        const res = await handleAuthDevicePoll(
          new Request(`${ORIGIN}/djdl/identity/auth/device/poll`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceCode, deviceId: "dev-1" }),
          }) as unknown as Request,
          env,
          db,
          product,
          at,
        );
        return (await res.json()) as { status: string; token?: string };
      };
      return { callback, poll };
    }

    for (const mode of ["off", "claim", "operators-only"] as const) {
      it(`${mode}: the browser sign-in is refused and nothing is minted or written`, async () => {
        const account = await platformLinkedAccount(db, SUB);
        // The subject's floating `sub`-keyed licence: before N9 this signed it in regardless.
        await insertSubLicense(db, "djdl", "lic-floating", SUB);
        await db.run(
          "UPDATE licenses SET tier_id = 'free' WHERE id = 'lic-floating'",
        );
        expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
        if (mode !== "off") env.PLATFORM_OIDC_MIGRATION = mode;
        if (mode === "operators-only") env.PLATFORM_OIDC_SUNSET = FUTURE;
        const before = await snapshot();

        await expectRefusedPage(await browserSignIn());
        expect(await snapshot()).toEqual(before);
        // Not the sunset's refusal: the subject did move; its account is what refuses.
        expect(fetched).toContain(`${ISSUER}/api/oidc/token`);
      });
    }

    it("an account whose deletion is under way is refused the same way", async () => {
      const account = await platformLinkedAccount(db, SUB);
      await db.run(
        "UPDATE accounts SET status = 'deleted', deleted_at = ? WHERE id = ?",
        NOW,
        account,
      );
      const before = await snapshot();
      await expectRefusedPage(await browserSignIn());
      expect(await snapshot()).toEqual(before);
    });

    it("a method still keyed by the pre-I-01 literal counts as the subject's account", async () => {
      env.PLATFORM_OIDC_MIGRATION = "claim";
      const account = await platformLinkedAccount(db, SUB);
      await db.run(
        "UPDATE account_links SET issuer_key = 'oidc' WHERE account_id = ?",
        account,
      );
      expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
      const before = await snapshot();
      await expectRefusedPage(await browserSignIn());
      // Not even re-keyed: a refused sign-in writes nothing.
      expect(await snapshot()).toEqual(before);
    });

    it("I-26: an account that owns a usable licence is refused, not sent to the chooser", async () => {
      const account = await platformLinkedAccount(db, SUB);
      await insertSubLicense(db, "djdl", "lic-owned", "someone-else", {
        account,
      });
      await db.run(
        "UPDATE licenses SET tier_id = 'free' WHERE id = 'lic-owned'",
      );
      // Active, the same sign-in opens the chooser.
      const chooser = await browserSignIn();
      expect(chooser.status).toBe(303);
      expect(chooser.headers.get("location")).toBe(
        `${ORIGIN}/djdl/identity/auth/choose`,
      );

      expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
      const before = await snapshot();
      await expectRefusedPage(await browserSignIn());
      expect(await snapshot()).toEqual(before);
      expect(await licenseOf()).toBeNull();
    });

    it("device code: refused at the callback, and the poll never mints", async () => {
      const account = await platformLinkedAccount(db, SUB);
      expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
      const before = await snapshot();
      const { callback, poll } = await deviceSignIn();
      await expectRefusedPage(callback);
      const answer = await poll();
      expect(answer.status).toBe("timeout");
      expect(answer.token).toBeUndefined();
      expect(await snapshot()).toEqual(before);
    });

    it("device code: an account disabled while the flow waits is refused at the poll", async () => {
      env.PLATFORM_OIDC_MIGRATION = "claim";
      const account = await platformLinkedAccount(db, SUB);
      const { callback, poll } = await deviceSignIn();
      expect(callback.status).toBe(200);
      // The callback stored the identity and wrote no licence; the account is disabled before
      // the device-code holder polls.
      expect(await licenseOf()).toBeNull();
      expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
      const before = await snapshot();
      const answer = await poll();
      expect(answer.status).toBe("error");
      expect(answer.token).toBeUndefined();
      expect(await snapshot()).toEqual(before);
      // The flow is gone: a later poll is told it timed out, and still mints nothing.
      expect((await poll()).status).toBe("timeout");
      expect(await licenseOf()).toBeNull();
    });

    it("an active account still signs in, through the browser and through a device code", async () => {
      await platformLinkedAccount(db, SUB);
      const res = await browserSignIn();
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/You(&#x27;|&#39;|')re signed in/);
      expect(await licenseOf()).not.toBeNull();

      const { callback, poll } = await deviceSignIn();
      expect(callback.status).toBe(200);
      const answer = await poll();
      expect(answer.status).toBe("ready");
      expect(answer.token).toMatch(/^pkeyt_/);
    });

    it("a subject with no account signs in exactly as before, beside a disabled one", async () => {
      // Someone else's account is disabled; this subject holds no method at all.
      const other = await platformLinkedAccount(db, "someone-else");
      expect(await disableAccount(ctx(), other)).toEqual({ ok: true });
      const res = await browserSignIn();
      expect(res.status).toBe(200);
      const lic = await licenseOf();
      expect(lic).not.toBeNull();
      expect(lic?.account_id).toBeNull();

      const { callback, poll } = await deviceSignIn();
      expect(callback.status).toBe(200);
      expect((await poll()).status).toBe("ready");
    });

    // ── the residual, closed: a live product browser session ends with its account ─────────

    describe("a live product browser session (the N9 residual)", () => {
      const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
      const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
      const COOKIE = "pkey_djdl_session";

      beforeEach(async () => {
        // License, Config and Identity on; registration only behind a product sign-in.
        await setServices(
          db,
          "djdl",
          serializeServices({
            services: {
              license: { enabled: true },
              config: { enabled: true },
              release: { enabled: false },
              distribution: { enabled: false },
              update: { enabled: false },
              identity: { enabled: true },
              sync: { enabled: false },
            },
            registration: "requires-identity",
          }),
          "manifest",
          NOW,
        );
        product = (await loadProduct(env, db, "djdl"))!;
        expect(product.registration).toBe("requires-identity");
      });

      /** The `return_to` browser flow: the callback answers with the product session cookie. */
      async function browserSessionSignIn(sub = SUB): Promise<string> {
        const returnTo = encodeURIComponent(`${ORIGIN}/djdl/app`);
        const start = await handleAuthStart(
          new Request(
            `${ORIGIN}/djdl/identity/auth/start?return_to=${returnTo}`,
          ) as unknown as Request,
          env,
          db,
          product,
        );
        expect(start.status).toBe(302);
        const binder = cookieOf(start, LICENSE_CHOICE_BINDER_COOKIE);
        const authorize = new URL(start.headers.get("location")!);
        installIdp({
          sub,
          groups: ["members"],
          nonce: authorize.searchParams.get("nonce"),
        });
        const res = await handleAuthCallback(
          new Request(
            `${ORIGIN}/djdl/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
            {
              headers: binder
                ? { cookie: `${LICENSE_CHOICE_BINDER_COOKIE}=${binder}` }
                : {},
            },
          ) as unknown as Request,
          env,
          db,
          product,
          NOW,
        );
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(`${ORIGIN}/djdl/app`);
        const value = cookieOf(res, COOKIE);
        expect(value).toBeTruthy();
        return `${COOKIE}=${value}`;
      }

      async function sessionRead(cookie: string, at = NOW + 10) {
        const res = await handleBrowserSession(
          new Request(`${ORIGIN}/djdl/identity/session`, {
            headers: { cookie },
          }) as unknown as Request,
          env,
          db,
          product,
          at,
        );
        expect(res.status).toBe(200);
        return (await res.json()) as {
          authenticated: boolean;
          doc: unknown;
        };
      }

      async function registerOn(cookie: string, device: string) {
        return handleRegister(
          new Request(`${ORIGIN}/djdl/devices/register`, {
            method: "POST",
            headers: { "x-pkey-device": device, cookie },
          }) as unknown as Request,
          env,
          db,
          product,
          NOW + 10,
          SERVICES,
        );
      }

      /** Every device seat and its credential: what disabling the account must not touch. */
      const seats = () =>
        db.all<{
          device_id: string;
          license_id: string;
          status: string;
          token_hash: string | null;
        }>(
          "SELECT device_id, license_id, status, token_hash FROM devices WHERE product = 'djdl' ORDER BY device_id",
        );

      const sessionKeys = () =>
        (env.HOT as unknown as KvMock)
          .keys()
          .filter((k) => k.startsWith("p:djdl:browser-session:"));

      it("disabling the account ends it: signed out, no registration, seats and tokens kept", async () => {
        const account = await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        expect(sessionKeys()).toHaveLength(1);

        // Live: the page reads its settings and the session registers a device.
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect((await registerOn(cookie, DEVICE)).status).toBe(200);
        const before = await seats();
        expect(before.map((d) => d.device_id)).toEqual(
          expect.arrayContaining([
            DEVICE,
            `browser:${(await licenseOf())!.id}`,
          ]),
        );
        expect(before.every((d) => d.status === "authorized")).toBe(true);

        expect(await disableAccount(ctx(), account)).toEqual({ ok: true });

        // Ended: signed out, and it registers nothing more.
        expect(await sessionRead(cookie)).toEqual({
          authenticated: false,
          doc: null,
        });
        const refused = await registerOn(cookie, DEVICE_2);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
          error: { code: "registration_closed" },
        });
        expect(sessionKeys()).toHaveLength(0);

        // The seats are the licence's: every one is still authorized, with its token.
        expect(await seats()).toEqual(before);
        for (const d of before)
          expect(
            await env.HOT.get(`p:djdl:token:${d.token_hash}`),
          ).not.toBeNull();

        // Sign-out finds nothing to end, and still deauthorizes no seat.
        const logout = await handleBrowserLogout(
          new Request(`${ORIGIN}/djdl/identity/auth/logout`, {
            method: "POST",
            headers: { cookie },
          }) as unknown as Request,
          env,
          db,
          product,
          NOW + 20,
        );
        expect(logout.status).toBe(200);
        expect(await seats()).toEqual(before);
      });

      it("an account whose deletion is under way ends it the same way", async () => {
        const account = await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        await db.run(
          "UPDATE accounts SET status = 'deleted', deleted_at = ? WHERE id = ?",
          NOW,
          account,
        );
        expect((await sessionRead(cookie)).authenticated).toBe(false);
        expect((await registerOn(cookie, DEVICE)).status).toBe(403);
      });

      it("a subject with no account keeps its session, beside a disabled account", async () => {
        const other = await platformLinkedAccount(db, "someone-else");
        const cookie = await browserSessionSignIn();
        expect(await disableAccount(ctx(), other)).toEqual({ ok: true });
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect((await registerOn(cookie, DEVICE)).status).toBe(200);
      });

      it("an active account's session lives on", async () => {
        await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect((await registerOn(cookie, DEVICE)).status).toBe(200);
        expect((await sessionRead(cookie, NOW + 60)).authenticated).toBe(true);
      });

      it("a session opened before the subject had an account ends when that account is disabled", async () => {
        // No account holds SUB at sign-in: the session is bound to the subject alone.
        const cookie = await browserSessionSignIn();
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect((await registerOn(cookie, DEVICE)).status).toBe(200);

        // Later the subject's method joins an account, which is then disabled.
        const account = await platformLinkedAccount(db, SUB);
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect(await disableAccount(ctx(), account)).toEqual({ ok: true });

        expect(await sessionRead(cookie)).toEqual({
          authenticated: false,
          doc: null,
        });
        expect((await registerOn(cookie, DEVICE_2)).status).toBe(403);
        expect(sessionKeys()).toHaveLength(0);
      });

      it("a method moved to a disabled account ends it, whichever account it signed in as", async () => {
        const first = await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        // The subject's method moves to another account, which is disabled; the first stays
        // active.
        const second = await platformLinkedAccount(db, "placeholder");
        await db.run(
          "UPDATE account_links SET account_id = ? WHERE account_id = ? AND subject = ?",
          second,
          first,
          SUB,
        );
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect(await disableAccount(ctx(), second)).toEqual({ ok: true });
        expect((await sessionRead(cookie)).authenticated).toBe(false);
        expect(sessionKeys()).toHaveLength(0);
      });

      it("erasing the account (no row, no method left) ends it", async () => {
        const account = await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        expect((await sessionRead(cookie)).authenticated).toBe(true);
        expect(await deleteAccount(ctx(), account)).toEqual({ ok: true });
        expect(
          await count(
            db,
            "SELECT COUNT(*) AS n FROM accounts WHERE id = ?",
            account,
          ),
        ).toBe(0);
        expect(
          await count(
            db,
            "SELECT COUNT(*) AS n FROM account_links WHERE subject = ?",
            SUB,
          ),
        ).toBe(0);
        expect(await sessionRead(cookie)).toEqual({
          authenticated: false,
          doc: null,
        });
        expect((await registerOn(cookie, DEVICE)).status).toBe(403);
        expect(sessionKeys()).toHaveLength(0);
      });

      it("a D1 error while checking reads as signed out, never a 500, and keeps the session", async () => {
        await platformLinkedAccount(db, SUB);
        const cookie = await browserSessionSignIn();
        // D1 fails on the subject's lookup, the check's first read.
        const first = db.first.bind(db);
        let failed = 0;
        const spy = vi.spyOn(db, "first").mockImplementation(((
          sql: string,
          ...params: unknown[]
        ) => {
          if (sql.includes("FROM account_links")) {
            failed++;
            return Promise.reject(new Error("D1 down"));
          }
          return first(sql, ...(params as never[]));
        }) as typeof db.first);
        expect(await sessionRead(cookie)).toEqual({
          authenticated: false,
          doc: null,
        });
        expect(failed).toBe(1);
        spy.mockRestore();
        // Transient: the record is kept, and the next read finds the session again.
        expect(sessionKeys()).toHaveLength(1);
        expect((await sessionRead(cookie)).authenticated).toBe(true);
      });
    });

    it("a custom-issuer product's subject resolves no account: unchanged", async () => {
      // The same subject string under the platform issuer belongs to a disabled account; a
      // custom issuer's subject is a different identity.
      const account = await platformLinkedAccount(db, SUB);
      expect(await disableAccount(ctx(), account)).toEqual({ ok: true });
      await db.run(
        "UPDATE oidc_config SET provider = 'custom', issuer = ?, client_id = ? WHERE product = 'djdl'",
        ISSUER,
        AUD,
      );
      product = (await loadProduct(env, db, "djdl"))!;
      const res = await browserSignIn();
      expect(res.status).toBe(200);
      expect(await licenseOf()).not.toBeNull();
    });
  });
});

// ── the portal's platform-IdP sign-in ───────────────────────────────────────────────────────

describe("the portal's single sign-on", () => {
  async function portalWorld(extra: Partial<Env> = {}): Promise<CardWorld> {
    const w = await seededWorld();
    platformEnv(w.env, extra);
    return w;
  }

  /** `/login` on `d`: the authorize redirect's `state` and `nonce`; `d` keeps the binding. */
  async function startPortalLogin(
    d: Device,
  ): Promise<{ state: string; nonce: string }> {
    const login = await d.send("GET", "/login");
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location")!);
    return {
      state: authorize.searchParams.get("state")!,
      nonce: authorize.searchParams.get("nonce")!,
    };
  }

  /** The IdP leg with `claims`, then the callback opened on `finisher`. */
  async function finishPortalLogin(
    finisher: Device,
    flow: { state: string; nonce: string },
    claims: Record<string, unknown>,
  ): Promise<Response> {
    installIdp({ nonce: flow.nonce, ...claims });
    return finisher.send("GET", `/callback?code=c&state=${flow.state}`);
  }

  /** The whole round trip in one browser: `/login`, the IdP, `/callback`. */
  async function portalCallback(
    _w: CardWorld,
    d: Device,
    claims: Record<string, unknown>,
  ): Promise<Response> {
    return finishPortalLogin(d, await startPortalLogin(d), claims);
  }

  it("claim: an email another account uses opens the email step; joining needs that account proven here", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "claim" });
    const other = await emailAccount(w.db, ADA);
    await insertSubLicense(w.db, "acme", "lic-pocket", SUB, { email: ADA });
    const d = new Device(w);

    const res = await portalCallback(w, d, {
      sub: SUB,
      email: ADA,
      email_verified: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(true);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await count(w.db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);

    // The email step: the IdP's verified address is another account's.
    const chosen = await d.send("POST", "/api/signin/confirm-email", {
      choice: "provider",
    });
    expect(chosen.status).toBe(409);
    expect(await chosen.json()).toEqual(
      expect.objectContaining({ error: "email_in_use", proven: false }),
    );
    // Taking the offer without proving that account is refused, and nothing moves.
    const early = await d.send("POST", "/api/signin/confirm-email/join");
    expect(early.status).toBe(403);
    expect(await linksOf(w.db, other)).toEqual([`email:email:${ADA}`]);

    // The person signs in to that account in this browser, then joins.
    expect((await d.signInWithCode(ADA)).status).toBe(200);
    const joined = await d.send("POST", "/api/signin/confirm-email/join");
    expect(joined.status).toBe(200);
    expect(await joined.json()).toEqual(
      expect.objectContaining({ status: "signed_in", joined: true }),
    );
    expect(await count(w.db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
    expect(await linksOf(w.db, other)).toEqual([
      `email:email:${ADA}`,
      `oidc:${ISSUER}:${SUB}`,
    ]);
    const lic = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-pocket'",
    );
    expect(lic?.account_id).toBe(other);
  });

  it("off: the same sign-in keeps the old answer and writes nothing", async () => {
    const w = await portalWorld();
    await emailAccount(w.db, ADA);
    const d = new Device(w);
    const res = await portalCallback(w, d, {
      sub: SUB,
      email: ADA,
      email_verified: true,
    });
    expect(res.status).toBe(409);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(await count(w.db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
  });

  it("claim: a new verified address makes one account, with the subject as a method", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "claim" });
    await insertSubLicense(w.db, "acme", "lic-pocket", SUB);
    const d = new Device(w);
    const res = await portalCallback(w, d, {
      sub: SUB,
      email: ADA,
      email_verified: true,
    });
    expect(res.status).toBe(302);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const account = await w.db.first<{ id: string }>("SELECT id FROM accounts");
    expect(await linksOf(w.db, account!.id)).toEqual([
      `email:email:${ADA}`,
      `oidc:${ISSUER}:${SUB}`,
    ]);
    const lic = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-pocket'",
    );
    expect(lic?.account_id).toBe(account!.id);
  });

  it("claim: an address the IdP did not verify is neither offered nor kept", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "claim" });
    const other = await emailAccount(w.db, ADA);
    const d = new Device(w);
    const res = await portalCallback(w, d, {
      sub: SUB,
      email: ADA,
      email_verified: false,
    });
    expect(res.status).toBe(302);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const link = await w.db.first<{
      account_id: string;
      email: string | null;
    }>("SELECT account_id, email FROM account_links WHERE kind = 'oidc'");
    expect(link?.account_id).not.toBe(other);
    expect(link?.email).toBeNull();
    expect(await linksOf(w.db, link!.account_id)).toEqual([
      `oidc:${ISSUER}:${SUB}`,
    ]);
  });

  it("operators-only: a moved subject signs in; one that never moved is refused", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "operators-only" });
    await platformLinkedAccount(w.db, "moved-1");
    const moved = new Device(w);
    const ok = await portalCallback(w, moved, { sub: "moved-1" });
    expect(ok.status).toBe(302);
    expect(moved.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);

    const stranger = new Device(w, "203.0.113.99");
    const refused = await portalCallback(w, stranger, {
      sub: "never-moved",
      email: "bob@example.com",
      email_verified: true,
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("This way of signing in has ended");
    expect(stranger.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await count(w.db, "SELECT COUNT(*) AS n FROM accounts")).toBe(1);
  });

  it("past the sunset: /login and the callback refuse, and the card stops offering single sign-on", async () => {
    const before = await portalWorld({
      PLATFORM_OIDC_MIGRATION: "operators-only",
      PLATFORM_OIDC_SUNSET: FUTURE,
    });
    const caps = await new Device(before).send("GET", "/api/capabilities");
    expect(((await caps.json()) as { auth: { oidc: boolean } }).auth.oidc).toBe(
      true,
    );

    const w = await portalWorld({
      PLATFORM_OIDC_MIGRATION: "operators-only",
      PLATFORM_OIDC_SUNSET: PAST,
    });
    await platformLinkedAccount(w.db, "moved-1");
    const d = new Device(w);
    const login = await d.send("GET", "/login");
    expect(login.status).toBe(403);
    expect(await login.text()).toContain("This way of signing in has ended");
    const after = await d.send("GET", "/api/capabilities");
    expect(
      ((await after.json()) as { auth: { oidc: boolean } }).auth.oidc,
    ).toBe(false);
    // A flow started before the sunset is not finished after it, and no code is exchanged.
    w.env.PLATFORM_OIDC_SUNSET = FUTURE;
    const flow = await startPortalLogin(d);
    w.env.PLATFORM_OIDC_SUNSET = PAST;
    fetched = [];
    const cb = await finishPortalLogin(d, flow, { sub: "moved-1" });
    expect(cb.status).toBe(403);
    expect(fetched).toEqual([]);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("a callback opened in another browser is refused: no gate, no session, no method, no exchange", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "claim" });
    await emailAccount(w.db, ADA);
    const starter = new Device(w);
    const other = new Device(w, "198.51.100.40");
    const flow = await startPortalLogin(starter);
    fetched = [];
    const res = await finishPortalLogin(other, flow, {
      sub: SUB,
      email: ADA,
      email_verified: true,
    });
    expect(res.status).toBe(401);
    expect(other.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(other.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(fetched).toEqual([]);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_links WHERE kind = 'oidc'",
      ),
    ).toBe(0);
    // The flow is spent: the starting browser cannot reuse it either.
    expect((await finishPortalLogin(starter, flow, { sub: SUB })).status).toBe(
      400,
    );
  });

  it("REGRESSION (I-17 review B1): an attacker's callback handed to a victim never joins the attacker's sign-in to the victim's account", async () => {
    const w = await portalWorld({ PLATFORM_OIDC_MIGRATION: "claim" });
    // The attacker's Pocket ID asserts a verified address an existing account uses, so a
    // completed callback would open the email step's join offer.
    await emailAccount(w.db, "att@example.com");
    // The victim has an account and is signed in to it in their browser.
    const victimEmail = "victim@example.com";
    const victimAccount = await emailAccount(w.db, victimEmail);
    const victim = new Device(w, "198.51.100.41");
    expect((await victim.signInWithCode(victimEmail)).status).toBe(200);

    // The attacker starts single sign-on in their own browser and finishes the IdP leg...
    const attacker = new Device(w, "198.51.100.42");
    const flow = await startPortalLogin(attacker);
    // ...then hands the callback URL to the victim, whose browser opens it.
    const res = await finishPortalLogin(victim, flow, {
      sub: "attacker-sub",
      email: "att@example.com",
      email_verified: true,
    });
    expect(res.status).toBe(401);
    expect(victim.jar.has(EMAIL_GATE_COOKIE)).toBe(false);

    // The victim's own proof (a code to their address) has no gate to complete.
    const typed = await victim.send("POST", "/api/signin/confirm-email", {
      choice: "typed",
      email: victimEmail,
    });
    expect(typed.status).toBe(400);
    expect(
      (await victim.send("POST", "/api/signin/confirm-email/join")).status,
    ).toBe(400);

    expect(await linksOf(w.db, victimAccount)).toEqual([
      `email:email:${victimEmail}`,
    ]);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_links WHERE subject = 'attacker-sub'",
      ),
    ).toBe(0);
  });
});

// ── the email-less count ─────────────────────────────────────────────────────────────────────

describe("the email-less count", () => {
  async function seededCount(): Promise<{ db: Db; env: Env }> {
    const db = makeTestDb();
    const env = platformEnv(makeEnv(new KvMock(), []), {
      PLATFORM_OIDC_MIGRATION: "claim",
      PLATFORM_OIDC_SUNSET: FUTURE,
    });
    await seedProduct(db, "acme");
    await seedProduct(db, "beta");
    await seedProduct(db, "byoidp");
    await db.run(
      "INSERT INTO oidc_config (product, provider, issuer, client_id) VALUES ('byoidp', 'custom', 'https://idp.byo.example', 'byo')",
    );
    // Linked: one with another way in, two whose only way in is the temporary method (one used
    // recently, one long ago), and a disabled account that is not counted.
    await platformLinkedAccount(db, "s-other", { email: "o@example.com" });
    await platformLinkedAccount(db, "s-only-recent", { lastUsedAt: NOW - 10 });
    await platformLinkedAccount(db, "s-only-old", {
      lastUsedAt: NOW - RECENT_USE_SECONDS - 10,
    });
    const disabled = await platformLinkedAccount(db, "s-disabled");
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      disabled,
    );
    // Unlinked licence subjects on platform products.
    const owner = await platformLinkedAccount(db, "s-owner", {
      email: "owner@example.com",
    });
    await insertSubLicense(db, "acme", "l1", "u-email", { email: "u@x.io" });
    await insertSubLicense(db, "acme", "l2", "u-none");
    await insertSubLicense(db, "beta", "l3", "u-none"); // one subject, two products
    await insertSubLicense(db, "acme", "l4", "u-owned", { account: owner });
    // A licence of a linked subject is not "unlinked"; a custom-issuer one is not the platform's.
    await insertSubLicense(db, "acme", "l5", "s-only-old");
    await insertSubLicense(db, "byoidp", "l6", "u-custom");
    return { db, env };
  }

  it("counts subjects only, split by whether they keep a way in after the sunset", async () => {
    const { db, env } = await seededCount();
    const report = await platformMigrationReport(db, env, NOW);
    expect(report).toEqual({
      generatedAt: NOW,
      mode: "claim",
      modeUnrecognised: false,
      sunset: FUTURE,
      sunsetInvalid: false,
      ended: false,
      platformIdpConfigured: true,
      linked: {
        subjects: 4,
        withOtherMethod: 2,
        onlyMethod: 2,
        onlyMethodRecent: 1,
      },
      unlinked: { subjects: 3, onAccount: 1, withEmail: 1, emailLess: 1 },
      emailLess: 3,
    });
    // Nothing that names a person: no subject, address or account id.
    const text = JSON.stringify(report);
    for (const needle of ["s-only", "u-none", "@", "acct_"])
      expect(text).not.toContain(needle);
  });

  it("is served to platform admins only, at GET /manage/api/platform/identity-migration", async () => {
    const { db, env } = await seededCount();
    env.ADMIN_SESSION_SECRET = "admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    const call = async (groups: string[], method = "GET") => {
      const { token, session } = await issueSession(
        env,
        { sub: "op-1", name: "Op", email: "op@example.com", groups },
        NOW,
      );
      const headers: Record<string, string> = {
        cookie: `${ADMIN_COOKIE}=${token}`,
      };
      if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
      return handleAdmin(
        new Request(`${ORIGIN}/manage/api/platform/identity-migration`, {
          method,
          headers,
        }) as unknown as Request,
        env,
        db,
        "/api/platform/identity-migration",
        { now: NOW },
      );
    };
    const ok = await call(["platform-admins"]);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(
      expect.objectContaining({ emailLess: 3, consoleClientDedicated: false }),
    );
    expect((await call(["members"])).status).toBe(403);
    expect((await call(["platform-admins"], "POST")).status).toBe(405);
  });
});
