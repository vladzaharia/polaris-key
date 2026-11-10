/**
 * I-21.4: the manifest's `identity.issuer` and `identity.clients` reach the Worker: the
 * `identity.issuer.enabled` setting (off by default, omit-clears, security-widening), the client
 * upsert by `(product, key)` that keeps the id, and the drop that disables and revokes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ManifestIdentityClient } from "@polaris-key/manifest";
import { makeTestDb } from "../../../helpers.js";
import { KvMock } from "../../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../../seed.js";
import { IDENTITY_ISSUER } from "../../../../src/services/identity/issuer/setting.js";
import { issuerServed } from "../../../../src/services/identity/issuer/served.js";
import {
  createClient,
  getClientByKey,
  listClients,
  setClientStatus,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { issueRefreshFamily } from "../../../../src/services/identity/issuer/refreshRepo.js";
import { ingestIdentity } from "./issuerHelpers.js";

const P = "acme";
let db: ReturnType<typeof makeTestDb>;
beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, P);
  await seedProduct(db, "other");
});

const client = (
  key: string,
  over: Partial<ManifestIdentityClient> = {},
): ManifestIdentityClient => ({
  key,
  name: `Client ${key}`,
  type: "web",
  redirectUris: ["https://c.example.com/cb"],
  postLogoutRedirectUris: [],
  scopes: ["openid", "profile"],
  claimsRequired: [],
  ...over,
});
const declare = (clients: ManifestIdentityClient[], at = NOW) =>
  ingestIdentity(db, P, { issuer: { enabled: true }, clients }, at);

describe("identity.issuer.enabled", () => {
  it("is off by default, on from the manifest, off again when omitted", async () => {
    expect(await issuerServed(db, P)).toBe(false);
    await ingestIdentity(db, P, { issuer: { enabled: true } });
    expect(await issuerServed(db, P)).toBe(true);
    expect(await issuerServed(db, "other")).toBe(false);
    await ingestIdentity(db, P, {}, NOW + 1);
    expect(await issuerServed(db, P)).toBe(false);
  });

  it("is a claimable, critical, security-widening setting named by its manifest path", () => {
    expect(IDENTITY_ISSUER).toMatchObject({
      key: "identity.issuer.enabled",
      defaultValue: false,
      ownership: "claimable",
      securityWidening: true,
      critical: true,
      manifest: { path: "product:identity.issuer.enabled" },
    });
  });

  it("is unserved for an unknown product", async () => {
    expect(await issuerServed(db, "nobody")).toBe(false);
  });
});

describe("identity.clients", () => {
  it("upserts by (product, key), keeps the minted id, and rewrites the declared members", async () => {
    await declare([client("forum", { developerName: "Partner Ltd" })]);
    const first = (await getClientByKey(db, P, "forum"))!;
    expect(first).toMatchObject({
      origin: "manifest",
      status: "active",
      developerName: "Partner Ltd",
      type: "web",
    });
    expect(first.clientId).toMatch(/^cl_[A-Za-z0-9_-]{22}$/);
    await declare(
      [
        client("forum", {
          name: "Forum 2",
          type: "spa",
          redirectUris: ["https://f.example.com/a", "https://f.example.com/b"],
          scopes: ["openid", "email"],
          claimsRequired: ["email"],
        }),
      ],
      NOW + 5,
    );
    const next = (await getClientByKey(db, P, "forum"))!;
    expect(next.clientId).toBe(first.clientId);
    expect(next).toMatchObject({
      name: "Forum 2",
      type: "spa",
      developerName: null,
      claims: { required: ["email"] },
      redirectUris: ["https://f.example.com/a", "https://f.example.com/b"],
      updatedAt: NOW + 5,
      createdAt: NOW,
    });
    expect(await listClients(db, P)).toHaveLength(1);
  });

  it("keeps another product's clients apart", async () => {
    await declare([client("forum")]);
    await ingestIdentity(db, "other", {
      issuer: { enabled: true },
      clients: [client("forum")],
    });
    const a = (await getClientByKey(db, P, "forum"))!;
    const b = (await getClientByKey(db, "other", "forum"))!;
    expect(a.clientId).not.toBe(b.clientId);
  });

  it("disables, never deletes, a client the manifest drops, and revokes its families", async () => {
    await declare([client("forum"), client("blog")]);
    const forum = (await getClientByKey(db, P, "forum"))!;
    const env = makeEnv(new KvMock(), [P]);
    (env as unknown as Record<string, unknown>).KEY_HASH_PEPPER = "pepper";
    const fam = await issueRefreshFamily(
      env,
      db,
      {
        product: P,
        clientId: forum.clientId,
        accountId: "a",
        scope: "openid",
        claims: [],
        authTime: NOW,
      },
      NOW,
    );
    await declare([client("blog")], NOW + 9);
    expect((await getClientByKey(db, P, "forum"))!.status).toBe("disabled");
    expect((await getClientByKey(db, P, "blog"))!.status).toBe("active");
    const row = await db.first<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM identity_refresh_tokens WHERE family_id = ?",
      fam.familyId,
    );
    expect(row!.revoked_at).toBe(NOW + 9);
    // Declaring it again re-enables it, with the same id.
    await declare([client("forum"), client("blog")], NOW + 20);
    const back = (await getClientByKey(db, P, "forum"))!;
    expect(back).toMatchObject({ status: "active", clientId: forum.clientId });
    // No manifest clients at all disables every manifest client.
    await ingestIdentity(db, P, {}, NOW + 30);
    expect((await listClients(db, P)).map((c) => c.status)).toEqual([
      "disabled",
      "disabled",
    ]);
  });

  it("never touches a console client, and never re-enables one an operator disabled", async () => {
    const made = await createClient(
      db,
      {
        product: P,
        key: "console-app",
        origin: "console",
        name: "Console",
        developerName: null,
        type: "spa",
        redirectUris: ["https://x.example.com/cb"],
        postLogoutRedirectUris: [],
        scopes: ["openid"],
        claimsRequired: [],
        iconUrl: null,
      },
      NOW,
    );
    if (!made.ok) throw new Error(made.reason);
    await declare([client("forum")]);
    await declare([], NOW + 1);
    expect((await getClientByKey(db, P, "console-app"))!.status).toBe("active");
    const forum = (await getClientByKey(db, P, "forum"))!;
    await setClientStatus(db, P, forum.clientId, "disabled", NOW + 2);
    await declare([client("forum")], NOW + 3);
    expect((await getClientByKey(db, P, "forum"))!.status).toBe("disabled");
  });

  it("stops at 20 clients per product", async () => {
    await declare(Array.from({ length: 22 }, (_, i) => client(`client-${i}`)));
    expect(await listClients(db, P)).toHaveLength(20);
  });
});
