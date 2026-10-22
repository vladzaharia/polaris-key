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

  it("leaves the same licence id on another product alone (every token class)", async () => {
    await seedProduct(db, "beta");
    await seedLicenseWithKey(db, "beta", { id: licenseId });
    await db.run(
      "UPDATE licenses SET account_id = 'acc-1' WHERE product = 'beta' AND id = ?",
      licenseId,
    );
    const betaOp = await mintRegistryToken(
      env,
      db,
      {
        product: "beta",
        label: "x",
        binding: "license",
        licenseId,
        createdBy: "admin:t",
      },
      NOW,
    );
    const betaMine = await mintRegistryToken(
      env,
      db,
      {
        product: "beta",
        label: "x",
        binding: "license",
        licenseId,
        createdBy: "portal:acc-1",
        portalAccountId: "acc-1",
      },
      NOW,
    );
    if (!betaOp.ok || !betaMine.ok) throw new Error("mint");
    const target = await mint(licenseId, null);
    const res = await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "detached",
      now: NOW,
    });
    expect(res).toEqual({ revokedTokens: 1 });
    expect((await state(target))?.revoked_at).toBe(NOW);
    expect((await state(betaOp.view.tokenId))?.revoked_at).toBeNull();
    expect((await state(betaMine.view.tokenId))?.revoked_at).toBeNull();
  });

  it("is one batch: a failing statement leaves neither half committed", async () => {
    const operator = await mint(licenseId, null);
    const mine = await mint(licenseId, "acc-1");
    const flaky = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === "batchChanges" || prop === "batch")
          return async (stmts: { sql: string; params: unknown[] }[]) =>
            v.call(target, [
              ...stmts,
              { sql: "UPDATE no_such_table SET x = 1", params: [] },
            ]);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    await expect(
      onLicenseOwnershipEnded(flaky, env, {
        product: "acme",
        licenseId,
        accountId: "acc-1",
        reason: "detached",
        now: NOW,
      }),
    ).rejects.toThrow();
    expect((await state(operator))?.revoked_at).toBeNull();
    expect((await state(mine))?.revoked_at).toBeNull();
  });

  it("operatorTokens: false revokes only the account's own tokens", async () => {
    const operator = await mint(licenseId, null);
    const mine = await mint(licenseId, "acc-1");
    const res = await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "relinked",
      now: NOW,
      operatorTokens: false,
    });
    expect(res).toEqual({ revokedTokens: 1 });
    expect((await state(operator))?.revoked_at).toBeNull();
    expect((await state(mine))?.revoked_at).toBe(NOW);
    expect(
      await db.first(
        "SELECT 1 FROM audit WHERE action = 'registry_token.revoke_all'",
      ),
    ).toBeNull();
  });

  it("writes one system audit row naming the licence and the count, never a token", async () => {
    const a = await mint(licenseId, null);
    const b = await mint(licenseId, null);
    await mint(licenseId, "acc-1");
    await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "detached",
      now: NOW,
    });
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM audit WHERE action = 'registry_token.revoke_all'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product: "acme",
      actor_sub: null,
      actor_name: "Polaris Key",
      target_kind: "license",
      target_id: licenseId,
    });
    expect(String(rows[0]?.summary)).toContain("revoked 2 operator-minted");
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(a);
    expect(dump).not.toContain(b);
    // Nothing to revoke, nothing to audit.
    await onLicenseOwnershipEnded(db, env, {
      product: "acme",
      licenseId,
      accountId: "acc-1",
      reason: "detached",
      now: NOW + 1,
    });
    expect(
      await db.all(
        "SELECT 1 FROM audit WHERE action = 'registry_token.revoke_all'",
      ),
    ).toHaveLength(1);
  });
});
