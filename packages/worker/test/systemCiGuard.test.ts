/**
 * SEC-WP-05 (SEC-ADM-1): the system product's trusted publisher and CI tokens are not changeable
 * from the console, by any platform admin. Other products are unchanged.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { CONSOLE, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { ensureSystemProduct } from "../src/console/systemProduct.js";
import { getPublisherPolicy } from "../src/core/publisher.js";

let db: Db;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  await ensureSystemProduct(env, db, "u1", NOW);
  await seedProduct(db, "acme");
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

const CLAIM = {
  repositoryId: 1,
  repositoryOwnerId: 2,
  repository: "evil/repo",
  workflow: ".github/workflows/x.yml",
};
const MINT = { scopes: ["release:publish", "release:yank"], expiresInDays: 90 };

async function auditActions(slug: string): Promise<string[]> {
  const rows = await db.all<{ action: string }>(
    "SELECT action FROM audit WHERE product = ? ORDER BY at, id",
    slug,
  );
  return rows.map((r) => r.action);
}

describe("system product CI guard (SEC-ADM-1)", () => {
  it("refuses a platform admin minting a CI token on the system product, and audits it", async () => {
    const res = await admin(
      "POST",
      `/products/${SYSTEM_PRODUCT_SLUG}/ci-tokens`,
      MINT,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "system_product_manifest_only",
    });
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ci_tokens WHERE product = ?",
      SYSTEM_PRODUCT_SLUG,
    );
    expect(n?.n).toBe(0);
    expect(await auditActions(SYSTEM_PRODUCT_SLUG)).toContain(
      "ci.token.issue.refused",
    );
  });

  it("refuses a platform admin repointing the system product's trusted publisher, and audits it", async () => {
    const res = await admin(
      "PUT",
      `/products/${SYSTEM_PRODUCT_SLUG}/ci-publisher`,
      CLAIM,
    );
    expect(res.status).toBe(403);
    expect(await getPublisherPolicy(db, SYSTEM_PRODUCT_SLUG)).toBeNull();
    expect(await auditActions(SYSTEM_PRODUCT_SLUG)).toContain(
      "ci.publisher.claim.refused",
    );
  });

  it("still lets an admin read the policy and the tokens of the system product", async () => {
    const base = `/products/${SYSTEM_PRODUCT_SLUG}`;
    expect((await admin("GET", `${base}/ci-publisher`)).status).toBe(200);
    expect((await admin("GET", `${base}/ci-tokens`)).status).toBe(200);
  });

  it("leaves other products unchanged: claim, mint and revoke still work", async () => {
    const put = await admin("PUT", "/products/acme/ci-publisher", CLAIM);
    expect(put.status).toBe(200);
    const mint = await admin("POST", "/products/acme/ci-tokens", MINT);
    expect(mint.status).toBe(201);
    const { tokenId } = (await mint.json()) as { tokenId: string };
    expect(
      (await admin("DELETE", `/products/acme/ci-tokens/${tokenId}`)).status,
    ).toBe(200);
    expect(await auditActions("acme")).toEqual(
      expect.arrayContaining(["ci.publisher.claim", "ci.token.issue"]),
    );
  });
});
