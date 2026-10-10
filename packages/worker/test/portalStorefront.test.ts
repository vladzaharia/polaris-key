/**
 * PS-04 — the Polaris Key storefront's portal API (notes/S-21 §6.4, §6.5, §6.6, §6.7):
 *
 *   GET    /api/discover               additive `paths[]`, `cta`, `shortDescription`, `stores`;
 *                                      `reason` and `offer` stay the first path's;
 *   GET    /api/discover/<p>           the storefront product page, `404` for anything not visible;
 *   POST   /api/discover/<p>/claim     optional `{path}`, issued through `issueFromPath`;
 *   GET    /api/library                entries (`kind: "entry"`) beside licences;
 *   DELETE /api/library/<p>            removes an entry, never a licence;
 *
 * and the daily analytics (`storefront_daily`, `storefront_seen`). PX-W10's own Discover
 * behaviour in `auto` mode stays pinned by `portalDiscover.test.ts`, the engine by
 * `obtainPaths.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import { portalHooksFor } from "./portalHarness.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/repo.js";
import { getLicense } from "../src/core/repo.js";
import { authorizeDevice } from "../src/core/licensing/authz.js";
import { loadProduct } from "../src/core/products.js";
import { sha256Hex } from "../src/platform/hash.js";
import type { CustomerDownloads, Delivery } from "../src/core/hooks.js";
import { STOREFRONT_ENABLED_KEY } from "../src/core/storefrontSwitch.js";
import {
  handlePortalApi as portalApi,
  type PortalHooksFor,
} from "../src/services/identity/portal/api.js";
import {
  deletePortalAccount,
  getOrCreateAccountByEmail,
  getOrCreateAccountByIdentity,
  linkLicense,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
// ST-04: the listing is a registry setting, written through `writeSetting()`.
import { writeListing } from "./listingWrites.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { handlePortalMedia } from "../src/services/identity/portal/media.js";
import {
  STOREFRONT_PAGE_LIMIT_PER_MINUTE,
  chooseClaimPath,
  issueFromPath,
} from "../src/services/identity/portal/discover.js";
import type { ObtainPath } from "../src/services/identity/portal/store/obtain.js";
import {
  ACTIVATION_WINDOW_SECONDS,
  claimPathKind,
  pruneStorefrontSeen,
  storefrontAccountKey,
  storefrontDay,
} from "../src/services/identity/portal/store/analytics.js";

const ISSUER = "https://id.plrs.im";
const SUB = "user-mara";
const DAY = 86400;

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "portal-client";
  env.KEY_HASH_PEPPER = "test-pepper";
  return env;
}

const ALL_OFF: ServicesMap = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: false },
  distribution: { enabled: false },
  update: { enabled: false },
  identity: { enabled: true },
  sync: { enabled: false },
};
const LICENSED: Partial<ServicesMap> = { license: { enabled: true } };
const DOWNLOADS_ONLY: Partial<ServicesMap> = {
  release: { enabled: true },
  distribution: { enabled: true },
};

async function services(
  db: Db,
  slug: string,
  over: Partial<ServicesMap>,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({ services: { ...ALL_OFF, ...over } }),
    "manifest",
    NOW,
  );
}

async function autoIssue(
  db: Db,
  slug: string,
  policy: Record<string, unknown>,
): Promise<void> {
  await db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    JSON.stringify(policy),
    slug,
  );
}

async function groupMap(
  db: Db,
  slug: string,
  map: Record<string, unknown>,
): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?, 'platform', NULL, NULL, NULL, NULL, ?)",
    slug,
    JSON.stringify(map),
  );
}

async function distListing(
  db: Db,
  slug: string,
  listing: Record<string, unknown>,
): Promise<void> {
  await db.run(
    "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
    slug,
    JSON.stringify(listing),
    NOW,
  );
}

const SHOT_0 =
  "https://raw.githubusercontent.com/fennick/openutil/main/shot-0.png";
const SHOT_EVIL = "https://evil.example/shot-1.png";
const SHOT_2 =
  "https://raw.githubusercontent.com/fennick/openutil/main/shot-2.png";

interface World {
  env: Env;
  db: Db;
  hooksFor: PortalHooksFor;
  /** Signed in through the platform IdP, in `aperture-beta`. */
  member: string;
  /** Magic link only: no platform identity, so no identity path. */
  anon: string;
}

/**
 * `mossgarden` free with an account (`auto_issue`), `aperture` for `aperture-beta` (`group`,
 * labelled), `openutil` open (License off, public downloads, a full listing), `teaser` a link
 * (audience everyone, a website, nothing to add), `hidden` unlisted, `private` licensed with no
 * policy. Every product but `hidden` is `listed`.
 */
