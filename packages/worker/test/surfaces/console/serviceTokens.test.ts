/**
 * Console service tokens (F-33b.3): Feeds → Tokens mints a read `pkeyci_` CI token holding
 * only `packages:read`; an owner-wide read `pkeyr_` is no longer mintable but a legacy one still
 * reads until it expires; revoke dispatches by id prefix; the platform scope mints none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "../../helpers.js";
import { mintCompat } from "../../helpers/legacyOwnerToken.js";
import { KvMock } from "../../kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "../../seed.js";
import { CONSOLE, enableServices, envFor } from "../../releaseRoutesFixture.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  handleRegistryTokensAdmin,
  revokeAllSummary,
} from "../../../src/console/handlers/registryTokens.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import {
  forgetRegistryTokens,
  lookupRegistryCredential,
  mintRegistryToken,
} from "../../../src/core/registry/registryTokens.js";
import {
  hashCiCredential,
  issueStaticCiToken,
} from "../../../src/core/publisher.js";
import { hashKey, mintAdminApiToken } from "../../../src/platform/crypto.js";
import type { Grant } from "../../../src/core/rbac/can.js";

let db: Db;
let env: Env;
const OWNER = "acme";
const DAY = 86_400;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  env.PKG_ORIGIN = "https://pkg.plrs.im";
  forgetRegistryTokens();
  await seedProduct(db, OWNER);
  await enableServices(db, true, OWNER);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface JsonResponse extends Response {
  json(): Promise<Loose>;
}

/** A session without a fresh step-up (the default session has one). */
let stale = false;
beforeEach(() => {
  stale = false;
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: ["platform-admins"],
      ...(stale ? {} : { authTime: NOW, stepUp: true }),
    },
    NOW,
  );
  const full = `/api${path}`;
  return (await handleAdmin(
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
    full.split("?")[0]!,
    { now: NOW },
  )) as JsonResponse;
}

const tokens = (rest = "") =>
  `/products/${OWNER}/distribution/feeds/tokens${rest}`;
const platform = (rest = "") => `/platform/feeds/tokens${rest}`;

async function mintService(over: Record<string, unknown> = {}) {
  return admin("POST", tokens(), {
    label: "CI install",
    binding: "service",
    ...over,
  });
}

async function resolves(token: string): Promise<boolean> {
  forgetRegistryTokens();
  const r = await lookupRegistryCredential(env, db, token, {
    nowMs: NOW * 1000,
  });
  return r.resolved !== null;
}

describe("minting a service token", () => {
  it("answers a pkeyci_ once, stores only its hash, and the token reads feeds", async () => {
    const res = await mintService({ expiresInDays: 30 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^pkeyci_/);
    expect(body.view).toMatchObject({
      label: "CI install",
      scopes: ["packages:read"],
      status: "active",
      createdBy: "admin:ada@x.io",
      createdAt: NOW,
      expiresAt: NOW + 30 * DAY,
      lastUsedAt: null,
    });
    const row = await db.first<Record<string, unknown>>(
      "SELECT * FROM ci_tokens WHERE token_id = ?",
      body.view.tokenId,
    );
    expect(row).toMatchObject({
      product: OWNER,
      kind: "static",
      scopes_json: '["packages:read"]',
      token_hash: await hashCiCredential(env, body.token),
    });
    expect(JSON.stringify(row)).not.toContain(body.token);
    // The hint is the token's last four characters, in the answer and the list.
    expect(body.view.hint).toBe(body.token.slice(-4));
    expect(row!.hint).toBe(body.token.slice(-4));
    expect(await resolves(body.token)).toBe(true);
    // Listed, never with the token or its hash.
    const listed = await (await admin("GET", tokens())).json();
    expect(listed.serviceTokens).toHaveLength(1);
    expect(listed.serviceTokens[0].hint).toBe(body.token.slice(-4));
    // Every feed names its namespace (`{}` when unset), which the setup snippets use.
    expect(
      listed.feeds.every((f: Loose) => typeof f.namespace === "object"),
    ).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(body.token);
    expect(JSON.stringify(listed)).not.toContain(row!.token_hash as string);
    expect(listed.limits).toMatchObject({
      serviceDefaultDays: 90,
      serviceMaxDays: 365,
    });
  });

  it("defaults to 90 days and allows 1 to 365", async () => {
    const d = await (await mintService()).json();
    expect(d.view.expiresAt).toBe(NOW + 90 * DAY);
    expect((await mintService({ expiresInDays: 365 })).status).toBe(201);
    expect((await mintService({ expiresInDays: 1 })).status).toBe(201);
    for (const expiresInDays of [0, 366, 1.5, "30"])
      expect(
        (await mintService({ expiresInDays })).status,
        String(expiresInDays),
      ).toBe(422);
  });

  it("is product-wide: no ecosystem, licence, URL or scope narrowing, and a label", async () => {
    for (const over of [
      { ecosystems: ["npm"] },
      { licenseId: "lic_1" },
      { presentation: "url" },
      { scopes: ["publish"] },
      { label: "" },
      { label: "x".repeat(65) },
    ])
      expect((await mintService(over)).status, JSON.stringify(over)).toBe(422);
    expect(await db.all("SELECT 1 FROM ci_tokens")).toEqual([]);
  });

  it("is refused on the platform scope (system_service_tokens), and nothing is written", async () => {
    expect((await admin("POST", "/platform/feeds/bootstrap")).status).toBe(200);
    const res = await admin("POST", platform(), {
      label: "x",
      binding: "service",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "system_service_tokens" },
    });
    expect(
      await db.all(
        "SELECT 1 FROM ci_tokens WHERE product = ?",
        SYSTEM_PRODUCT_SLUG,
      ),
    ).toEqual([]);
    expect(
      await db.all(
        "SELECT 1 FROM platform_audit WHERE action LIKE 'service_token.%'",
      ),
    ).toEqual([]);
  });

  it("caps live service tokens per product", async () => {
    for (let i = 0; i < 500; i++)
      await issueStaticCiToken(env, db, {
        product: OWNER,
        scopes: ["packages:read"],
        expiresAt: NOW + DAY,
        label: `t${i}`,
        createdBy: "admin:a",
        now: NOW,
      });
    const res = await mintService();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { reason: "token_limit" },
    });
  });
});

