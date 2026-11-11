/**
 * I-21.15 (V5 §12.13.7; plans/I-34-I-21.15.md §2): what each event does to a person's client grants
 * and refresh families. One describe per row of the lifecycle matrix, and the re-checks the rows rely
 * on: the grant epoch, the issuer epoch and the redeemed code's claims against the grant as it
 * stands. Each row asserts both ends: the token endpoints (`invalid_grant`, `invalid_token`) and the
 * rows that go or stay.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../../../../src/core/accounts/subjectHooks.js";
import { deleteProduct } from "../../../../src/core/products/store.js";
import * as contributions from "../../../../src/core/contributions.js";
import { applyServiceTransitions } from "../../../../src/core/servicesTransitions.js";
import { parseServices } from "../../../../src/core/services.js";
import {
  deleteAccount,
  disableAccount,
  replayErasures,
  sweepErasures,
} from "../../../../src/services/identity/accounts/deletion.js";
import { mergeAccounts } from "../../../../src/services/identity/accounts/merge.js";
import { undoMerge } from "../../../../src/services/identity/accounts/mergeUndo.js";
import { removeProductData } from "../../../../src/services/identity/accounts/productRemoval.js";
import { scheduleAccountDeletion } from "../../../../src/services/identity/accounts/lifecycle.js";
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
import { eraseAndRestore } from "../../../eraseRestore.js";
import { asR2, R2Mock } from "../../../r2Mock.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG } from "../../connect/connectFixture.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerSuite, type IssuerTokens } from "./issuerFlow.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
const { s, codeFor, token, grantForm, err, signIn, signInSecondAccount } =
  issuerSuite("lifecycle-pepper");

type Tokens = IssuerTokens;
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
/** The person narrows what the public client gets: only `name`, the rest declined. */
const narrow = async (at: number) => {
  const g = (await getClientGrant(s.w.db, SLUG, s.accountId, s.spa.clientId))!;
  await putClientGrant(
    s.w.db,
    { ...g, claimsGranted: ["name"], claimsDeclined: ["picture", "email"] },
    at,
  );
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
describe("services listeners and the issuer", () => {
  const set = (enabled: boolean) =>
    parseServices(JSON.stringify({ identity: { enabled } })).services;
  const actor = { sub: "op", name: null, email: null };
  afterEach(() => vi.restoreAllMocks());

  it("a listener that throws does not stop the issuer's: Identity off still revokes the families", async () => {
    const t = await signIn();
    const real = contributions.contributedServicesChangeListeners();
    vi.spyOn(
      contributions,
      "contributedServicesChangeListeners",
    ).mockReturnValue([
      [
        "test.broken",
        async () => {
          throw new TypeError("secret detail that must not be recorded");
        },
      ],
      ...real,
    ]);
    await applyServiceTransitions(
      s.w.env,
      s.w.db,
      SLUG,
      set(false),
      actor,
      NOW + 1,
      {
        before: set(true),
      },
    );
    const rows = await s.w.db.all<{ summary: string; target_id: string }>(
      "SELECT summary, target_id FROM audit WHERE action = 'services.listener.failed'",
    );
    expect(rows).toEqual([
      {
        summary: `A services listener failed for ${SLUG}: test.broken (TypeError)`,
        target_id: SLUG,
      },
    ]);
    expect(await live()).toBe(0);
    await refreshRefused(t);
    expect(await grants()).toBe(1);
  });

  it("a re-enable after a missed off-write revokes the families that are left, even when the restore listener throws", async () => {
    const t = await signIn();
    // The restore listener fails on an off-to-on write; the off-write itself was never applied.
    await s.w.db.run("DROP TABLE identity_restore_keys");
    await applyServiceTransitions(
      s.w.env,
      s.w.db,
      SLUG,
      set(true),
      actor,
      NOW + 5,
      {
        before: set(false),
      },
    );
    expect(await live()).toBe(0);
    await refreshRefused(t);
    expect(await grants()).toBe(1);
  });

  it("an on-to-on write revokes nothing", async () => {
    await signIn();
    await applyServiceTransitions(
      s.w.env,
      s.w.db,
      SLUG,
      set(true),
      actor,
      NOW + 5,
      {
        before: set(true),
      },
    );
    expect(await live()).toBe(1);
  });
});

describe("a family opened after a Disconnect", () => {
  const fields = () => ({
    product: SLUG,
    clientId: s.spa.clientId,
    accountId: s.accountId,
    scope: "openid profile email offline_access pkey:entitlements",
    claims: ["name" as const],
    authTime: NOW,
    redirectUri: s.spa.redirectUris[0]!,
  });

  it("is refused when the grant is gone: nothing is written", async () => {
    await signIn();
    await disconnectClient(s.w.db, SLUG, s.accountId, s.spa.clientId, NOW + 1);
    const before = await count("identity_refresh_tokens");
    expect(
      await issueRefreshFamily(s.w.env, s.w.db, fields(), NOW + 1, {
        requireGrant: true,
      }),
    ).toBeNull();
    expect(await count("identity_refresh_tokens")).toBe(before);
  });

  it("is opened while the grant exists", async () => {
    await signIn();
    const f = await issueRefreshFamily(s.w.env, s.w.db, fields(), NOW + 1, {
      requireGrant: true,
    });
    expect(f?.token).toBeTruthy();
  });

  it("the token endpoint answers invalid_grant when a Disconnect lands between the grant read and the insert", async () => {
    const code = await codeFor(s.spa);
    // The first insert into the families is the one the redemption makes; the grant goes first.
    const real = s.w.db;
    let done = false;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "runChanges")
          return async (sql: string, ...params: never[]) => {
            if (!done && sql.includes("INSERT INTO identity_refresh_tokens")) {
              done = true;
              await disconnectClient(
                target,
                SLUG,
                s.accountId,
                s.spa.clientId,
                NOW,
              );
            }
            return target.runChanges(sql, ...params);
          };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    let res: Response;
    (s.w as { db: unknown }).db = racing;
    try {
      res = await token(grantForm(s.spa, code));
    } finally {
      (s.w as { db: unknown }).db = real;
    }
    expect(done).toBe(true);
    expect(await err(res)).toBe("invalid_grant");
    expect(await count("identity_refresh_tokens")).toBe(0);
  });
});

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
    const second = await signInSecondAccount();
    const theirs = second.tokens;
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
    await narrow(NOW);
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
    await narrow(NOW + 5);
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
    });

    it("a D1 restore that brings the rows back is ended again by the ledger replay", async () => {
      s.w.env.BLOBS = asR2(new R2Mock());
      const t = await signIn();
      await seedOtherProduct(s.accountId);
      await eraseAndRestore(ctx(), s.accountId);
      // The rewound database holds a live account, its grant and its family: nothing yet ended them.
      expect(await grants()).toBe(2);
      expect(await live()).toBe(1);
      await replayErasures(ctx(NOW + 60));
      expect(await grants()).toBe(0);
      expect(
        await count("identity_refresh_tokens", "account_id = ?", s.accountId),
      ).toBe(0);
      await refreshRefused(t);
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
    const second = await signInSecondAccount();
    const absorbed = second.tokens;
    const merged = await mergeAccounts(ctx(), {
      survivor: { accountId: s.accountId, authenticatedAt: NOW },
      absorbed: { accountId: second.accountId, authenticatedAt: NOW },
    });
    expect(merged.ok).toBe(true);
    expect(await grants(second.accountId)).toBe(0);
    expect(
      await count(
        "identity_refresh_tokens",
        "account_id = ?",
        second.accountId,
      ),
    ).toBe(0);
    expect(await err(await refresh(s.spa, absorbed.refresh_token))).toBe(
      "invalid_grant",
    );
    expect((await info(absorbed)).status).toBe(401);
    expect((await refresh(s.spa, survivor.refresh_token)).status).toBe(200);
    expect(await grants()).toBe(1);
    // Undoing the join restores the absorbed account, and neither its grants nor its families.
    const undone = await undoMerge(
      ctx(),
      { accountId: s.accountId, authenticatedAt: NOW },
      merged.ok ? merged.mergeId : "",
    );
    expect(undone.ok).toBe(true);
    expect(await grants(second.accountId)).toBe(0);
    expect(await live(second.accountId)).toBe(0);
    expect(await err(await refresh(s.spa, absorbed.refresh_token))).toBe(
      "invalid_grant",
    );
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
