/**
 * PS-06 — the Polaris Key storefront's console panel (notes/S-21 §6.6):
 *
 *   GET  /manage/api/products/<p>/storefronts/polaris-key            the first-party `status` op
 *   POST /manage/api/products/<p>/storefronts/polaris-key/preview    "Who can see this?"
 *   GET  /manage/api/products/<p>/storefronts/polaris-key/analytics  the 28-day card
 *
 * The preview takes a persona, never a person (owner decision 11): its body schema names nothing
 * that identifies anyone, any other key is refused, and the engine runs on the persona with no
 * account row read. The routes write nothing.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import { writeListing } from "./listingWrites.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { STOREFRONT_ADAPTERS } from "../src/core/storefront/adapter.js";
import { STOREFRONT_ENABLED_KEY } from "../src/core/storefrontSwitch.js";
import { isBuiltIn } from "../src/services/distribution/storefronts/plan.js";
import {
  PERSONA_FIELDS,
  parsePersona,
} from "../src/admin/handlers/polarisKeyStorefront.js";
import { storefrontDay } from "../src/services/identity/portal/store/analytics.js";

const ISSUER = "https://id.plrs.im";
const PLATFORM_GROUP = "platform-admins";

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

interface World {
  env: Env;
  db: Db;
  call: (
    method: string,
    path: string,
    body?: unknown,
    db?: Db,
  ) => Promise<{ status: number; body: Record<string, any> }>;
}

/**
 * `aperture` licensed, for `aperture-beta` (labelled) and `crew` (no tier), and free with an
 * account on tier `free`; `openutil` open (License off, public downloads); `bare` licensed with
 * no policy at all.
 */
