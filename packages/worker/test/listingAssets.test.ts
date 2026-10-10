/**
 * A-18d — registering the listing assets `pkey listing assets` derived
 * (`POST /<p>/distribution/listing/assets`, `services/distribution/listing/assets.ts`), through
 * the real dispatcher: the opt-in `distribution:listing` scope, the upload ticket's earn-a-ref
 * rule, the model's validator (fixed slots, numbered per-store screenshots, packs), an operator's
 * row never replaced, refs replaced with their rows, and the audit row.
 *
 * The `pkeyci_` lookup (`lookupCiToken` in `core/publisher.ts`) is mocked, as in the other CI-route suites.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      {
        product: string;
        subject: string;
        scopes: readonly string[];
        tokenHash: string;
        expiresAt: number;
      }
    >(),
);
vi.mock("../src/core/publisher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/publisher.js")>()),
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { dispatch } from "../src/dispatch.js";
import {
  blobKey,
  putVerified,
  recordObject,
  recordRef,
  stagingKey,
} from "../src/core/assets/blobs.js";
import { issueUploadTicket } from "../src/core/publisher.js";
import {
  aiGeneratedStateOf,
  assetProblems,
  listingAssetRule,
} from "../src/core/storefront/listingModel.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const SLUG = "acme";
const LISTER = "pkeyci_lister";
const PUBLISHER = "pkeyci_publisher";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

let db: Db;
let env: Env;
let r2: R2Mock;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(LISTER, {
    product: SLUG,
    subject: "static:tok_listing",
    scopes: ["distribution:listing"],
    tokenHash: "hash-lister",
    expiresAt: NOW + 3600,
  });
  tokens.set(PUBLISHER, {
    product: SLUG,
    subject: "static:tok_pub",
    scopes: ["release:publish"],
    tokenHash: "hash-publisher",
    expiresAt: NOW + 3600,
  });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
});

interface Asset {
  slot: string;
  locale?: string | null;
  data: Uint8Array;
  width?: number | null;
  height?: number | null;
  alpha: boolean;
  derivedFrom?: string | null;
  textAllowed: "none" | "title" | "free";
}

const ICON = bytes("play icon png bytes");
const HERO = bytes("steam hero png bytes");
const SHOT = bytes("play phone screenshot");
const PACK = bytes("steam pack zip");

const ASSETS: Asset[] = [
  {
    slot: "play:icon",
    data: ICON,
    width: 512,
    height: 512,
    alpha: true,
    derivedFrom: "icon-master",
    textAllowed: "free",
  },
  {
    slot: "steam:library-hero",
    data: HERO,
    width: 3840,
    height: 1240,
    alpha: false,
    derivedFrom: "key-art",
    textAllowed: "none",
  },
  {
    slot: "play:screenshot:phone-portrait:1",
    data: SHOT,
    width: 1320,
    height: 2640,
    alpha: false,
    derivedFrom: "screenshot:phone-portrait",
    textAllowed: "free",
  },
  {
    slot: "pack:steam",
    data: PACK,
    alpha: false,
    derivedFrom: null,
    textAllowed: "free",
  },
];

const row = (a: Asset) => ({
  slot: a.slot,
  ...(a.locale !== undefined ? { locale: a.locale } : {}),
  sha256: sha(a.data),
  size: a.data.length,
  width: a.width ?? null,
  height: a.height ?? null,
  alpha: a.alpha,
  derivedFrom: a.derivedFrom ?? null,
  textAllowed: a.textAllowed,
});

async function post(body: unknown, token = LISTER): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/distribution/listing/assets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    db,
  );
}

/** Stage the objects under a fresh ticket, as `pkey listing assets --upload` does. */
async function stage(assets: Asset[], token = LISTER): Promise<string> {
  const holder = tokens.get(token)!;
  const unique = new Map(assets.map((a) => [sha(a.data), a.data]));
  const ticket = await issueUploadTicket(env, db, {
    product: SLUG,
    holder: { tokenHash: holder.tokenHash, expiresAt: holder.expiresAt },
    objects: [...unique].map(([h, b]) => ({
      sha256: h,
      size: b.length,
      gated: false,
    })),
    now: NOW,
  });
  for (const [h, b] of unique)
    await putVerified(asR2(r2), stagingKey(SLUG, ticket.ticketId, h), b, {
      sha256: h,
      size: b.length,
    });
  return ticket.ticket;
}

