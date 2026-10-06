/**
 * PX-W6 — purchase source and store grants on the product page (docs/design/PORTAL.md §10.2 G8).
 *
 *   1. Rule 6: Identity reads License's facts only through Core's `licenseProvenance` hook — no
 *      Identity file imports License or names its store-grant table.
 *   2. The hook (License's): one source per licence from its active store grants, then its
 *      origin; scoped to its product; fails closed with License off; never a purchase key.
 *   3. The portal: `GET /api/products/<p>` carries each licence's `purchase`, one fixture per
 *      source (store, developer, sign-in, free, a refunded store purchase), hidden flags masked,
 *      and `null` with License off.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { SERVICES } from "../src/mount.js";
import { setServices } from "../src/repo.js";
import { applyStoreGrant } from "../src/services/license/storeGrants.js";
import {
  originSource,
  purchaseSourceOf,
} from "../src/services/license/provenance.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import { handlePortalApi } from "./portalHarness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SLUG = "tidewater";

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "pro",
      kind: "flag",
      category: "Extras",
      label: "pro",
      grantLabel: "Pro effects",
      description: "The Pro flag.",
      schema: { type: "boolean" },
      userGrant: true,
    },
    {
      key: "beta_vault",
      kind: "flag",
      category: "Extras",
      label: "beta vault",
      description: "A flag the developer keeps out of the portal.",
      schema: { type: "boolean" },
    },
  ],
};

/** Module specifiers (the same shapes `boundaries.test.ts` reads). */
const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Source without its comments, so a doc comment may name a table the code never reads. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  return env;
}

function services(licenseOn: boolean): ServicesMap {
  return {
    license: { enabled: licenseOn },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
    sync: { enabled: false },
  } as ServicesMap;
}

async function setLicense(db: Db, slug: string, on: boolean): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({ services: services(on) }),
    "manifest",
    NOW,
  );
}

async function licence(
  db: Db,
  slug: string,
  id: string,
  origin: string,
): Promise<string> {
  const { licenseId } = await seedLicenseWithKey(db, slug, { id });
  await db.run(
    "UPDATE licenses SET origin = ? WHERE product = ? AND id = ?",
    origin,
    slug,
    licenseId,
  );
  return licenseId;
}

async function grant(
  db: Db,
  env: Env,
  slug: string,
  licenseId: string,
  store: "app-store" | "play" | "steam",
  flag: string,
  at: number,
  action: "grant" | "revoke" = "grant",
): Promise<void> {
  const product = (await loadProductPublic(db, slug))!;
  const outcome = await applyStoreGrant(
    { env, db, product, now: at },
    {
      licenseId,
      flag,
      store,
      purchaseKeyHash: `hash-${store}-${licenseId}`,
      action,
      summary: `${action} ${flag} from ${store}`,
    },
  );
  expect(outcome.ok).toBe(true);
}

async function world(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  const env = portalEnv();
  await seedProduct(db, SLUG, { catalog: CATALOG });
  await setLicense(db, SLUG, true);
  return { db, env };
}

async function provenanceOf(db: Db, env: Env, slug = SLUG) {
  const product = (await loadProductPublic(db, slug))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  }).licenseProvenance();
}

async function productPage(
  db: Db,
  env: Env,
  licenseIds: string[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const account = await getOrCreateAccountByEmail(
    db,
    "mara@fennick.studio",
    NOW,
  );
  for (const id of licenseIds)
    await linkLicense(db, account.id, SLUG, id, "admin", NOW);
  const { token } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  const path = `/api/products/${SLUG}`;
  const res = await handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      headers: { cookie: `${PORTAL_COOKIE}=${token}` },
    }),
    env,
    db,
    path,
    NOW,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

