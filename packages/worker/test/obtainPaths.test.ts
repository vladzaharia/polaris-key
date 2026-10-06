/**
 * PS-03 — the Polaris Key storefront's obtain-path engine (notes/S-21 §6.3,
 * `services/identity/portal/store/obtain.ts`).
 *
 * 1. THE PROTOTYPE'S TABLE, ported. `prototype/polaris-storefront/obtain.mjs --self-test` is the
 *    acceptance table: the same eleven products, the same three accounts and the same seven
 *    checks, here against a real database, the real candidate query and the real `group`,
 *    `auto_issue` and `open` paths. The three kinds later packages build (`store_owned` PS-07,
 *    `product_idp` PS-08, `email_domain` PS-09) are stand-in `PathSource`s implementing the
 *    prototype's rule for each, so the table runs whole; each of those packages replaces its
 *    stand-in with the real source and keeps the row.
 * 2. The engine's other guarantees: no enumeration, dry run, listing modes and audience, the
 *    deployment switch, held products (licences, the identity's subject, library entries) and
 *    Distribution's `openAccess`.
 *
 * The `auto`-mode parity with PX-W10's Discover is `portalDiscover.test.ts`, unchanged.
 */

import { describe, expect, it } from "vitest";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import { writeListing } from "./listingWrites.js";
import { handlePortalApi, portalHooksFor } from "./portalHarness.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { loadProductPublic } from "../src/core/products.js";
import { activateFromIdentity } from "../src/services/identity/oidc.js";
import type { CustomerDownloads, Delivery } from "../src/core/hooks.js";
import type { PortalHooksFor } from "../src/services/identity/portal/api.js";
import {
  getOrCreateAccountByEmail,
  getOrCreateAccountByIdentity,
  linkLicense,
  type ListingPatch,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import {
  discoverCount,
  discoverIdentity,
  discoverOffers,
} from "../src/services/identity/portal/discover.js";
import {
  HIDDEN,
  OBTAIN_PATH_ORDER,
  STOREFRONT_SOURCES,
  decideVerdict,
  obtainPaths,
  offeredPaths,
  storefrontOffers,
  type ObtainOptions,
  type ObtainPath,
  type PathSource,
} from "../src/services/identity/portal/store/obtain.js";
import {
  DEFAULT_LISTING,
  type StorefrontListing,
} from "../src/core/storefront/polarisKeyListing.js";
import { STOREFRONT_ENABLED_KEY } from "../src/core/storefrontSwitch.js";

const ISSUER = "https://id.plrs.im";

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "portal-client";
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

/** License on, nothing else: the identity paths' products. */
const LICENSED: Partial<ServicesMap> = { license: { enabled: true } };
/** License off, Distribution (and the Release it requires) on: what `open` asks about. */
const DOWNLOADS_ONLY: Partial<ServicesMap> = {
  release: { enabled: true },
  distribution: { enabled: true },
};

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

async function oidcConfig(
  db: Db,
  slug: string,
  opts: { provider?: string; groupRoleMap?: Record<string, unknown> } = {},
): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    slug,
    opts.provider ?? "platform",
    opts.provider === "custom" ? "https://idp.example" : null,
    opts.provider === "custom" ? "client" : null,
    null,
    null,
    opts.groupRoleMap ? JSON.stringify(opts.groupRoleMap) : null,
  );
}