async function register(assets: Asset[] = ASSETS): Promise<Response> {
  const ticket = await stage(assets);
  return post({ ticket, assets: assets.map(row) });
}

async function rows(): Promise<Loose[]> {
  return db.all(
    "SELECT slot, locale, blob, sha256, width, height, alpha, derived_from, text_allowed, source, modified_by FROM dist_listing_assets WHERE product = ? ORDER BY slot",
    SLUG,
  );
}

async function refs(): Promise<Loose[]> {
  return db.all(
    "SELECT storage_key, ref_id FROM blob_refs WHERE product = ? AND ref_kind = 'listing-asset' ORDER BY ref_id",
    SLUG,
  );
}

describe("the listing model's asset slots (A-18d additions)", () => {
  it("knows the numbered per-store screenshots and the per-store packs", () => {
    expect(listingAssetRule("play:screenshot:phone-portrait:1")).toBe("free");
    expect(listingAssetRule("steam:screenshot:desktop-16x9:16")).toBe("free");
    expect(listingAssetRule("app-store:screenshot:tablet:3")).toBe("free");
    expect(listingAssetRule("pack:steam")).toBe("free");
    expect(
      listingAssetRule("steam:screenshot:desktop-16x9:17"),
    ).toBeUndefined();
    expect(listingAssetRule("steam:screenshot:desktop-16x9:0")).toBeUndefined();
    expect(listingAssetRule("itch:screenshot:tablet:1")).toBeUndefined();
    expect(listingAssetRule("play:screenshot:watch:1")).toBeUndefined();
    expect(listingAssetRule("__proto__")).toBeUndefined();
    expect(listingAssetRule("constructor")).toBeUndefined();
    expect(listingAssetRule("steam:library-hero")).toBe("none");
  });

  it("refuses a numbered screenshot with a text rule other than free", () => {
    const base = {
      slot: "play:screenshot:tablet:2",
      locale: null,
      blob: blobKey("a".repeat(64)),
      sha256: "a".repeat(64),
      width: 2064,
      height: 2752,
      alpha: false,
      derivedFrom: "screenshot:tablet",
      textAllowed: "free" as const,
    };
    expect(assetProblems(base)).toEqual([]);
    expect(
      assetProblems({ ...base, textAllowed: "none" }).map((p) => p.field),
    ).toEqual(["textAllowed"]);
  });

  it("marks template outputs NotAiGenerated for Play, and says nothing of a master", () => {
    expect(aiGeneratedStateOf({ derived_from: "key-art" })).toBe(
      "NotAiGenerated",
    );
    expect(aiGeneratedStateOf({ derivedFrom: "icon-master" })).toBe(
      "NotAiGenerated",
    );
    expect(aiGeneratedStateOf({ derived_from: null })).toBeNull();
  });

  it("says nothing of a fitted screenshot or an unknown source", () => {
    expect(aiGeneratedStateOf({ derivedFrom: "screenshot:phone" })).toBeNull();
    expect(
      aiGeneratedStateOf({ derived_from: "screenshot:tablet" }),
    ).toBeNull();
    expect(aiGeneratedStateOf({ derivedFrom: "something-else" })).toBeNull();
  });
});

