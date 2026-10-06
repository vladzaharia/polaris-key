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
import { artefacts } from "./singleUseMock.js";
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  handleAuthCallback,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthStart,
} from "../src/services/identity/oidc.js";
import { LICENSE_CHOICE_BINDER_COOKIE } from "../src/services/identity/licenseChoice.js";
import { portalFlowKey } from "../src/services/identity/portal/auth.js";
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

    // Past the sunset it does not, and no code is exchanged for it.
    env.PLATFORM_OIDC_SUNSET = PAST;
    fetched = [];
    const ended = await browserSignIn({});
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
});

// ── the portal's platform-IdP sign-in ───────────────────────────────────────────────────────

describe("the portal's single sign-on", () => {
  const STATE = "portal-state-1";
  const NONCE = "portal-nonce-1";

  async function portalWorld(extra: Partial<Env> = {}): Promise<CardWorld> {
    const w = await seededWorld();
    platformEnv(w.env, extra);
    return w;
  }

  /** The IdP round trip on a device: plant the flow `/login` would have made, then call back. */
  async function portalCallback(
    w: CardWorld,
    d: Device,
    claims: Record<string, unknown>,
  ): Promise<Response> {
    await artefacts(w.env).put(
      await portalFlowKey(w.env, STATE),
      JSON.stringify({
        verifier: "v".repeat(43),
        nonce: NONCE,
        redirectUri: `${ORIGIN}/callback`,
      }),
    );
    installIdp({ nonce: NONCE, ...claims });
    return d.send("GET", `/callback?code=c&state=${STATE}`);
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
    fetched = [];
    const cb = await portalCallback(w, d, { sub: "moved-1" });
    expect(cb.status).toBe(403);
    expect(fetched).toEqual([]);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
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
