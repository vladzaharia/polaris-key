/**
 * I-21.15 (V5 §12.13.7; plans/I-34-I-21.15.md §2): what each event does to a person's client grants
 * and refresh families. One describe per row of the lifecycle matrix, and the re-checks the rows rely
 * on: the grant epoch, the issuer epoch and the redeemed code's claims against the grant as it
 * stands. Each row asserts both ends: the token endpoints (`invalid_grant`, `invalid_token`) and the
 * rows that go or stay.
 */
import { afterEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../../../../src/core/accounts/subjectHooks.js";
import { deleteProduct } from "../../../../src/core/products/store.js";
import { applyServiceTransitions } from "../../../../src/core/servicesTransitions.js";
import { parseServices } from "../../../../src/core/services.js";
import {
  deleteAccount,
  disableAccount,
  sweepErasures,
} from "../../../../src/services/identity/accounts/deletion.js";
import { mergeAccounts } from "../../../../src/services/identity/accounts/merge.js";
import { removeProductData } from "../../../../src/services/identity/accounts/productRemoval.js";
import { scheduleAccountDeletion } from "../../../../src/services/identity/accounts/lifecycle.js";
import { signIn as accountSignIn } from "../../../../src/services/identity/accounts/signIn.js";
import {
  deleteClient,
  setClientStatus,
  type ClientRecord,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import {
  clientGrantStatement,
  disconnectClient,
  getClientGrant,
  putClientGrant,
} from "../../../../src/services/identity/issuer/grantsRepo.js";
import { issueRefreshFamily } from "../../../../src/services/identity/issuer/refreshRepo.js";
import { asR2, R2Mock } from "../../../r2Mock.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG } from "../../connect/connectFixture.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerFlow, issuerSuite } from "./issuerFlow.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
const { s, codeFor, token, grantForm, err } = issuerSuite("lifecycle-pepper");

type Tokens = {
  access_token: string;
  id_token: string;
  refresh_token: string;
};
const signIn = async (c: ClientRecord = s.spa): Promise<Tokens> => {
  const res = await token(
    grantForm(
      c,
      await codeFor(c),
      c.type === "web" ? { client_secret: s.secret } : {},
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
};
const refresh = (c: ClientRecord, rt: string, at = NOW) =>
  token(
    {
      grant_type: "refresh_token",
      client_id: c.clientId,
      refresh_token: rt,
      ...(c.type === "web" ? { client_secret: s.secret } : {}),
    },
    { at },
  );
const info = (t: Tokens, at = NOW) =>
  dispatchWith(
    new Request(`${ISSUER}/userinfo`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    }),
    s.w.env,
    s.w.db,
    at,
  );
/** Refresh answers `invalid_grant`. */
const refreshRefused = async (t: Tokens, c: ClientRecord = s.spa) =>
  expect(await err(await refresh(c, t.refresh_token))).toBe("invalid_grant");
/** Refresh answers `invalid_grant` and userinfo `invalid_token` at once: the grant is gone. */
const cutOff = async (t: Tokens, c: ClientRecord = s.spa) => {
  await refreshRefused(t, c);
  expect((await info(t)).status).toBe(401);
};
const count = async (table: string, where = "1 = 1", ...p: unknown[]) =>
  (await s.w.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    ...(p as never[]),
  ))!.n;
const live = (accountId = s.accountId) =>
  count(
    "identity_refresh_tokens",
    "account_id = ? AND product = 'djdl' AND revoked_at IS NULL AND spent_at IS NULL",
    accountId,
  );
const grants = (accountId = s.accountId) =>
  count("identity_client_grants", "account_id = ?", accountId);
const ctx = (now = NOW) => ({
  db: s.w.db,
  env: s.w.env,
  now,
  origin: "https://key.plrs.im",
});
/** A foreign row of another product that no event of SLUG may touch. */
const seedOtherProduct = async (accountId: string) => {
  await s.w.db.batch([
    clientGrantStatement(
      {
        accountId,
        clientId: "cl_other",
        product: "acme",
        claimsGranted: ["name"],
        claimsDeclined: [],
        scopes: ["offline_access"],
        scopeHash: "h",
      },
      NOW,
    ),
    {
      sql: `INSERT INTO identity_refresh_tokens
              (token_hash, family_id, product, client_id, account_id, scope, claims_json, auth_time,
               family_started_at, created_at, last_used_at)
            VALUES ('th', 'rf_other', 'acme', 'cl_other', ?, 'openid', '[]', ?, ?, ?, ?)`,
      params: [accountId, NOW, NOW, NOW, NOW],
    },
  ]);
};
const otherProductIntact = async (accountId: string) => {
  expect(
    await count(
      "identity_client_grants",
      "product = 'acme' AND account_id = ?",
      accountId,
    ),
  ).toBe(1);
  expect(
    await count(
      "identity_refresh_tokens",
      "product = 'acme' AND account_id = ? AND revoked_at IS NULL",
      accountId,
    ),
  ).toBe(1);
};

describe("Disconnect", () => {
  it("deletes the grant and revokes that account's families for the client, in one batch, and nothing else", async () => {
    const mine = await signIn(s.spa);
    const second = await signIn(s.spa);
    const other = await signIn(s.web);
    await seedOtherProduct(s.accountId);
    expect(
      await disconnectClient(s.w.db, SLUG, s.accountId, s.spa.clientId, NOW),
    ).toBe(true);
    await cutOff(mine);
    await cutOff(second);
    expect(
      await getClientGrant(s.w.db, SLUG, s.accountId, s.spa.clientId),
    ).toBeNull();
    // The same person's other client, and another product, are untouched.
    expect((await refresh(s.web, other.refresh_token)).status).toBe(200);
    expect(
      await getClientGrant(s.w.db, SLUG, s.accountId, s.web.clientId),
    ).not.toBeNull();
    await otherProductIntact(s.accountId);
    expect(
      await disconnectClient(s.w.db, SLUG, s.accountId, s.spa.clientId, NOW),
    ).toBe(false);
  });

  it("another account's families for the same client are untouched", async () => {
    const mine = await signIn(s.spa);
    const b = await accountSignIn(
      s.w.db,
      { issuerKey: "email", subject: "grace@example.com", kind: "email" },
      NOW,
      { unfenced: true },
    );
    if (b.status !== "signed_in") throw new Error("sign-in");
    const flowB = issuerFlow(() => ({
      w: s.w,
      accountId: b.account.id,
      pair: s.pair,
    }));
    const res = await token(flowB.grantForm(s.spa, await flowB.codeFor(s.spa)));
    expect(res.status).toBe(200);
    const theirs = (await res.json()) as Tokens;
    await disconnectClient(s.w.db, SLUG, s.accountId, s.spa.clientId, NOW);
    await cutOff(mine);
    expect((await refresh(s.spa, theirs.refresh_token)).status).toBe(200);
  });
});

describe("the grant epoch", () => {
  it("a family that started before the grant is refused: re-consent never revives it", async () => {
    const old = await signIn();
    // The race the revoke statements alone cannot cover: a family the Disconnect did not reach.
    await disconnectClient(s.w.db, SLUG, s.accountId, s.spa.clientId, NOW);
    await s.w.db.run("UPDATE identity_refresh_tokens SET revoked_at = NULL");
    const grant = {
      accountId: s.accountId,
      clientId: s.spa.clientId,
      product: SLUG,
      claimsGranted: ["name" as const, "email" as const],
      claimsDeclined: ["picture" as const],
      scopes: ["pkey:entitlements", "offline_access"],
      scopeHash: "h",
    };
    await putClientGrant(s.w.db, grant, NOW + 100);
    expect(await err(await refresh(s.spa, old.refresh_token, NOW + 100))).toBe(
      "invalid_grant",
    );
    const fresh = await issueRefreshFamily(
      s.w.env,
      s.w.db,
      {
        product: SLUG,
        clientId: s.spa.clientId,
        accountId: s.accountId,
        scope: "openid profile email offline_access pkey:entitlements",
        claims: ["name", "email"],
        authTime: NOW,
        redirectUri: s.spa.redirectUris[0]!,
      },
      NOW + 100,
    );
    expect((await refresh(s.spa, fresh.token, NOW + 100)).status).toBe(200);
  });

  it("a Change keeps granted_at, so the families stay", async () => {
    const t = await signIn();
    const before = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    await putClientGrant(
      s.w.db,
      {
        ...before,
        claimsGranted: ["name"],
        claimsDeclined: ["picture", "email"],
      },
      NOW + 50,
    );
    const after = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    expect(after.grantedAt).toBe(before.grantedAt);
    expect(after.changedAt).toBe(NOW + 50);
    expect((await refresh(s.spa, t.refresh_token, NOW + 50)).status).toBe(200);
  });
});

describe("Change what <Client> gets", () => {
  it("a Change within the code's 60 seconds never reaches its id_token or its family", async () => {
    const code = await codeFor(s.spa, {}, ["name", "email"]);
    const g = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    await putClientGrant(
      s.w.db,
      { ...g, claimsGranted: ["name"], claimsDeclined: ["picture", "email"] },
      NOW,
    );
    const res = await token(grantForm(s.spa, code));
    expect(res.status).toBe(200);
    const t = (await res.json()) as Tokens;
    const payload = JSON.parse(
      Buffer.from(t.id_token.split(".")[1]!, "base64url").toString(),
    );
    expect(payload.email).toBeUndefined();
    expect(payload.name).toBeTruthy();
    expect(
      JSON.parse(
        (await s.w.db.first<{ claims_json: string }>(
          "SELECT claims_json FROM identity_refresh_tokens",
        ))!.claims_json,
      ),
    ).toEqual(["name"]);
  });

  it("refresh recomputes the claims and userinfo is live; the families are kept", async () => {
    const t = await signIn();
    const g = (await getClientGrant(
      s.w.db,
      SLUG,
      s.accountId,
      s.spa.clientId,
    ))!;
    await putClientGrant(
      s.w.db,
      { ...g, claimsGranted: ["name"], claimsDeclined: ["picture", "email"] },
      NOW + 5,
    );
    expect(
      ((await (await info(t, NOW + 5)).json()) as Record<string, unknown>)
        .email,
    ).toBeUndefined();
    const next = await refresh(s.spa, t.refresh_token, NOW + 5);
    expect(next.status).toBe(200);
    const body = (await next.json()) as Tokens;
    const payload = JSON.parse(
      Buffer.from(body.id_token.split(".")[1]!, "base64url").toString(),
    );
    expect(payload.email).toBeUndefined();
  });
});

describe("the client", () => {
  it("disabled: families revoked, the grant kept", async () => {
    const t = await signIn();
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "disabled", NOW);
    expect((await refresh(s.spa, t.refresh_token)).status).toBe(401);
    expect(await live()).toBe(0);
    expect(await grants()).toBe(1);
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "active", NOW);
    await refreshRefused(t);
  });

  it("deleted: the grant and the families are deleted", async () => {
    await signIn();
    await signIn(s.web);
    expect(await deleteClient(s.w.db, SLUG, s.spa.clientId)).toBe(true);
    expect(
      await count("identity_client_grants", "client_id = ?", s.spa.clientId),
    ).toBe(0);
    expect(
      await count("identity_refresh_tokens", "client_id = ?", s.spa.clientId),
    ).toBe(0);
    expect(await grants()).toBe(1);
  });
});

