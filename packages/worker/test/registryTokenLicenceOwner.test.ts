/**
 * B-155: a licence-bound registry token a person minted is good only while that person's account
 * still owns the licence. The unlink, relink and merge paths revoke or repoint such tokens; this
 * pins the serve-time check behind them, for a change of the licence's account that went through
 * none of them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetRegistryTokens,
  lookupRegistryCredential,
  lookupRegistrySubject,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import { onLicenseOwnershipEnded } from "../src/core/accounts/subjectHooks.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";

const AT = { nowMs: NOW * 1000 };

describe("licence-bound registry tokens follow the licence's account (B-155)", () => {
  let db: Db;
  let env: Env;
  let licenseId: string;

  beforeEach(async () => {
    forgetRegistryTokens();
    db = makeTestDb();
    env = makeEnv(new KvMock(), []);
    env.KEY_HASH_PEPPER = "pepper";
    env.REGISTRY_TOKEN_KEY = "registry-token-key-for-tests";
    await seedProduct(db, "acme");
    licenseId = (await seedLicenseWithKey(db, "acme")).licenseId;
  });

  async function mint(accountId: string | null) {
    const res = await mintRegistryToken(
      env,
      db,
      {
        product: "acme",
        label: "laptop",
        binding: "license",
        licenseId,
        createdBy: accountId ? `portal:${accountId}` : "admin:test",
        ...(accountId ? { portalAccountId: accountId } : {}),
      },
      NOW,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    await db.run(
      "UPDATE registry_tokens SET last_used_at = ? WHERE token_id = ?",
      NOW - 86_400,
      res.view.tokenId,
    );
    return { token: res.token, tokenId: res.view.tokenId };
  }

  const lastUsed = async (tokenId: string) =>
    (
      await db.first<{ last_used_at: number | null }>(
        "SELECT last_used_at FROM registry_tokens WHERE token_id = ?",
        tokenId,
      )
    )?.last_used_at;

  it("resolves while the minting account owns the licence", async () => {
    await db.run(
      "UPDATE licenses SET account_id = 'acc-1' WHERE id = ?",
      licenseId,
    );
    const t = await mint("acc-1");
    const got = await lookupRegistryCredential(env, db, t.token, AT);
    expect(got.resolved?.kind).toBe("license");
  });

  it("stops resolving once the licence belongs to another account, and writes nothing", async () => {
    await db.run(
      "UPDATE licenses SET account_id = 'acc-1' WHERE id = ?",
      licenseId,
    );
    const t = await mint("acc-1");
    // The licence's account changes by a route that does not run the ownership hook.
    await db.run(
      "UPDATE licenses SET account_id = 'acc-2' WHERE id = ?",
      licenseId,
    );
    forgetRegistryTokens();
    const got = await lookupRegistryCredential(env, db, t.token, AT);
    expect(got.resolved).toBeNull();
    expect(await lastUsed(t.tokenId)).toBe(NOW - 86_400);
    forgetRegistryTokens();
    expect(
      await lookupRegistrySubject(env, db, "acme", t.tokenId, AT),
    ).toBeNull();
  });

  it("stops resolving once the licence has no account", async () => {
    await db.run(
      "UPDATE licenses SET account_id = 'acc-1' WHERE id = ?",
      licenseId,
    );
    const t = await mint("acc-1");
    await db.run(
      "UPDATE licenses SET account_id = NULL WHERE id = ?",
      licenseId,
    );
    forgetRegistryTokens();
    expect(
      (await lookupRegistryCredential(env, db, t.token, AT)).resolved,
    ).toBeNull();
  });

  it("leaves a token no account minted alone", async () => {
    const t = await mint(null);
    const got = await lookupRegistryCredential(env, db, t.token, AT);
    expect(got.resolved?.kind).toBe("license");
  });
});

describe("ownership end revokes the operator-minted licence-bound tokens too (F-33b.1)", () => {
  let db: Db;
  let env: Env;
  let licenseId: string;
  let otherId: string;

  beforeEach(async () => {
    forgetRegistryTokens();
    db = makeTestDb();
    env = makeEnv(new KvMock(), []);
    env.KEY_HASH_PEPPER = "pepper";
    env.REGISTRY_TOKEN_KEY = "registry-token-key-for-tests";
    await seedProduct(db, "acme");
    licenseId = (await seedLicenseWithKey(db, "acme")).licenseId;
    otherId = (await seedLicenseWithKey(db, "acme", { id: "lic_acme_2" }))
      .licenseId;
    await db.run(
      "UPDATE licenses SET account_id = 'acc-1' WHERE id = ?",
      licenseId,
    );
  });

  async function mint(forLicense: string, accountId: string | null) {
    const res = await mintRegistryToken(
      env,
      db,
      {
        product: "acme",
        label: "ci",
        binding: "license",
        licenseId: forLicense,
        createdBy: accountId ? `portal:${accountId}` : "admin:test",
        ...(accountId ? { portalAccountId: accountId } : {}),
      },
      NOW,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.view.tokenId;
  }

  const state = async (tokenId: string) =>
    db.first<{
      revoked_at: number | null;
      revoked_by: string | null;
      revoke_reason: string | null;
    }>(
      "SELECT revoked_at, revoked_by, revoke_reason FROM registry_tokens WHERE token_id = ?",
      tokenId,
    );

  it.each([
    ["detached", "link_removed"],
    ["relinked", "link_removed"],
    ["account_deleted", "account_deleted"],
  ] as const)(
    "%s revokes the operator's token as system (%s) and the account's as the account",
    async (reason, stored) => {
      const operator = await mint(licenseId, null);
      const mine = await mint(licenseId, "acc-1");
      const res = await onLicenseOwnershipEnded(db, env, {
        product: "acme",
        licenseId,
        accountId: "acc-1",
        reason,
        now: NOW,
      });
      expect(res).toEqual({ revokedTokens: 2 });
      expect(await state(operator)).toEqual({
        revoked_at: NOW,
        revoked_by: "system",
        revoke_reason: stored,
      });
      expect(await state(mine)).toEqual({
        revoked_at: NOW,
        revoked_by: "portal:acc-1",
        revoke_reason: stored,
      });
    },
  );

  it("leaves another licence's tokens, a floating licence's operator token and other accounts' tokens alone", async () => {
    const otherOperator = await mint(otherId, null);
    const otherMine = await mint(otherId, "acc-2");
    const otherSameAccount = await mint(otherId, "acc-1");
    const res = await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "detached",
      now: NOW,
    });
    expect(res).toEqual({ revokedTokens: 0 });
    for (const id of [otherOperator, otherMine, otherSameAccount])
      expect((await state(id))?.revoked_at).toBeNull();
  });

  it("does not touch another account's token on the same licence, nor an already revoked one", async () => {
    const theirs = await mint(licenseId, "acc-2");
    const operator = await mint(licenseId, null);
    await db.run(
      "UPDATE registry_tokens SET revoked_at = 5, revoked_by = 'admin', revoke_reason = 'manual' WHERE token_id = ?",
      operator,
    );
    const res = await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "detached",
      now: NOW,
    });
    expect(res).toEqual({ revokedTokens: 0 });
    expect((await state(theirs))?.revoked_at).toBeNull();
    expect(await state(operator)).toMatchObject({
      revoked_at: 5,
      revoked_by: "admin",
    });
  });

  it("an operator-minted token stops resolving at once", async () => {
    const t = await mintRegistryToken(
      env,
      db,
      {
        product: "acme",
        label: "ci",
        binding: "license",
        licenseId,
        createdBy: "admin:test",
      },
      NOW,
    );
    if (!t.ok) throw new Error("mint");
    expect(
      (await lookupRegistryCredential(env, db, t.token, AT)).resolved?.kind,
    ).toBe("license");
    await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "relinked",
      now: NOW,
    });
    expect(
      (await lookupRegistryCredential(env, db, t.token, AT)).resolved,
    ).toBeNull();
  });
});
