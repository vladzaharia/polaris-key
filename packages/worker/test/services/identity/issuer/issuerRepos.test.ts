/**
 * I-21.2: the issuer's repositories (clients, secrets, grants, refresh tokens): the caps inside
 * the insert, product scoping, shown-once secrets, rotation and reuse, and the purge.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ISSUER_REFRESH_IDLE_SECONDS,
  ISSUER_REFRESH_MAX_SECONDS,
  MAX_CLIENT_SECRETS,
  MAX_ISSUER_CLIENTS,
  MAX_REFRESH_FAMILIES,
} from "@polaris-key/protocol/identity";
import {
  addClientSecret,
  createClient,
  deleteClient,
  getActiveClient,
  getClient,
  listClientSecrets,
  listClients,
  revokeClientSecret,
  setClientStatus,
  updateClient,
  verifyClientSecret,
  type NewClient,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import {
  disconnectClient,
  getClientGrant,
  listAccountGrants,
  putClientGrant,
  touchClientGrant,
} from "../../../../src/services/identity/issuer/grantsRepo.js";
import {
  findRefreshToken,
  issueRefreshFamily,
  purgeRefreshTokens,
  revokeClientRefresh,
  revokeProductRefresh,
  rotateRefreshToken,
} from "../../../../src/services/identity/issuer/refreshRepo.js";
import { makeEnv, seedProduct, NOW } from "../../../seed.js";
import { KvMock } from "../../../kvMock.js";
import { makeTestDb } from "../../../helpers.js";

const P = "acme";
let db: ReturnType<typeof makeTestDb>;
let env: ReturnType<typeof makeEnv>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  (env as unknown as Record<string, unknown>).KEY_HASH_PEPPER = "pepper";
  await seedProduct(db, P);
});

const base = (key: string, over: Partial<NewClient> = {}): NewClient => ({
  product: P,
  key,
  origin: "console",
  name: "Web app",
  developerName: null,
  type: "web",
  redirectUris: ["https://app.example.com/cb"],
  postLogoutRedirectUris: [],
  scopes: ["openid", "profile"],
  claimsRequired: [],
  iconUrl: null,
  ...over,
});
const mk = async (key: string, over: Partial<NewClient> = {}) => {
  const r = await createClient(db, base(key, over), NOW);
  if (!r.ok) throw new Error(r.reason);
  return r.client;
};

describe("clients", () => {
  it("mints a cl_ id, round-trips members, and scopes reads by product", async () => {
    const c = await mk("web-app", { claimsRequired: ["name"] });
    expect(c.clientId).toMatch(/^cl_[A-Za-z0-9_-]{22}$/);
    expect(c).toMatchObject({
      key: "web-app",
      status: "active",
      claims: { required: ["name"] },
      redirectUris: ["https://app.example.com/cb"],
    });
    expect(await getClient(db, "other", c.clientId)).toBeNull();
    expect((await listClients(db, P)).map((x) => x.key)).toEqual(["web-app"]);
  });

  it("refuses a duplicate key, and a 21st client", async () => {
    await mk("one");
    expect(await createClient(db, base("one"), NOW)).toEqual({
      ok: false,
      reason: "key_exists",
    });
    for (let i = 1; i < MAX_ISSUER_CLIENTS; i++) await mk(`c${i}x`);
    expect(await createClient(db, base("overflow"), NOW)).toEqual({
      ok: false,
      reason: "limit",
    });
  });

  it("updates and disables; a disabled client is not active and loses its families", async () => {
    const c = await mk("web-app");
    expect(
      await updateClient(db, P, c.clientId, { name: "Renamed" }, NOW + 1),
    ).toBe(true);
    expect((await getClient(db, P, c.clientId))!.name).toBe("Renamed");
    expect(
      await updateClient(db, "other", c.clientId, { name: "x" }, NOW),
    ).toBe(false);
    const { token } = await issueRefreshFamily(
      env,
      db,
      fields(c.clientId),
      NOW,
    );
    await setClientStatus(db, P, c.clientId, "disabled", NOW + 2);
    expect(await getActiveClient(db, P, c.clientId)).toBeNull();
    expect((await findRefreshToken(env, db, P, token))!.revokedAt).toBe(
      NOW + 2,
    );
  });

  it("deletes a client with its secrets, grants and tokens", async () => {
    const c = await mk("web-app");
    await addClientSecret(env, db, P, c.clientId, NOW);
    await putClientGrant(db, grant(c.clientId), NOW);
    await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    expect(await deleteClient(db, P, c.clientId)).toBe(true);
    for (const t of [
      "identity_clients",
      "identity_client_secrets",
      "identity_client_grants",
      "identity_refresh_tokens",
    ])
      expect(await db.first(`SELECT 1 FROM ${t}`)).toBeNull();
    expect(await deleteClient(db, P, c.clientId)).toBe(false);
  });
});

describe("secrets", () => {
  it("shows the secret once, stores only a hash, and caps live secrets at 2", async () => {
    const c = await mk("web-app");
    const a = (await addClientSecret(env, db, P, c.clientId, NOW))!;
    expect(a.secret).toMatch(/^pkeycs_[A-Za-z0-9_-]{43}$/);
    expect(a.last4).toBe(a.secret.slice(-4));
    const stored = JSON.stringify(
      await db.all("SELECT * FROM identity_client_secrets"),
    );
    expect(stored).not.toContain(a.secret);
    const b = (await addClientSecret(env, db, P, c.clientId, NOW))!;
    expect(MAX_CLIENT_SECRETS).toBe(2);
    expect(await addClientSecret(env, db, P, c.clientId, NOW)).toBeNull();
    expect(await revokeClientSecret(db, P, c.clientId, a.id, NOW)).toBe(true);
    expect(await addClientSecret(env, db, P, c.clientId, NOW)).not.toBeNull();
    expect(
      (await listClientSecrets(db, P, c.clientId)).map((s) => s.id),
    ).toContain(b.id);
    expect(
      JSON.stringify(await listClientSecrets(db, P, c.clientId)),
    ).not.toMatch(/hash/i);
  });

  it("verifies a live secret, stamps last_used, and refuses wrong, revoked and other-client secrets", async () => {
    const c = await mk("web-app");
    const d = await mk("second");
    const s = (await addClientSecret(env, db, P, c.clientId, NOW))!;
    expect(
      await verifyClientSecret(env, db, P, c.clientId, s.secret, NOW + 9),
    ).toBe(true);
    expect((await listClientSecrets(db, P, c.clientId))[0]!.lastUsedAt).toBe(
      NOW + 9,
    );
    expect(
      await verifyClientSecret(env, db, P, c.clientId, s.secret + "x", NOW),
    ).toBe(false);
    expect(
      await verifyClientSecret(env, db, P, d.clientId, s.secret, NOW),
    ).toBe(false);
    expect(
      await verifyClientSecret(env, db, "other", c.clientId, s.secret, NOW),
    ).toBe(false);
    await revokeClientSecret(db, P, c.clientId, s.id, NOW);
    expect(
      await verifyClientSecret(env, db, P, c.clientId, s.secret, NOW),
    ).toBe(false);
  });

  it("public clients hold none, and a disabled client's secret stops verifying", async () => {
    const spa = await mk("spa-app", { type: "spa" });
    expect(await addClientSecret(env, db, P, spa.clientId, NOW)).toBeNull();
    const c = await mk("web-app");
    const s = (await addClientSecret(env, db, P, c.clientId, NOW))!;
    await setClientStatus(db, P, c.clientId, "disabled", NOW);
    expect(
      await verifyClientSecret(env, db, P, c.clientId, s.secret, NOW),
    ).toBe(false);
  });
});

const fields = (clientId: string, accountId = "acc_1") => ({
  product: P,
  clientId,
  accountId,
  scope: "openid offline_access",
  claims: ["name"],
  authTime: NOW,
});
const grant = (clientId: string, accountId = "acc_1") => ({
  accountId,
  clientId,
  product: P,
  claimsGranted: ["name" as const],
  claimsDeclined: ["email" as const],
  scopes: ["offline_access"],
  scopeHash: "h1",
});

describe("grants", () => {
  it("keeps granted_at across a change, and Disconnect deletes the grant and the families", async () => {
    const c = await mk("web-app");
    await putClientGrant(db, grant(c.clientId), NOW);
    await putClientGrant(
      db,
      { ...grant(c.clientId), scopeHash: "h2" },
      NOW + 50,
    );
    const g = (await getClientGrant(db, P, "acc_1", c.clientId))!;
    expect(g).toMatchObject({
      scopeHash: "h2",
      grantedAt: NOW,
      changedAt: NOW + 50,
      claimsDeclined: ["email"],
    });
    expect(await listAccountGrants(db, P, "acc_1")).toHaveLength(1);
    await touchClientGrant(db, P, "acc_1", c.clientId, NOW + 55);
    expect((await getClientGrant(db, P, "acc_1", c.clientId))!.lastUsedAt).toBe(
      NOW + 55,
    );
    const { token } = await issueRefreshFamily(
      env,
      db,
      fields(c.clientId),
      NOW,
    );
    expect(await disconnectClient(db, P, "acc_1", c.clientId, NOW + 60)).toBe(
      true,
    );
    expect(await getClientGrant(db, P, "acc_1", c.clientId)).toBeNull();
    expect((await findRefreshToken(env, db, P, token))!.revokedAt).toBe(
      NOW + 60,
    );
    expect(await disconnectClient(db, P, "acc_1", c.clientId, NOW)).toBe(false);
  });
});

describe("refresh tokens", () => {
  it("stores only a hash and rotates: the old token is spent, the new one carries the family", async () => {
    const c = await mk("web-app");
    const f = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    expect(f.token).toMatch(/^pkeyo_[A-Za-z0-9_-]{43}$/);
    expect(
      JSON.stringify(await db.all("SELECT * FROM identity_refresh_tokens")),
    ).not.toContain(f.token);
    const r = await rotateRefreshToken(
      env,
      db,
      { product: P, clientId: c.clientId, token: f.token },
      NOW + 100,
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.token).not.toBe(f.token);
    expect(r.row).toMatchObject({
      familyId: f.familyId,
      authTime: NOW,
      familyStartedAt: NOW,
    });
    expect((await findRefreshToken(env, db, P, f.token))!.spentAt).toBe(
      NOW + 100,
    );
    expect((await findRefreshToken(env, db, P, r.token))!.lastUsedAt).toBe(
      NOW + 100,
    );
  });

  it("a spent token presented again is reuse and revokes the whole family", async () => {
    const c = await mk("web-app");
    const f = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    const r1 = await rotateRefreshToken(
      env,
      db,
      { product: P, clientId: c.clientId, token: f.token },
      NOW + 1,
    );
    if (!r1.ok) throw new Error("x");
    const again = await rotateRefreshToken(
      env,
      db,
      { product: P, clientId: c.clientId, token: f.token },
      NOW + 2,
    );
    expect(again).toMatchObject({
      ok: false,
      reason: "reuse",
      familyId: f.familyId,
      accountId: "acc_1",
    });
    // The new token of the family is dead too, with no grace.
    expect(
      await rotateRefreshToken(
        env,
        db,
        { product: P, clientId: c.clientId, token: r1.token },
        NOW + 3,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses unknown, other-client, other-product and ended tokens without spending", async () => {
    const c = await mk("web-app");
    const d = await mk("second");
    const f = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    const rot = (clientId: string, token: string, now: number, product = P) =>
      rotateRefreshToken(env, db, { product, clientId, token }, now);
    expect(await rot(c.clientId, "pkeyo_" + "A".repeat(43), NOW)).toMatchObject(
      { reason: "invalid" },
    );
    expect(await rot(d.clientId, f.token, NOW)).toMatchObject({
      reason: "wrong_client",
    });
    expect(await rot(c.clientId, f.token, NOW, "other")).toMatchObject({
      reason: "invalid",
    });
    expect(
      await rot(c.clientId, f.token, NOW + ISSUER_REFRESH_IDLE_SECONDS),
    ).toMatchObject({ reason: "expired" });
    expect((await findRefreshToken(env, db, P, f.token))!.spentAt).toBeNull();
  });

  it("ends a family 90 days after it opened however it is used", async () => {
    const c = await mk("web-app");
    let token = (await issueRefreshFamily(env, db, fields(c.clientId), NOW))
      .token;
    let now = NOW;
    while (now + 25 * 86_400 < NOW + ISSUER_REFRESH_MAX_SECONDS) {
      now += 25 * 86_400;
      const r = await rotateRefreshToken(
        env,
        db,
        { product: P, clientId: c.clientId, token },
        now,
      );
      if (!r.ok) throw new Error(r.reason);
      token = r.token;
    }
    const last = await rotateRefreshToken(
      env,
      db,
      { product: P, clientId: c.clientId, token },
      NOW + ISSUER_REFRESH_MAX_SECONDS,
    );
    expect(last).toMatchObject({ ok: false, reason: "expired" });
  });

  it("narrows the scope on rotation", async () => {
    const c = await mk("web-app");
    const f = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    const r = await rotateRefreshToken(
      env,
      db,
      { product: P, clientId: c.clientId, token: f.token, scope: "openid" },
      NOW + 1,
    );
    expect(r.ok && r.row.scope).toBe("openid");
  });

  it("caps live families at 10 per account and client, revoking the oldest", async () => {
    const c = await mk("web-app");
    const tokens: string[] = [];
    for (let i = 0; i < MAX_REFRESH_FAMILIES + 1; i++)
      tokens.push(
        (await issueRefreshFamily(env, db, fields(c.clientId), NOW + i)).token,
      );
    expect(
      (await findRefreshToken(env, db, P, tokens[0]!))!.revokedAt,
    ).not.toBeNull();
    for (const t of tokens.slice(1))
      expect((await findRefreshToken(env, db, P, t))!.revokedAt).toBeNull();
    // Another account's families are separate.
    await issueRefreshFamily(env, db, fields(c.clientId, "acc_2"), NOW);
    expect(
      (await findRefreshToken(env, db, P, tokens[1]!))!.revokedAt,
    ).toBeNull();
  });

  it("revokes one client's families and leaves another client's", async () => {
    const c = await mk("web-app");
    const d = await mk("second");
    const a = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    const b = await issueRefreshFamily(env, db, fields(d.clientId), NOW);
    expect(await revokeClientRefresh(db, P, c.clientId, NOW + 1)).toBe(1);
    expect((await findRefreshToken(env, db, P, a.token))!.revokedAt).toBe(
      NOW + 1,
    );
    expect((await findRefreshToken(env, db, P, b.token))!.revokedAt).toBeNull();
  });

  it("revokes a whole product, and purges rows 30 days after the family ended", async () => {
    const c = await mk("web-app");
    const f = await issueRefreshFamily(env, db, fields(c.clientId), NOW);
    const live = await issueRefreshFamily(
      env,
      db,
      fields(c.clientId, "acc_2"),
      NOW + 5 * 86_400,
    );
    expect(await revokeProductRefresh(db, P, NOW + 10)).toBe(2);
    expect(await purgeRefreshTokens(db, P, NOW + 10 + 30 * 86_400 - 1)).toBe(0);
    expect(await purgeRefreshTokens(db, P, NOW + 10 + 30 * 86_400)).toBe(2);
    expect(await findRefreshToken(env, db, P, f.token)).toBeNull();
    expect(await findRefreshToken(env, db, P, live.token)).toBeNull();
  });
});