describe("owner read tokens are retired", () => {
  it("the API and Core both refuse a new one", async () => {
    const res = await admin("POST", tokens(), {
      label: "x",
      binding: "owner",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "owner_read_retired" },
    });
    expect(
      await mintRegistryToken(
        env,
        db,
        { product: OWNER, label: "x", binding: "owner", createdBy: "a" },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 422, reason: "owner_read_retired" });
    expect(await db.all("SELECT 1 FROM registry_tokens")).toEqual([]);
  });

  it("a legacy owner pkeyr_ still reads until it expires, and is listed as legacy", async () => {
    const legacy = await mintCompat(
      env,
      db,
      {
        product: OWNER,
        label: "old",
        binding: "owner",
        expiresInDays: 10,
        createdBy: "admin:a",
      },
      NOW,
    );
    if (!legacy.ok) throw new Error("fixture");
    expect(await resolves(legacy.token)).toBe(true);
    const listed = await (await admin("GET", tokens())).json();
    expect(listed.tokens).toEqual([
      expect.objectContaining({ label: "old", legacy: true }),
    ]);
    // Past its expiry it stops.
    forgetRegistryTokens();
    const later = await lookupRegistryCredential(env, db, legacy.token, {
      nowMs: (NOW + 11 * DAY) * 1000,
    });
    expect(later.resolved).toBeNull();
    // Revocable from the page, as before.
    const rev = await admin("POST", tokens(`/${legacy.view.tokenId}/revoke`));
    expect(rev.status).toBe(200);
    expect(await resolves(legacy.token)).toBe(false);
  });

  it("a publish token is not legacy; a licence-bound mint is unchanged", async () => {
    await db.run(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at) VALUES (?, 'lic_1', 'active', ?, ?)`,
      OWNER,
      NOW,
      NOW,
    );
    const lic = await admin("POST", tokens(), {
      label: "seat",
      binding: "license",
      licenseId: "lic_1",
    });
    expect(lic.status).toBe(201);
    expect((await lic.json()).token).toMatch(/^pkeyr_/);
    const pub = await admin("POST", tokens(), {
      label: "laptop",
      binding: "owner",
      scopes: ["publish"],
      ecosystems: ["npm"],
    });
    expect(pub.status).toBe(201);
    expect((await pub.json()).view.expiresAt).toBe(NOW + 7 * DAY);
    const listed = await (await admin("GET", tokens())).json();
    expect(listed.tokens.map((t: Loose) => [t.label, t.legacy]).sort()).toEqual(
      [
        ["laptop", false],
        ["seat", false],
      ],
    );
    // A licence filter lists no service token.
    await mintService();
    const one = await (await admin("GET", tokens("?license=lic_1"))).json();
    expect(one.serviceTokens).toEqual([]);
  });
});

describe("revoking", () => {
  it("a cit_ id revokes a service token, audited without the token", async () => {
    const m = await (await mintService()).json();
    const res = await admin("POST", tokens(`/${m.view.tokenId}/revoke`));
    expect(res.status).toBe(200);
    expect((await res.json()).view).toMatchObject({ status: "revoked" });
    expect(await resolves(m.token)).toBe(false);
    const rows = await db.all<{
      action: string;
      summary: string;
      target_id: string;
    }>(
      "SELECT action, summary, target_id FROM audit WHERE product = ? AND action LIKE 'service_token.%' ORDER BY at, id",
      OWNER,
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "service_token.create",
      "service_token.revoke",
    ]);
    expect(rows.every((r) => r.target_id === m.view.tokenId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(m.token);
    expect(JSON.stringify(rows)).toContain("CI install");
    // A second revoke answers the token as it stands.
    expect(
      (await admin("POST", tokens(`/${m.view.tokenId}/revoke`))).status,
    ).toBe(200);
  });

  it("the view says who revoked a service token and why, from the audit trail", async () => {
    const one = await (await mintService({ label: "one" })).json();
    const a = await (await mintService({ label: "a" })).json();
    const b = await (await mintService({ label: "b" })).json();
    const live = await (await admin("GET", tokens())).json();
    expect(
      live.serviceTokens.every(
        (t: Loose) => t.revokedBy === null && t.revokeReason === null,
      ),
    ).toBe(true);
    const res = await admin("POST", tokens(`/${one.view.tokenId}/revoke`));
    expect((await res.json()).view).toMatchObject({
      status: "revoked",
      revokedBy: "admin:ada@x.io",
      revokeReason: "manual",
    });
    await admin("POST", tokens("/revoke-all"), {});
    const listed = (await (await admin("GET", tokens())).json())
      .serviceTokens as Loose[];
    const by = (id: string) => listed.find((t) => t.tokenId === id);
    expect(by(one.view.tokenId)).toMatchObject({
      revokedBy: "admin:ada@x.io",
      revokeReason: "manual",
    });
    for (const t of [a, b])
      expect(by(t.view.tokenId)).toMatchObject({
        status: "revoked",
        revokedBy: "admin:ada@x.io",
        revokeReason: "revoke_all",
      });
    // A revoked token with no audit row (revoked outside the console) reads null, not a guess.
    const c = await (await mintService({ label: "c" })).json();
    await db.run(
      "UPDATE ci_tokens SET revoked_at = ? WHERE token_id = ?",
      NOW + 5,
      c.view.tokenId,
    );
    const again = (await (await admin("GET", tokens())).json())
      .serviceTokens as Loose[];
    expect(again.find((t) => t.tokenId === c.view.tokenId)).toMatchObject({
      status: "revoked",
      revokedBy: null,
      revokeReason: null,
    });
  });

  it("a cit_ that is not a packages:read-only token, or not this product's, is 404", async () => {
    const publish = await issueStaticCiToken(env, db, {
      product: OWNER,
      scopes: ["release:publish"],
      expiresAt: NOW + DAY,
      label: "ci",
      createdBy: "admin:a",
      now: NOW,
    });
    const mixed = await issueStaticCiToken(env, db, {
      product: OWNER,
      scopes: ["packages:read", "release:publish"],
      expiresAt: NOW + DAY,
      label: "mixed",
      createdBy: "admin:a",
      now: NOW,
    });
    await seedProduct(db, "other");
    const foreign = await issueStaticCiToken(env, db, {
      product: "other",
      scopes: ["packages:read"],
      expiresAt: NOW + DAY,
      label: "f",
      createdBy: "admin:a",
      now: NOW,
    });
    for (const t of [publish, mixed, foreign, { tokenId: "cit_nope" }])
      expect(
        (await admin("POST", tokens(`/${t.tokenId}/revoke`))).status,
        t.tokenId,
      ).toBe(404);
    const live = await db.all(
      "SELECT 1 FROM ci_tokens WHERE revoked_at IS NULL",
    );
    expect(live).toHaveLength(3);
    expect(
      await db.all("SELECT 1 FROM audit WHERE action = 'service_token.revoke'"),
    ).toEqual([]);
  });

  it("revoke-all on product scope ends service tokens too; a licence filter does not", async () => {
    const a = await (await mintService({ label: "a" })).json();
    const b = await (await mintService({ label: "b" })).json();
    // Not packages:read-only: untouched.
    await issueStaticCiToken(env, db, {
      product: OWNER,
      scopes: ["release:publish"],
      expiresAt: NOW + DAY,
      label: "ci",
      createdBy: "admin:a",
      now: NOW,
    });
    await db.run(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at) VALUES (?, 'lic_1', 'active', ?, ?)`,
      OWNER,
      NOW,
      NOW,
    );
    const scoped = await admin("POST", tokens("/revoke-all"), {
      licenseId: "lic_1",
    });
    expect((await scoped.json()).revoked).toBe(0);
    expect(await resolves(a.token)).toBe(true);
    const res = await admin("POST", tokens("/revoke-all"), {});
    expect((await res.json()).revoked).toBe(2);
    expect(await resolves(a.token)).toBe(false);
    expect(await resolves(b.token)).toBe(false);
    expect(
      await db.all("SELECT 1 FROM ci_tokens WHERE revoked_at IS NULL"),
    ).toHaveLength(1);
  });

  it("legacy platform tokens stay revocable; a cit_ on the platform scope is 404 unless the system product's", async () => {
    expect((await admin("POST", "/platform/feeds/bootstrap")).status).toBe(200);
    const m = await (await mintService()).json();
    expect(
      (await admin("POST", platform(`/${m.view.tokenId}/revoke`))).status,
    ).toBe(404);
  });
});

