/**
 * I-11: package tokens and the request-time erasure fence.
 *
 * A D1 Time Travel restore rewinds the database but not the erasure ledger (R2), so an erased
 * account's package tokens are live rows again until the cron replay revokes them. The fence closes
 * that window: a token a person minted for their account (`registry_tokens.portal_account_id`)
 * resolves to nothing when the ledger holds the account, and to "not known" (not cached) when the
 * ledger cannot be read. Tokens no account owns are never asked.
 *
 * Every window test asserts the same three things: refused between the restore and the replay,
 * still refused after the replay, and a live account's token passing the same gate in the same
 * world.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRegistryHost } from "../src/core/registry/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/repo.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { forgetLicenceHolds } from "../src/services/distribution/registry/authorize.js";
import {
  forgetRegistryTokens,
  lookupRegistryCredential,
  lookupRegistrySubject,
  mintRegistryToken,
  signPullToken,
  type MintRegistryTokenInput,
} from "../src/core/registry/registryTokens.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import {
  ERASURE_PREFIX,
  erasureKey,
} from "../src/core/accounts/erasureFence.js";
import * as deletion from "../src/services/identity/accounts/deletion.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { getAccountRow } from "../src/services/identity/accounts/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { eraseAndRestore, LedgerBucket } from "./eraseRestore.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { OCI_REPO, publishOciFixture } from "./ociFixture.js";

const PKG = "https://pkg.example.test";
const HOST = "pkg.example.test";
const OWNER = "acme";
const NAME = `${OWNER}/${OCI_REPO}`;
const KEY = "registry-token-key-for-tests";
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
};

/** What the lookups are asked at: the clock the fence's `clear` answers expire on is `NOW`. */
const AT = { nowMs: NOW * 1000 };
/** A token the ledger (or the revocation) refuses: it resolves to nothing, as an unknown one does. */
const REFUSED = { resolved: null, miss: true };
/** A token whose account could not be asked about: nothing now, and nothing remembered. */
const UNKNOWN = { resolved: null, miss: false };

interface World {
  readonly db: Db;
  readonly env: Env;
  readonly bucket: LedgerBucket;
  readonly licenseId: string;
  ctx(now?: number): AccountContext;
}