async function world(): Promise<World> {
  const env = portalEnv();
  const db = makeTestDb();
  const listed = async (slug: string, svc: Partial<ServicesMap>) => {
    await seedProduct(db, slug);
    await services(db, slug, svc);
    await writeListing(db, slug, { storeListed: "listed" });
  };
  await listed("mossgarden", LICENSED);
  await seedTier(db, "mossgarden", "free", { deviceLimit: 2 });
  await autoIssue(db, "mossgarden", {
    enabled: true,
    tierId: "free",
    mode: "oidcDefault",
  });

  await listed("aperture", LICENSED);
  await seedTier(db, "aperture", "beta", { deviceLimit: 3 });
  await groupMap(db, "aperture", {
    "aperture-beta": { role: "user", tier: "beta" },
  });
  await writeListing(db, "aperture", {
    storeGroupLabels: { "aperture-beta": "Aperture Seven" },
  });

  await listed("openutil", DOWNLOADS_ONLY);
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES ('openutil', 'app', 'public', NULL, 'admin', 0)`,
  );
  await distListing(db, "openutil", {
    name: "Open Util",
    subtitle: "A small free tool",
    description: "Everything it does,\nin two lines.",
    website: "https://openutil.example",
    screenshots: [SHOT_0, SHOT_EVIL, SHOT_2],
  });

  await listed("teaser", { ...LICENSED, ...DOWNLOADS_ONLY });
  await writeListing(db, "teaser", { storeAudience: "everyone" });
  await distListing(db, "teaser", { website: "https://teaser.example" });

  await seedProduct(db, "hidden");
  await services(db, "hidden", LICENSED);
  await writeListing(db, "hidden", { storeListed: "unlisted" });
  await seedTier(db, "hidden", "free");
  await autoIssue(db, "hidden", {
    enabled: true,
    tierId: "free",
    mode: "both",
  });

  await listed("private", LICENSED);

  const member = (
    await getOrCreateAccountByIdentity(
      db,
      {
        provider: ISSUER,
        subject: SUB,
        email: "mara@fennick.studio",
        displayName: "Mara",
        groups: ["aperture-beta"],
      },
      NOW,
    )
  ).id;
  const anon = (await getOrCreateAccountByEmail(db, "anon@example.com", NOW))
    .id;
  return { env, db, hooksFor: portalHooksFor(env, db), member, anon };
}

interface Answer {
  status: number;
  body: Record<string, any>;
}

async function call(
  w: World,
  accountId: string,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    csrf?: boolean;
    now?: number;
    hooksFor?: PortalHooksFor;
  } = {},
): Promise<Answer> {
  const now = opts.now ?? NOW;
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId, email: "someone@example.com", name: "Someone" },
    now,
  );
  const headers: Record<string, string> = {
    cookie: `${PORTAL_COOKIE}=${token}`,
  };
  if (method !== "GET" && opts.csrf !== false)
    headers[PORTAL_CSRF_HEADER] = session.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await portalApi(
    new Request(`https://key.plrs.im${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    w.env,
    w.db,
    path,
    now,
    opts.hooksFor ?? w.hooksFor,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

const discover = (w: World, who: string, now = NOW) =>
  call(w, who, "GET", "/api/discover", { now });
const page = (w: World, who: string, slug: string, now = NOW) =>
  call(w, who, "GET", `/api/discover/${slug}`, { now });
const claim = (
  w: World,
  who: string,
  slug: string,
  body?: unknown,
  now = NOW,
) => call(w, who, "POST", `/api/discover/${slug}/claim`, { body, now });
const library = (w: World, who: string) => call(w, who, "GET", "/api/library");

async function daily(
  db: Db,
  product: string,
): Promise<
  Array<{
    day: string;
    path_kind: string;
    impressions: number;
    adds: number;
    activations: number;
  }>
> {
  return db.all(
    "SELECT day, path_kind, impressions, adds, activations FROM storefront_daily WHERE product = ? ORDER BY day, path_kind",
    product,
  );
}

// ── GET /api/discover ───────────────────────────────────────────────────────────────────────

describe("GET /api/discover (PS-04 additive fields)", () => {
  it("adds paths, cta, shortDescription and stores; reason and offer stay the first path's", async () => {
    const w = await world();
    const { status, body } = await discover(w, w.member);
    expect(status).toBe(200);
    const bySlug = Object.fromEntries(
      body.offers.map((o: Record<string, any>) => [o.product, o]),
    );
    expect(Object.keys(bySlug).sort()).toEqual([
      "aperture",
      "mossgarden",
      "openutil",
      "teaser",
    ]);

    const moss = bySlug.mossgarden;
    expect(moss.cta).toBe("add");
    expect(moss.reason).toBe("free_with_account");
    expect(moss.offer).toMatchObject({ tier: "free", deviceLimit: 2 });
    expect(moss.paths).toEqual([
      {
        kind: "auto_issue",
        detail: null,
        label: null,
        terms: moss.offer,
        action: "add",
        reason: "free_with_account",
      },
    ]);
    expect(moss.shortDescription).toBeNull();
    expect(moss.stores).toEqual([]);

    // The operator's group label rides on the group path.
    expect(bySlug.aperture.paths).toEqual([
      expect.objectContaining({
        kind: "group",
        detail: "aperture-beta",
        label: "Aperture Seven",
        reason: "group:aperture-beta",
      }),
    ]);
    expect(bySlug.aperture.reason).toBe("group:aperture-beta");

    // `open` issues no licence: no terms, so no `offer`.
    expect(bySlug.openutil).toMatchObject({
      name: "Open Util",
      cta: "add",
      reason: "open",
      offer: null,
      shortDescription: "A small free tool",
      paths: [
        {
          kind: "open",
          detail: null,
          label: null,
          terms: null,
          action: "add",
          reason: "open",
        },
      ],
    });

    // A link: nothing to add, no reason, no offer.
    expect(bySlug.teaser).toMatchObject({
      cta: "link",
      paths: [],
      reason: null,
      offer: null,
      website: "https://teaser.example",
      stores: [],
    });
  });

  it("a link offer carries its live store pages, and only those", async () => {
    const w = await world();
    const stores: CustomerDownloads["stores"] = [
      {
        id: "steam:steam",
        kind: "steam",
        outletId: "steam",
        platforms: ["windows"],
        label: "Steam",
        url: "https://store.steampowered.com/app/480/",
        deepLink: null,
        command: null,
        activateUrl: null,
        live: true,
        version: "1.0.0",
      },
      {
        id: "snap:snap",
        kind: "snap",
        outletId: "snap",
        platforms: ["linux"],
        label: "Snap Store",
        url: "https://snapcraft.io/teaser",
        deepLink: null,
        command: null,
        activateUrl: null,
        live: false,
        version: null,
      },
    ];
    const hooksFor: PortalHooksFor = (product, now) => {
      const hooks = w.hooksFor(product, now);
      const delivery = hooks.delivery();
      if (!delivery || product.slug !== "teaser") return hooks;
      const d: Delivery = {
        ...delivery,
        customerDownloads: async () => ({
          channel: "stable",
          releases: [],
          stores,
        }),
      };
      return { ...hooks, delivery: () => d };
    };
    const { body } = await call(w, w.member, "GET", "/api/discover", {
      hooksFor,
    });
    const teaser = body.offers.find((o: any) => o.product === "teaser");
    expect(teaser.stores).toEqual([
      {
        id: "steam:steam",
        kind: "steam",
        label: "Steam",
        url: "https://store.steampowered.com/app/480/",
      },
    ]);
  });

  it("a group label never reads an inherited property", async () => {
    const w = await world();
    await w.db.run("DELETE FROM oidc_config WHERE product = 'aperture'");
    await groupMap(w.db, "aperture", {
      constructor: { role: "user", tier: "beta" },
    });
    await w.db.run(
      "UPDATE account_links SET groups_json = ? WHERE account_id = ?",
      JSON.stringify(["constructor"]),
      w.member,
    );
    const { body } = await discover(w, w.member);
    const aperture = body.offers.find((o: any) => o.product === "aperture");
    expect(aperture.paths[0]).toMatchObject({
      kind: "group",
      detail: "constructor",
      label: null,
    });
  });

  it("the nav count is the products the account can add now: links are not counted", async () => {
    const w = await world();
    expect((await library(w, w.member)).body.discoverCount).toBe(3);
    expect((await library(w, w.anon)).body.discoverCount).toBe(1); // openutil
  });
});

// ── GET /api/discover/<p> ───────────────────────────────────────────────────────────────────

describe("GET /api/discover/<p> (the storefront product page)", () => {
  it("serves the listing, screenshots the proxy would serve, platforms and paths with terms", async () => {
    const w = await world();
    const { status, body } = await page(w, w.anon, "openutil");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      product: "openutil",
      name: "Open Util",
      shortDescription: "A small free tool",
      description: "Everything it does,\nin two lines.",
      website: "https://openutil.example",
      platforms: [],
      cta: "add",
      reason: "open",
      offer: null,
      stores: [],
    });
    expect(body.paths).toHaveLength(1);
    // Same-origin media URLs only, by position; a source the proxy refuses is left out.
    expect(body.screenshots).toHaveLength(2);
    expect(body.screenshots[0]).toMatch(
      /^\/media\/openutil\/screenshot-0\?v=[0-9a-f]{16}$/,
    );
    expect(body.screenshots[1]).toMatch(
      /^\/media\/openutil\/screenshot-2\?v=[0-9a-f]{16}$/,
    );

    const moss = await page(w, w.member, "mossgarden");
    expect(moss.status).toBe(200);
    expect(moss.body.paths[0]).toMatchObject({
      kind: "auto_issue",
      terms: { tier: "free", deviceLimit: 2 },
    });
    expect(moss.body.screenshots).toEqual([]);
    expect(moss.body.description).toBeNull();
  });

  it("answers one identical 404 for unknown, unlisted, ineligible, held and storefront-off", async () => {
    const w = await world();
    expect((await claim(w, w.member, "mossgarden")).status).toBe(200);
    const answers = new Set<string>();
    for (const slug of ["does-not-exist", "hidden", "private", "mossgarden"])
      answers.add(JSON.stringify(await page(w, w.member, slug)));
    // An account with no platform identity is ineligible for the identity paths.
    answers.add(JSON.stringify(await page(w, w.anon, "aperture")));
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES (?, '"off"', 1, ?, 'test')`,
      STOREFRONT_ENABLED_KEY,
      NOW,
    );
    answers.add(JSON.stringify(await page(w, w.anon, "openutil")));
    expect([...answers]).toEqual([
      JSON.stringify({ status: 404, body: { error: "not_found" } }),
    ]);
  });

  it("spends its own per-account budget before any lookup", async () => {
    const w = await world();
    const { token, session } = await issuePortalSessionRow(
      w.env,
      w.db,
      { accountId: w.anon, email: "anon@example.com", name: "Anon" },
      NOW,
    );
    let last = 0;
    for (let i = 0; i <= STOREFRONT_PAGE_LIMIT_PER_MINUTE; i++) {
      const res = await portalApi(
        new Request("https://key.plrs.im/api/discover/does-not-exist", {
          headers: { cookie: `${PORTAL_COOKIE}=${token}` },
        }),
        w.env,
        w.db,
        "/api/discover/does-not-exist",
        NOW,
        w.hooksFor,
      );
      last = res.status;
    }
    expect(session.csrf).toBeTruthy();
    expect(last).toBe(429);
  });

  it("is GET only", async () => {
    const w = await world();
    expect(
      (await call(w, w.anon, "PUT", "/api/discover/openutil")).status,
    ).toBe(405);
  });
});

// ── The media proxy's screenshot slots ──────────────────────────────────────────────────────

describe("/media/<p>/screenshot-<n> (the product page's screenshots)", () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
  ]);

  async function media(
    w: World,
    asset: string,
    fetched: string[],
  ): Promise<number> {
    const res = await handlePortalMedia(
      new Request(`https://key.plrs.im/media/openutil/${asset}`),
      w.env,
      w.db,
      "openutil",
      asset,
      NOW,
      w.hooksFor,
      async (input) => {
        fetched.push(typeof input === "string" ? input : input.url);
        return new Response(PNG, { status: 200 });
      },
    );
    return res.status;
  }

  it("serves the n-th allowlisted screenshot and refuses the rest", async () => {
    const w = await world();
    const fetched: string[] = [];
    expect(await media(w, "screenshot-0", fetched)).toBe(200);
    expect(await media(w, "screenshot-2", fetched)).toBe(200);
    expect(fetched).toEqual([SHOT_0, SHOT_2]);
    // Not an allowlisted host, past the list, past the cap, or not a slot at all.
    for (const asset of [
      "screenshot-1",
      "screenshot-3",
      "screenshot-16",
      "screenshot-01",
      "screenshot-x",
    ])
      expect(await media(w, asset, fetched), asset).toBe(404);
    expect(fetched).toHaveLength(2);
  });
});

