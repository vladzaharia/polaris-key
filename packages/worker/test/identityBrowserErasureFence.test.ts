/**
 * I-11: the request-time erasure fence on the product side (`core/accounts/erasureFence.ts`).
 *
 * A D1 Time Travel restore rewinds D1 but not R2, so an erased account is `active` again in D1,
 * with its methods, subjects and sessions, until the cron replay re-erases it. The erasure ledger
 * (R2) is what still says "erased". These gates read it before they grant anything:
 *
 *   - a product browser session (`loadBrowserSession`): a KV record, which a restore never touches;
 *   - the platform-IdP product sign-in (`platformSubjectStanding`: the callback and the device poll);
 *   - the browser-session mint (`createBrowserSession`, with an `accountId`);
 *   - the device wire (`POST /<p>/identity/attach`, `GET /<p>/identity/subject`).
 *
 * Every window test pins the same three things: REFUSED between the restore and the replay, STILL
 * refused (or, where the replay erases the account's methods, a stranger again) after the replay,
 * and for an unreadable ledger the fail-closed answer with nothing spent, written or ended, and
 * the gate working again once the ledger reads. Each also names an account that is NOT on the
 * ledger in the same world, so a gate that is broken for everyone cannot pass.
 *
 * "A cold isolate": the fence remembers an erasure for the life of the bucket binding it read
 * through, and the isolate that erased knows at once. A restore is noticed by an isolate that
 * never saw the erasure, so most tests rebind `BLOBS` to a fresh bucket that holds the same ledger
 * ({@link coldIsolate}); the `HEAD` it then records is the read the fence actually makes.
 */

import { issuerMetadataResponse } from "./oidcIssuerFake.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { eraseAndRestore, LedgerBucket } from "./eraseRestore.js";
import { dispatchWith } from "../src/dispatch.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  setDeviceSubject,
  subjectFor,
} from "../src/core/accounts/accountSubjects.js";
import {
  handleAuthCallback,
  handleAuthDeviceEntry,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthStart,
} from "../src/services/identity/oidc.js";
import { LICENSE_CHOICE_BINDER_COOKIE } from "../src/services/identity/licenseChoice.js";
import {
  EMAIL_ISSUER,
  getAccountRow,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import {
  disableAccount,
  replayErasures,
} from "../src/services/identity/accounts/deletion.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import {
  createBrowserSession,
  handleBrowserSession,
} from "../src/services/identity/browserSession.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { handleRegister } from "../src/core/register.js";
import { SERVICES } from "../src/mount.js";
import { SERVICE_SLUGS, serializeServices } from "../src/core/services.js";
import { getDevice, getLicense, setServices } from "../src/core/repo.js";
import { platformSubjectStanding } from "../src/services/identity/accounts/platformMigration.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

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
const SLUG = "djdl";
const REDIRECT = `${ORIGIN}/${SLUG}/identity/auth/callback`;
const SUB = "pocket-user-1";
const SUB_B = "pocket-user-2";
const SUB_C = "pocket-user-3";
const OTHER_SUB = "someone-else";
const FUTURE = "2030-01-01";
const DEVICE = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const DEVICE_2 = "IIIIJJJJKKKKLLLLMMMMNNNNOOOOPPPP";
const COOKIE = "pkey_djdl_session";
const DEV_A = "I11DEVICEA0000000000000000000001";
const DEV_B = "I11DEVICEB0000000000000000000002";

let priv: CryptoKey;
let db: SqliteDb;
let env: Env;
let product: Product;
/** The bucket `env.BLOBS` starts out as: the isolate that does the erasing. */
let bucket: LedgerBucket;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  priv = pair.privateKey;
  const pub = await importJWK(
    { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp" },
    "ES256",
  );
  idpKey.getKey = async () => pub;

  db = makeTestDb();
  bucket = new LedgerBucket();
  env = makeEnv(new KvMock(), [SLUG]);
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = AUD;
  env.PORTAL_SESSION_SECRET = env.PORTAL_SESSION_SECRET ?? "portal-secret";
  env.BLOBS = asR2(bucket);
  await seedProduct(db, SLUG);
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    SLUG,
    "platform",
    null,
    null,
    null,
    JSON.stringify([REDIRECT]),
    JSON.stringify({ members: { role: "user", tier: "free" } }),
  );
  await db.run(
    "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
    SLUG,
    "free",
    "Free",
    null,
    null,
    3,
    null,
    NOW,
  );
  product = (await loadProduct(env, db, SLUG))!;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  idpKey.getKey = null;
});

// ── harness ──────────────────────────────────────────────────────────────────────────────────

