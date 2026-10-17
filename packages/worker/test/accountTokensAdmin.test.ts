/**
 * The Superadmin's roster of personal tokens (F-33): list, revoke, audit, and who may call it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  PACKAGES_READ_SCOPE,
  mintAccountToken,
  resolvePersonalToken,
} from "../src/core/accounts/personalTokens.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";

let db: Db;
let env: Env;
let ada: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface JsonResponse extends Response {
  json(): Promise<Loose>;
}

async function admin(
  method: string,
  path: string,
  groups = ["platform-admins"],
): Promise<JsonResponse> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Root", email: "root@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  return (await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
      },
    }),
    env,
    db,
    full,
    { now: NOW },
  )) as JsonResponse;
}

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  ada = (await getOrCreateAccountByEmail(db, "ada@example.com", NOW)).id;
});

async function mint(label: string) {
  const res = await mintAccountToken(
    env,
    db,
    { accountId: ada, label, scope: PACKAGES_READ_SCOPE, createdBy: "x" },
    NOW,
  );
  if (!res.ok) throw new Error("mint");
  return res;
}

describe("account tokens roster (Superadmin)", () => {
  it("lists every account's tokens with whose they are, and never a secret", async () => {
    const t = await mint("laptop");
    const res = await admin("GET", "/account-tokens");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({
      id: t.view.id,
      label: "laptop",
      email: "ada@example.com",
      status: "active",
    });
    expect(JSON.stringify(body)).not.toContain(t.token);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("revokes at once, audits without the token, and a second revoke writes no second row", async () => {
    const t = await mint("laptop");
    const res = await admin("DELETE", `/account-tokens/${t.view.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toMatchObject({
      status: "revoked",
      revokeReason: "admin",
      revokedBy: "admin",
    });
    expect(
      await resolvePersonalToken(env, db, t.token, PACKAGES_READ_SCOPE, NOW),
    ).toBeNull();
    await admin("DELETE", `/account-tokens/${t.view.id}`);
    const rows = await db.all<{ summary: string; detail: string | null }>(
      "SELECT * FROM platform_audit WHERE action = 'account_token.revoke'",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(t.token);
    expect(rows[0]!.summary).toContain("laptop");
  });

  it("404s an unknown id, and refuses a member without the Platform area", async () => {
    expect((await admin("DELETE", "/account-tokens/nope")).status).toBe(404);
    const t = await mint("laptop");
    const denied = await admin("GET", "/account-tokens", ["nobody"]);
    expect([401, 403]).toContain(denied.status);
    const del = await admin("DELETE", `/account-tokens/${t.view.id}`, [
      "nobody",
    ]);
    expect([401, 403]).toContain(del.status);
    expect(
      await resolvePersonalToken(env, db, t.token, PACKAGES_READ_SCOPE, NOW),
    ).not.toBeNull();
  });
});
