/**
 * ST-34.2: `consoleTokenSubject` (= `subjectForAccount`), who an account is in the console right now
 * for a credential with no session row. `consoleSubject` is the session-row check plus this tail.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { asR2 } from "./r2Mock.js";
import { LedgerBucket } from "./eraseRestore.js";
import type { Env } from "../src/platform/env.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../src/core/console/session.js";
import { isMemberId, memberIdFor } from "../src/core/console/memberId.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import {
  consoleSubject,
  consoleTokenSubject,
} from "../src/services/identity/public.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const BOUND = ADMIN_SESSION_TTL_SECONDS;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  return env;
}

type Db = ReturnType<typeof makeTestDb>;

/** A real console sign-in; returns the cookie claims (account id, session id). */
async function signedIn(
  env: Env,
  db: Db,
): Promise<{ aid: string; sid: string }> {
  const start = await handleAdminLogin(
    new Request("https://key.plrs.im/manage/login?go=1") as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: "op-1",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
      groups: [GROUP],
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    NOW,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  return JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString(),
  ) as { aid: string; sid: string };
}

beforeEach(() => resetConsoleSessionCache());

describe("consoleTokenSubject", () => {
  it("a strong link with a fresh assertion and the group is root, with the member id and groups", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    const s = await consoleTokenSubject(env, db, aid, NOW + 5);
    expect(s).toMatchObject({
      sub: await memberIdFor(env, aid),
      idpSub: "op-1",
      name: "Ada",
      email: "ada@example.com",
      groups: [GROUP],
      root: true,
    });
    expect(isMemberId(s!.sub)).toBe(true);
    // No field carries the account id.
    expect(JSON.stringify(s)).not.toContain(aid);
  });

  it("holds exactly at the reused bound and is root:false with no groups just past it, not null", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    expect((await consoleTokenSubject(env, db, aid, NOW + BOUND))!.root).toBe(
      true,
    );
    const stale = await consoleTokenSubject(env, db, aid, NOW + BOUND + 1);
    expect(stale).not.toBeNull();
    expect(stale!.root).toBe(false);
    expect(stale!.groups).toEqual([]);
  });

  it("a link that is not strong gives null", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    await db.run("UPDATE account_links SET strong_at = NULL");
    expect(await consoleTokenSubject(env, db, aid, NOW + 1)).toBeNull();
  });

  it("a link through another issuer, or no console IdP configured, gives null", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    await db.run(
      "UPDATE account_links SET issuer_key = 'https://other.example'",
    );
    expect(await consoleTokenSubject(env, db, aid, NOW + 1)).toBeNull();
    const unconfigured = adminEnv();
    delete unconfigured.PLATFORM_OIDC_ISSUER;
    const db2 = makeTestDb();
    const { aid: aid2 } = await signedIn(env, db2);
    expect(
      await consoleTokenSubject(unconfigured, db2, aid2, NOW + 1),
    ).toBeNull();
  });

  it("a disabled account gives null", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", aid);
    expect(await consoleTokenSubject(env, db, aid, NOW + 1)).toBeNull();
  });

  it("an account on the erasure ledger gives null, and so does an unreadable ledger", async () => {
    const env = adminEnv();
    const bucket = new LedgerBucket();
    env.BLOBS = asR2(bucket);
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    expect(await consoleTokenSubject(env, db, aid, NOW + 1)).not.toBeNull();

    const env2 = adminEnv();
    const down = new LedgerBucket();
    env2.BLOBS = asR2(down);
    const db2 = makeTestDb();
    const { aid: aid2 } = await signedIn(env2, db2);
    down.down = true;
    expect(await consoleTokenSubject(env2, db2, aid2, NOW + 1)).toBeNull();

    await bucket.put(erasureKey(aid), "{}");
    // The clear answer is believed for 30 s: ask after it.
    expect(await consoleTokenSubject(env, db, aid, NOW + 100)).toBeNull();
  });

  it("a merged-away account id gives null", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { aid } = await signedIn(env, db);
    const survivor = await signIn(
      db,
      {
        issuerKey: "email",
        subject: "keep@example.com",
        kind: "email",
        email: "keep@example.com",
        emailVerified: true,
      },
      NOW,
      { unfenced: true },
    );
    if (survivor.status !== "signed_in") throw new Error("seed");
    const merged = await mergeAccounts(
      { db, env, now: NOW + 2, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: survivor.account.id, authenticatedAt: NOW + 2 },
        absorbed: { accountId: aid, authenticatedAt: NOW + 2 },
      },
    );
    expect(merged.ok).toBe(true);
    expect(await consoleTokenSubject(env, db, aid, NOW + 3)).toBeNull();
  });
});

describe("consoleSubject is the session-row check plus the same tail", () => {
  it("a live session gives the same object as the account's subject", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const claims = await signedIn(env, db);
    const viaSession = await consoleSubject(env, db, claims, NOW + 5);
    expect(viaSession).not.toBeNull();
    expect(viaSession).toEqual(
      await consoleTokenSubject(env, db, claims.aid, NOW + 5),
    );
  });

  it("a revoked or expired session row still gives null though the account resolves", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const claims = await signedIn(env, db);
    await db.run("UPDATE account_sessions SET expires_at = ?", NOW + 10);
    expect(await consoleSubject(env, db, claims, NOW + 10)).toBeNull();
    expect(
      await consoleTokenSubject(env, db, claims.aid, NOW + 10),
    ).not.toBeNull();
    await db.run(
      "UPDATE account_sessions SET expires_at = ?, revoked_at = ?",
      NOW + 999,
      NOW + 1,
    );
    expect(await consoleSubject(env, db, claims, NOW + 2)).toBeNull();
    expect(
      await consoleTokenSubject(env, db, claims.aid, NOW + 2),
    ).not.toBeNull();
  });
});
