/**
 * Registry auth (F-21, plans/F-20.md §6): the `pkeyr_` store, the lazy credential ladder, the OCI
 * token service and pull tokens, `GET /v2/`'s challenge, and SwiftPM's login, end to end through
 * the real registry host dispatcher over `mount.ts`'s routes. Godot's tokenised URLs are in
 * `test/registry/godot.test.ts`, beside that feed's fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRegistryHost } from "../src/core/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { deleteProduct } from "../src/admin/repo.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { forgetLicenceHolds } from "../src/services/distribution/registry/authorize.js";
import {
  REGISTRY_PULL_TOKEN_TTL_SECONDS,
  REGISTRY_TOKEN_TTL_SECONDS,
  forgetRegistryTokens,
  hashRegistryToken,
  listRegistryTokens,
  lookupRegistryCredential,
  mintRegistryToken,
  purgeRegistryTokens,
  revokeAllRegistryTokens,
  revokeRegistryToken,
  signPullToken,
  verifyPullToken,
} from "../src/core/registryTokens.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { OCI_ID, OCI_REPO, publishOciFixture } from "./ociFixture.js";

const PKG = "https://pkg.example.test";
const HOST = "pkg.example.test";
const OWNER = "acme";
const OTHER = "globex";
const NAME = `${OWNER}/${OCI_REPO}`;
const KEY = "registry-token-key-for-tests";
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
};

let db: Db;
let env: Env;
let clock: number;

function basic(token: string, user = "__token__"): string {
  return `Basic ${btoa(`${user}:${token}`)}`;
}

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, init),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
    undefined,
    REGISTRY_OWNERLESS_ROUTES,
  );
}

async function ociCode(res: Response): Promise<string> {
  const body = (await res.json()) as { errors: { code: string }[] };
  return body.errors[0]!.code;
}

async function setMode(mode: string, product = OWNER, eco = "oci") {
  await db.run(
    "UPDATE dist_registry_feeds SET access_mode = ? WHERE product = ? AND ecosystem = ?",
    mode,
    product,
    eco,
  );
  forgetRegistrySettings();
}

async function seedOwner(slug: string): Promise<void> {
  await seedProduct(db, slug);
  await setServices(
    db,
    slug,
    serializeServices({ services: ON }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    slug,
    NOW,
  );
  for (const eco of ["oci", "swift"])
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
       VALUES (?, ?, 1, ?, 52428800, ?)`,
      slug,
      eco,
      eco === "swift" ? '{"scope":"acme"}' : "{}",
      NOW,
    );
}

async function mint(
  over: Partial<Parameters<typeof mintRegistryToken>[2]> = {},
): Promise<string> {
  const res = await mintRegistryToken(
    env,
    db,
    {
      product: OWNER,
      label: "ci",
      binding: "owner",
      createdBy: "admin:test",
      ...over,
    },
    Math.floor(clock / 1000),
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res.token;
}

/** Advance the clock past every 30-second per-isolate window. */
function pastWindow(): void {
  clock += (REGISTRY_TOKEN_TTL_SECONDS + 1) * 1000;
  vi.setSystemTime(clock);
}

beforeEach(async () => {
  clock = NOW * 1000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.PKG_ORIGIN = PKG;
  env.KEY_HASH_PEPPER = "pepper";
  const bucket = new R2Mock();
  env.BLOBS = asR2(bucket);
  await seedOwner(OWNER);
  await seedOwner(OTHER);
  await publishOciFixture(db, env, bucket, OWNER, NOW);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { caches?: unknown }).caches;
});

// ── The store ────────────────────────────────────────────────────────────────────────────────