async function access(
  db: Db,
  slug: string,
  deliverable: string,
  mode: string,
  entitlement: string | null = null,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES (?, ?, ?, ?, 'admin', 0)`,
    slug,
    deliverable,
    mode,
    entitlement,
  );
}

async function website(db: Db, slug: string, url: string): Promise<void> {
  await db.run(
    "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
    slug,
    JSON.stringify({ website: url }),
    NOW,
  );
}

async function listing(
  db: Db,
  slug: string,
  patch: ListingPatch,
): Promise<void> {
  // ST-04: the listing is a registry setting, written through `writeSetting()`.
  await writeListing(db, slug, patch);
}

async function holdLicense(
  db: Db,
  accountId: string,
  slug: string,
  tier: string | null = null,
): Promise<void> {
  const id = `lic_${slug}_${accountId.slice(-6)}`;
  await db.run(
    `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
     VALUES (?, ?, 'active', ?, ?, ?)`,
    slug,
    id,
    tier,
    NOW,
    NOW,
  );
  await linkLicense(db, accountId, slug, id, "license-key", NOW);
}

/** The account that signed in to the portal through the platform IdP, with these groups. */
async function platformAccount(
  db: Db,
  subject: string,
  email: string,
  groups: string[],
): Promise<string> {
  return (
    await getOrCreateAccountByIdentity(
      db,
      { provider: ISSUER, subject, email, displayName: subject, groups },
      NOW,
    )
  ).id;
}

/** The database with every write refused: a read path that writes anything throws. */
function readOnly(db: Db): Db {
  const refuse = () => {
    throw new Error("the storefront engine attempted a write");
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "run" || prop === "runChanges" || prop === "batch")
        return refuse;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Every row of every table, for a whole-database before/after comparison. */
async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables)
    out[name] = await db.all(`SELECT * FROM "${name}" ORDER BY rowid`);
  return out;
}

async function claim(
  env: Env,
  db: Db,
  accountId: string,
  slug: string,
): Promise<{ status: number; body: unknown }> {
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    { accountId, email: "someone@example.com", name: "Someone" },
    NOW,
  );
  const path = `/api/discover/${slug}/claim`;
  const res = await handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      method: "POST",
      headers: {
        cookie: `${PORTAL_COOKIE}=${token}`,
        [PORTAL_CSRF_HEADER]: session.csrf,
      },
    }),
    env,
    db,
    path,
    NOW,
  );
  return { status: res.status, body: await res.json() };
}

// ── 1. The prototype's acceptance table ─────────────────────────────────────────────────────

/**
 * The facts the three later kinds read, exactly the prototype's fixture: Steam app 480 on
 * `steam-game`, the product-scoped IdP link to `team-app`, the domain `fennick.studio` on
 * `domain-app`. Keyed by account id once the accounts exist.
 */
interface LaterFacts {
  steamOwns: string[];
  productLinks: string[];
  verifiedEmails: string[];
}
const STEAM_APPS: Record<string, string> = { "steam-game": "480" };
const CUSTOM_IDP: Record<string, string> = { "team-app": "Aperture" };
const EMAIL_DOMAINS: Record<string, string[]> = {
  "domain-app": ["fennick.studio"],
};

/** Stand-ins for PS-07, PS-08 and PS-09: the prototype's rule for each kind, over `facts`. */
function laterSources(facts: Map<string, LaterFacts>): PathSource[] {
  const of = (accountId: string): LaterFacts =>
    facts.get(accountId) ?? {
      steamOwns: [],
      productLinks: [],
      verifiedEmails: [],
    };
  const path = (kind: ObtainPath["kind"], detail: string): ObtainPath => ({
    kind,
    detail,
    terms: null,
    action: "add",
    reason: `${kind}:${detail}`,
  });
  return [
    {
      kinds: ["store_owned"],
      async paths(ctx, c) {
        const app = STEAM_APPS[c.slug];
        return app && of(ctx.accountId).steamOwns.includes(app)
          ? [path("store_owned", "steam")]
          : [];
      },
    },
    {
      kinds: ["product_idp"],
      async paths(ctx, c) {
        const label = CUSTOM_IDP[c.slug];
        return label && of(ctx.accountId).productLinks.includes(c.slug)
          ? [path("product_idp", label)]
          : [];
      },
    },
    {
      kinds: ["email_domain"],
      async paths(ctx, c) {
        const domains = EMAIL_DOMAINS[c.slug] ?? [];
        const hit = of(ctx.accountId)
          .verifiedEmails.map((e) => e.split("@")[1]!)
          .find((d) => domains.includes(d));
        return hit ? [path("email_domain", hit)] : [];
      },
    },
  ];
}

interface Storefront {
  env: Env;
  db: Db;
  opts: ObtainOptions;
  anon: string;
  member: string;
  holder: string;
}

/** The prototype's eleven products and three accounts (obtain.mjs `selfTest`). */
async function prototypeStorefront(): Promise<Storefront> {
  const env = portalEnv();
  const db = makeTestDb();
  // `base`: active, portal on, listed, audience eligible, platform provider, auto-link on,
  // licence required. Each product below is `base` plus the prototype's overrides.
  const base = async (slug: string, svc: Partial<ServicesMap> = LICENSED) => {
    await seedProduct(db, slug);
    await services(db, slug, svc);
    await listing(db, slug, { storeListed: "listed" });
  };
  await base("freebie");
  await seedTier(db, "freebie", "free");
  await autoIssue(db, "freebie", {
    enabled: true,
    mode: "oidcDefault",
    tierId: "free",
  });

  await base("djdl");
  await seedTier(db, "djdl", "standard");
  await oidcConfig(db, "djdl", {
    groupRoleMap: {
      members: { role: "user", tier: "standard" },
      admins: { role: "admin" },
    },
  });

  await base("private-tool");

  // `licenseRequired: false`: License off; its downloads are public.
  await base("open-util", DOWNLOADS_ONLY);
  await access(db, "open-util", "app", "public");

  await base("steam-game"); // steamAppId 480, storeTier full (the stand-in's facts)

  await base("team-app");
  await seedTier(db, "team-app", "team");
  await oidcConfig(db, "team-app", { provider: "custom" });
  await autoIssue(db, "team-app", {
    enabled: true,
    mode: "oidcDefault",
    tierId: "team",
  });

  await base("domain-app");
  await seedTier(db, "domain-app", "pro");
  await autoIssue(db, "domain-app", {
    enabled: true,
    mode: "oidcDefault",
    tierId: "pro",
  });

  // `audience: everyone`, `storeLinks`: a page to link to (the listing's website).
  await base("teaser", { ...LICENSED, ...DOWNLOADS_ONLY });
  await listing(db, "teaser", { storeAudience: "everyone" });
  await website(db, "teaser", "https://teaser.example");

  await base("hidden-free");
  await listing(db, "hidden-free", { storeListed: "unlisted" });
  await seedTier(db, "hidden-free", "free");
  await autoIssue(db, "hidden-free", {
    enabled: true,
    mode: "both",
    tierId: "free",
  });

  await base("auto-open", DOWNLOADS_ONLY);
  await listing(db, "auto-open", { storeListed: "auto" });
  await access(db, "auto-open", "app", "public");

  await base("auto-free");
  await listing(db, "auto-free", { storeListed: "auto" });
  await seedTier(db, "auto-free", "free");
  await autoIssue(db, "auto-free", {
    enabled: true,
    mode: "oidcDefault",
    tierId: "free",
  });

  // anon: magic link only (no platform identity), a@example.com.
  const anon = (await getOrCreateAccountByEmail(db, "a@example.com", NOW)).id;
  // member: the platform IdP's `members` group, m@fennick.studio, owns Steam app 480, linked to
  // team-app's own IdP.
  const member = await platformAccount(db, "user-member", "m@fennick.studio", [
    "members",
  ]);
  // holder: the member's facts, holding freebie and djdl.
  const holder = await platformAccount(db, "user-holder", "h@fennick.studio", [
    "members",
  ]);
  await holdLicense(db, holder, "freebie", "free");
  await holdLicense(db, holder, "djdl", "standard");

  const memberFacts: LaterFacts = {
    steamOwns: ["480"],
    productLinks: ["team-app"],
    verifiedEmails: ["m@fennick.studio"],
  };
  const facts = new Map<string, LaterFacts>([
    [
      anon,
      { steamOwns: [], productLinks: [], verifiedEmails: ["a@example.com"] },
    ],
    [member, memberFacts],
    [holder, { ...memberFacts, verifiedEmails: ["h@fennick.studio"] }],
  ]);
  return {
    env,
    db,
    anon,
    member,
    holder,
    opts: {
      hooksFor: portalHooksFor(env, db),
      sources: [...STOREFRONT_SOURCES, ...laterSources(facts)],
    },
  };
}

async function visible(s: Storefront, accountId: string): Promise<string[]> {
  return (await storefrontOffers(s.env, s.db, accountId, NOW, s.opts))
    .map((o) => o.product.slug)
    .sort();
}

describe("the prototype's acceptance table (obtain.mjs --self-test)", () => {
  it("anon (magic link only) sees only open-util and the everyone teaser", async () => {
    const s = await prototypeStorefront();
    expect(await visible(s, s.anon)).toEqual(["open-util", "teaser"]);
  });

  it("member sees 8 of 11 products", async () => {
    const s = await prototypeStorefront();
    expect(await visible(s, s.member)).toEqual([
      "auto-free",
      "djdl",
      "domain-app",
      "freebie",
      "open-util",
      "steam-game",
      "team-app",
      "teaser",
    ]);
  });

  it("holder sees 6: held products never appear", async () => {
    const s = await prototypeStorefront();
    expect(await visible(s, s.holder)).toEqual([
      "auto-free",
      "domain-app",
      "open-util",
      "steam-game",
      "team-app",
      "teaser",
    ]);
  });

  it("unknown, unlisted and ineligible products answer identically, everywhere the engine is used", async () => {
    const s = await prototypeStorefront();
    const slugs = ["does-not-exist", "hidden-free", "private-tool"];
    // The engine: the same frozen verdict.
    for (const slug of slugs)
      expect(
        await obtainPaths(s.env, s.db, s.member, slug, NOW, s.opts),
        slug,
      ).toBe(HIDDEN);
    // The listing and the count never name one.
    const listed = await visible(s, s.member);
    const discover = (await discoverOffers(s.env, s.db, s.member, NOW)).map(
      (o) => o.product.slug,
    );
    for (const slug of slugs) {
      expect(listed).not.toContain(slug);
      expect(discover).not.toContain(slug);
    }
    // The claim: one status and one body for all three.
    const answers = new Set<string>();
    for (const slug of slugs)
      answers.add(JSON.stringify(await claim(s.env, s.db, s.member, slug)));
    expect(answers.size).toBe(1);
    expect(JSON.parse([...answers][0]!)).toMatchObject({
      status: 409,
      body: { error: "not_eligible" },
    });
    expect(await s.db.all("SELECT id FROM licenses")).toHaveLength(2); // the holder's two
  });

  it("group and auto-issue both apply: the group path comes first, with the group's tier", async () => {
    const s = await prototypeStorefront();
    await seedProduct(s.db, "x");
    await services(s.db, "x", LICENSED);
    await listing(s.db, "x", { storeListed: "listed" });
    await seedTier(s.db, "x", "beta");
    await seedTier(s.db, "x", "free");
    await oidcConfig(s.db, "x", {
      groupRoleMap: { members: { role: "user", tier: "beta" } },
    });
    await autoIssue(s.db, "x", { enabled: true, mode: "both", tierId: "free" });
    const v = await obtainPaths(s.env, s.db, s.member, "x", NOW, s.opts);
    if (!v.visible) throw new Error("x is not visible");
    expect(v.paths[0]).toMatchObject({
      kind: "group",
      detail: "members",
      reason: "group:members",
      terms: { tier: "beta" },
    });
    // One identity path: `identityTier` grants the group's tier, so the claim would never mint
    // the default one, and no `auto_issue` path promises it.
    expect(v.paths.map((p) => p.kind)).toEqual(["group"]);
  });

  it("an open product's path issues no licence: the claim adds a library entry", async () => {
    const s = await prototypeStorefront();
    expect(
      await obtainPaths(s.env, s.db, s.anon, "open-util", NOW, s.opts),
    ).toEqual({
      visible: true,
      cta: "add",
      paths: [
        {
          kind: "open",
          detail: null,
          terms: null,
          action: "add",
          reason: "open",
        },
      ],
    });
    // PS-04: the claim writes the library entry and mints nothing.
    expect(await claim(s.env, s.db, s.anon, "open-util")).toMatchObject({
      status: 200,
      body: { added: true, product: "open-util", kind: "entry" },
    });
    expect(
      await s.db.all("SELECT id FROM licenses WHERE product = 'open-util'"),
    ).toEqual([]);
    expect(
      await s.db.all(
        "SELECT via FROM library_entries WHERE account_id = ? AND product = 'open-util'",
        s.anon,
      ),
    ).toEqual([{ via: "open" }]);
  });

  it("audience everyone with no path is a link, never an Add, and cannot be claimed", async () => {
    const s = await prototypeStorefront();
    expect(
      await obtainPaths(s.env, s.db, s.anon, "teaser", NOW, s.opts),
    ).toEqual({ visible: true, cta: "link", paths: [] });
    const teaser = await claim(s.env, s.db, s.anon, "teaser");
    const unknown = await claim(s.env, s.db, s.anon, "does-not-exist");
    expect(teaser).toEqual(unknown);
    expect(teaser.status).toBe(409);
  });
});

// ── 2. The engine's other guarantees ────────────────────────────────────────────────────────

describe("the obtain-path engine", () => {
  it("writes nothing: the full engine runs on a database that refuses every write", async () => {
    const s = await prototypeStorefront();
    const ro = readOnly(s.db);
    const opts = { ...s.opts, hooksFor: portalHooksFor(s.env, ro) };
    const offers = await storefrontOffers(s.env, ro, s.member, NOW, opts);
    expect(offers.map((o) => o.product.slug).sort()).toEqual(
      await visible(s, s.member),
    );
    for (const slug of ["freebie", "open-util", "teaser", "private-tool"])
      await obtainPaths(s.env, ro, s.member, slug, NOW, opts);
  });

  it("writes nothing: the whole database is identical before and after", async () => {
    const s = await prototypeStorefront();
    const before = await dump(s.db);
    for (const who of [s.anon, s.member, s.holder]) {
      await storefrontOffers(s.env, s.db, who, NOW, s.opts);
      await obtainPaths(s.env, s.db, who, "freebie", NOW, s.opts);
    }
    expect(await dump(s.db)).toEqual(before);
  });

  it("orders paths store_owned, group, product_idp, email_domain, auto_issue, open", async () => {
    const s = await prototypeStorefront();
    const v = await obtainPaths(
      s.env,
      s.db,
      s.member,
      "domain-app",
      NOW,
      s.opts,
    );
    if (!v.visible) throw new Error("domain-app is not visible");
    expect(v.paths.map((p) => p.kind)).toEqual(["email_domain", "auto_issue"]);
    // team-app auto-issues too, but on a custom issuer: the platform subject keys nothing there
    // (R5-01/R5-02), so the identity paths never run on it and only its own IdP's path shows.
    const team = await obtainPaths(
      s.env,
      s.db,
      s.member,
      "team-app",
      NOW,
      s.opts,
    );
    if (!team.visible) throw new Error("team-app is not visible");
    expect(team.paths.map((p) => p.kind)).toEqual(["product_idp"]);
    // The pure ordering over every kind, whatever order the sources answered in.
    const every = [...OBTAIN_PATH_ORDER].reverse().map(
      (kind): ObtainPath => ({
        kind,
        detail: null,
        terms: null,
        action: "add",
        reason: kind,
      }),
    );
    const listed: StorefrontListing = { ...DEFAULT_LISTING, listed: "listed" };
    expect(offeredPaths(listed, every).map((p) => p.kind)).toEqual(
      OBTAIN_PATH_ORDER,
    );
    // `auto` counts the identity kinds only; `unlisted` none.
    expect(offeredPaths(DEFAULT_LISTING, every).map((p) => p.kind)).toEqual([
      "group",
      "auto_issue",
    ]);
    expect(
      decideVerdict(
        { ...DEFAULT_LISTING, listed: "unlisted" },
        false,
        every,
        true,
      ),
    ).toBe(HIDDEN);
    expect(decideVerdict(listed, true, every, true)).toBe(HIDDEN); // held
  });

  it("offerPaths narrows what counts, in every mode, and the claim follows it", async () => {
    const s = await prototypeStorefront();
    // auto-free (auto) without the auto_issue kind, djdl (listed) without group, open-util
    // (listed) with open only: the first two disappear, the third stays.
    await listing(s.db, "auto-free", { storeOfferPaths: ["group", "open"] });
    await listing(s.db, "djdl", { storeOfferPaths: ["auto_issue"] });
    await listing(s.db, "open-util", { storeOfferPaths: ["open"] });
    const seen = await visible(s, s.member);
    expect(seen).not.toContain("auto-free");
    expect(seen).not.toContain("djdl");
    expect(seen).toContain("open-util");
    expect((await claim(s.env, s.db, s.member, "djdl")).status).toBe(409);
    expect(
      await s.db.all("SELECT id FROM licenses WHERE product = 'djdl'"),
    ).toHaveLength(1); // the holder's
  });

  it("audience everyone applies to listed products only, and only with somewhere to link", async () => {
    const s = await prototypeStorefront();
    // Audience `eligible` (the default): a link target alone never shows a product.
    await listing(s.db, "teaser", { storeAudience: "eligible" });
    expect(await visible(s, s.anon)).toEqual(["open-util"]);
    await listing(s.db, "teaser", { storeAudience: "everyone" });
    // No website, no store page: nothing to link to.
    await s.db.run("DELETE FROM dist_listing WHERE product = 'teaser'");
    expect(await visible(s, s.anon)).toEqual(["open-util"]);
    // A store page from the product's downloads counts as a link target (`stores[]`), but only
    // where a channel release is reported live there.
    const withStore =
      (live: boolean): PortalHooksFor =>
      (product, now) => {
        const hooks = portalHooksFor(s.env, s.db)(product, now);
        const delivery = hooks.delivery();
        if (!delivery || product.slug !== "teaser") return hooks;
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
            live,
            version: live ? "1.0.0" : null,
          },
        ];
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
    expect(
      await obtainPaths(s.env, s.db, s.anon, "teaser", NOW, {
        ...s.opts,
        hooksFor: withStore(true),
      }),
    ).toEqual({ visible: true, cta: "link", paths: [] });
    expect(
      await obtainPaths(s.env, s.db, s.anon, "teaser", NOW, {
        ...s.opts,
        hooksFor: withStore(false),
      }),
    ).toBe(HIDDEN);
    // In `auto` mode the audience shows nothing a path does not.
    await website(s.db, "teaser", "https://teaser.example");
    await listing(s.db, "teaser", { storeListed: "auto" });
    expect(await visible(s, s.anon)).toEqual(["open-util"]);
    // And a held product is never a teaser.
    await listing(s.db, "teaser", { storeListed: "listed" });
    await holdLicense(s.db, s.member, "teaser");
    expect(await visible(s, s.member)).not.toContain("teaser");
  });

  it("the deployment switch off hides every listing; a tombstone or no row is on; anything else is off", async () => {
    const s = await prototypeStorefront();
    const set = (value: string) =>
      s.db.run(
        `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
         VALUES (?, ?, 1, ?, 'test')
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
        STOREFRONT_ENABLED_KEY,
        value,
        NOW,
      );
    const all = await visible(s, s.member);
    expect(all).toHaveLength(8);

    await set('"off"');
    expect(await visible(s, s.member)).toEqual([]);
    expect(await discoverOffers(s.env, s.db, s.member, NOW)).toEqual([]);
    expect(await discoverCount(s.env, s.db, s.member, NOW)).toBe(0);
    expect(
      await obtainPaths(s.env, s.db, s.member, "freebie", NOW, s.opts),
    ).toBe(HIDDEN);
    expect((await claim(s.env, s.db, s.member, "freebie")).status).toBe(409);

    await set('"on"');
    expect(await visible(s, s.member)).toEqual(all);
    await set("null"); // a tombstone: the default
    expect(await visible(s, s.member)).toEqual(all);
    for (const bad of ['"yes"', "true", "not json"]) {
      await set(bad);
      expect(await visible(s, s.member), bad).toEqual([]);
    }
  });

  it("a licence the account's platform subject already holds hides the product, linked or not", async () => {
    const s = await prototypeStorefront();
    // Minted by auto-free's own first sign-in, keyed by the member's subject, not yet linked.
    const product = (await loadProductPublic(s.db, "auto-free"))!;
    const identity = (await discoverIdentity(s.env, s.db, s.member))!;
    await activateFromIdentity(s.db, product, identity, NOW);
    expect(await visible(s, s.member)).not.toContain("auto-free");
    expect(
      await obtainPaths(s.env, s.db, s.member, "auto-free", NOW, s.opts),
    ).toBe(HIDDEN);
    // The same holds when another path would list it: domain-app's email-domain path does not
    // bring back a product the subject already holds.
    expect(await visible(s, s.member)).toContain("domain-app");
    await activateFromIdentity(
      s.db,
      (await loadProductPublic(s.db, "domain-app"))!,
      identity,
      NOW,
    );
    expect(await visible(s, s.member)).not.toContain("domain-app");
  });

  it("a library entry hides the product (PS-04's library_entries)", async () => {
    const s = await prototypeStorefront();
    expect(await visible(s, s.anon)).toContain("open-util");
    await s.db.run(
      "INSERT INTO library_entries (account_id, product, via, added_at) VALUES (?, 'open-util', 'open', ?)",
      s.anon,
      NOW,
    );
    expect(await visible(s, s.anon)).toEqual(["teaser"]);
    expect(
      await obtainPaths(s.env, s.db, s.anon, "open-util", NOW, s.opts),
    ).toBe(HIDDEN);
    // Only the anon account's library holds it.
    expect(await visible(s, s.member)).toContain("open-util");
  });

  it("open needs License off, Distribution on and every download open", async () => {
    const s = await prototypeStorefront();
    const open = async () =>
      (await obtainPaths(s.env, s.db, s.anon, "open-util", NOW, s.opts))
        .visible;
    expect(await open()).toBe(true);
    // A licensed pack: no longer open.
    await access(s.db, "open-util", "soundtrack", "licensed");
    expect(await open()).toBe(false);
    await s.db.run(
      "UPDATE dist_access SET mode = 'authenticated' WHERE product = 'open-util' AND deliverable_id = 'soundtrack'",
    );
    expect(await open()).toBe(true);
    // Distribution off: no downloads to open.
    await services(s.db, "open-util", { release: { enabled: true } });
    expect(await open()).toBe(false);
    // License on: there is a licence to obtain, so the product is not open.
    await services(s.db, "open-util", { ...DOWNLOADS_ONLY, ...LICENSED });
    expect(await open()).toBe(false);
  });
});