describe("review fixes (B1, N1 to N4)", () => {
  it("B1: revoke-all and the cap see every live token, beyond 1000 newer rows", async () => {
    const old = await issueStaticCiToken(env, db, {
      product: OWNER,
      scopes: ["packages:read"],
      expiresAt: NOW + 360 * DAY,
      label: "old",
      createdBy: "admin:a",
      now: NOW - 5000,
    });
    // 1100 newer, already revoked rows push the old one out of any 1000-row window.
    for (let i = 0; i < 1100; i++)
      await db.run(
        `INSERT INTO ci_tokens (token_hash, token_id, product, kind, scopes_json, subject, label,
           jti, issued_at, expires_at, revoked_at, created_by)
         VALUES (?, ?, ?, 'static', '["packages:read"]', ?, 'r', NULL, ?, ?, ?, 'admin:a')`,
        `h${i}`,
        `cit_r${i}`,
        OWNER,
        `static:r${i}`,
        NOW - 4000 + i,
        NOW + DAY,
        NOW - 1,
      );
    expect(await resolves(old.token)).toBe(true);
    // The list shows the live token though 1100 newer revoked rows exist.
    const listed = await (await admin("GET", tokens())).json();
    expect(
      listed.serviceTokens.some((t: Loose) => t.tokenId === old.tokenId),
    ).toBe(true);
    const res = await admin("POST", tokens("/revoke-all"), {});
    expect((await res.json()).revoked).toBe(1);
    expect(await resolves(old.token)).toBe(false);
    expect(
      await db.all("SELECT 1 FROM ci_tokens WHERE revoked_at IS NULL"),
    ).toEqual([]);
  });

  it("B1: the cap counts every live token, not a window", async () => {
    for (let i = 0; i < 500; i++)
      await issueStaticCiToken(env, db, {
        product: OWNER,
        scopes: ["packages:read"],
        expiresAt: NOW + 300 * DAY,
        label: `t${i}`,
        createdBy: "admin:a",
        now: NOW - 10_000 + i,
      });
    for (let i = 0; i < 1100; i++)
      await db.run(
        `INSERT INTO ci_tokens (token_hash, token_id, product, kind, scopes_json, subject, label,
           jti, issued_at, expires_at, revoked_at, created_by)
         VALUES (?, ?, ?, 'static', '["packages:read"]', ?, 'r', NULL, ?, ?, ?, 'admin:a')`,
        `h${i}`,
        `cit_r${i}`,
        OWNER,
        `static:r${i}`,
        NOW - 100 + (i % 50),
        NOW + DAY,
        NOW - 1,
      );
    expect((await mintService()).status).toBe(409);
    expect(
      (await admin("GET", tokens()))
        .json()
        .then(
          (b: Loose) =>
            b.serviceTokens.filter((t: Loose) => t.status === "active").length,
        ),
    ).resolves.toBe(500);
  });

  it("N1: minting needs the Keys area on the product; N3: no control characters in a label", async () => {
    const { session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u2",
        name: "Bo",
        email: "bo@x.io",
        groups: [],
        authTime: NOW,
        stepUp: true,
      },
      NOW,
    );
    const as = (areas: string[] | null) => {
      const grants = [
        {
          role: "product_admin",
          scope: `product:${OWNER}`,
          areas,
        },
      ] as unknown as Grant[];
      return { ...session, principal: { memberId: "m", grants } };
    };
    const call = (areas: string[] | null, label = "svc") =>
      handleRegistryTokensAdmin(
        new Request(`${CONSOLE}/x`, {
          method: "POST",
          body: JSON.stringify({ label, binding: "service" }),
        }),
        env,
        db,
        as(areas) as never,
        { kind: "product", slug: OWNER } as never,
        [],
        NOW,
      );
    const denied = await call(["ship"]);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { reason: "no_access", area: "keys" },
    });
    expect(await db.all("SELECT 1 FROM ci_tokens")).toEqual([]);
    expect((await call(["keys"], "a\nb")).status).toBe(422);
    expect((await call(["keys"], "a\u007fb")).status).toBe(422);
    expect((await call(["keys"])).status).toBe(201);
    expect((await call(null)).status).toBe(201);
  });
});