describe("registry tokens: the store (§6.1)", () => {
  const now = NOW;

  it("mints pkeyr_ + 256 bits, stores only the peppered hash and a hint, and shows the token once", async () => {
    const res = await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "laptop",
        binding: "owner",
        createdBy: "admin:a",
      },
      now,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.token).toMatch(/^pkeyr_[A-Za-z0-9_-]{43}$/);
    expect(res.view.hint).toBe(res.token.slice(-4));
    expect(res.view.expiresAt).toBe(now + 90 * 86_400);
    expect(res.view.scopes).toEqual(["read"]);
    expect(res.view.ecosystems).toBeNull();
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM registry_tokens",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(res.token);
    expect(rows[0]!.token_hash).toBe(await hashRegistryToken(env, res.token));
    expect(
      JSON.stringify(await listRegistryTokens(db, OWNER, now)),
    ).not.toContain(res.token);
  });

  it("enforces the mint rules: expiry 1..365 days, URL tokens godot-only for 30 days, licence tokens read-only", async () => {
    const m = (over: Record<string, unknown>) =>
      mintRegistryToken(
        env,
        db,
        {
          product: OWNER,
          label: "x",
          binding: "owner",
          createdBy: "admin:a",
          ...over,
        } as Parameters<typeof mintRegistryToken>[2],
        now,
      );
    for (const days of [0, 366, 1.5])
      expect((await m({ expiresInDays: days })).ok, String(days)).toBe(false);
    expect((await m({ expiresInDays: 365 })).ok).toBe(true);
    expect((await m({ label: "" })).ok).toBe(false);
    expect((await m({ label: "x".repeat(65) })).ok).toBe(false);
    expect((await m({ ecosystems: ["go"] })).ok).toBe(false);
    expect((await m({ ecosystems: [] })).ok).toBe(false);
    // F-22: `publish` must name its publish ecosystems (registryPublish.test.ts has the rest);
    // it implies `read` (F-23's push tokens are the same scope, naming OCI).
    expect((await m({ scopes: ["publish"] })).ok).toBe(false);
    const pub = await m({ scopes: ["publish"], ecosystems: ["npm"] });
    expect(pub.ok && pub.view.scopes).toEqual(["publish", "read"]);
    expect((await m({ scopes: ["publish"], ecosystems: ["oci"] })).ok).toBe(
      true,
    );
    expect((await m({ scopes: ["delete"] })).ok).toBe(false);
    expect((await m({ scopes: ["write"] })).ok).toBe(false);
    const url = await m({ presentation: "url", ecosystems: ["npm"] });
    expect(url.ok && url.view.ecosystems).toEqual(["godot"]);
    expect(url.ok && url.view.expiresAt).toBe(now + 30 * 86_400);
    // A licence-bound token names an existing licence of the owner.
    expect(
      await m({ binding: "license", licenseId: "lic_nope" }),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
    expect((await m({ binding: "license" })).ok).toBe(false);
  });

  it("caps live tokens per licence at 10", async () => {
    const { licenseId } = await seedLicenseWithKey(db, OWNER);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await mintRegistryToken(
            env,
            db,
            {
              product: OWNER,
              label: `t${i}`,
              binding: "license",
              licenseId,
              createdBy: "admin:a",
            },
            now,
          )
        ).ok,
      ).toBe(true);
    expect(
      await mintRegistryToken(
        env,
        db,
        {
          product: OWNER,
          label: "eleventh",
          binding: "license",
          licenseId,
          createdBy: "admin:a",
        },
        now,
      ),
    ).toMatchObject({ ok: false, status: 409, reason: "token_limit" });
  });

  it("revokes one, revokes all, and purges 90 days after expiry or revocation", async () => {
    const a = await mint({ label: "a" });
    await mint({ label: "b" });
    const [first] = await listRegistryTokens(db, OWNER, NOW);
    const revoked = await revokeRegistryToken(
      db,
      OWNER,
      first!.tokenId,
      "admin:a",
      "manual",
      NOW,
    );
    expect(revoked?.status).toBe("revoked");
    expect(
      await revokeAllRegistryTokens(db, OWNER, "admin:a", "revoke_all", NOW),
    ).toBe(1);
    expect((await lookupRegistryCredential(env, db, a)).resolved).toBeNull();
    expect(await purgeRegistryTokens(db, NOW + 89 * 86_400)).toBe(0);
    expect(await purgeRegistryTokens(db, NOW + 91 * 86_400)).toBe(2);
  });

  it("resolves through a 30-second cache: a revocation elsewhere lands within the window", async () => {
    const t = await mint();
    expect((await lookupRegistryCredential(env, db, t)).resolved?.kind).toBe(
      "owner",
    );
    // Another isolate revokes: this one still holds its entry until the window passes.
    await db.run("UPDATE registry_tokens SET revoked_at = ?", NOW);
    expect((await lookupRegistryCredential(env, db, t)).resolved?.kind).toBe(
      "owner",
    );
    pastWindow();
    expect((await lookupRegistryCredential(env, db, t)).resolved).toBeNull();
  });

  it("a deleted product's tokens resolve to nothing and show as revoked", async () => {
    const t = await mint();
    await deleteProduct(db, OWNER, NOW + 1);
    forgetRegistryTokens();
    expect((await lookupRegistryCredential(env, db, t)).resolved).toBeNull();
    const [view] = await listRegistryTokens(db, OWNER, NOW + 2);
    expect(view?.revokeReason).toBe("product_deleted");
  });

  it("an unknown token is a miss once, then a cached negative", async () => {
    const bogus = `pkeyr_${"z".repeat(43)}`;
    expect((await lookupRegistryCredential(env, db, bogus)).miss).toBe(true);
    expect((await lookupRegistryCredential(env, db, bogus)).miss).toBe(false);
    // Neither device tokens nor licence keys are registry credentials (Q5).
    for (const t of [`pkeyt_${"a".repeat(43)}`, "pkey_acme_abcdefghijk"])
      expect(await lookupRegistryCredential(env, db, t)).toEqual({
        resolved: null,
        miss: false,
      });
  });
});

