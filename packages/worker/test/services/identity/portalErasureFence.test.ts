/**
 * I-11: the portal's request-time erasure fence. A D1 Time Travel restore rewinds the database but
 * not the erasure ledger (R2), so an account erased and restored is `active` again, with its
 * sessions, until the cron replay (`deletion.replayErasures`) erases it again. These suites open
 * that window through the real state machine (`eraseAndRestore`) and drive the portal's own entry
 * points across it:
 *
 *   - a live portal session (`requireSession` over `checkAccountSession`): 401 for an erased
 *     account, 503 for an unreadable or unbound ledger, nothing cleared and nothing written;
 *   - the same cookie after a merge, when the SURVIVOR is the account that was erased;
 *   - the device-login poll (an approval whose approver is erased or unreadable);
 *   - the licensed download route (a token of an erased account);
 *   - `checkAccountSession` itself, in its three answers.
 *
 * Every window test asserts the refusal between the restore and the replay, the same refusal after
 * the replay, and a positive control: an account that is not on the ledger passes the same gate in
 * the same world. "The isolate that erased it" knows the erasure at once (the write-through);
 * "another isolate" holds its own binding over the same ledger objects, so its answer comes from a
 * real HEAD of `erasures/<id>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { asR2 } from "../../r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "../../seed.js";
import { eraseAndRestore, LedgerBucket } from "../../eraseRestore.js";
import { snapshotDb } from "../../d1Restore.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import { handlePortalApi, handlePortalDownload } from "../../portalHarness.js";
import {
  setup as setupDownloads,
  BYTES,
  CONSOLE,
  SLUG,
} from "../../downloadWorld.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import {
  ERASURE_CLEAR_TTL_SECONDS,
  erasureKey,
} from "../../../src/core/accounts/erasureFence.js";
import type { AccountContext } from "../../../src/services/identity/accounts/links.js";
import { replayErasures } from "../../../src/services/identity/accounts/deletion.js";
import { mergeAccounts } from "../../../src/services/identity/accounts/merge.js";
import { checkAccountSession } from "../../../src/services/identity/portal/accountSessions.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../../../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  type PortalSession,
} from "../../../src/services/identity/portal/session.js";
import type { PortalDownloads } from "../../../src/services/identity/portal/downloads.js";

const PORTAL_SECRET = "test-portal-session-secret";
const ORIGIN = "https://key.plrs.im";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/** Past a session's five-minute `last_seen_at` touch, so a LIVE check would write. */
const TOUCH_NOW = NOW + 600;
/** The first second at which a `clear` answer read at `NOW` has expired. */
const AFTER_CLEAR = NOW + ERASURE_CLEAR_TTL_SECONDS;

interface World {
  db: Db;
  env: Env;
  /** The bucket bound as `BLOBS`: the erasure ledger lives in it. */
  ledger: LedgerBucket;
  ctx: AccountContext;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  const ledger = new LedgerBucket();
  env.BLOBS = asR2(ledger);
  await seedProduct(db, "djdl");
  return { db, env, ledger, ctx: { db, env, now: NOW, origin: ORIGIN } };
}

type Isolate = "the isolate that erased it" | "another isolate";
const ISOLATES: Isolate[] = ["the isolate that erased it", "another isolate"];

/**
 * Run the rest of the test as `isolate`. The erasing isolate keeps its binding (and the
 * write-through of `recordErasure`); another isolate gets a fresh binding that holds copies of the
 * ledger objects, so it has to read them. Returns the binding now in use.
 */
async function enter(w: World, isolate: Isolate): Promise<LedgerBucket> {
  if (isolate === "the isolate that erased it") {
    // Forget the reads made before the erasure: only the window's own are of interest.
    w.ledger.heads.splice(0);
    return w.ledger;
  }
  const next = new LedgerBucket();
  for (const key of w.ledger.keys()) {
    const got = await w.ledger.get(key);
    if (!got || !("text" in got))
      throw new Error(`ledger object ${key} is unreadable`);
    await next.put(key, await got.text());
  }
  w.env.BLOBS = asR2(next);
  return next;
}

/** The ledger was consulted (another isolate) or answered from the write-through (the erasing one). */
function expectLedgerRead(
  bucket: LedgerBucket,
  isolate: Isolate,
  accountId: string,
): void {
  if (isolate === "another isolate")
    expect(bucket.heads).toContain(erasureKey(accountId));
  else expect(bucket.heads).not.toContain(erasureKey(accountId));
}