describe("the issuer and Identity", () => {
  it("issuer off then on: 404 while off, older families refused after, a new family allowed", async () => {
    const old = await signIn();
    await s.w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect((await refresh(s.spa, old.refresh_token, NOW + 10)).status).toBe(
      401,
    );
    await ingestIdentity(s.w.db, SLUG, { issuer: { enabled: true } }, NOW + 20);
    expect(await err(await refresh(s.spa, old.refresh_token, NOW + 30))).toBe(
      "invalid_grant",
    );
    expect(await grants()).toBe(1);
    const fresh = await issueRefreshFamily(
      s.w.env,
      s.w.db,
      {
        product: SLUG,
        clientId: s.spa.clientId,
        accountId: s.accountId,
        scope: "openid profile email offline_access pkey:entitlements",
        claims: ["name"],
        authTime: NOW,
        redirectUri: s.spa.redirectUris[0]!,
      },
      NOW + 25,
    );
    expect((await refresh(s.spa, fresh.token, NOW + 30)).status).toBe(200);
  });

  it("a family that started at the turn-on is allowed", async () => {
    const t = await signIn();
    expect((await refresh(s.spa, t.refresh_token)).status).toBe(200);
  });

  it("Identity off revokes the product's families and keeps the grants; idempotent, one audit row", async () => {
    const t = await signIn();
    const u = await signIn(s.web);
    await seedOtherProduct(s.accountId);
    const off = parseServices(
      JSON.stringify({ identity: { enabled: false } }),
    ).services;
    const actor = { sub: "op", name: null, email: null };
    for (let i = 0; i < 2; i++)
      await applyServiceTransitions(s.w.env, s.w.db, SLUG, off, actor, NOW + 1);
    await refreshRefused(t);
    expect(await live()).toBe(0);
    expect(await count("identity_client_grants", "product = ?", SLUG)).toBe(2);
    expect(
      await count("audit", "action = 'identity.issuer.refresh_revoked'"),
    ).toBe(1);
    await refreshRefused(u, s.web);
    await otherProductIntact(s.accountId);
  });
});