// ── POST /api/discover/<p>/claim ────────────────────────────────────────────────────────────

describe("POST /api/discover/<p>/claim (claim by path)", () => {
  it("open: adds a library entry, no licence and no device", async () => {
    const w = await world();
    const { status, body } = await claim(w, w.anon, "openutil");
    expect(status).toBe(200);
    expect(body).toEqual({
      added: true,
      product: "openutil",
      kind: "entry",
      entry: { via: "open", addedAt: NOW },
    });
    expect(
      await w.db.all("SELECT id FROM licenses WHERE product = 'openutil'"),
    ).toEqual([]);
    expect(
      await w.db.all(
        "SELECT device_id FROM devices WHERE product = 'openutil'",
      ),
    ).toEqual([]);
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM portal_audit WHERE account_id = ? AND product = 'openutil'",
      w.anon,
    );
    expect(audit).toEqual([
      {
        action: "portal.discover.claim",
        summary:
          "Added openutil from Discover (source: discover; path: open; reason: open)",
      },
    ]);
  });

  it("identity paths: mint the licence, audited with the path, never a device", async () => {
    const w = await world();
    const { body } = await claim(w, w.member, "aperture", { path: "group" });
    expect(body).toMatchObject({
      added: true,
      product: "aperture",
      kind: "license",
      license: { tier: "beta", deviceLimit: 3, usable: true },
    });
    const lic = await getLicense(w.db, "aperture", body.license.id);
    expect(lic?.account_id).toBe(w.member);
    expect(
      await w.db.all(
        "SELECT device_id FROM devices WHERE product = 'aperture'",
      ),
    ).toEqual([]);
    const audit = await w.db.first<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = 'aperture' AND action = 'license.create'",
    );
    expect(audit?.summary).toContain(
      "(source: discover; path: group; reason: group:aperture-beta)",
    );
  });

  for (const [label, slug, who, path] of [
    ["auto_issue", "mossgarden", "member", "auto_issue"],
    ["group", "aperture", "member", "group"],
    ["open", "openutil", "anon", "open"],
  ] as const) {
    it(`is idempotent for ${label}: a second submit answers the same and creates nothing`, async () => {
      const w = await world();
      const account = who === "member" ? w.member : w.anon;
      const first = await claim(w, account, slug, { path });
      const second = await claim(w, account, slug, { path });
      const third = await claim(w, account, slug); // no path: still the held answer
      expect(first.status).toBe(200);
      expect(first.body.added).toBe(true);
      for (const again of [second, third]) {
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ ...first.body, added: false });
      }
      expect(
        await w.db.all("SELECT id FROM licenses WHERE product = ?", slug),
      ).toHaveLength(path === "open" ? 0 : 1);
      expect(
        await w.db.all(
          "SELECT product FROM library_entries WHERE product = ?",
          slug,
        ),
      ).toHaveLength(path === "open" ? 1 : 0);
      expect(
        (await daily(w.db, slug)).find((r) => r.path_kind === path)?.adds,
      ).toBe(1);
    });

    it(`is idempotent for ${label} under a double submit: one created, both answers the same`, async () => {
      const w = await world();
      const account = who === "member" ? w.member : w.anon;
      const [a, b] = await Promise.all([
        claim(w, account, slug, { path }),
        claim(w, account, slug, { path }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.added, b.body.added].sort()).toEqual([false, true]);
      expect({ ...a.body, added: null }).toEqual({ ...b.body, added: null });
      expect(
        await w.db.all("SELECT id FROM licenses WHERE product = ?", slug),
      ).toHaveLength(path === "open" ? 0 : 1);
      expect(
        (await daily(w.db, slug)).find((r) => r.path_kind === path)?.adds,
      ).toBe(1);
    });
  }

  it("never mints a second licence for a product the account holds by any route", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
       VALUES ('mossgarden', 'lic_key', 'active', 'free', ?, ?)`,
      NOW,
      NOW,
    );
    await linkLicense(
      w.db,
      w.member,
      "mossgarden",
      "lic_key",
      "license-key",
      NOW,
    );
    const { status, body } = await claim(w, w.member, "mossgarden");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      added: false,
      kind: "license",
      license: { id: "lic_key" },
    });
    expect(
      await w.db.all("SELECT id FROM licenses WHERE product = 'mossgarden'"),
    ).toHaveLength(1);
  });

  it("answers one identical 409 for unknown, unlisted, ineligible, a link, and a path not offered", async () => {
    const w = await world();
    const answers = new Set<string>();
    for (const [slug, body] of [
      ["does-not-exist", undefined],
      ["hidden", undefined],
      ["private", undefined],
      ["teaser", undefined],
      ["mossgarden", { path: "open" }],
      ["mossgarden", { path: "store_owned" }],
      ["mossgarden", { path: "not-a-kind" }],
      ["mossgarden", { path: 42 }],
      ["openutil", { path: "group" }],
    ] as const)
      answers.add(JSON.stringify(await claim(w, w.member, slug, body)));
    // The anon account has no platform identity: the identity paths are not offered to it.
    answers.add(JSON.stringify(await claim(w, w.anon, "mossgarden")));
    expect([...answers]).toEqual([
      JSON.stringify({
        status: 409,
        body: {
          error: "not_eligible",
          message: "this product is no longer offered to your account",
        },
      }),
    ]);
    expect(await w.db.all("SELECT id FROM licenses")).toEqual([]);
    expect(await w.db.all("SELECT product FROM library_entries")).toEqual([]);
  });

  it("chooseClaimPath: the first path without a request, the exact kind with one, else none", () => {
    const p = (kind: ObtainPath["kind"]): ObtainPath => ({
      kind,
      detail: null,
      terms: null,
      action: "add",
      reason: kind,
    });
    const offered = [p("group"), p("open")];
    expect(chooseClaimPath(offered, undefined)?.kind).toBe("group");
    expect(chooseClaimPath(offered, null)?.kind).toBe("group");
    expect(chooseClaimPath(offered, "open")?.kind).toBe("open");
    expect(chooseClaimPath(offered, "auto_issue")).toBeNull();
    expect(chooseClaimPath(offered, "bogus")).toBeNull();
    expect(chooseClaimPath(offered, ["open"])).toBeNull();
    expect(chooseClaimPath([], undefined)).toBeNull();
  });

  it("issueFromPath refuses a kind no source offers yet, creating nothing", async () => {
    const w = await world();
    const product = (await loadProduct(w.env, w.db, "mossgarden"))!;
    for (const kind of ["store_owned", "product_idp", "email_domain"] as const)
      expect(
        await issueFromPath(
          { env: w.env, db: w.db, now: NOW },
          { kind, detail: null, terms: null, action: "add", reason: kind },
          { accountId: w.member },
          { product, identity: null },
        ),
      ).toEqual({ error: "not_eligible" });
    expect(await w.db.all("SELECT id FROM licenses")).toEqual([]);
  });
});

// ── The library ─────────────────────────────────────────────────────────────────────────────

describe("library entries (GET /api/library, GET /api/products/<p>, DELETE /api/library/<p>)", () => {
  it("shows an entry for an open product, and hides it once a licence exists", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    const { body } = await library(w, w.anon);
    expect(body.products).toEqual([
      expect.objectContaining({
        product: "openutil",
        kind: "entry",
        via: "open",
        name: "Open Util",
        status: "active",
        license: null,
        licenseCount: 0,
        addedAt: NOW,
      }),
    ]);
    // An entry holds the product: it is not offered or counted again.
    expect(body.discoverCount).toBe(0);
    expect(
      (await discover(w, w.anon)).body.offers.map((o: any) => o.product),
    ).toEqual(["teaser"]); // the audience-everyone link alone

    const view = await call(w, w.anon, "GET", "/api/products/openutil");
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      product: "openutil",
      kind: "entry",
      via: "open",
      status: "active",
      addedAt: NOW,
      licenses: [],
    });

    // A licence for the product, by any route: the licence is the library item now.
    await w.db.run(
      `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
       VALUES ('openutil', 'lic_open', 'active', NULL, ?, ?)`,
      NOW,
      NOW,
    );
    await linkLicense(w.db, w.anon, "openutil", "lic_open", "license-key", NOW);
    const after = (await library(w, w.anon)).body.products;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ product: "openutil", kind: "license" });
    expect(after[0].license.id).toBe("lic_open");
    expect(
      (await call(w, w.anon, "GET", "/api/products/openutil")).body.kind,
    ).toBe("license");
  });

  it("hides an entry while the portal is off for the product", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    await upsertPortalProductSettings(
      w.db,
      "openutil",
      { portalEnabled: false },
      NOW,
    );
    expect((await library(w, w.anon)).body.products).toEqual([]);
    expect(
      (await call(w, w.anon, "GET", "/api/products/openutil")).status,
    ).toBe(404);
  });

  it("DELETE removes an entry only; a licence-backed product is never touched", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    await claim(w, w.member, "mossgarden");

    const removed = await call(w, w.anon, "DELETE", "/api/library/openutil");
    expect(removed).toEqual({
      status: 200,
      body: { ok: true, product: "openutil", inLibrary: false },
    });
    expect((await library(w, w.anon)).body.products).toEqual([]);
    expect(
      await w.db.first(
        "SELECT summary FROM portal_audit WHERE account_id = ? AND action = 'portal.library.remove'",
        w.anon,
      ),
    ).toBeTruthy();
    // Removed, the product is offered again.
    expect(
      (await discover(w, w.anon)).body.offers.map((o: any) => o.product),
    ).toEqual(["openutil", "teaser"]);

    expect(await call(w, w.anon, "DELETE", "/api/library/openutil")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    // The licence stays in the library: it leaves only by the existing detach. With no entry
    // to remove, the answer says the product is still there, and nothing is written.
    expect(
      await call(w, w.member, "DELETE", "/api/library/mossgarden"),
    ).toEqual({
      status: 200,
      body: { ok: true, product: "mossgarden", inLibrary: true },
    });
    expect(
      await w.db.first(
        "SELECT id FROM portal_audit WHERE account_id = ? AND action = 'portal.library.remove'",
        w.member,
      ),
    ).toBeNull();
    const held = await w.db.all<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE product = 'mossgarden'",
    );
    expect(held).toEqual([{ account_id: w.member }]);
  });

  it("DELETE of an entry a licence replaced: the success shape, and the product stays", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    // A licence for the product arrives by another route; the entry is hidden behind it.
    await w.db.run(
      `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
       VALUES ('openutil', 'lic_open', 'active', NULL, ?, ?)`,
      NOW,
      NOW,
    );
    await linkLicense(w.db, w.anon, "openutil", "lic_open", "license-key", NOW);

    const removed = await call(w, w.anon, "DELETE", "/api/library/openutil");
    expect(removed).toEqual({
      status: 200,
      body: { ok: true, product: "openutil", inLibrary: true },
    });
    // The licence is untouched and still the library item; the hidden entry is gone.
    const after = (await library(w, w.anon)).body.products;
    expect(after).toEqual([
      expect.objectContaining({ product: "openutil", kind: "license" }),
    ]);
    expect(await w.db.all("SELECT product FROM library_entries")).toEqual([]);
    expect(
      await w.db.first<{ account_id: string }>(
        "SELECT account_id FROM licenses WHERE id = 'lic_open'",
      ),
    ).toEqual({ account_id: w.anon });
    // The history says what happened: the entry went, the licence keeps the product.
    expect(
      await w.db.first<{ summary: string }>(
        "SELECT summary FROM portal_audit WHERE account_id = ? AND action = 'portal.library.remove'",
        w.anon,
      ),
    ).toEqual({
      summary:
        "Removed a product's library entry; its license keeps it in the library (source: discover; path: open)",
    });

    // Asked again (another tab): the same answer, idempotent, and nothing more is written.
    expect(await call(w, w.anon, "DELETE", "/api/library/openutil")).toEqual({
      status: 200,
      body: { ok: true, product: "openutil", inLibrary: true },
    });
    expect(
      await w.db.all(
        "SELECT id FROM portal_audit WHERE account_id = ? AND action = 'portal.library.remove'",
        w.anon,
      ),
    ).toHaveLength(1);
  });

  it("DELETE needs the CSRF header and is DELETE only", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    expect(
      (
        await call(w, w.anon, "DELETE", "/api/library/openutil", {
          csrf: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(w, w.anon, "POST", "/api/library/openutil")).status,
    ).toBe(405);
    expect(await w.db.all("SELECT product FROM library_entries")).toHaveLength(
      1,
    );
  });

  it("account deletion deletes the account's entries; a merge moves them to the survivor", async () => {
    const w = await world();
    await claim(w, w.anon, "openutil");
    const other = (
      await getOrCreateAccountByEmail(w.db, "other@example.com", NOW)
    ).id;
    expect(
      await mergeAccounts(
        { db: w.db, env: w.env, now: NOW, origin: "" },
        {
          survivor: { accountId: other, authenticatedAt: NOW },
          absorbed: { accountId: w.anon, authenticatedAt: NOW },
        },
      ),
    ).toMatchObject({ ok: true });
    expect(await w.db.all("SELECT account_id FROM library_entries")).toEqual([
      { account_id: other },
    ]);

    await deletePortalAccount(w.db, other, NOW, w.env);
    expect(await w.db.all("SELECT account_id FROM library_entries")).toEqual(
      [],
    );
  });
});

// ── Analytics ───────────────────────────────────────────────────────────────────────────────

describe("storefront analytics (storefront_daily, storefront_seen)", () => {
  it("counts one impression per product, account and day, under the first path's kind", async () => {
    const w = await world();
    await discover(w, w.member);
    await discover(w, w.member);
    await page(w, w.member, "openutil");
    const day = storefrontDay(NOW);
    expect(await daily(w.db, "mossgarden")).toEqual([
      { day, path_kind: "auto_issue", impressions: 1, adds: 0, activations: 0 },
    ]);
    expect(await daily(w.db, "aperture")).toEqual([
      { day, path_kind: "group", impressions: 1, adds: 0, activations: 0 },
    ]);
    expect(await daily(w.db, "openutil")).toEqual([
      { day, path_kind: "open", impressions: 1, adds: 0, activations: 0 },
    ]);
    expect(await daily(w.db, "teaser")).toEqual([
      { day, path_kind: "link", impressions: 1, adds: 0, activations: 0 },
    ]);
    // Never a product the account did not see.
    expect(await daily(w.db, "hidden")).toEqual([]);
    expect(await daily(w.db, "private")).toEqual([]);

    // Another account counts again; so does the next day.
    await page(w, w.anon, "openutil");
    await page(w, w.anon, "openutil", NOW + DAY);
    expect(
      (await daily(w.db, "openutil")).map((r) => [r.day, r.impressions]),
    ).toEqual([
      [day, 2],
      [storefrontDay(NOW + DAY), 1],
    ]);
  });

  it("the analytics tables hold no account id", async () => {
    const w = await world();
    await discover(w, w.member);
    await page(w, w.anon, "openutil");
    await claim(w, w.anon, "openutil");
    await claim(w, w.member, "mossgarden");

    for (const table of ["storefront_daily", "storefront_seen"]) {
      const cols = await w.db.all<{ name: string }>(
        `PRAGMA table_info(${table})`,
      );
      expect(cols.map((c) => c.name).filter((c) => c === "account_id")).toEqual(
        [],
      );
      const rows = await w.db.all<Record<string, unknown>>(
        `SELECT * FROM ${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const cells = rows.flatMap((r) => Object.values(r).map(String));
      // The dedupe keys: never a (truncated) plain hash of an account id.
      const keys = rows
        .map((r) => r.account_key)
        .filter((k): k is string => typeof k === "string");
      for (const accountId of [w.member, w.anon]) {
        const plain = await sha256Hex(accountId);
        for (const cell of cells) {
          expect(cell).not.toContain(accountId);
          expect(cell).not.toBe(plain);
        }
        for (const key of keys) {
          expect(key).toMatch(/^[0-9a-f]{32}$/);
          expect(plain.startsWith(key)).toBe(false);
        }
      }
    }
    // A key is the day's: the same account's keys on two days never match.
    expect(await storefrontAccountKey(w.env, w.anon, "2026-10-06")).not.toBe(
      await storefrontAccountKey(w.env, w.anon, "2026-10-07"),
    );
  });

  it("without KEY_HASH_PEPPER no dedupe key is made and no impression is counted; adds still are", async () => {
    const w = await world();
    delete (w.env as Record<string, unknown>).KEY_HASH_PEPPER;
    expect(await storefrontAccountKey(w.env, w.anon, "2026-10-06")).toBeNull();
    await discover(w, w.member);
    await page(w, w.anon, "openutil");
    expect(await w.db.all("SELECT * FROM storefront_seen")).toEqual([]);
    expect(
      await w.db.all(
        "SELECT product FROM storefront_daily WHERE impressions > 0",
      ),
    ).toEqual([]);
    await claim(w, w.anon, "openutil");
    expect((await daily(w.db, "openutil"))[0]).toMatchObject({
      path_kind: "open",
      impressions: 0,
      adds: 1,
    });
  });

  it("counts the licence's first device within seven days, on the add's day and kind, writing nothing per person", async () => {
    const w = await world();
    const { body } = await claim(w, w.member, "mossgarden");
    const product = (await loadProduct(w.env, w.db, "mossgarden"))!;
    const license = (await getLicense(w.db, "mossgarden", body.license.id))!;
    const later = NOW + 2 * DAY;
    expect(
      "token" in
        (await authorizeDevice(w.env, w.db, product, license, "dev-1", later)),
    ).toBe(true);
    expect(
      "token" in
        (await authorizeDevice(
          w.env,
          w.db,
          product,
          license,
          "dev-2",
          later + 60,
        )),
    ).toBe(true);
    // The same device again is no new authorization either.
    await authorizeDevice(w.env, w.db, product, license, "dev-1", later + 120);
    expect(await daily(w.db, "mossgarden")).toEqual([
      {
        day: storefrontDay(NOW),
        path_kind: "auto_issue",
        impressions: 0,
        adds: 1,
        activations: 1,
      },
    ]);
    // Deauthorized and bound again, the first device is not first a second time.
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized', seat_no = NULL WHERE product = 'mossgarden'",
    );
    await authorizeDevice(w.env, w.db, product, license, "dev-1", later + 180);
    // The count wrote no row in the account's history, or anywhere else per person.
    expect(
      await w.db.all(
        "SELECT action FROM portal_audit WHERE product = 'mossgarden' ORDER BY at",
      ),
    ).toEqual([{ action: "portal.discover.claim" }]);
    expect(await daily(w.db, "mossgarden")).toEqual([
      {
        day: storefrontDay(NOW),
        path_kind: "auto_issue",
        impressions: 0,
        adds: 1,
        activations: 1,
      },
    ]);
  });

  it("does not count an activation past the window, or of a licence not added from Discover", async () => {
    const w = await world();
    const { body } = await claim(w, w.member, "aperture");
    const product = (await loadProduct(w.env, w.db, "aperture"))!;
    const license = (await getLicense(w.db, "aperture", body.license.id))!;
    await authorizeDevice(
      w.env,
      w.db,
      product,
      license,
      "dev-late",
      NOW + ACTIVATION_WINDOW_SECONDS + 1,
    );
    expect((await daily(w.db, "aperture"))[0]?.activations).toBe(0);

    await w.db.run(
      `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
       VALUES ('aperture', 'lic_plain', 'active', 'beta', ?, ?)`,
      NOW,
      NOW,
    );
    const plain = (await getLicense(w.db, "aperture", "lic_plain"))!;
    await authorizeDevice(w.env, w.db, product, plain, "dev-plain", NOW + 60);
    expect((await daily(w.db, "aperture"))[0]?.activations).toBe(0);
  });

  it("reads the path kind from a claim's summary, and from a pre-PS-04 claim's reason", () => {
    expect(
      claimPathKind(
        "Added X from Discover (source: discover; path: open; reason: open)",
      ),
    ).toBe("open");
    expect(
      claimPathKind(
        "Added X from Discover (source: discover; reason: free_with_account)",
      ),
    ).toBe("auto_issue");
    expect(
      claimPathKind(
        "Added X from Discover (source: discover; reason: group:members)",
      ),
    ).toBe("group");
    expect(
      claimPathKind(
        "Added X from Discover (source: discover; path: nonsense; reason: x)",
      ),
    ).toBeNull();
    expect(claimPathKind("Something else")).toBeNull();
    expect(claimPathKind(null)).toBeNull();
    // The operator's product name comes first and cannot choose the kind: the last marker wins.
    expect(
      claimPathKind(
        "Added Evil (source: discover; path: open; reason: open) from Discover (source: discover; path: group; reason: group:members)",
      ),
    ).toBe("group");
  });

  it("the nightly prune keeps today's and yesterday's dedupe keys, per product", async () => {
    const w = await world();
    for (const [product, day] of [
      ["openutil", storefrontDay(NOW - 2 * DAY)],
      ["openutil", storefrontDay(NOW - DAY)],
      ["openutil", storefrontDay(NOW)],
      ["teaser", storefrontDay(NOW - 2 * DAY)],
    ])
      await w.db.run(
        "INSERT INTO storefront_seen (product, day, account_key) VALUES (?, ?, 'k')",
        product,
        day,
      );
    expect(await pruneStorefrontSeen(w.db, "openutil", NOW)).toBe(1);
    expect(
      await w.db.all(
        "SELECT product, day FROM storefront_seen ORDER BY product, day",
      ),
    ).toEqual([
      { product: "openutil", day: storefrontDay(NOW - DAY) },
      { product: "openutil", day: storefrontDay(NOW) },
      { product: "teaser", day: storefrontDay(NOW - 2 * DAY) },
    ]);
  });
});