interface Session {
  cookie: string;
  csrf: string;
  accountId: string;
  session: PortalSession;
}

async function sessionOf(
  w: World,
  account: { id: string; primary_email: string | null },
  issuedAt = NOW,
): Promise<Session> {
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId: account.id, email: account.primary_email, name: null },
    issuedAt,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
    session,
  };
}

async function signedIn(
  w: World,
  email: string,
  issuedAt = NOW,
): Promise<Session> {
  const account = await getOrCreateAccountByEmail(w.db, email, issuedAt);
  return sessionOf(w, account, issuedAt);
}

interface CallOpts {
  cookie?: string;
  csrf?: string;
  body?: unknown;
  now?: number;
  country?: string;
  ua?: string;
  origin?: string;
}

function call(
  w: Pick<World, "env" | "db">,
  method: string,
  path: string,
  opts: CallOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "user-agent": opts.ua ?? CHROME_MAC,
    "cf-connecting-ip": "203.0.113.7",
  };
  if (opts.country) headers["cf-ipcountry"] = opts.country;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return handlePortalApi(
    new Request(`${opts.origin ?? ORIGIN}${path}`, init),
    w.env,
    w.db,
    path,
    opts.now ?? NOW,
  );
}

async function jsonOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The authenticated read every `requireSession` route shares. */
const me = (w: World, s: Session, now = TOUCH_NOW) =>
  call(w, "GET", "/api/me", { cookie: s.cookie, now });

async function accountStatus(db: Db, accountId: string): Promise<unknown> {
  return (
    await db.first<{ status: string }>(
      "SELECT status FROM accounts WHERE id = ?",
      accountId,
    )
  )?.status;
}

/** The state a restore leaves: the account is `active` again and its session row is back. */
async function expectRestored(w: World, s: Session): Promise<void> {
  expect(await accountStatus(w.db, s.accountId)).toBe("active");
  expect(
    await w.db.first(
      "SELECT 1 AS present FROM account_sessions WHERE account_id = ?",
      s.accountId,
    ),
  ).toEqual({ present: 1 });
}