/** The platform IdP: the token endpoint answers an ID token carrying `claims`. */
function installIdp(claims: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const meta = await issuerMetadataResponse(u, idpKey.getKey);
    if (meta) return meta;
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

/** The account context the erasure and the replay run under. */
const ctx = (now = NOW + 50): AccountContext => ({
  db,
  env,
  now,
  origin: ORIGIN,
});

/**
 * Another isolate: `env.BLOBS` becomes a bucket of its own (so the fence remembers nothing about
 * any account) holding every object `from` holds, i.e. the ledger a restore leaves behind.
 */
async function coldIsolate(
  from: LedgerBucket,
  opts: { down?: boolean } = {},
): Promise<LedgerBucket> {
  const cold = new LedgerBucket();
  for (const key of from.keys()) await cold.put(key, "ledger");
  cold.down = opts.down ?? false;
  env.BLOBS = asR2(cold);
  return cold;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await db.first<{ n: number }>(sql, ...(params as never[])))?.n ?? 0;
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

/** Add the platform IdP's subject `sub` as a sign-in method of `accountId`. */
async function addPlatformLink(accountId: string, sub: string): Promise<void> {
  await insertLink(
    db,
    accountId,
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
    NOW,
  );
}

/** An account whose only method is the platform IdP's subject `sub`. */
async function platformLinkedAccount(sub: string): Promise<string> {
  const a = await insertAccount(
    db,
    { primaryEmail: null, primaryEmailVerified: false, displayName: null },
    NOW,
  );
  await addPlatformLink(a.id, sub);
  return a.id;
}

/** An account with an email method only (no platform subject). */
async function emailAccount(email: string): Promise<string> {
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

const licenseOf = (sub = SUB) =>
  db.first<{ id: string; account_id: string | null }>(
    "SELECT id, account_id FROM licenses WHERE product = ? AND sub = ?",
    SLUG,
    sub,
  );

const kv = (): KvMock => env.HOT as unknown as KvMock;

const sessionKeys = () =>
  kv()
    .keys()
    .filter((k) => k.startsWith(`p:${SLUG}:browser-session:`));

/** Every browser session and device token the KV holds: what a refused sign-in must not mint. */
const mintedKeys = () =>
  kv()
    .keys()
    .filter(
      (k) =>
        k.startsWith(`p:${SLUG}:browser-session:`) ||
        k.startsWith(`p:${SLUG}:token:`),
    );

/** Everything a refused sign-in must leave as it was: no licence, no device, no account or method
 *  touched, no audit row. */
async function snapshot() {
  return {
    licenses: await count("SELECT COUNT(*) AS n FROM licenses"),
    devices: await count("SELECT COUNT(*) AS n FROM devices"),
    accounts: await db.all(
      "SELECT id, status, last_sign_in_at, modified_at FROM accounts ORDER BY id",
    ),
    links: await db.all(
      "SELECT id, account_id, issuer_key, last_used_at, email FROM account_links ORDER BY id",
    ),
    subjects: await count("SELECT COUNT(*) AS n FROM account_product_subjects"),
    portalAudit: await count("SELECT COUNT(*) AS n FROM portal_audit"),
    audit: await count("SELECT COUNT(*) AS n FROM audit"),
  };
}

interface SessionAnswer {
  authenticated: boolean;
  doc: unknown;
}
const SIGNED_OUT: SessionAnswer = { authenticated: false, doc: null };

/** Every device seat and its credential. */
const seats = () =>
  db.all<{
    device_id: string;
    license_id: string;
    status: string;
    token_hash: string | null;
  }>(
    "SELECT device_id, license_id, status, token_hash FROM devices WHERE product = ? ORDER BY device_id",
    SLUG,
  );

async function setRequiresIdentity(): Promise<void> {
  // Config and Identity on, License off: registration follows the services to requires-identity.
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: false },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  product = (await loadProduct(env, db, SLUG))!;
}

// ── 1 + 2. a live product browser session ────────────────────────────────────────────────────

describe("I-11 fence: a live product browser session", () => {
  beforeEach(setRequiresIdentity);

  /** The `return_to` browser flow: the callback answers with the product session cookie. */
  async function browserSessionSignIn(sub = SUB): Promise<string> {
    const returnTo = encodeURIComponent(`${ORIGIN}/${SLUG}/app`);
    const start = await handleAuthStart(
      new Request(
        `${ORIGIN}/${SLUG}/identity/auth/start?return_to=${returnTo}`,
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
        `${ORIGIN}/${SLUG}/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
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
    expect(res.headers.get("location")).toBe(`${ORIGIN}/${SLUG}/app`);
    const value = cookieOf(res, COOKIE);
    expect(value).toBeTruthy();
    return `${COOKIE}=${value}`;
  }

  async function sessionRead(cookie: string, at = NOW + 10) {
    const res = await handleBrowserSession(
      new Request(`${ORIGIN}/${SLUG}/identity/session`, {
        headers: { cookie },
      }) as unknown as Request,
      env,
      db,
      product,
      at,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as SessionAnswer;
  }

  async function registerOn(cookie: string, device: string, at = NOW + 10) {
    return handleRegister(
      new Request(`${ORIGIN}/${SLUG}/devices/register`, {
        method: "POST",
        headers: { "x-pkey-device": device, cookie },
      }) as unknown as Request,
      env,
      db,
      product,
      at,
      SERVICES,
    );
  }

  async function expectRegistrationClosed(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "registration_closed" },
    });
  }

  it("erased then restored: signed out, registration refused, the record deleted; still so after the replay", async () => {
    const account = await platformLinkedAccount(SUB);
    await addPlatformLink(account, SUB_B);
    await addPlatformLink(account, SUB_C);
    await platformLinkedAccount(OTHER_SUB);
    // Three sessions of the account, each through its own subject (a later sign-in through the
    // same subject rotates the browser seat's token under an earlier one): the first is used for
    // registration, the second is read, the third is first used only after the replay. The fourth
    // is another account's.
    const viaRegister = await browserSessionSignIn(SUB);
    const viaRead = await browserSessionSignIn(SUB_B);
    const afterReplay = await browserSessionSignIn(SUB_C);
    const control = await browserSessionSignIn(OTHER_SUB);
    expect(sessionKeys()).toHaveLength(4);
    expect((await sessionRead(viaRead)).authenticated).toBe(true);
    const seatsBefore = await seats();

    await eraseAndRestore(ctx(), account);
    const cold = await coldIsolate(bucket);
    // The window: D1 says the account is active again, with its method, and KV kept the records.
    expect((await getAccountRow(db, account))?.status).toBe("active");
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM account_links WHERE account_id = ?",
        account,
      ),
    ).toBe(3);
    expect(sessionKeys()).toHaveLength(4);

    // Registration behind a product sign-in is refused exactly as for no session, and the session
    // is ended by the refusal.
    await expectRegistrationClosed(await registerOn(viaRegister, DEVICE));
    expect(await getDevice(db, SLUG, DEVICE)).toBeNull();
    expect(sessionKeys()).toHaveLength(3);
    expect(await sessionRead(viaRead)).toEqual(SIGNED_OUT);
    expect(sessionKeys()).toHaveLength(2);
    // It was the ledger that said so: a HEAD of the account's record, from this isolate.
    expect(cold.heads).toContain(erasureKey(account));
    // The seats belong to the licence, not the account: all of them are as they were.
    expect(await seats()).toEqual(seatsBefore);

    // Positive control, same world: another account's session lives and registers.
    expect((await sessionRead(control)).authenticated).toBe(true);
    expect((await registerOn(control, DEVICE)).status).toBe(200);

    // The cron replay re-erases the account for real.
    expect(await replayErasures(ctx(NOW + 200))).toMatchObject({
      scanned: 1,
      reapplied: 1,
      failures: [],
    });
    expect(await getAccountRow(db, account)).toBeNull();
    await expectRegistrationClosed(
      await registerOn(afterReplay, DEVICE_2, NOW + 300),
    );
    expect(await sessionRead(afterReplay, NOW + 300)).toEqual(SIGNED_OUT);
    expect(await getDevice(db, SLUG, DEVICE_2)).toBeNull();
    expect(sessionKeys()).toHaveLength(1);
    expect((await sessionRead(control, NOW + 300)).authenticated).toBe(true);
  });

  it("the isolate that erased the account knows at once, without reading the ledger", async () => {
    const account = await platformLinkedAccount(SUB);
    const cookie = await browserSessionSignIn();
    expect((await sessionRead(cookie)).authenticated).toBe(true);
    await eraseAndRestore(ctx(), account);
    // The ledger cannot even be read, and the verdict does not need it.
    bucket.down = true;
    expect(await sessionRead(cookie)).toEqual(SIGNED_OUT);
    expect(sessionKeys()).toHaveLength(0);
  });

  it("an unreadable ledger reads signed out for that request and keeps the record; readable again, the same cookie works", async () => {
    await platformLinkedAccount(SUB);
    const cookie = await browserSessionSignIn();
    expect((await sessionRead(cookie)).authenticated).toBe(true);
    const seatsBefore = await seats();

    // Past the 30 seconds "clear" was believed for, so the fence has to read.
    const at = NOW + 100;
    bucket.down = true;
    const asked = bucket.heads.length;
    expect(await sessionRead(cookie, at)).toEqual(SIGNED_OUT);
    expect(bucket.heads.length).toBeGreaterThan(asked);
    await expectRegistrationClosed(await registerOn(cookie, DEVICE, at));
    expect(await getDevice(db, SLUG, DEVICE)).toBeNull();
    // Nothing ended, nothing spent.
    expect(sessionKeys()).toHaveLength(1);
    expect(await seats()).toEqual(seatsBefore);

    bucket.down = false;
    expect((await sessionRead(cookie, at)).authenticated).toBe(true);
    expect((await registerOn(cookie, DEVICE, at)).status).toBe(200);
  });

  it("an unbound BLOBS fails closed the same way, and the record survives", async () => {
    await platformLinkedAccount(SUB);
    const cookie = await browserSessionSignIn();
    expect((await sessionRead(cookie)).authenticated).toBe(true);

    const at = NOW + 100;
    delete env.BLOBS;
    expect(await sessionRead(cookie, at)).toEqual(SIGNED_OUT);
    await expectRegistrationClosed(await registerOn(cookie, DEVICE, at));
    expect(sessionKeys()).toHaveLength(1);

    env.BLOBS = asR2(bucket);
    expect((await sessionRead(cookie, at)).authenticated).toBe(true);
  });

  it("erased and restored on an unreadable ledger: signed out and kept (nothing known), ended once it reads", async () => {
    const account = await platformLinkedAccount(SUB);
    const cookie = await browserSessionSignIn();
    await eraseAndRestore(ctx(), account);

    const cold = await coldIsolate(bucket, { down: true });
    expect(await sessionRead(cookie)).toEqual(SIGNED_OUT);
    await expectRegistrationClosed(await registerOn(cookie, DEVICE));
    expect(sessionKeys()).toHaveLength(1);

    cold.down = false;
    expect(await sessionRead(cookie)).toEqual(SIGNED_OUT);
    expect(sessionKeys()).toHaveLength(0);
  });
});

// ── 3. the platform-IdP product sign-in ──────────────────────────────────────────────────────

describe("I-11 fence: product sign-in through the platform IdP", () => {
  /** The browser flow (no `return_to`): start, the IdP, the callback's "signed in" page. */
  async function browserSignIn(sub = SUB): Promise<Response> {
    const start = await handleAuthStart(
      new Request(
        `${ORIGIN}/${SLUG}/identity/auth/start`,
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
    return handleAuthCallback(
      new Request(
        `${ORIGIN}/${SLUG}/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
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

  /** SIGN-IN.md §3.13's Account disabled page: never a dead end. */
  async function expectRefusedPage(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(setCookies(res)).toEqual([]);
    const html = await res.text();
    expect(html).toMatch(/This account can(&#39;|&#x27;|')t sign in/);
    expect(html).toContain(
      '<a class="button" href="/">Sign in with another account</a>',
    );
  }

  async function expectSignedIn(res: Response): Promise<void> {
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/You(&#x27;|&#39;|')re signed in/);
  }

  /** A device-code flow up to its callback; `poll` is then the device-code holder's poll. */
  async function deviceSignIn(sub = SUB): Promise<{
    callback: Response;
    poll: () => Promise<{ status: string; token?: string }>;
  }> {
    const started = await handleAuthDeviceStart(
      new Request(`${ORIGIN}/${SLUG}/identity/auth/device/start`, {
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
        `${ORIGIN}/${SLUG}/identity/auth/device?user_code=${userCode}`,
      ) as unknown as Request,
      env,
      product,
    );
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
    const confirmed = await handleAuthDeviceEntry(
      new Request(`${ORIGIN}/${SLUG}/identity/auth/device`, {
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
        `${ORIGIN}/${SLUG}/identity/auth/callback?code=c&state=${authorize.searchParams.get("state")}`,
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
        new Request(`${ORIGIN}/${SLUG}/identity/auth/device/poll`, {
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
    it(`${mode}: an erased then restored subject is refused at the callback and nothing is minted or written`, async () => {
      const account = await platformLinkedAccount(SUB);
      // The subject's floating `sub`-keyed licence, which signed it in before N9 whatever its account.
      await db.run(
        `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
           expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
           origin, modified_by, modified_at)
         VALUES (?, 'lic-floating', 'active', ?, NULL, NULL, NULL, 'free', ?, NULL, NULL, NULL, NULL,
           NULL, NULL, 'oidc', 'test', ?)`,
        SLUG,
        SUB,
        NOW - 1000,
        NOW,
      );
      await platformLinkedAccount(OTHER_SUB);
      await eraseAndRestore(ctx(), account);
      const cold = await coldIsolate(bucket);
      if (mode !== "off") env.PLATFORM_OIDC_MIGRATION = mode;
      if (mode === "operators-only") env.PLATFORM_OIDC_SUNSET = FUTURE;
      expect((await getAccountRow(db, account))?.status).toBe("active");
      const before = await snapshot();
      const kvBefore = mintedKeys();

      await expectRefusedPage(await browserSignIn());
      expect(cold.heads).toContain(erasureKey(account));
      expect(await snapshot()).toEqual(before);
      expect(mintedKeys()).toEqual(kvBefore);

      // Positive control, same world: a live account's subject signs in, in every mode.
      await expectSignedIn(await browserSignIn(OTHER_SUB));
      expect(await licenseOf(OTHER_SUB)).not.toBeNull();
    });
  }

  it("after the replay the erased account is gone, so its subject is a stranger again: signs in with no account", async () => {
    const account = await platformLinkedAccount(SUB);
    await eraseAndRestore(ctx(), account);
    const cold = await coldIsolate(bucket);
    expect(await platformSubjectStanding(env, db, ISSUER, SUB, NOW)).toBe(
      "refused",
    );
    expect(await replayErasures(ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect(cold.heads).toContain(erasureKey(account));
    // An erasure leaves no method behind: nothing ties the subject to the erased account.
    expect(await platformSubjectStanding(env, db, ISSUER, SUB, NOW)).toBe(
      "allowed",
    );
    await expectSignedIn(await browserSignIn());
    expect((await licenseOf())?.account_id).toBeNull();
    expect(await getAccountRow(db, account)).toBeNull();
  });

  it("device code: refused at the callback after a restore, and the poll never mints", async () => {
    const account = await platformLinkedAccount(SUB);
    await platformLinkedAccount(OTHER_SUB);
    await eraseAndRestore(ctx(), account);
    await coldIsolate(bucket);
    const before = await snapshot();
    const kvBefore = mintedKeys();

    const { callback, poll } = await deviceSignIn();
    await expectRefusedPage(callback);
    const answer = await poll();
    expect(answer.status).toBe("timeout");
    expect(answer.token).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    expect(mintedKeys()).toEqual(kvBefore);

    // Positive control: another account's subject still signs in through a device code.
    const control = await deviceSignIn(OTHER_SUB);
    expect(control.callback.status).toBe(200);
    const ready = await control.poll();
    expect(ready.status).toBe("ready");
    expect(ready.token).toMatch(/^pkeyt_/);
  });

  it("device code: an account erased and restored while the flow waits is refused at the poll", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    const account = await platformLinkedAccount(SUB);
    const { callback, poll } = await deviceSignIn();
    expect(callback.status).toBe(200);
    expect(await licenseOf()).toBeNull();

    await eraseAndRestore(ctx(), account);
    const cold = await coldIsolate(bucket);
    const before = await snapshot();
    const answer = await poll();
    expect(answer.status).toBe("error");
    expect(answer.token).toBeUndefined();
    expect(cold.heads).toContain(erasureKey(account));
    expect(await snapshot()).toEqual(before);
    // The flow is gone: a later poll is told it timed out, and still mints nothing.
    const later = await poll();
    expect(later.status).toBe("timeout");
    expect(later.token).toBeUndefined();
    expect(await licenseOf()).toBeNull();
  });

  it("an unreadable ledger refuses the sign-in, writes nothing, and the next sign-in works once it reads", async () => {
    await platformLinkedAccount(SUB);
    bucket.down = true;
    const before = await snapshot();
    const kvBefore = mintedKeys();
    await expectRefusedPage(await browserSignIn());
    expect(bucket.heads.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    expect(mintedKeys()).toEqual(kvBefore);
    expect(await licenseOf()).toBeNull();

    // "Unavailable" is never remembered.
    bucket.down = false;
    await expectSignedIn(await browserSignIn());
    expect(await licenseOf()).not.toBeNull();
  });

  it("an unbound BLOBS refuses a subject that holds an account, but not one that holds none", async () => {
    await platformLinkedAccount(SUB);
    delete env.BLOBS;
    const before = await snapshot();
    await expectRefusedPage(await browserSignIn());
    expect(await snapshot()).toEqual(before);

    // No method, no account, nothing to ask the ledger about.
    await expectSignedIn(await browserSignIn(OTHER_SUB));
    expect((await licenseOf(OTHER_SUB))?.account_id).toBeNull();
  });

  it("an unreadable ledger at the device poll drops the flow and mints nothing", async () => {
    env.PLATFORM_OIDC_MIGRATION = "claim";
    await platformLinkedAccount(SUB);
    const { callback, poll } = await deviceSignIn();
    expect(callback.status).toBe(200);

    // The ledger goes down while the flow waits; this isolate has asked about nothing yet.
    await coldIsolate(bucket, { down: true });
    const before = await snapshot();
    const answer = await poll();
    expect(answer.status).toBe("error");
    expect(answer.token).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    const later = await poll();
    expect(later.status).toBe("timeout");
    expect(later.token).toBeUndefined();
    expect(await licenseOf()).toBeNull();
  });

  it("a subject with no account signs in exactly as before, beside an erased and restored one", async () => {
    const erased = await platformLinkedAccount(OTHER_SUB);
    await eraseAndRestore(ctx(), erased);
    await coldIsolate(bucket);

    await expectSignedIn(await browserSignIn());
    expect((await licenseOf())?.account_id).toBeNull();
    const { callback, poll } = await deviceSignIn();
    expect(callback.status).toBe(200);
    expect((await poll()).status).toBe("ready");
  });

  it("an account that is not on the ledger signs in through the browser and a device code", async () => {
    const account = await platformLinkedAccount(SUB);
    await expectSignedIn(await browserSignIn());
    expect(await licenseOf()).not.toBeNull();
    const { callback, poll } = await deviceSignIn();
    expect(callback.status).toBe(200);
    const ready = await poll();
    expect(ready.status).toBe("ready");
    expect(bucket.heads).toContain(erasureKey(account));
  });
});

// ── 4. the browser-session mint ──────────────────────────────────────────────────────────────

describe("I-11 fence: createBrowserSession", () => {
  async function licenseFor(id: string) {
    const existing = await getLicense(db, SLUG, id);
    if (existing) return existing;
    const { licenseId } = await seedLicenseWithKey(db, SLUG, { id });
    return (await getLicense(db, SLUG, licenseId))!;
  }

  const mint = async (
    id: string,
    accountId: string | null | undefined,
    at = NOW,
  ) =>
    createBrowserSession(
      env,
      db,
      product,
      await licenseFor(id),
      at,
      undefined,
      accountId === undefined ? {} : { accountId },
    );

  const REFUSED = {
    ok: false,
    status: 403,
    code: "forbidden",
    message: "this account cannot sign in",
  };
  const UNAVAILABLE = {
    ok: false,
    status: 503,
    code: "erasure_ledger_unavailable",
    message: "try again",
  };

  async function expectNothingMinted(): Promise<void> {
    expect(sessionKeys()).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM devices")).toBe(0);
  }

  it("an erased then restored account is refused 403, mints no record and authorizes no device; the same after the replay", async () => {
    const account = await emailAccount("ada@example.com");
    const control = await emailAccount("bob@example.com");
    await eraseAndRestore(ctx(), account);
    const cold = await coldIsolate(bucket);
    expect((await getAccountRow(db, account))?.status).toBe("active");

    expect(await mint("lic-1", account)).toEqual(REFUSED);
    expect(cold.heads).toContain(erasureKey(account));
    await expectNothingMinted();

    expect(await replayErasures(ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect(await getAccountRow(db, account)).toBeNull();
    expect(await mint("lic-1", account, NOW + 300)).toEqual(REFUSED);
    await expectNothingMinted();

    // Positive control, same world: an account that is not on the ledger gets its session.
    const ok = await mint("lic-2", control, NOW + 300);
    expect(ok).toMatchObject({ ok: true, record: { accountId: control } });
    expect(sessionKeys()).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM devices")).toBe(1);
  });

  it("the isolate that erased the account refuses it without reading the ledger", async () => {
    const account = await emailAccount("ada@example.com");
    await eraseAndRestore(ctx(), account);
    bucket.down = true;
    expect(await mint("lic-1", account)).toEqual(REFUSED);
    await expectNothingMinted();
  });

  it("an unreadable ledger is a 503 with nothing minted; readable again it mints", async () => {
    const account = await emailAccount("ada@example.com");
    bucket.down = true;
    expect(await mint("lic-1", account)).toEqual(UNAVAILABLE);
    expect(bucket.heads).toContain(erasureKey(account));
    await expectNothingMinted();

    bucket.down = false;
    expect(await mint("lic-1", account)).toMatchObject({
      ok: true,
      record: { accountId: account },
    });
    expect(sessionKeys()).toHaveLength(1);
  });

  it("an unbound BLOBS is a 503 with nothing minted", async () => {
    const account = await emailAccount("ada@example.com");
    delete env.BLOBS;
    expect(await mint("lic-1", account)).toEqual(UNAVAILABLE);
    await expectNothingMinted();
  });

  it("a key session names no account, is never asked, and mints even with BLOBS unbound", async () => {
    delete env.BLOBS;
    expect(await mint("lic-1", undefined)).toMatchObject({ ok: true });
    expect(await mint("lic-2", null)).toMatchObject({ ok: true });
    expect(sessionKeys()).toHaveLength(2);
    env.BLOBS = asR2(bucket);
    expect(await mint("lic-3", undefined)).toMatchObject({ ok: true });
    expect(bucket.heads).toEqual([]);
  });
});

// ── 5. platformSubjectStanding ───────────────────────────────────────────────────────────────

describe("I-11 fence: platformSubjectStanding", () => {
  const standing = (sub = SUB, at = NOW) =>
    platformSubjectStanding(env, db, ISSUER, sub, at);

  it("allowed: a subject holding no method, and an active account the ledger does not hold", async () => {
    expect(await standing()).toBe("allowed");
    expect(bucket.heads).toEqual([]);
    const account = await platformLinkedAccount(SUB);
    expect(await standing()).toBe("allowed");
    expect(bucket.heads).toEqual([erasureKey(account)]);
  });

  it("refused: an erased then restored account, from the isolate that erased it and from a cold one", async () => {
    const account = await platformLinkedAccount(SUB);
    const control = await platformLinkedAccount(OTHER_SUB);
    await eraseAndRestore(ctx(), account);
    expect((await getAccountRow(db, account))?.status).toBe("active");

    // Known to this isolate: refused even though the ledger cannot be read (erased outranks it).
    bucket.down = true;
    expect(await standing()).toBe("refused");
    bucket.down = false;

    const cold = await coldIsolate(bucket);
    expect(await standing()).toBe("refused");
    expect(cold.heads).toEqual([erasureKey(account)]);
    // Positive control: the other account in the same world.
    expect(await standing(OTHER_SUB)).toBe("allowed");
    expect(cold.heads).toContain(erasureKey(control));
  });

  it("refused: an account that is not active, whatever the ledger says", async () => {
    const disabled = await platformLinkedAccount(SUB);
    const deleted = await platformLinkedAccount(OTHER_SUB);
    expect(await disableAccount(ctx(), disabled)).toEqual({ ok: true });
    await db.run(
      "UPDATE accounts SET status = 'deleted', deleted_at = ? WHERE id = ?",
      NOW,
      deleted,
    );
    bucket.down = true;
    expect(await standing()).toBe("refused");
    expect(await standing(OTHER_SUB)).toBe("refused");
    // The status says so before the ledger is asked.
    expect(bucket.heads).toEqual([]);
  });

  it("unavailable: the ledger cannot be read or BLOBS is unbound, for a subject that holds an account", async () => {
    const account = await platformLinkedAccount(SUB);
    bucket.down = true;
    expect(await standing()).toBe("unavailable");
    expect(bucket.heads).toEqual([erasureKey(account)]);
    // Unreadable is never remembered.
    bucket.down = false;
    expect(await standing()).toBe("allowed");

    // Past the 30 seconds "clear" is believed for.
    delete env.BLOBS;
    expect(await standing(SUB, NOW + 100)).toBe("unavailable");
    // A subject with no account asks nothing, so it is allowed even now.
    expect(await standing(OTHER_SUB, NOW + 100)).toBe("allowed");
  });

  it("erased and restored on an unreadable ledger from a cold isolate: unavailable, then refused once it reads", async () => {
    const account = await platformLinkedAccount(SUB);
    await eraseAndRestore(ctx(), account);
    const cold = await coldIsolate(bucket, { down: true });
    expect(await standing()).toBe("unavailable");
    cold.down = false;
    expect(await standing()).toBe("refused");
  });

  it("after the replay the erased account has no method left: allowed", async () => {
    const account = await platformLinkedAccount(SUB);
    await eraseAndRestore(ctx(), account);
    await coldIsolate(bucket);
    expect(await standing()).toBe("refused");
    expect(await replayErasures(ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect(await standing()).toBe("allowed");
  });
});

// ── 6. the device wire ───────────────────────────────────────────────────────────────────────

interface ActivateAnswer {
  token: string;
}

describe("I-11 fence: the device wire (attach and subject)", () => {
  /** A request through the production router. */
  function call(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
    now = NOW,
  ): Promise<Response> {
    return dispatchWith(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }) as unknown as Request,
      env,
      db,
      now,
    );
  }

  async function tokenOf(key: string, device: string): Promise<string> {
    const res = await call(
      "POST",
      `/${SLUG}/license/activate`,
      { authorization: `Bearer ${key}`, "x-pkey-device": device },
      undefined,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivateAnswer;
    return body.token;
  }

  const attach = (
    token: string,
    device: string,
    body: unknown = { confirm: true },
    now = NOW,
  ) =>
    call(
      "POST",
      `/${SLUG}/identity/attach`,
      { authorization: `Bearer ${token}`, "x-pkey-device": device },
      body,
      now,
    );

  const subjectOf = (token: string, device: string, now = NOW) =>
    call(
      "GET",
      `/${SLUG}/identity/subject`,
      { authorization: `Bearer ${token}`, "x-pkey-device": device },
      undefined,
      now,
    );

  /** An active account with `email` verified, and its pairwise subject for the product. */
  async function account(
    email: string,
  ): Promise<{ id: string; subject: string }> {
    const acct = await getOrCreateAccountByEmail(db, email, NOW);
    await db.run(
      "UPDATE accounts SET primary_email = ?, primary_email_verified_at = ? WHERE id = ?",
      email,
      NOW,
      acct.id,
    );
    const subject = await subjectFor(db, acct.id, SLUG, NOW);
    expect(subject).toMatch(PAIRWISE_SUBJECT_PATTERN);
    return { id: acct.id, subject };
  }

  async function ownerOf(licenseId: string): Promise<string | null> {
    return (
      (
        await db.first<{ account_id: string | null }>(
          "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
          SLUG,
          licenseId,
        )
      )?.account_id ?? null
    );
  }

  /**
   * Identity on; two licences (Ada's and Bob's, each held by the email its account verifies), each
   * activated by key on its own device, and a sign-in of each account on its device.
   */
  async function world() {
    const enabled = ["license", "config", "identity"];
    await setServices(
      db,
      SLUG,
      serializeServices({
        services: Object.fromEntries(
          SERVICE_SLUGS.map((s) => [s, { enabled: enabled.includes(s) }]),
        ),
      } as Parameters<typeof serializeServices>[0]),
      "manifest",
      NOW,
    );
    const adaLicense = await seedLicenseWithKey(db, SLUG);
    const bobLicense = await seedLicenseWithKey(db, SLUG, { id: "lic-bob" });
    await db.run(
      "UPDATE licenses SET email = ?, name = ? WHERE product = ? AND id = ?",
      "bob@example.com",
      "Bob",
      SLUG,
      "lic-bob",
    );
    const adaToken = await tokenOf(adaLicense.key, DEV_A);
    const bobToken = await tokenOf(bobLicense.key, DEV_B);
    const ada = await account("ada@example.com");
    const bob = await account("bob@example.com");
    expect(await setDeviceSubject(env, db, SLUG, DEV_A, ada.subject)).toBe(
      true,
    );
    expect(await setDeviceSubject(env, db, SLUG, DEV_B, bob.subject)).toBe(
      true,
    );
    return {
      ada: { ...ada, token: adaToken, licenseId: adaLicense.licenseId },
      bob: { ...bob, token: bobToken, licenseId: bobLicense.licenseId },
    };
  }

  const ACCOUNT_REQUIRED = { error: { code: "account_required" } };
  const UNAVAILABLE = { error: { code: "erasure_ledger_unavailable" } };

  it("a device bound to an erased then restored account: attach 403 account_required, subject null; the same after the replay", async () => {
    const { ada, bob } = await world();
    // Before the erasure the binding reads through.
    expect(await (await subjectOf(ada.token, DEV_A)).json()).toEqual({
      subject: ada.subject,
    });

    await eraseAndRestore(ctx(), ada.id);
    const cold = await coldIsolate(bucket);
    // The window: the restore brought the account, its subject and the device's binding back.
    expect((await getAccountRow(db, ada.id))?.status).toBe("active");
    expect(
      (
        await db.first<{ subject: string | null }>(
          "SELECT subject FROM devices WHERE product = ? AND device_id = ?",
          SLUG,
          DEV_A,
        )
      )?.subject,
    ).toBe(ada.subject);

    for (const confirm of [false, true]) {
      const res = await attach(ada.token, DEV_A, { confirm });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(ACCOUNT_REQUIRED);
    }
    expect(cold.heads).toContain(erasureKey(ada.id));
    expect(await ownerOf(ada.licenseId)).toBeNull();
    const subject = await subjectOf(ada.token, DEV_A);
    expect(subject.status).toBe(200);
    expect(await subject.json()).toEqual({ subject: null });

    // The replay erases the account for real; the answers do not move.
    expect(await replayErasures(ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect(await getAccountRow(db, ada.id)).toBeNull();
    const later = await attach(ada.token, DEV_A, { confirm: true }, NOW + 300);
    expect(later.status).toBe(403);
    expect(await later.json()).toEqual(ACCOUNT_REQUIRED);
    expect(await ownerOf(ada.licenseId)).toBeNull();
    expect(await (await subjectOf(ada.token, DEV_A, NOW + 300)).json()).toEqual(
      { subject: null },
    );

    // Positive control, same world: Bob's device still reads its subject and attaches.
    expect(await (await subjectOf(bob.token, DEV_B, NOW + 300)).json()).toEqual(
      {
        subject: bob.subject,
      },
    );
    const claimed = await attach(
      bob.token,
      DEV_B,
      { confirm: true },
      NOW + 300,
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      subject: bob.subject,
      attached: "claimed",
    });
    expect(await ownerOf(bob.licenseId)).toBe(bob.id);
  });

  it("the isolate that erased the account refuses it without reading the ledger", async () => {
    const { ada } = await world();
    await eraseAndRestore(ctx(), ada.id);
    bucket.down = true;
    const res = await attach(ada.token, DEV_A);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ACCOUNT_REQUIRED);
    expect(await (await subjectOf(ada.token, DEV_A)).json()).toEqual({
      subject: null,
    });
  });

  it("an unreadable ledger answers 503 unavailable to both, writes and rotates nothing, and works once it reads", async () => {
    const { bob } = await world();
    bucket.down = true;
    const asked = bucket.heads.length;

    const refused = await attach(bob.token, DEV_B);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual(UNAVAILABLE);
    const subject = await subjectOf(bob.token, DEV_B);
    expect(subject.status).toBe(503);
    expect(await subject.json()).toEqual(UNAVAILABLE);
    expect(bucket.heads.length).toBeGreaterThan(asked);
    // Nothing attached; the token did not rotate.
    expect(await ownerOf(bob.licenseId)).toBeNull();

    bucket.down = false;
    expect(await (await subjectOf(bob.token, DEV_B)).json()).toEqual({
      subject: bob.subject,
    });
    const claimed = await attach(bob.token, DEV_B);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ attached: "claimed" });
    expect(await ownerOf(bob.licenseId)).toBe(bob.id);
  });

  it("an unbound BLOBS answers 503 unavailable to both", async () => {
    const { bob } = await world();
    delete env.BLOBS;
    const refused = await attach(bob.token, DEV_B);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual(UNAVAILABLE);
    expect((await subjectOf(bob.token, DEV_B)).status).toBe(503);
    expect(await ownerOf(bob.licenseId)).toBeNull();

    env.BLOBS = asR2(bucket);
    expect((await attach(bob.token, DEV_B)).status).toBe(200);
  });

  it("erased and restored on an unreadable ledger from a cold isolate: 503 for both, then account_required and null once it reads", async () => {
    const { ada } = await world();
    await eraseAndRestore(ctx(), ada.id);
    const cold = await coldIsolate(bucket, { down: true });

    const refused = await attach(ada.token, DEV_A);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual(UNAVAILABLE);
    expect((await subjectOf(ada.token, DEV_A)).status).toBe(503);
    expect(await ownerOf(ada.licenseId)).toBeNull();

    cold.down = false;
    const closed = await attach(ada.token, DEV_A);
    expect(closed.status).toBe(403);
    expect(await closed.json()).toEqual(ACCOUNT_REQUIRED);
    expect(await (await subjectOf(ada.token, DEV_A)).json()).toEqual({
      subject: null,
    });
    expect(await ownerOf(ada.licenseId)).toBeNull();
  });
});