function purchaseById(
  body: Record<string, unknown>,
): Record<string, Record<string, unknown> | null> {
  const out: Record<string, Record<string, unknown> | null> = {};
  for (const l of body.licenses as Array<Record<string, unknown>>)
    out[l.id as string] = l.purchase as Record<string, unknown> | null;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("rule 6: Identity reaches License only through the hook", () => {
  it("no Identity file imports License or reads its store-grant table", () => {
    const identity = join(WORKER_ROOT, "src", "services", "identity");
    const license = join(WORKER_ROOT, "src", "services", "license");
    const offenders: string[] = [];
    for (const file of walkTs(identity)) {
      const src = readFileSync(file, "utf8");
      const rel = relative(WORKER_ROOT, file);
      for (const m of src.matchAll(SPECIFIER_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec?.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target === license || target.startsWith(license + sep))
          offenders.push(`${rel}: imports ${spec}`);
      }
      if (/license_store_grants/.test(stripComments(src)))
        offenders.push(`${rel}: names license_store_grants`);
    }
    expect(offenders).toEqual([]);
  });

  it("the portal's purchase module asks Core's hook", () => {
    const src = readFileSync(
      join(WORKER_ROOT, "src/services/identity/portal/purchase.ts"),
      "utf8",
    );
    expect(src).toContain(".licenseProvenance()");
    expect(src).toContain('from "../../../core/hooks.js"');
  });
});

describe("licenseProvenance (License)", () => {
  it("maps each origin to its source; an unknown origin is the developer", () => {
    expect(originSource("admin")).toBe("developer");
    expect(originSource("oidc")).toBe("sign_in");
    expect(originSource("enroll")).toBe("free");
    expect(originSource(undefined)).toBe("developer");
    expect(originSource("something-new")).toBe("developer");
  });

  it("an active store grant wins over the origin; stores in grant order, deduplicated", () => {
    const s = purchaseSourceOf("lic", "enroll", [
      {
        store: "play",
        flag: "a",
        state: "revoked",
        grantedAt: 1,
        revokedAt: 2,
      },
      {
        store: "steam",
        flag: "a",
        state: "active",
        grantedAt: 3,
        revokedAt: null,
      },
      {
        store: "app-store",
        flag: "b",
        state: "active",
        grantedAt: 4,
        revokedAt: null,
      },
      {
        store: "steam",
        flag: "b",
        state: "active",
        grantedAt: 5,
        revokedAt: null,
      },
    ]);
    expect(s).toMatchObject({
      kind: "store",
      store: "steam",
      stores: ["steam", "app-store"],
    });
    expect(s.grants).toHaveLength(4);
  });

  it("reads this product's licences only, in the order asked, and never a purchase key", async () => {
    const { db, env } = await world();
    await seedProduct(db, "quill");
    await setLicense(db, "quill", true);
    const mine = await licence(db, SLUG, "lic_a", "admin");
    const steam = await licence(db, SLUG, "lic_s", "enroll");
    await grant(db, env, SLUG, steam, "steam", "pro", NOW - 100);
    const other = await licence(db, "quill", "lic_q", "oidc");
    await grant(db, env, "quill", other, "play", "pro", NOW - 50);

    const sources = await (await provenanceOf(db, env))!.purchaseSources([
      steam,
      other,
      "lic_missing",
      mine,
      steam,
    ]);
    expect(sources.map((s) => [s.licenseId, s.kind, s.store])).toEqual([
      ["lic_s", "store", "steam"],
      ["lic_a", "developer", null],
    ]);
    expect(sources[0]!.grants).toEqual([
      {
        store: "steam",
        flag: "pro",
        state: "active",
        grantedAt: NOW - 100,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(sources)).not.toContain("hash-");
  });

  it("fails closed: with License off the accessor is null", async () => {
    const { db, env } = await world();
    await setLicense(db, SLUG, false);
    expect(await provenanceOf(db, env)).toBeNull();
  });
});

describe("GET /api/products/<p>: each licence's purchase", () => {
  it("one fixture per source renders the right source", async () => {
    const { db, env } = await world();
    const developer = await licence(db, SLUG, "lic_dev", "admin");
    const signIn = await licence(db, SLUG, "lic_oidc", "oidc");
    const free = await licence(db, SLUG, "lic_free", "enroll");
    const steam = await licence(db, SLUG, "lic_steam", "enroll");
    await grant(db, env, SLUG, steam, "steam", "pro", NOW - 300);
    const appStore = await licence(db, SLUG, "lic_ios", "oidc");
    await grant(db, env, SLUG, appStore, "app-store", "pro", NOW - 200);
    const play = await licence(db, SLUG, "lic_play", "admin");
    await grant(db, env, SLUG, play, "play", "pro", NOW - 100);

    const { status, body } = await productPage(db, env, [
      developer,
      signIn,
      free,
      steam,
      appStore,
      play,
    ]);
    expect(status).toBe(200);
    const p = purchaseById(body);
    expect(p.lic_dev).toEqual({
      source: "developer",
      store: null,
      stores: [],
      grants: [],
    });
    expect(p.lic_oidc).toMatchObject({ source: "sign_in", store: null });
    expect(p.lic_free).toMatchObject({ source: "free", store: null });
    expect(p.lic_steam).toEqual({
      source: "store",
      store: "steam",
      stores: ["steam"],
      grants: [
        {
          store: "steam",
          state: "active",
          grantedAt: NOW - 300,
          revokedAt: null,
          flag: "pro",
          label: "Pro effects",
        },
      ],
    });
    expect(p.lic_ios).toMatchObject({ source: "store", store: "app-store" });
    expect(p.lic_play).toMatchObject({ source: "store", store: "play" });
    expect(JSON.stringify(body)).not.toContain("hash-");
  });

  it("a refunded store purchase falls back to the origin and stays listed as revoked", async () => {
    const { db, env } = await world();
    const id = await licence(db, SLUG, "lic_refund", "admin");
    await grant(db, env, SLUG, id, "steam", "pro", NOW - 500);
    await grant(db, env, SLUG, id, "steam", "pro", NOW - 10, "revoke");
    const { body } = await productPage(db, env, [id]);
    expect(purchaseById(body).lic_refund).toEqual({
      source: "developer",
      store: null,
      stores: [],
      grants: [
        {
          store: "steam",
          state: "revoked",
          grantedAt: NOW - 500,
          revokedAt: NOW - 10,
          flag: "pro",
          label: "Pro effects",
        },
      ],
    });
  });

  it("a grant of a flag the developer keeps out of the portal names its store, not its flag", async () => {
    const { db, env } = await world();
    const id = await licence(db, SLUG, "lic_hidden", "enroll");
    await grant(db, env, SLUG, id, "play", "beta_vault", NOW - 5);
    const { body } = await productPage(db, env, [id]);
    expect(purchaseById(body).lic_hidden).toEqual({
      source: "store",
      store: "play",
      stores: ["play"],
      grants: [
        {
          store: "play",
          state: "active",
          grantedAt: NOW - 5,
          revokedAt: null,
          flag: null,
          label: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("beta_vault");
  });

  it("with License off every licence's purchase is null (the developer fallback)", async () => {
    const { db, env } = await world();
    const id = await licence(db, SLUG, "lic_off", "enroll");
    await grant(db, env, SLUG, id, "steam", "pro", NOW - 5);
    await setLicense(db, SLUG, false);
    const { status, body } = await productPage(db, env, [id]);
    expect(status).toBe(200);
    expect(purchaseById(body).lic_off).toBeNull();
  });
});