interface Minted {
  readonly token: string;
  readonly tokenId: string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A product with an OCI feed, a licence, and an empty ledger bucket bound as `BLOBS`. */
async function world(): Promise<World> {
  const db = makeTestDb();
  const bucket = new LedgerBucket();
  const env = makeEnv(new KvMock(), []);
  env.BLOBS = asR2(bucket);
  env.PKG_ORIGIN = PKG;
  env.KEY_HASH_PEPPER = "pepper";
  env.REGISTRY_TOKEN_KEY = KEY;
  await seedProduct(db, OWNER);
  await setServices(
    db,
    OWNER,
    serializeServices({ services: ON }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    OWNER,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'oci', 1, '{}', 52428800, ?)`,
    OWNER,
    NOW,
  );
  await publishOciFixture(db, env, bucket, OWNER, NOW);
  const { licenseId } = await seedLicenseWithKey(db, OWNER);
  return {
    db,
    env,
    bucket,
    licenseId,
    ctx: (now = NOW) => ({ db, env, now, origin: "https://key.plrs.im" }),
  };
}

async function account(w: World, email: string): Promise<string> {
  const r = await signIn(
    w.db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { env: w.env },
  );
  if (r.status !== "signed_in") throw new Error(`sign-in of ${email} failed`);
  return r.account.id;
}

/**
 * A token minted the way the portal mints one for `accountId` (`portal:<id>` and the account id on
 * the row), or the way the console does with `null`. Its `last_used_at` is set well in the past so
 * a lookup that wrote it would show.
 */
async function mintFor(
  w: World,
  accountId: string | null,
  over: Partial<MintRegistryTokenInput> = {},
): Promise<Minted> {
  const res = await mintRegistryToken(
    w.env,
    w.db,
    {
      product: OWNER,
      label: "laptop",
      binding: "owner",
      createdBy: accountId ? `portal:${accountId}` : "admin:test",
      ...(accountId ? { portalAccountId: accountId } : {}),
      ...over,
    },
    NOW,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  await w.db.run(
    "UPDATE registry_tokens SET last_used_at = ? WHERE token_id = ?",
    NOW - 86_400,
    res.view.tokenId,
  );
  return { token: res.token, tokenId: res.view.tokenId };
}

async function lastUsed(w: World, tokenId: string): Promise<number | null> {
  const row = await w.db.first<{ last_used_at: number | null }>(
    "SELECT last_used_at FROM registry_tokens WHERE token_id = ?",
    tokenId,
  );
  if (!row) throw new Error(`no row for ${tokenId}`);
  return row.last_used_at;
}

async function revokeReason(w: World, tokenId: string): Promise<string | null> {
  const row = await w.db.first<{ revoke_reason: string | null }>(
    "SELECT revoke_reason FROM registry_tokens WHERE token_id = ?",
    tokenId,
  );
  if (!row) throw new Error(`no row for ${tokenId}`);
  return row.revoke_reason;
}

const credential = (w: World, token: string) =>
  lookupRegistryCredential(w.env, w.db, token, AT);

const subject = (w: World, tokenId: string) =>
  lookupRegistrySubject(w.env, w.db, OWNER, tokenId, AT);

/** The ledger keys the fence asked R2 about (publishing the fixture HEADs other keys). */
const ledgerHeads = (w: World): string[] =>
  w.bucket.heads.filter((k) => k.startsWith(ERASURE_PREFIX));

/** What the cron runs: the account is then erased in D1 for real. */
async function replay(w: World): Promise<void> {
  expect(await deletion.replayErasures(w.ctx(NOW + 200))).toMatchObject({
    reapplied: 1,
    failures: [],
  });
}

/**
 * A second isolate: its own bucket binding (so none of the erasing isolate's memory), holding
 * what the ledger holds. Its registry cache is empty too.
 */
async function otherIsolate(w: World): Promise<LedgerBucket> {
  const fresh = new LedgerBucket();
  for (const key of w.bucket.keys()) {
    if (!key.startsWith(ERASURE_PREFIX)) continue;
    const object = await w.bucket.get(key);
    if (!object || !("arrayBuffer" in object))
      throw new Error(`no ledger body for ${key}`);
    fresh.seed(key, new Uint8Array(await object.arrayBuffer()));
  }
  w.env.BLOBS = asR2(fresh);
  forgetRegistryTokens();
  return fresh;
}

// ── Lookups ──────────────────────────────────────────────────────────────────────────────────

describe("a restored erased account's package token", () => {
  it.each(["owner", "license"] as const)(
    "resolves to nothing, %s-bound, between the restore and the replay and after it",
    async (binding) => {
      const w = await world();
      const ada = await account(w, "ada@example.com");
      const bob = await account(w, "bob@example.com");
      const over =
        binding === "license"
          ? { binding, licenseId: w.licenseId }
          : { binding };
      const adaToken = await mintFor(w, ada, over);
      const bobToken = await mintFor(w, bob, over);

      await eraseAndRestore(w.ctx(), ada);
      // The restore did rewind D1: the account is active and the token is live again.
      expect((await getAccountRow(w.db, ada))?.status).toBe("active");
      expect(await revokeReason(w, adaToken.tokenId)).toBeNull();
      forgetRegistryTokens();

      expect(await credential(w, adaToken.token)).toEqual(REFUSED);
      // The positive control: bob is not on the ledger and his token resolves in the same world.
      const live = await credential(w, bobToken.token);
      expect(live.miss).toBe(false);
      expect(live.resolved).toMatchObject({
        kind: binding,
        tokenId: bobToken.tokenId,
        product: OWNER,
      });
      expect(ledgerHeads(w)).toContain(erasureKey(bob));
      // The refused lookup wrote nothing; the resolved one recorded its use.
      expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);
      expect(await lastUsed(w, bobToken.tokenId)).toBe(NOW);

      await replay(w);
      expect(await revokeReason(w, adaToken.tokenId)).toBe("account_deleted");
      forgetRegistryTokens();
      expect(await credential(w, adaToken.token)).toEqual(REFUSED);
      expect((await credential(w, bobToken.token)).resolved?.kind).toBe(
        binding,
      );
    },
  );

  it("is refused by the OCI pull-token subject path too, and a live account's subject resolves", async () => {
    const w = await world();
    const ada = await account(w, "ada@example.com");
    const bob = await account(w, "bob@example.com");
    const adaToken = await mintFor(w, ada);
    const bobToken = await mintFor(w, bob);

    await eraseAndRestore(w.ctx(), ada);
    forgetRegistryTokens();

    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(await subject(w, bobToken.tokenId)).toMatchObject({
      kind: "owner",
      tokenId: bobToken.tokenId,
    });
    expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);
    expect(await lastUsed(w, bobToken.tokenId)).toBe(NOW);

    await replay(w);
    forgetRegistryTokens();
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(await subject(w, bobToken.tokenId)).not.toBeNull();
  });

  it("is refused by an isolate that learns of the erasure from the ledger, not from its own write", async () => {
    const w = await world();
    const ada = await account(w, "ada@example.com");
    const bob = await account(w, "bob@example.com");
    const adaToken = await mintFor(w, ada);
    const bobToken = await mintFor(w, bob);
    await eraseAndRestore(w.ctx(), ada);
    const fresh = await otherIsolate(w);

    expect(await credential(w, adaToken.token)).toEqual(REFUSED);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(fresh.heads).toContain(erasureKey(ada));
    expect((await credential(w, bobToken.token)).resolved).not.toBeNull();
    expect(fresh.heads).toContain(erasureKey(bob));

    await replay(w);
    forgetRegistryTokens();
    expect(await credential(w, adaToken.token)).toEqual(REFUSED);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect((await credential(w, bobToken.token)).resolved).not.toBeNull();
  });
});

// ── An unreadable ledger ─────────────────────────────────────────────────────────────────────

describe("a package token while the ledger cannot be read", () => {
  /** The two ways a request cannot ask: R2 fails the HEAD, or the bucket is not bound. */
  const breakers = {
    down: {
      fail(w: World) {
        w.bucket.down = true;
      },
      repair(w: World) {
        w.bucket.down = false;
      },
    },
    unbound: {
      fail(w: World) {
        delete w.env.BLOBS;
      },
      repair(w: World) {
        w.env.BLOBS = asR2(w.bucket);
      },
    },
  };

  it.each(["down", "unbound"] as const)(
    "is not resolved and not cached (%s), and resolves once the ledger is readable again",
    async (how) => {
      const w = await world();
      const bob = await account(w, "bob@example.com");
      const bobToken = await mintFor(w, bob);
      const { fail, repair } = breakers[how];

      fail(w);
      expect(await credential(w, bobToken.token)).toEqual(UNKNOWN);
      expect(await subject(w, bobToken.tokenId)).toBeNull();
      expect(await lastUsed(w, bobToken.tokenId)).toBe(NOW - 86_400);
      if (how === "down") expect(ledgerHeads(w)).toContain(erasureKey(bob));

      // No forgetRegistryTokens(): neither the null nor an "unavailable" verdict was remembered.
      repair(w);
      const back = await credential(w, bobToken.token);
      expect(back.miss).toBe(false);
      expect(back.resolved).toMatchObject({ tokenId: bobToken.tokenId });
      expect(await subject(w, bobToken.tokenId)).toMatchObject({
        tokenId: bobToken.tokenId,
      });
      expect(await lastUsed(w, bobToken.tokenId)).toBe(NOW);
    },
  );

  it("fails closed for an erased account's token too, and its erasure is refused again once readable", async () => {
    const w = await world();
    const ada = await account(w, "ada@example.com");
    const adaToken = await mintFor(w, ada);
    await eraseAndRestore(w.ctx(), ada);
    // An isolate that did not write the record cannot know while R2 fails.
    const fresh = await otherIsolate(w);

    fresh.down = true;
    expect(await credential(w, adaToken.token)).toEqual(UNKNOWN);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);

    fresh.down = false;
    expect(await credential(w, adaToken.token)).toEqual(REFUSED);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);

    // Once an isolate has seen the record it keeps refusing, even while R2 fails.
    fresh.down = true;
    forgetRegistryTokens();
    expect(await credential(w, adaToken.token)).toEqual(REFUSED);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
  });

  it("still refuses the isolate that erased an account while R2 fails (it remembers its own write)", async () => {
    const w = await world();
    const ada = await account(w, "ada@example.com");
    const adaToken = await mintFor(w, ada);
    await eraseAndRestore(w.ctx(), ada);
    forgetRegistryTokens();

    w.bucket.down = true;
    expect(await credential(w, adaToken.token)).toEqual(REFUSED);
    expect(await subject(w, adaToken.tokenId)).toBeNull();
    expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);
  });
});

// ── Tokens no account owns ───────────────────────────────────────────────────────────────────

describe("a token no account owns", () => {
  it.each(["healthy", "down", "unbound"] as const)(
    "is never asked about and resolves (ledger %s); an account's token in the same world is refused or resolved by the ledger",
    async (state) => {
      const w = await world();
      const bob = await account(w, "bob@example.com");
      const bobToken = await mintFor(w, bob);
      const owner = await mintFor(w, null);
      const ci = await issueStaticCiToken(w.env, w.db, {
        product: OWNER,
        label: "build",
        scopes: ["release:publish"],
        expiresAt: NOW + 86_400,
        createdBy: "admin:test",
        now: NOW,
      });
      expect(ci.token).toMatch(/^pkeyci_/);
      if (state === "down") w.bucket.down = true;
      if (state === "unbound") delete w.env.BLOBS;

      const ownerSeen = await credential(w, owner.token);
      expect(ownerSeen.miss).toBe(false);
      expect(ownerSeen.resolved).toMatchObject({
        kind: "owner",
        tokenId: owner.tokenId,
      });
      expect(await subject(w, owner.tokenId)).toMatchObject({
        kind: "owner",
        tokenId: owner.tokenId,
      });
      const ciSeen = await credential(w, ci.token);
      expect(ciSeen.miss).toBe(false);
      expect(ciSeen.resolved).toMatchObject({
        kind: "ci",
        tokenId: ci.tokenId,
        scopes: ["release:publish"],
      });
      expect(await subject(w, `ci:${ci.tokenId}`)).toMatchObject({
        kind: "ci",
        tokenId: ci.tokenId,
      });
      // Nothing was asked of the ledger for either.
      expect(ledgerHeads(w)).toEqual([]);

      // The account's token in the same world is the one that depends on the ledger.
      const bobSeen = await credential(w, bobToken.token);
      if (state === "healthy") expect(bobSeen.resolved).not.toBeNull();
      else expect(bobSeen).toEqual(UNKNOWN);
    },
  );
});

// ── The feed access ladder ───────────────────────────────────────────────────────────────────

describe("the feed access ladder, through the registry host", () => {
  const manifest = `/v2/${NAME}/tags/list`;

  const basic = (token: string): string =>
    `Basic ${btoa(`__token__:${token}`)}`;

  function get(w: World, path: string, init: RequestInit = {}) {
    return dispatchRegistryHost(
      new Request(`${PKG}${path}`, init),
      w.env,
      w.db,
      REGISTRY_ROUTES,
      SERVICES,
      undefined,
      REGISTRY_OWNERLESS_ROUTES,
    );
  }

  const bearer = (token: string): RequestInit => ({
    headers: { authorization: `Bearer ${token}` },
  });

  /** `docker login` with a registry token: the pull-token service. */
  function login(w: World, token: string) {
    const scope = encodeURIComponent(`repository:${NAME}:pull`);
    return get(w, `/v2/token?service=${HOST}&scope=${scope}`, {
      headers: { authorization: basic(token) },
    });
  }

  async function pullTokenOf(w: World, token: string): Promise<string> {
    const res = await login(w, token);
    expect(res.status, await res.clone().text()).toBe(200);
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("token" in body) ||
      typeof body.token !== "string"
    )
      throw new Error("no pull token in the answer");
    return body.token;
  }

  async function setPrivate(w: World): Promise<void> {
    await w.db.run(
      "UPDATE dist_registry_feeds SET access_mode = 'authenticated' WHERE product = ? AND ecosystem = 'oci'",
      OWNER,
    );
    forgetRegistrySettings();
  }

  it("serves a live account's token and refuses a restored erased account's, before and after the replay", async () => {
    const w = await world();
    await setPrivate(w);
    const ada = await account(w, "ada@example.com");
    const bob = await account(w, "bob@example.com");
    const adaToken = await mintFor(w, ada);
    const bobToken = await mintFor(w, bob);
    // Pull tokens live 300 s: ada's was issued before her erasure.
    const adaPull = await pullTokenOf(w, adaToken.token);
    const bobPull = await pullTokenOf(w, bobToken.token);
    expect((await get(w, manifest)).status).toBe(401);
    // Her live use above recorded itself; put it back so a later write would show.
    await w.db.run(
      "UPDATE registry_tokens SET last_used_at = ? WHERE token_id = ?",
      NOW - 86_400,
      adaToken.tokenId,
    );

    await eraseAndRestore(w.ctx(), ada);

    const settle = async () => {
      forgetRegistryTokens();
      // Raw registry token as a Bearer credential, a pull token, and docker login.
      expect((await get(w, manifest, bearer(adaToken.token))).status).toBe(401);
      expect((await get(w, manifest, bearer(adaPull))).status).toBe(401);
      expect((await login(w, adaToken.token)).status).toBe(401);
      expect((await get(w, manifest, bearer(bobToken.token))).status).toBe(200);
      expect((await get(w, manifest, bearer(bobPull))).status).toBe(200);
      expect((await login(w, bobToken.token)).status).toBe(200);
    };
    await settle();
    await replay(w);
    await settle();
    expect(await lastUsed(w, adaToken.tokenId)).toBe(NOW - 86_400);
  });

  it.each(["down", "unbound"] as const)(
    "refuses a token for the request while the ledger is unreadable (%s) and serves it again without a cache flush once readable",
    async (how) => {
      const w = await world();
      await setPrivate(w);
      const bob = await account(w, "bob@example.com");
      const bobToken = await mintFor(w, bob);
      const pull = await signPullToken(
        w.env,
        { sub: bobToken.tokenId, own: OWNER, repos: [NAME] },
        NOW,
      );
      if (!pull) throw new Error("REGISTRY_TOKEN_KEY is set");

      if (how === "down") w.bucket.down = true;
      else delete w.env.BLOBS;
      expect((await get(w, manifest, bearer(bobToken.token))).status).toBe(401);
      expect((await get(w, manifest, bearer(pull.token))).status).toBe(401);
      expect((await login(w, bobToken.token)).status).toBe(401);

      if (how === "down") w.bucket.down = false;
      else w.env.BLOBS = asR2(w.bucket);
      expect((await get(w, manifest, bearer(bobToken.token))).status).toBe(200);
      expect((await get(w, manifest, bearer(pull.token))).status).toBe(200);
      expect((await login(w, bobToken.token)).status).toBe(200);
    },
  );

  it("serves an owner's and a CI token with the ledger unreadable", async () => {
    const w = await world();
    await setPrivate(w);
    const owner = await mintFor(w, null);
    const ci = await issueStaticCiToken(w.env, w.db, {
      product: OWNER,
      label: "build",
      scopes: ["release:publish"],
      expiresAt: NOW + 86_400,
      createdBy: "admin:test",
      now: NOW,
    });
    w.bucket.down = true;
    expect((await get(w, manifest, bearer(owner.token))).status).toBe(200);
    expect((await get(w, manifest, bearer(ci.token))).status).toBe(200);
    expect(await pullTokenOf(w, owner.token)).toBeTruthy();
    expect(await pullTokenOf(w, ci.token)).toBeTruthy();
    delete w.env.BLOBS;
    forgetRegistryTokens();
    expect((await get(w, manifest, bearer(owner.token))).status).toBe(200);
    expect((await get(w, manifest, bearer(ci.token))).status).toBe(200);
  });
});