describe("portal session across a restore", () => {
  it.each(ISOLATES)(
    "refuses the cookie of an erased and restored account before and after the replay (%s)",
    async (isolate) => {
      const w = await world();
      const erased = await signedIn(w, "ada@example.com");
      const control = await signedIn(w, "bo@example.com");
      await eraseAndRestore(w.ctx, erased.accountId);
      await expectRestored(w, erased);
      const bucket = await enter(w, isolate);

      // Between the restore and the replay: 401, no cookie touched, nothing written.
      const before = await snapshotDb(w.db);
      const window = await me(w, erased);
      expect(window.status).toBe(401);
      expect(await window.json()).toMatchObject({ error: "unauthorized" });
      expect(window.headers.get("set-cookie")).toBeNull();
      expect(await snapshotDb(w.db)).toEqual(before);
      expectLedgerRead(bucket, isolate, erased.accountId);

      // The cron replay ends it for real; the answer does not change.
      await replayErasures(w.ctx);
      expect(await accountStatus(w.db, erased.accountId)).not.toBe("active");
      const afterReplayState = await snapshotDb(w.db);
      const replayed = await me(w, erased);
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toMatchObject({ error: "unauthorized" });
      expect(replayed.headers.get("set-cookie")).toBeNull();
      expect(await snapshotDb(w.db)).toEqual(afterReplayState);

      // Positive control: the account that is not on the ledger is served in the same world.
      const served = await me(w, control);
      expect(served.status).toBe(200);
      // ...and it was asked about, so the control is judged by the ledger, not waved through.
      expect(bucket.heads).toContain(erasureKey(control.accountId));
    },
  );

  it("answers 503 for an unreadable ledger, keeps the cookie and row, and works again once readable", async () => {
    const w = await world();
    const holder = await signedIn(w, "ada@example.com");
    const before = await snapshotDb(w.db);

    w.ledger.down = true;
    const down = await me(w, holder);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      error: "erasure_ledger_unavailable",
    });
    expect(down.headers.get("set-cookie")).toBeNull();
    // The session row is untouched: not revoked, not refreshed (TOUCH_NOW is past the touch age).
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(w.ledger.heads).toContain(erasureKey(holder.accountId));

    // An unreadable answer is never remembered: the same cookie is served as soon as R2 is back.
    w.ledger.down = false;
    const up = await me(w, holder);
    expect(up.status).toBe(200);
  });

  it("answers 503 when BLOBS is unbound, and works once a bucket is bound", async () => {
    const w = await world();
    const holder = await signedIn(w, "ada@example.com");
    const before = await snapshotDb(w.db);

    delete w.env.BLOBS;
    const unbound = await me(w, holder);
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toMatchObject({
      error: "erasure_ledger_unavailable",
    });
    expect(unbound.headers.get("set-cookie")).toBeNull();
    expect(await snapshotDb(w.db)).toEqual(before);

    w.env.BLOBS = asR2(new LedgerBucket());
    expect((await me(w, holder)).status).toBe(200);
  });

  it("an erased account on an unreadable ledger is 503, then 401 once readable: unreadable is never taken for clear", async () => {
    const w = await world();
    const erased = await signedIn(w, "ada@example.com");
    await eraseAndRestore(w.ctx, erased.accountId);
    const bucket = await enter(w, "another isolate");

    bucket.down = true;
    const down = await me(w, erased);
    expect(down.status).toBe(503);
    expect(down.headers.get("set-cookie")).toBeNull();

    bucket.down = false;
    const up = await me(w, erased);
    expect(up.status).toBe(401);
    expect(up.headers.get("set-cookie")).toBeNull();
  });

  it("refuses the cookie of an absorbed account whose SURVIVOR was erased and restored", async () => {
    const w = await world();
    const survivor = await signedIn(w, "ada@example.com");
    const absorbed = await signedIn(w, "grace@example.com");
    const control = await signedIn(w, "bo@example.com");
    const merged = await mergeAccounts(w.ctx, {
      survivor: { accountId: survivor.accountId, authenticatedAt: NOW },
      absorbed: { accountId: absorbed.accountId, authenticatedAt: NOW },
    });
    expect(merged.ok).toBe(true);
    // Before anything is erased, the absorbed account's cookie acts as the survivor.
    expect((await me(w, absorbed, NOW)).status).toBe(200);

    await eraseAndRestore(w.ctx, survivor.accountId);
    expect(await accountStatus(w.db, survivor.accountId)).toBe("active");
    const bucket = await enter(w, "another isolate");

    const before = await snapshotDb(w.db);
    const window = await me(w, absorbed);
    expect(window.status).toBe(401);
    expect(window.headers.get("set-cookie")).toBeNull();
    expect(await snapshotDb(w.db)).toEqual(before);
    // The cookie's own id was clear; the resolved survivor is the one the ledger holds.
    expect(bucket.heads).toContain(erasureKey(absorbed.accountId));
    expect(bucket.heads).toContain(erasureKey(survivor.accountId));

    await replayErasures(w.ctx);
    const replayed = await me(w, absorbed);
    expect(replayed.status).toBe(401);
    expect(replayed.headers.get("set-cookie")).toBeNull();

    expect((await me(w, control)).status).toBe(200);
  });
});

describe("checkAccountSession", () => {
  it("answers live, refused and unavailable", async () => {
    const w = await world();
    const live = await signedIn(w, "ada@example.com");
    const erased = await signedIn(w, "bo@example.com");
    const unread = await signedIn(w, "cy@example.com");
    await eraseAndRestore(w.ctx, erased.accountId);
    const bucket = await enter(w, "another isolate");

    expect(await checkAccountSession(w.env, w.db, live.session, NOW)).toEqual({
      status: "live",
      accountId: live.accountId,
      idHash: expect.any(String),
    });
    expect(await checkAccountSession(w.env, w.db, erased.session, NOW)).toEqual(
      { status: "refused" },
    );

    bucket.down = true;
    expect(await checkAccountSession(w.env, w.db, unread.session, NOW)).toEqual(
      { status: "unavailable" },
    );
    bucket.down = false;
    expect(await checkAccountSession(w.env, w.db, unread.session, NOW)).toEqual(
      {
        status: "live",
        accountId: unread.accountId,
        idHash: expect.any(String),
      },
    );
  });
});

// ── Device-login poll ─────────────────────────────────────────────────────────────────────────

interface Started {
  id: string;
  code: string;
  /** `name=value` of the binding cookie. */
  binding: string;
}