describe("POST /<p>/distribution/listing/assets", () => {
  it("needs a pkeyci_ token with distribution:listing", async () => {
    const none = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/distribution/listing/assets`, {
        method: "POST",
        body: "{}",
      }),
      env,
      db,
    );
    expect(none.status).toBe(401);
    const wrong = await post({ assets: ASSETS.map(row) }, PUBLISHER);
    expect(wrong.status).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it("answers not-found for another method (Core's not-found, no CORS)", async () => {
    const res = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/distribution/listing/assets`, {
        headers: { authorization: `Bearer ${LISTER}` },
      }),
      env,
      db,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("registers the uploaded outputs: rows, refs and the audit", async () => {
    const res = await register();
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Loose;
    expect(body.ok).toBe(true);
    expect(body.kept).toEqual([]);
    expect(body.stored.map((s: Loose) => s.slot)).toEqual([
      "pack:steam",
      "play:icon",
      "play:screenshot:phone-portrait:1",
      "steam:library-hero",
    ]);
    const stored = await rows();
    expect(stored).toHaveLength(4);
    const icon = stored.find((r) => r.slot === "play:icon");
    expect(icon).toMatchObject({
      locale: "",
      blob: blobKey(sha(ICON)),
      sha256: sha(ICON),
      width: 512,
      height: 512,
      alpha: 1,
      derived_from: "icon-master",
      text_allowed: "free",
      source: "import",
      modified_by: "ci:static:tok_listing",
    });
    expect(stored.find((r) => r.slot === "pack:steam")).toMatchObject({
      width: null,
      height: null,
      alpha: 0,
      derived_from: null,
    });
    // Promoted into the content-addressed store, verified.
    expect(await r2.get(blobKey(sha(HERO)))).not.toBeNull();
    expect((await refs()).map((r) => r.ref_id)).toEqual([
      "pack:steam@",
      "play:icon@",
      "play:screenshot:phone-portrait:1@",
      "steam:library-hero@",
    ]);
    const audit = await db.all<Loose>(
      "SELECT action, actor_sub, summary FROM audit WHERE product = ?",
      SLUG,
    );
    expect(audit).toEqual([
      {
        action: "distribution.listing.assets",
        actor_sub: "ci:static:tok_listing",
        summary: "Registered 4 listing assets",
      },
    ]);
  });

  it("re-registers objects it already holds without a ticket, and replaces a slot's ref", async () => {
    expect((await register()).status).toBe(200);
    // The same bytes again: no ticket needed (the product's listing-asset refs earn them).
    const again = await post({ assets: ASSETS.map(row) });
    expect(again.status, await again.clone().text()).toBe(200);
    // A new play icon: needs a ticket; the old ref goes with the old row.
    const icon2: Asset = { ...ASSETS[0]!, data: bytes("a new icon") };
    const noTicket = await post({ assets: [row(icon2)] });
    expect(noTicket.status).toBe(403);
    expect(((await noTicket.json()) as Loose).reason).toBe("invalid_ticket");
    const res = await register([icon2]);
    expect(res.status, await res.clone().text()).toBe(200);
    const iconRefs = (await refs()).filter((r) => r.ref_id === "play:icon@");
    expect(iconRefs).toEqual([
      { storage_key: blobKey(sha(icon2.data)), ref_id: "play:icon@" },
    ]);
    expect((await rows()).find((r) => r.slot === "play:icon")?.sha256).toBe(
      sha(icon2.data),
    );
  });

  it("never earns an object from a ref of another kind (a digest is not possession)", async () => {
    // The product already references the bytes as a release artifact.
    await putVerified(asR2(r2), blobKey(sha(ICON)), ICON, {
      sha256: sha(ICON),
      size: ICON.length,
    });
    await recordObject(
      db,
      {
        storageKey: blobKey(sha(ICON)),
        sha256: sha(ICON),
        size: ICON.length,
        kind: "blob",
        gated: false,
      },
      NOW,
    );
    await recordRef(
      db,
      {
        product: SLUG,
        storageKey: blobKey(sha(ICON)),
        refKind: "artifact",
        refId: "app@1.0.0",
      },
      NOW,
    );
    const res = await post({ assets: [row(ASSETS[0]!)] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Loose).reason).toBe("invalid_ticket");
    expect(await rows()).toEqual([]);
  });

  it("refuses an object the ticket does not name, or one never uploaded", async () => {
    const ticket = await stage([ASSETS[0]!]);
    const res = await post({ ticket, assets: [row(ASSETS[1]!)] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Loose).reason).toBe("object_not_in_ticket");

    const holder = tokens.get(LISTER)!;
    const unstaged = await issueUploadTicket(env, db, {
      product: SLUG,
      holder: { tokenHash: holder.tokenHash, expiresAt: holder.expiresAt },
      objects: [{ sha256: sha(HERO), size: HERO.length, gated: false }],
      now: NOW,
    });
    const missing = await post({
      ticket: unstaged.ticket,
      assets: [row(ASSETS[1]!)],
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Loose).reason).toBe(
      "staged_object_missing",
    );
    expect(await rows()).toEqual([]);
  });

  it("refuses an invalid row, and writes nothing", async () => {
    const ticket = await stage(ASSETS);
    for (const [patch, reason] of [
      [{ slot: "steam:hero" }, "invalid_asset"],
      [{ textAllowed: "title" }, "invalid_asset"],
      [{ width: 0 }, "invalid_asset"],
      [{ locale: "not a locale" }, "invalid_asset"],
      [{ derivedFrom: "nope" }, "invalid_asset"],
      [{ alpha: "yes" }, "bad_assets"],
      [{ size: 0 }, "bad_assets"],
      [{ sha256: "ABC" }, "bad_assets"],
    ] as const) {
      const res = await post({
        ticket,
        assets: [{ ...row(ASSETS[1]!), ...patch }],
      });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(((await res.json()) as Loose).reason, JSON.stringify(patch)).toBe(
        reason,
      );
    }
    const twice = await post({
      ticket,
      assets: [row(ASSETS[0]!), row(ASSETS[0]!)],
    });
    expect(((await twice.json()) as Loose).reason).toBe("bad_assets");
    expect((await post({ ticket, assets: [] })).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("keeps an image the operator uploaded, and says so", async () => {
    await db.run(
      `INSERT INTO dist_listing_assets
         (product, slot, locale, blob, sha256, width, height, alpha, derived_from, text_allowed,
          source, modified_at, modified_by)
       VALUES (?, 'steam:library-hero', '', ?, ?, 3840, 1240, 0, NULL, 'none', 'admin', ?, 'admin:u1')`,
      SLUG,
      blobKey("b".repeat(64)),
      "b".repeat(64),
      NOW,
    );
    const res = await register();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Loose;
    expect(body.kept).toEqual([{ slot: "steam:library-hero", locale: null }]);
    const hero = (await rows()).find((r) => r.slot === "steam:library-hero");
    expect(hero).toMatchObject({ source: "admin", sha256: "b".repeat(64) });
    expect((await refs()).map((r) => r.ref_id)).not.toContain(
      "steam:library-hero@",
    );
    const [audit] = await db.all<Loose>(
      "SELECT summary FROM audit WHERE product = ?",
      SLUG,
    );
    expect(audit.summary).toBe(
      "Registered 3 listing assets; kept 1 the operator uploaded (steam:library-hero)",
    );
  });

  it("stores a localized row under its locale", async () => {
    const fr: Asset = {
      ...ASSETS[0]!,
      slot: "play:feature-graphic",
      locale: "fr-FR",
      width: 1024,
      height: 500,
      alpha: false,
      textAllowed: "title",
      derivedFrom: "key-art",
    };
    const res = await register([fr]);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await rows())[0]).toMatchObject({
      slot: "play:feature-graphic",
      locale: "fr-FR",
    });
    expect((await refs())[0].ref_id).toBe("play:feature-graphic@fr-FR");
  });

  it("P2-02's uploads route accepts distribution:listing for a ticket", async () => {
    env.R2_ACCOUNT_ID = "0".repeat(32);
    env.R2_PARENT_ACCESS_KEY_ID = "AKID";
    env.R2_PARENT_SECRET_ACCESS_KEY = "secret";
    env.BLOBS_BUCKET_NAME = "pkey-blobs";
    const res = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/release/publish/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${LISTER}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          objects: [{ sha256: sha(ICON), size: ICON.length }],
        }),
      }),
      env,
      db,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as Loose).ticket).toMatch(/^pkeyup_/);
  });
});