describe("the OCI pull token (§6.4)", () => {
  it("signs identity-only claims, verifies under the current or previous key, and expires in 300 s", async () => {
    env.REGISTRY_TOKEN_KEY = KEY;
    const signed = await signPullToken(
      env,
      { sub: "rtok_x", own: OWNER, repos: [NAME] },
      NOW,
    );
    expect(signed?.expiresIn).toBe(REGISTRY_PULL_TOKEN_TTL_SECONDS);
    const token = signed!.token;
    expect(await verifyPullToken(env, token, NOW + 10)).toMatchObject({
      sub: "rtok_x",
      own: OWNER,
      repos: [NAME],
    });
    expect(await verifyPullToken(env, token, NOW + 300)).toBeNull();
    // Rotation: the old key verifies as PREVIOUS, and not at all once removed.
    env.REGISTRY_TOKEN_KEY = "new-key";
    expect(await verifyPullToken(env, token, NOW + 10)).toBeNull();
    env.REGISTRY_TOKEN_KEY_PREVIOUS = KEY;
    expect(await verifyPullToken(env, token, NOW + 10)).not.toBeNull();
    // Tampering with the claims breaks the signature.
    const [v, body, sig] = token.split(".");
    const forged = JSON.parse(
      atob(body!.replace(/-/g, "+").replace(/_/g, "/")),
    );
    forged.own = OTHER;
    const forgedBody = btoa(JSON.stringify(forged))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyPullToken(env, `${v}.${forgedBody}.${sig}`, NOW),
    ).toBeNull();
    delete env.REGISTRY_TOKEN_KEY;
    delete env.REGISTRY_TOKEN_KEY_PREVIOUS;
    expect(
      await signPullToken(env, { sub: "anonymous", own: null, repos: [] }, NOW),
    ).toBeNull();
  });
});

// ── The ladder, through OCI ──────────────────────────────────────────────────────────────────