async function startLogin(w: World): Promise<Started> {
  const res = await call(w, "POST", "/api/device-login/start", {
    country: "PT",
  });
  expect(res.status).toBe(201);
  const binding = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { ...(await jsonOf<Omit<Started, "binding">>(res)), binding };
}

async function approve(w: World, s: Session, code: string): Promise<void> {
  const res = await call(w, "POST", "/api/device-login/approve", {
    cookie: s.cookie,
    csrf: s.csrf,
    body: { code, decision: "approve" },
    country: "PT",
  });
  expect(res.status).toBe(200);
}

const pollLogin = (w: World, s: Started, now = AFTER_CLEAR) =>
  call(w, "GET", `/api/device-login/${s.id}`, { cookie: s.binding, now });

describe("device-login poll across a restore", () => {
  it.each(ISOLATES)(
    "403 account_disabled for an approval by an erased account, before and after the replay, and the record is not consumed (%s)",
    async (isolate) => {
      const w = await world();
      const approver = await signedIn(w, "ana@example.com");
      const control = await signedIn(w, "bo@example.com");
      const request = await startLogin(w);
      await approve(w, approver, request.code);
      await eraseAndRestore(w.ctx, approver.accountId);
      const bucket = await enter(w, isolate);

      const before = await snapshotDb(w.db);
      const window = await pollLogin(w, request);
      expect(window.status).toBe(403);
      expect(await window.json()).toMatchObject({ error: "account_disabled" });
      expect(window.headers.get("set-cookie")).toBeNull();
      expect(await snapshotDb(w.db)).toEqual(before);
      expectLedgerRead(bucket, isolate, approver.accountId);
      // Not consumed: a spent record would answer 410 on the next poll.
      expect((await pollLogin(w, request)).status).toBe(403);

      await replayErasures(w.ctx);
      const replayed = await pollLogin(w, request);
      expect(replayed.status).toBe(403);
      expect(await replayed.json()).toMatchObject({
        error: "account_disabled",
      });
      expect(replayed.headers.get("set-cookie")).toBeNull();

      // Positive control: an approval by an account that is not on the ledger signs a device in.
      const other = await startLogin(w);
      await approve(w, control, other.code);
      const ok = await pollLogin(w, other);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "approved" });
      expect(ok.headers.get("set-cookie") ?? "").toContain(`${PORTAL_COOKIE}=`);
    },
  );

  it("503 for an approval on an unreadable ledger spends nothing; a later poll is approved with a session", async () => {
    const w = await world();
    const approver = await signedIn(w, "ana@example.com");
    const request = await startLogin(w);
    await approve(w, approver, request.code);
    const before = await snapshotDb(w.db);

    w.ledger.down = true;
    for (let i = 0; i < 2; i += 1) {
      const down = await pollLogin(w, request);
      expect(down.status).toBe(503);
      expect(await down.json()).toMatchObject({
        error: "erasure_ledger_unavailable",
      });
      expect(down.headers.get("set-cookie")).toBeNull();
    }
    // No session row was opened and nothing else was written.
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(w.ledger.heads).toContain(erasureKey(approver.accountId));

    // R2 is back: the record was never taken, so this poll still answers approved.
    w.ledger.down = false;
    const ok = await pollLogin(w, request);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "approved" });
    expect(ok.headers.get("set-cookie") ?? "").toContain(`${PORTAL_COOKIE}=`);
  });

  it("an erased approver on an unreadable ledger is 503, then 403 once readable, with the record still there", async () => {
    const w = await world();
    const approver = await signedIn(w, "ana@example.com");
    const request = await startLogin(w);
    await approve(w, approver, request.code);
    await eraseAndRestore(w.ctx, approver.accountId);
    const bucket = await enter(w, "another isolate");

    bucket.down = true;
    const down = await pollLogin(w, request);
    expect(down.status).toBe(503);
    expect(down.headers.get("set-cookie")).toBeNull();

    bucket.down = false;
    for (let i = 0; i < 2; i += 1) {
      const refused = await pollLogin(w, request);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: "account_disabled" });
      expect(refused.headers.get("set-cookie")).toBeNull();
    }
  });
});

// ── Licensed download ─────────────────────────────────────────────────────────────────────────