describe("Distribution's openAccess (Delivery hook, through Core)", () => {
  async function openAccess(
    rows: Array<[string, string, string | null]>,
  ): Promise<boolean> {
    const env = portalEnv();
    const db = makeTestDb();
    await seedProduct(db, "p");
    await services(db, "p", DOWNLOADS_ONLY);
    for (const [deliverable, mode, gate] of rows)
      await access(db, "p", deliverable, mode, gate);
    const product = (await loadProductPublic(db, "p"))!;
    return portalHooksFor(env, db)(product, NOW).delivery()!.openAccess();
  }

  it("is true only when every deliverable is public or authenticated and ungated", async () => {
    expect(await openAccess([["app", "public", null]])).toBe(true);
    expect(await openAccess([["app", "authenticated", null]])).toBe(true);
    expect(
      await openAccess([
        ["app", "public", null],
        ["dlc", "authenticated", null],
      ]),
    ).toBe(true);
    expect(await openAccess([["app", "licensed", null]])).toBe(false);
    expect(await openAccess([["app", "entitled", null]])).toBe(false);
    expect(
      await openAccess([
        ["app", "public", null],
        ["dlc", "entitled", null],
      ]),
    ).toBe(false);
    // A gated pack needs a licence flag, whatever its mode says.
    expect(
      await openAccess([
        ["app", "public", null],
        ["dlc", "public", "dlcAccess"],
      ]),
    ).toBe(false);
  });

  it("fails closed with no app row (nothing ingested)", async () => {
    expect(await openAccess([])).toBe(false);
    expect(await openAccess([["dlc", "public", null]])).toBe(false);
  });
});