async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "portal-client";
  env.KEY_HASH_PEPPER = "test-pepper";

  await seedProduct(db, "aperture");
  await services(db, "aperture", LICENSED);
  await seedTier(db, "aperture", "beta", { deviceLimit: 3 });
  await seedTier(db, "aperture", "free", { deviceLimit: 2, expiryDays: 14 });
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?, 'platform', NULL, NULL, NULL, NULL, ?)",
    "aperture",
    JSON.stringify({
      "aperture-beta": { role: "user", tier: "beta" },
      crew: { role: "user" },
    }),
  );
  await db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    JSON.stringify({ enabled: true, tierId: "free", mode: "oidcDefault" }),
    "aperture",
  );
  await writeListing(db, "aperture", {
    storeGroupLabels: { "aperture-beta": "Aperture Seven" },
  });

  await seedProduct(db, "openutil");
  await services(db, "openutil", DOWNLOADS_ONLY);
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
     VALUES ('openutil', 'app', 'public', NULL, 'admin', 0)`,
  );

  await seedProduct(db, "bare");
  await services(db, "bare", LICENSED);

  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    over?: Db,
  ) => {
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      over ?? db,
      path,
      { now: NOW },
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { env, db, call };
}

const PANEL = (p: string, sub = "") =>
  `/api/products/${p}/storefronts/polaris-key${sub}`;

interface Read {
  sql: string;
  params: unknown[];
}

/** Every read a database is asked to run, and whether any statement wrote. */
function recording(db: Db): { db: Db; sql: Read[]; wrote: () => boolean } {
  const sql: Read[] = [];
  let wrote = false;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (prop === "run" || prop === "runChanges" || prop === "batch")
        return (...args: unknown[]) => {
          wrote = true;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      if (prop === "all" || prop === "first")
        return (q: string, ...params: unknown[]) => {
          sql.push({ sql: q, params });
          return (v as (...a: unknown[]) => unknown).apply(target, [
            q,
            ...params,
          ]);
        };
      return v.bind(target);
    },
  });
  return { db: proxy, sql, wrote: () => wrote };
}

/** The tables that hold a person: accounts, their links, emails, sessions, licences, history. */
const PERSON_TABLES =
  /\b(accounts|account_[a-z_]+|portal_account[a-z_]*|portal_license_links[a-z_]*|portal_audit|library_entries|licenses|license_[a-z_]+|storefront_seen|devices)\b/i;

/**
 * A read of a person's row. The one licence-table read the engine makes is the seat limit of the
 * licence a path WOULD mint (`licenseDeviceLimit` over a row that has no id yet): it is keyed by
 * the empty licence id, which no licence has, so it can match no one.
 */
function personRead(r: Read): boolean {
  if (!PERSON_TABLES.test(r.sql)) return false;
  const wouldBe =
    /^\s*SELECT[\s\S]*FROM license_(store_grants|profiles)\b[\s\S]*license_id = \?/i.test(
      r.sql,
    ) && r.params.includes("");
  return !wouldBe;
}

// ── status ─────────────────────────────────────────────────────────────────────────────────

describe("GET …/storefronts/polaris-key (the first-party status op)", () => {
  it("answers the listing, the configured and offered paths, the groups and readiness", async () => {
    const w = await world();
    const { status, body } = await w.call("GET", PANEL("aperture"));
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.portalEnabled).toBe(true);
    expect(body.listing).toEqual({
      listed: "auto",
      audience: "eligible",
      offerPaths: null,
      groupLabels: { "aperture-beta": "Aperture Seven" },
    });
    expect(body.available).toEqual(["group", "auto_issue"]);
    expect(body.active).toEqual(["group", "auto_issue"]);
    expect(body.everyone).toBe(false);
    expect(body.groups).toEqual([
      { group: "aperture-beta", tier: "beta", label: "Aperture Seven" },
      { group: "crew", tier: null, label: null },
    ]);
    expect(body.autoIssue).toEqual({
      tier: "free",
      tierLabel: expect.any(String),
      expiryDays: 14,
    });
    expect(
      body.readiness.map((c: { id: string; state: string }) => [c.id, c.state]),
    ).toEqual([
      ["portal", "pass"],
      // No listing in the model yet.
      ["listing", "fail"],
      ["obtain-path", "pass"],
      // No release, store link or website.
      ["get-it", "fail"],
      ["licence-tier", "pass"],
    ]);
  });

  it("is absent where the policy is not configured, and follows the listing mode", async () => {
    const w = await world();
    // Open, but `auto` counts the identity kinds only: configured, not offered.
    let r = await w.call("GET", PANEL("openutil"));
    expect(r.body.available).toEqual(["open"]);
    expect(r.body.active).toEqual([]);
    expect(
      r.body.readiness.find((c: { id: string }) => c.id === "obtain-path")
        .state,
    ).toBe("fail");
    await writeListing(w.db, "openutil", { storeListed: "listed" });
    r = await w.call("GET", PANEL("openutil"));
    expect(r.body.active).toEqual(["open"]);
    expect(
      r.body.readiness.find((c: { id: string }) => c.id === "licence-tier")
        .reason,
    ).toBe("No obtain path issues a licence");

    // No policy at all: nothing is available, nothing is offered.
    r = await w.call("GET", PANEL("bare"));
    expect(r.body.available).toEqual([]);
    expect(r.body.groups).toEqual([]);
    expect(r.body.autoIssue).toBeNull();

    // `offerPaths` narrows what is offered, not what is configured.
    await writeListing(w.db, "aperture", { storeOfferPaths: ["group"] });
    r = await w.call("GET", PANEL("aperture"));
    expect(r.body.available).toEqual(["group", "auto_issue"]);
    expect(r.body.active).toEqual(["group"]);
    expect(r.body.listing.offerPaths).toEqual(["group"]);
  });

  it("an unlisted product's readiness counts what listing it would offer", async () => {
    const w = await world();
    await writeListing(w.db, "aperture", { storeListed: "unlisted" });
    const r = await w.call("GET", PANEL("aperture"));
    expect(r.body.active).toEqual([]);
    expect(
      r.body.readiness.find((c: { id: string }) => c.id === "obtain-path")
        .state,
    ).toBe("pass");
  });

  it("a missing tier fails readiness by name", async () => {
    const w = await world();
    await w.db.run(
      "DELETE FROM tiers WHERE product = 'aperture' AND id = 'beta'",
    );
    const r = await w.call("GET", PANEL("aperture"));
    const tier = r.body.readiness.find(
      (c: { id: string }) => c.id === "licence-tier",
    );
    expect(tier.state).toBe("fail");
    expect(tier.reason).toContain("beta");
  });

  it("writes nothing", async () => {
    const w = await world();
    const rec = recording(w.db);
    const r = await w.call("GET", PANEL("aperture"), undefined, rec.db);
    expect(r.status).toBe(200);
    expect(rec.wrote()).toBe(false);
  });

  it("serves only polaris-key, by GET", async () => {
    const w = await world();
    expect(
      (await w.call("GET", "/api/products/aperture/storefronts/google-play"))
        .status,
    ).toBe(404);
    expect((await w.call("POST", PANEL("aperture"), {})).status).toBe(405);
    expect((await w.call("GET", PANEL("aperture", "/preview"))).status).toBe(
      405,
    );
    expect((await w.call("GET", PANEL("aperture", "/nope"))).status).toBe(404);
    expect((await w.call("GET", PANEL("ghost"))).status).toBe(404);
  });
});

// ── the preview's schema ───────────────────────────────────────────────────────────────────

describe("POST …/preview takes a persona, never a person", () => {
  it("the schema is exactly five fields, none of which identifies anyone", () => {
    expect([...PERSONA_FIELDS].sort()).toEqual(
      ["emailDomain", "groups", "holds", "platformAccount", "stores"].sort(),
    );
    // Every key that could carry an identity is outside the schema (and refused below).
    const IDENTIFYING = [
      "email",
      "accountId",
      "account",
      "sub",
      "subject",
      "userId",
      "user",
      "name",
      "id",
    ];
    for (const f of IDENTIFYING)
      expect(PERSONA_FIELDS as readonly string[]).not.toContain(f);
  });

  it.each([
    { email: "mara@fennick.studio" },
    { accountId: "acc_123" },
    { account: "acc_123" },
    { sub: "user-mara" },
    { userId: "u1" },
    { subject: "user-mara" },
    { name: "Mara" },
  ])("refuses %o", async (body) => {
    const w = await world();
    const r = await w.call("POST", PANEL("aperture", "/preview"), body);
    expect(r.status).toBe(422);
    expect(r.body.fields).toEqual(Object.keys(body));
  });

  it("an email domain is a domain, never an address", () => {
    expect(parsePersona({ emailDomain: "Fennick.Studio" })).toEqual({
      ok: true,
      persona: {
        platformAccount: true,
        groups: [],
        emailDomain: "fennick.studio",
        stores: [],
        holds: false,
      },
    });
    for (const bad of [
      "mara@fennick.studio",
      "@fennick.studio",
      "fennick",
      "a b.example",
      7,
    ])
      expect(parsePersona({ emailDomain: bad })).toEqual({
        ok: false,
        fields: ["emailDomain"],
      });
  });

  it("refuses malformed groups, stores and switches", () => {
    expect(parsePersona({ groups: "crew" })).toEqual({
      ok: false,
      fields: ["groups"],
    });
    expect(parsePersona({ groups: [""] })).toEqual({
      ok: false,
      fields: ["groups"],
    });
    expect(
      parsePersona({ groups: Array.from({ length: 51 }, (_, i) => `g${i}`) }),
    ).toEqual({ ok: false, fields: ["groups"] });
    expect(parsePersona({ stores: ["Steam!"] })).toEqual({
      ok: false,
      fields: ["stores"],
    });
    expect(parsePersona({ holds: "yes", platformAccount: 1 })).toEqual({
      ok: false,
      fields: ["platformAccount", "holds"],
    });
  });
});

// ── the preview's answers ──────────────────────────────────────────────────────────────────

describe("POST …/preview shows the tile that person would see", () => {
  it("a group member sees the group path with its label", async () => {
    const w = await world();
    const r = await w.call("POST", PANEL("aperture", "/preview"), {
      groups: ["aperture-beta"],
    });
    expect(r.status).toBe(200);
    expect(r.body.visible).toBe(true);
    expect(r.body.hidden).toBeNull();
    expect(r.body.tile.product).toBe("aperture");
    expect(r.body.tile.cta).toBe("add");
    expect(r.body.tile.reason).toBe("group:aperture-beta");
    expect(r.body.tile.paths).toEqual([
      expect.objectContaining({
        kind: "group",
        detail: "aperture-beta",
        label: "Aperture Seven",
        action: "add",
      }),
    ]);
    expect(r.body.tile.offer).toEqual(
      expect.objectContaining({ tier: "beta", deviceLimit: 3 }),
    );
  });

  it("anyone signed in with the platform IdP gets the free tier", async () => {
    const w = await world();
    const r = await w.call("POST", PANEL("aperture", "/preview"), {});
    expect(r.body.visible).toBe(true);
    expect(r.body.tile.reason).toBe("free_with_account");
    expect(r.body.tile.offer).toEqual(
      expect.objectContaining({ tier: "free", expiryDays: 14 }),
    );
  });

  it("says why a persona sees nothing", async () => {
    const w = await world();
    const preview = (slug: string, body: unknown) =>
      w.call("POST", PANEL(slug, "/preview"), body);
    // An email-link-only account has no subject for an identity path.
    expect(
      (await preview("aperture", { platformAccount: false })).body,
    ).toEqual(
      expect.objectContaining({
        visible: false,
        hidden: "no_path",
        tile: null,
      }),
    );
    expect((await preview("aperture", { holds: true })).body.hidden).toBe(
      "holds",
    );
    expect((await preview("bare", {})).body.hidden).toBe("no_path");
    await writeListing(w.db, "aperture", { storeListed: "unlisted" });
    expect((await preview("aperture", {})).body.hidden).toBe("not_candidate");
    await w.db.run(
      "INSERT INTO platform_settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, 'test')",
      STOREFRONT_ENABLED_KEY,
      JSON.stringify("off"),
      NOW,
    );
    expect((await preview("openutil", {})).body.hidden).toBe("storefront_off");
  });

  it("an open product shows to a persona with no account subject at all", async () => {
    const w = await world();
    await writeListing(w.db, "openutil", { storeListed: "listed" });
    const r = await w.call("POST", PANEL("openutil", "/preview"), {
      platformAccount: false,
    });
    expect(r.body.visible).toBe(true);
    expect(r.body.tile.reason).toBe("open");
    expect(r.body.tile.offer).toBeNull();
  });

  it("reads no account row and writes nothing, not even an impression", async () => {
    const w = await world();
    await writeListing(w.db, "openutil", { storeListed: "listed" });
    for (const [slug, body] of [
      [
        "aperture",
        { groups: ["aperture-beta"], emailDomain: "fennick.studio" },
      ],
      ["aperture", {}],
      ["aperture", { holds: true }],
      ["openutil", { platformAccount: false, stores: ["steam"] }],
    ] as const) {
      const rec = recording(w.db);
      const r = await w.call("POST", PANEL(slug, "/preview"), body, rec.db);
      expect(r.status).toBe(200);
      expect(rec.wrote()).toBe(false);
      // The admin session gate reads nothing of the portal; the engine reads the product only.
      const touched = rec.sql.filter(personRead).map((r) => r.sql);
      expect(touched).toEqual([]);
    }
    expect(await w.db.all("SELECT * FROM storefront_daily")).toEqual([]);
  });
});

// ── analytics ──────────────────────────────────────────────────────────────────────────────

describe("GET …/analytics (the 28-day card)", () => {
  it("sums the window per kind and per day, zero-filled, and nothing else", async () => {
    const w = await world();
    const day = (ago: number) => storefrontDay(NOW - ago * 86400);
    const row = (
      product: string,
      ago: number,
      kind: string,
      n: [number, number, number],
    ) =>
      w.db.run(
        "INSERT INTO storefront_daily (product, day, path_kind, impressions, adds, activations) VALUES (?, ?, ?, ?, ?, ?)",
        product,
        day(ago),
        kind,
        ...n,
      );
    await row("aperture", 0, "group", [10, 3, 1]);
    await row("aperture", 5, "group", [4, 1, 1]);
    await row("aperture", 5, "auto_issue", [20, 6, 2]);
    await row("aperture", 27, "link", [7, 0, 0]);
    // Outside the window, and another product.
    await row("aperture", 28, "group", [100, 100, 100]);
    await row("openutil", 0, "open", [50, 50, 50]);

    const r = await w.call("GET", PANEL("aperture", "/analytics"));
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(28);
    expect(r.body.from).toBe(day(27));
    expect(r.body.to).toBe(day(0));
    expect(r.body.impressionsCounted).toBe(true);
    expect(r.body.totals).toEqual({
      impressions: 41,
      adds: 10,
      activations: 4,
    });
    expect(r.body.byKind).toEqual([
      { kind: "group", impressions: 14, adds: 4, activations: 2 },
      { kind: "auto_issue", impressions: 20, adds: 6, activations: 2 },
      { kind: "link", impressions: 7, adds: 0, activations: 0 },
    ]);
    expect(r.body.daily).toHaveLength(28);
    expect(r.body.daily[0]).toEqual({
      day: day(27),
      impressions: 7,
      adds: 0,
      activations: 0,
    });
    expect(r.body.daily[22]).toEqual({
      day: day(5),
      impressions: 24,
      adds: 7,
      activations: 3,
    });
    expect(r.body.daily[1]).toEqual({
      day: day(26),
      impressions: 0,
      adds: 0,
      activations: 0,
    });
  });

  it("writes nothing", async () => {
    const w = await world();
    const rec = recording(w.db);
    const r = await w.call(
      "GET",
      PANEL("aperture", "/analytics"),
      undefined,
      rec.db,
    );
    expect(r.status).toBe(200);
    expect(rec.wrote()).toBe(false);
  });

  it("says when impressions are not counted (no pepper)", async () => {
    const w = await world();
    delete (w.env as Partial<Env>).KEY_HASH_PEPPER;
    const r = await w.call("GET", PANEL("aperture", "/analytics"));
    expect(r.body.impressionsCounted).toBe(false);
    expect(r.body.totals).toEqual({ impressions: 0, adds: 0, activations: 0 });
  });
});

// ── the hub's flag ─────────────────────────────────────────────────────────────────────────

describe("builtIn (the storefront view's first-party flag)", () => {
  it("is true for the first-party adapter alone, from its declaration", () => {
    expect(STOREFRONT_ADAPTERS.filter(isBuiltIn).map((a) => a.id)).toEqual([
      "polaris-key",
    ]);
  });
});