/** A Mac browser (Chrome: Safari's desktop UA also stands for an iPad). */
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function downloadsWorld(): Promise<World> {
  const base = await setupDownloads({ access: "public" });
  base.env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  const ledger = new LedgerBucket();
  base.env.BLOBS = asR2(ledger);
  return {
    db: base.db,
    env: base.env,
    ledger,
    ctx: { db: base.db, env: base.env, now: NOW, origin: CONSOLE },
  };
}

/** A portal account holding the licence `licenseId` for the product. */
async function holder(
  w: World,
  email: string,
  licenseId: string,
): Promise<Session> {
  await seedLicenseWithKey(w.db, SLUG, { id: licenseId });
  const account = await getOrCreateAccountByEmail(w.db, email, NOW);
  await linkLicense(w.db, account.id, SLUG, licenseId, "license-key", NOW);
  return sessionOf(w, account);
}

/** Mint a download token the way production does (the SPA encodes every path segment). */
async function mintToken(w: World, s: Session): Promise<string> {
  const listing = await call(w, "GET", `/api/products/${SLUG}/downloads`, {
    cookie: s.cookie,
    ua: MAC_UA,
    origin: CONSOLE,
  });
  expect(listing.status, await listing.clone().text()).toBe(200);
  const file = (await jsonOf<PortalDownloads>(listing)).recommended!.files[0]!;
  const enc = encodeURIComponent;
  const url = new URL(
    `${CONSOLE}/api/releases/${enc(SLUG)}/${enc(file.releaseId)}/artifacts/${enc(file.artifactId)}/token`,
  );
  const minted = await call(w, "POST", url.pathname, {
    cookie: s.cookie,
    csrf: s.csrf,
    origin: CONSOLE,
  });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { url: path } = await jsonOf<{ url: string }>(minted);
  return decodeURIComponent(path.replace("/download/", ""));
}

const redeem = (w: World, token: string, now: number) =>
  handlePortalDownload(
    new Request(`${CONSOLE}/download/${encodeURIComponent(token)}`),
    w.env,
    w.db,
    token,
    now,
  );

async function spentTokens(db: Db): Promise<number> {
  const rows = await db.all<{ used_at: number | null }>(
    "SELECT used_at FROM release_download_tokens WHERE used_at IS NOT NULL",
  );
  return rows.length;
}

describe("licensed download across a restore", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(ISOLATES)(
    "404 for a token of an erased account, before and after the replay, and the token is not spent (%s)",
    async (isolate) => {
      const w = await downloadsWorld();
      const erased = await holder(w, "ada@example.com", "lic_diceroll_a");
      const control = await holder(w, "grace@example.com", "lic_diceroll_g");
      const erasedToken = await mintToken(w, erased);
      const controlToken = await mintToken(w, control);
      await eraseAndRestore(w.ctx, erased.accountId);
      const bucket = await enter(w, isolate);

      const before = await snapshotDb(w.db);
      const window = await redeem(w, erasedToken, AFTER_CLEAR);
      expect(window.status).toBe(404);
      expect(window.headers.get("location")).toBeNull();
      expect(await snapshotDb(w.db)).toEqual(before);
      expect(await spentTokens(w.db)).toBe(0);
      expectLedgerRead(bucket, isolate, erased.accountId);

      await replayErasures(w.ctx);
      expect((await redeem(w, erasedToken, AFTER_CLEAR)).status).toBe(404);

      // Positive control: a token of an account that is not on the ledger is redeemed.
      const served = await redeem(w, controlToken, AFTER_CLEAR);
      expect(served.status).toBe(302);
      expect(served.headers.get("location")).toContain(BYTES);
    },
  );

  it("503 for an unreadable ledger spends nothing; once readable the same token redirects", async () => {
    const w = await downloadsWorld();
    const account = await holder(w, "ada@example.com", "lic_diceroll_a");
    const token = await mintToken(w, account);
    const before = await snapshotDb(w.db);

    w.ledger.down = true;
    const down = await redeem(w, token, AFTER_CLEAR);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({
      error: "erasure_ledger_unavailable",
    });
    expect(down.headers.get("location")).toBeNull();
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(await spentTokens(w.db)).toBe(0);
    expect(w.ledger.heads).toContain(erasureKey(account.accountId));

    w.ledger.down = false;
    const up = await redeem(w, token, AFTER_CLEAR);
    expect(up.status).toBe(302);
    expect(up.headers.get("location")).toContain(BYTES);
    expect(await spentTokens(w.db)).toBe(1);
  });
});
