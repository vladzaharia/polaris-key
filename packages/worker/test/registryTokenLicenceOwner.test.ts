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
