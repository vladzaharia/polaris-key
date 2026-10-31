// I-17 on the console IdP's issuer: a platform claim leaves a console member's link facts alone.

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { claimPlatformSubject } from "../../../src/services/identity/accounts/platformMigration.js";

const ISSUER = "https://console.idp.example";

function setup() {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.PLATFORM_OIDC_MIGRATION = "claim";
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "platform";
  env.ADMIN_OIDC_ISSUER = ISSUER;
  env.ADMIN_OIDC_CLIENT_ID = "console";
  return { db, env };
}

const row = (db: ReturnType<typeof makeTestDb>) =>
  db.first<{
    groups_json: string | null;
    claims_json: string | null;
    asserted_at: number | null;
    asserted_connection_id: string | null;
  }>(
    "SELECT groups_json, claims_json, asserted_at, asserted_connection_id FROM account_links WHERE subject = 'sub-1'",
  );

const signIn = (
  { db, env }: ReturnType<typeof setup>,
  groups: string[],
  at: number,
) =>
  claimPlatformSubject(
    db,
    env,
    {
      issuer: ISSUER,
      sub: "sub-1",
      email: "una@example.test",
      emailVerified: true,
      groups,
    },
    at,
  );

describe("a platform claim on the console IdP's issuer", () => {
  it("a platform claim leaves a console member's link facts alone", async () => {
    const s = setup();
    expect((await signIn(s, ["a"], NOW)).status).toBe("signed_in");
    await s.db.run(
      `UPDATE account_links SET strong_at = ?, groups_json = '["admins"]', claims_json = NULL,
         asserted_at = ?, asserted_connection_id = 'console-idp' WHERE subject = 'sub-1'`,
      NOW,
      NOW,
    );
    const before = await row(s.db);
    expect((await signIn(s, ["other"], NOW + 60)).status).toBe("signed_in");
    expect(await row(s.db)).toEqual(before);
  });

  it("a link that is not strong keeps the platform claim's write", async () => {
    const s = setup();
    await signIn(s, ["a"], NOW);
    expect(await row(s.db)).toMatchObject({
      groups_json: '["a"]',
      asserted_at: NOW,
      asserted_connection_id: null,
    });
    await signIn(s, ["b"], NOW + 60);
    expect(await row(s.db)).toMatchObject({
      groups_json: '["b"]',
      asserted_at: NOW + 60,
    });
  });
});