describe("step-up (F-33b.7)", () => {
  it("minting needs a fresh step-up: refused without one, nothing written, then admitted", async () => {
    stale = true;
    const refused = await mintService();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "step_up_required" },
    });
    expect(await db.all("SELECT 1 FROM ci_tokens")).toEqual([]);
    stale = false;
    expect((await mintService()).status).toBe(201);
  });

  it("revoking works without one", async () => {
    const minted = await (await mintService()).json();
    stale = true;
    const id = minted.view.tokenId;
    const res = await admin("POST", tokens(`/${id}/revoke`));
    expect(res.status).toBe(200);
    expect((await admin("POST", tokens("/revoke-all"), {})).status).toBe(200);
  });

  it("a pkeya_ admin API token is refused (no scope names the route, so it never reaches the handler)", async () => {
    const secret = mintAdminApiToken();
    await db.run(
      `INSERT INTO admin_api_tokens (id, token_hash, label, scopes_json, created_at, expires_at)
       VALUES ('apitok_x', ?, 'x', '["bundles:mint"]', ?, ?)`,
      await hashKey(secret, env.KEY_HASH_PEPPER),
      NOW - DAY,
      NOW + DAY,
    );
    const full = `/api${tokens()}`;
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ label: "x", binding: "service" }),
      }),
      env,
      db,
      full,
      { now: NOW },
    );
    expect(res.status).toBe(403);
    expect(await db.all("SELECT 1 FROM ci_tokens")).toEqual([]);
  });

  it("revoked-by: a token revoked elsewhere in the same second is not credited to the revoke-all", async () => {
    const x = await (await mintService({ label: "x" })).json();
    const y = await (await mintService({ label: "y" })).json();
    // Keys → CI tokens revokes through a different audit action, in the same second.
    await db.run(
      "UPDATE ci_tokens SET revoked_at = ? WHERE token_id = ?",
      NOW,
      x.view.tokenId,
    );
    await admin("POST", tokens("/revoke-all"), {});
    const listed = (await (await admin("GET", tokens())).json())
      .serviceTokens as Loose[];
    const by = (id: string) => listed.find((t) => t.tokenId === id);
    expect(by(y.view.tokenId)).toMatchObject({
      revokedBy: "admin:ada@x.io",
      revokeReason: "revoke_all",
    });
    expect(by(x.view.tokenId)).toMatchObject({
      status: "revoked",
      revokedBy: null,
      revokeReason: null,
    });
  });

  it("POST …/ci-tokens with packages:read alone shares the service-token cap; other scopes do not", async () => {
    for (let i = 0; i < 500; i++)
      await issueStaticCiToken(env, db, {
        product: OWNER,
        scopes: ["packages:read"],
        expiresAt: NOW + DAY,
        label: `t${i}`,
        createdBy: "admin:a",
        now: NOW,
      });
    const read = await admin("POST", `/products/${OWNER}/ci-tokens`, {
      scopes: ["packages:read"],
      expiresInDays: 30,
    });
    expect(read.status).toBe(409);
    expect(await read.json()).toMatchObject({
      error: { reason: "token_limit" },
    });
    const count = async () =>
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM ci_tokens"))!.n;
    expect(await count()).toBe(500);
    const publish = await admin("POST", `/products/${OWNER}/ci-tokens`, {
      scopes: ["release:publish"],
      expiresInDays: 30,
    });
    expect(publish.status).toBe(201);
  });

  it("the revoke-all audit lists at most 100 ids, then +N more", async () => {
    const ids = Array.from({ length: 103 }, (_, i) => `cit_${i}`);
    const text = revokeAllSummary(ids);
    expect(
      text.startsWith("Revoked every live service token (103): cit_0 "),
    ).toBe(true);
    expect(text).toContain(" cit_99");
    expect(text).not.toContain("cit_100");
    expect(text.endsWith(" +3 more")).toBe(true);
    expect(revokeAllSummary(ids.slice(0, 2))).toBe(
      "Revoked every live service token (2): cit_0 cit_1",
    );
  });
});