describe("the credential ladder (§6.2), through the registry host", () => {
  const manifest = `/v2/${NAME}/tags/list`;

  async function pullToken(
    credential?: string,
    scope = `repository:${NAME}:pull`,
  ) {
    const res = await get(
      `/v2/token?service=${HOST}&scope=${encodeURIComponent(scope)}`,
      {
        headers: credential ? { authorization: credential } : {},
      },
    );
    return res;
  }

  async function bearer(credential?: string): Promise<string> {
    const res = await pullToken(credential);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  beforeEach(() => {
    env.REGISTRY_TOKEN_KEY = KEY;
  });

  it("a public feed never looks a credential up, and its answers stay shared-cacheable", async () => {
    const spy = vi.spyOn(db, "first");
    const res = await get(manifest, {
      headers: { authorization: `Bearer ${"garbage"}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(
      spy.mock.calls.some(([sql]) => /registry_tokens/.test(String(sql))),
    ).toBe(false);
  });

  it("a non-public feed challenges anonymous callers, and admits an owner token's pull token privately", async () => {
    await setMode("authenticated");
    const anon = await get(manifest);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(
      `Bearer realm="${PKG}/v2/token",service="${HOST}",scope="repository:${NAME}:pull"`,
    );
    // An anonymous token is refused a private repository: 401, a Basic challenge.
    const anonToken = await pullToken();
    expect(anonToken.status).toBe(401);
    expect(anonToken.headers.get("www-authenticate")).toBe(
      `Basic realm="${HOST}"`,
    );
    const t = await mint();
    const pull = await bearer(basic(t));
    const store = new Map<string, Response>();
    const put = vi.fn(async (r: Request, res: Response) => {
      store.set(r.url, res.clone());
    });
    (globalThis as { caches?: unknown }).caches = {
      default: { match: async (r: Request) => store.get(r.url)?.clone(), put },
    };
    const res = await get(manifest, {
      headers: { authorization: `Bearer ${pull}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toBeNull();
    // A credentialed answer never reaches the Cache API.
    expect(put).not.toHaveBeenCalled();
    // The raw registry token is a Bearer credential on the OCI routes too (curl, scripts).
    expect(
      (await get(manifest, { headers: { authorization: `Bearer ${t}` } }))
        .status,
    ).toBe(200);
  });

  it("a revoked token's pull token stops within the 30-second window, though the pull token lives 300 s", async () => {
    await setMode("authenticated");
    const t = await mint();
    const pull = await bearer(basic(t));
    const auth = { headers: { authorization: `Bearer ${pull}` } };
    // The first pull resolves the subject into this isolate's cache.
    expect((await get(manifest, auth)).status).toBe(200);
    const [view] = await listRegistryTokens(db, OWNER, NOW);
    // Revoked on another isolate (no forget here).
    await db.run(
      "UPDATE registry_tokens SET revoked_at = ? WHERE token_id = ?",
      NOW,
      view!.tokenId,
    );
    expect((await get(manifest, auth)).status).toBe(200);
    pastWindow();
    expect((await get(manifest, auth)).status).toBe(401);
  });

  it("another owner's token, a token narrowed away from OCI and a URL token are no credential here", async () => {
    await setMode("authenticated");
    const other = await mintRegistryToken(
      env,
      db,
      { product: OTHER, label: "x", binding: "owner", createdBy: "admin:a" },
      NOW,
    );
    if (!other.ok) throw new Error("mint");
    // Valid for globex, asking for an acme private repository: 403 DENIED.
    const denied = await pullToken(basic(other.token));
    expect(denied.status).toBe(403);
    expect(await ociCode(denied)).toBe("DENIED");
    const npmOnly = await mint({ ecosystems: ["npm"] });
    expect((await pullToken(basic(npmOnly))).status).toBe(403);
    const urlToken = await mint({ presentation: "url" });
    expect((await pullToken(basic(urlToken))).status).toBe(401);
    // Unknown and malformed credentials are 401, never an oracle.
    expect((await pullToken(basic(`pkeyr_${"q".repeat(43)}`))).status).toBe(
      401,
    );
    expect((await pullToken(basic("nonsense"))).status).toBe(401);
  });

  it("CI tokens of the owner pass every mode, entitled included (Q4)", async () => {
    await setMode("entitled");
    await db.run(
      "UPDATE dist_access SET mode = 'entitled' WHERE product = ? AND deliverable_id = ?",
      OWNER,
      OCI_ID,
    );
    forgetRegistrySettings();
    const { token } = await issueStaticCiToken(env, db, {
      product: OWNER,
      label: "build",
      scopes: ["release:publish"],
      expiresAt: NOW + 86_400,
      createdBy: "admin:a",
      now: NOW,
    });
    const pull = await bearer(basic(token));
    expect(
      (await get(manifest, { headers: { authorization: `Bearer ${pull}` } }))
        .status,
    ).toBe(200);
  });

  it("a licence-bound token needs a usable licence, and for entitled the package's gate flag", async () => {
    const { licenseId } = await seedLicenseWithKey(db, OWNER, {
      entitlements: { pro: { state: "enforced", value: true, updatedAt: NOW } },
    });
    const t = await mint({ binding: "license", licenseId });
    await setMode("licensed");
    const pull = await bearer(basic(t));
    const auth = { headers: { authorization: `Bearer ${pull}` } };
    expect((await get(manifest, auth)).status).toBe(200);
    // Entitled with no gate fails closed: 403 DENIED.
    await setMode("entitled");
    expect((await pullToken(basic(t))).status).toBe(403);
    // With a gate the licence holds, admitted; with one it does not hold, refused.
    await db.run(
      "UPDATE dist_access SET entitlement = 'pro' WHERE product = ? AND deliverable_id = ?",
      OWNER,
      OCI_ID,
    );
    forgetRegistrySettings();
    expect((await pullToken(basic(t))).status).toBe(200);
    await db.run(
      "UPDATE dist_access SET entitlement = 'enterprise' WHERE product = ? AND deliverable_id = ?",
      OWNER,
      OCI_ID,
    );
    forgetRegistrySettings();
    expect((await pullToken(basic(t))).status).toBe(403);
    // A disabled licence stops its tokens at the next check, with no write to the token.
    await setMode("authenticated");
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE id = ?",
      licenseId,
    );
    forgetRegistryTokens();
    expect((await pullToken(basic(t))).status).toBe(403);
  });
});

describe("the OCI token service and /v2/ (§6.4, Q1)", () => {
  it("without REGISTRY_TOKEN_KEY: /v2/ stays 200 and /v2/token is 503", async () => {
    expect((await get("/v2/")).status).toBe(200);
    const res = await get(`/v2/token?service=${HOST}`);
    expect(res.status).toBe(503);
    expect(await ociCode(res)).toBe("UNAVAILABLE");
  });

  it("with the key: /v2/ challenges, an anonymous token opens it, and docker login checks its credential", async () => {
    env.REGISTRY_TOKEN_KEY = KEY;
    const challenged = await get("/v2/");
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toBe(
      `Bearer realm="${PKG}/v2/token",service="${HOST}"`,
    );
    const anon = await get(`/v2/token?service=${HOST}`);
    expect(anon.status).toBe(200);
    const body = (await anon.json()) as Record<string, unknown>;
    expect(body.expires_in).toBe(300);
    expect(body.token).toBe(body.access_token);
    expect(anon.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await get("/v2/", {
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).status,
    ).toBe(200);
    // docker login with a bad token: 401 at once.
    expect(
      (
        await get(`/v2/token?service=${HOST}`, {
          headers: { authorization: basic(`pkeyr_${"n".repeat(43)}`) },
        })
      ).status,
    ).toBe(401);
    // Public repositories stay pullable with an anonymous token.
    const pub = await get(
      `/v2/token?service=${HOST}&scope=${encodeURIComponent(`repository:${NAME}:pull`)}`,
    );
    expect(pub.status).toBe(200);
  });

  it("refuses push, catalog, too many scopes, a foreign service and POST", async () => {
    env.REGISTRY_TOKEN_KEY = KEY;
    const t = await mint();
    const auth = { headers: { authorization: basic(t) } };
    const q = (scope: string) =>
      `/v2/token?service=${HOST}&scope=${encodeURIComponent(scope)}`;
    expect((await get(q(`repository:${NAME}:pull,push`), auth)).status).toBe(
      403,
    );
    expect((await get(q(`repository:${NAME}:pull,push`))).status).toBe(401);
    expect((await get(q("registry:catalog:*"), auth)).status).toBe(403);
    const five = Array.from(
      { length: 5 },
      (_, i) => `scope=repository:${OWNER}/r${i}:pull`,
    ).join("&");
    expect((await get(`/v2/token?service=${HOST}&${five}`, auth)).status).toBe(
      403,
    );
    expect((await get(`/v2/token?service=evil.example`, auth)).status).toBe(
      401,
    );
    expect((await get(`/v2/token`, { method: "POST" })).status).toBe(405);
  });
});

describe("SwiftPM login (§6.3)", () => {
  it("answers 200 for a token valid for this owner's Swift feed, else 401", async () => {
    const t = await mint();
    const login = (authorization?: string, owner = OWNER) =>
      get(`/swift/${owner}/login`, {
        method: "POST",
        headers: authorization ? { authorization } : {},
      });
    const ok = await login(`Bearer ${t}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-version")).toBe("1");
    expect((await login(basic(t))).status).toBe(200);
    expect((await login()).status).toBe(401);
    expect((await login(`Bearer pkeyr_${"x".repeat(43)}`)).status).toBe(401);
    // Another owner's login with this token: 401.
    expect((await login(`Bearer ${t}`, OTHER)).status).toBe(401);
    const ociOnly = await mint({ ecosystems: ["oci"] });
    expect((await login(`Bearer ${ociOnly}`)).status).toBe(401);
  });

  it("a non-public Swift feed then admits the logged-in client and refuses others", async () => {
    await setMode("authenticated", OWNER, "swift");
    const t = await mint();
    const list = `/swift/${OWNER}/identifiers?url=${encodeURIComponent("https://github.com/acme/kit")}`;
    const anon = await get(list);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(`Basic realm="${HOST}"`);
    const authed = await get(list, {
      headers: { authorization: `Bearer ${t}` },
    });
    // No package claims that URL: the ladder admitted the read, the route found nothing.
    expect(authed.status).toBe(404);
  });
});
