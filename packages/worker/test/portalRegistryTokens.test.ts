/**
 * Package access in the portal (F-21, plans/F-20.md §6.5, Q3): a licensee mints, lists and
 * revokes licence-bound registry tokens for a linked licence whenever the product has an enabled
 * feed that is not public, and the tokens die with the portal account.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices } from "../src/core/services.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import {
  forgetRegistryTokens,
  lookupRegistryCredential,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import { handlePortalApi } from "./portalHarness.js";
import {
  ACCOUNT_DELETION_GRACE_SECONDS,
  sweepAccountDeletions,
} from "../src/services/identity/accounts/lifecycle.js";

const SLUG = "acme";
let db: Db;
let env: Env;
let auth: { cookie: string; csrf: string; accountId: string };
let licenseId: string;

function req(
  method: string,
  path: string,
  body?: unknown,
  csrf = true,
): Request {
  const headers: Record<string, string> = { cookie: auth.cookie };
  if (csrf) headers[PORTAL_CSRF_HEADER] = auth.csrf;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im/portal${path}`, init);
}

async function call(
  method: string,
  rest = "",
  body?: unknown,
  csrf = true,
): Promise<Response> {
  const path = `/api/licenses/${SLUG}/${licenseId}/registry-tokens${rest}`;
  return handlePortalApi(req(method, path, body, csrf), env, db, path, NOW);
}

/** A licence-bound token as the portal minted them before F-33 (the portal no longer does). */
async function legacyToken(label = "laptop"): Promise<{
  token: string;
  tokenId: string;
}> {
  const res = await mintRegistryToken(
    env,
    db,
    {
      product: SLUG,
      label,
      ecosystems: ["npm"],
      binding: "license",
      licenseId,
      presentation: "header",
      createdBy: `portal:${auth.accountId}`,
      portalAccountId: auth.accountId,
    },
    NOW,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return { token: res.token, tokenId: res.view.tokenId };
}

async function setFeed(mode: string, eco = "npm"): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
     VALUES (?, ?, 1, ?, '{"scope":"@acme"}', 1024, ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET access_mode = excluded.access_mode`,
    SLUG,
    eco,
    mode,
    NOW,
  );
}

beforeEach(async () => {
  forgetRegistryTokens();
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.PKG_ORIGIN = "https://pkg.example.test";
  await seedProduct(db, SLUG);
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: false },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
        commerce: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    SLUG,
    NOW,
  );
  ({ licenseId } = await seedLicenseWithKey(db, SLUG));
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  await linkLicense(db, account.id, SLUG, licenseId, "admin", NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  auth = {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
});

describe("portal package access (Q3)", () => {
  it("is unavailable while every feed is public", async () => {
    await setFeed("public");
    const state = await call("GET");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      available: false,
      feeds: [],
      tokens: [],
      username: "__token__",
    });
  });

  it("no longer mints: the portal answers 410 and points at Account → Packages", async () => {
    await setFeed("licensed");
    const res = await call("POST", "", { label: "laptop", ecosystem: "npm" });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toBe("gone");
    expect(
      await db.first("SELECT 1 FROM registry_tokens WHERE product = ?", SLUG),
    ).toBeNull();
  });

  it("lists tokens minted before F-33 without the secret, and revokes and audits them", async () => {
    await setFeed("licensed");
    const state = (await (await call("GET")).json()) as {
      available: boolean;
      feeds: { ecosystem: string; baseUrl: string }[];
    };
    expect(state.available).toBe(true);
    expect(state.feeds).toEqual([
      {
        ecosystem: "npm",
        accessMode: "licensed",
        baseUrl: "https://pkg.example.test/npm/acme/",
      },
    ]);
    const minted = await legacyToken();
    expect(minted.token).toMatch(/^pkeyr_/);
    const listed = (await (await call("GET")).json()) as {
      tokens: { tokenId: string }[];
    };
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
    const del = await call("DELETE", `/${listed.tokens[0]!.tokenId}`);
    expect(del.status).toBe(200);
    expect((await call("DELETE", "/rtok_nope")).status).toBe(404);
    expect(
      (
        await db.all<{ action: string }>(
          "SELECT action FROM portal_audit WHERE action LIKE 'portal.registry_token.%' ORDER BY at, id",
        )
      ).map((r) => r.action),
    ).toEqual(["portal.registry_token.revoke"]);
  });

  it("answers an unlinked licence 404", async () => {
    await setFeed("authenticated");
    const other = await seedLicenseWithKey(db, SLUG, { id: "lic_other" });
    // Someone else's licence: not auto-linked to this account by email.
    await db.run(
      "UPDATE licenses SET email = 'grace@example.com' WHERE id = 'lic_other'",
    );
    const path = `/api/licenses/${SLUG}/${other.licenseId}/registry-tokens`;
    expect(
      (
        await handlePortalApi(
          req("POST", path, { label: "x" }),
          env,
          db,
          path,
          NOW,
        )
      ).status,
    ).toBe(404);
  });

  it("hard erasure after the grace period revokes every token it minted", async () => {
    await setFeed("licensed");
    const minted = await legacyToken();
    const me = await handlePortalApi(
      new Request("https://key.plrs.im/portal/api/me", {
        method: "DELETE",
        headers: {
          cookie: auth.cookie,
          [PORTAL_CSRF_HEADER]: auth.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: "ada@example.com" }),
      }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(me.status).toBeLessThan(300);
    // I-11: an erasure is recorded on the ledger (R2) before D1 changes.
    env.BLOBS = asR2(new R2Mock());
    await sweepAccountDeletions({
      db,
      env,
      now: NOW + ACCOUNT_DELETION_GRACE_SECONDS,
      origin: "",
    });
    forgetRegistryTokens();
    expect(
      (await lookupRegistryCredential(env, db, minted.token)).resolved,
    ).toBeNull();
    const row = await db.first<{ revoke_reason: string }>(
      "SELECT revoke_reason FROM registry_tokens",
    );
    expect(row?.revoke_reason).toBe("account_deleted");
  });
});