describe("the account", () => {
  it("a scheduled deletion changes nothing", async () => {
    const t = await signIn();
    await scheduleAccountDeletion(s.w.db, s.accountId, NOW);
    expect(await live()).toBe(1);
    expect(await grants()).toBe(1);
    expect((await refresh(s.spa, t.refresh_token)).status).toBe(200);
  });

  describe("erasure", () => {
    afterEach(() => unregisterSubjectStore("lifecycle-failing"));

    it("closing batch revokes every family and keeps the grants; the commit deletes both; replay is idempotent", async () => {
      s.w.env.BLOBS = asR2(new R2Mock());
      const t = await signIn();
      await signIn(s.web);
      await seedOtherProduct(s.accountId);
      let fail = true;
      registerSubjectStore("lifecycle-failing", {
        merge: async () => ({ skipped: 0 }),
        delete: async () => {
          if (fail) throw new Error("store down");
        },
      });
      const r = await deleteAccount(ctx(), s.accountId);
      expect(r).toEqual({ ok: true, erasing: true });
      // Step 1: closed, families revoked, grants still there for the retry.
      expect(await live()).toBe(0);
      expect(await grants()).toBe(3);
      await refreshRefused(t);
      fail = false;
      const done = await sweepErasures(ctx(NOW + 24 * 3600));
      expect(done.completed).toBe(1);
      // Step 3: every row of the account is gone, whatever the product.
      expect(await grants()).toBe(0);
      expect(
        await count("identity_refresh_tokens", "account_id = ?", s.accountId),
      ).toBe(0);
      // A replay (a D1 restore brought the rows back) ends them again.
      await seedOtherProduct(s.accountId);
      await s.w.db.run(
        "UPDATE identity_refresh_tokens SET revoked_at = NULL WHERE account_id = ?",
        s.accountId,
      );
      expect((await deleteAccount(ctx(NOW + 48 * 3600), s.accountId)).ok).toBe(
        false,
      );
    });
  });

  it("an operator's disable revokes the families and keeps the grants", async () => {
    const t = await signIn();
    expect(await disableAccount(ctx(), s.accountId)).toEqual({ ok: true });
    expect(await live()).toBe(0);
    expect(await grants()).toBe(1);
    await refreshRefused(t);
    // Enabling it again revives nothing: revocation is a column that is never cleared.
    await s.w.db.run(
      "UPDATE accounts SET status = 'active' WHERE id = ?",
      s.accountId,
    );
    expect(await err(await refresh(s.spa, t.refresh_token))).toBe(
      "invalid_grant",
    );
  });

  it("per-product removal deletes the grants and families of that product, not another's", async () => {
    await signIn();
    await seedOtherProduct(s.accountId);
    const r = await removeProductData(ctx(), {
      accountId: s.accountId,
      product: SLUG,
      alsoDetachLicenses: false,
    });
    expect(r.ok).toBe(true);
    expect(await count("identity_client_grants", "product = ?", SLUG)).toBe(0);
    expect(await count("identity_refresh_tokens", "product = ?", SLUG)).toBe(0);
    await otherProductIntact(s.accountId);
  });

  it("a merge deletes the absorbed account's grants and revokes its families; the survivor's stay; undo restores neither", async () => {
    const survivor = await signIn(s.spa);
    const b = await accountSignIn(
      s.w.db,
      { issuerKey: "email", subject: "grace@example.com", kind: "email" },
      NOW,
      { unfenced: true },
    );
    if (b.status !== "signed_in") throw new Error("sign-in");
    const flowB = issuerFlow(() => ({
      w: s.w,
      accountId: b.account.id,
      pair: s.pair,
    }));
    const res = await token(flowB.grantForm(s.spa, await flowB.codeFor(s.spa)));
    expect(res.status).toBe(200);
    const absorbed = (await res.json()) as Tokens;
    const merged = await mergeAccounts(ctx(), {
      survivor: { accountId: s.accountId, authenticatedAt: NOW },
      absorbed: { accountId: b.account.id, authenticatedAt: NOW },
    });
    expect(merged.ok).toBe(true);
    expect(await grants(b.account.id)).toBe(0);
    expect(
      await count("identity_refresh_tokens", "account_id = ?", b.account.id),
    ).toBe(0);
    expect(await err(await refresh(s.spa, absorbed.refresh_token))).toBe(
      "invalid_grant",
    );
    expect((await info(absorbed)).status).toBe(401);
    expect((await refresh(s.spa, survivor.refresh_token)).status).toBe(200);
    expect(await grants()).toBe(1);
  });

  it("product deletion deletes every client, grant and family of the product", async () => {
    await signIn();
    await signIn(s.web);
    await deleteProduct(s.w.db, SLUG, NOW + 5);
    for (const t of [
      "identity_clients",
      "identity_client_grants",
      "identity_refresh_tokens",
    ])
      expect(await count(t, "product = ?", SLUG), t).toBe(0);
  });
});

describe("reuse", () => {
  it("a spent token presented again revokes that family only", async () => {
    const t1 = await signIn();
    const other = await signIn();
    const next = (await (
      await refresh(s.spa, t1.refresh_token)
    ).json()) as Tokens;
    expect(await err(await refresh(s.spa, t1.refresh_token))).toBe(
      "invalid_grant",
    );
    expect(await err(await refresh(s.spa, next.refresh_token))).toBe(
      "invalid_grant",
    );
    expect((await refresh(s.spa, other.refresh_token)).status).toBe(200);
    expect(await grants()).toBe(1);
  });
});
