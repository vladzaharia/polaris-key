/**
 * A-18c — listing import from the App Store, Google Play, the Microsoft Store and the Godot
 * project, through the real admin API (`POST …/distribution/listing/import`), each store against
 * its fake vendor (`ascDistributeFake.ts`, `playFake.ts`, `msstoreFake.ts`). Nothing reaches a
 * store.
 *
 * Each store's `readListing` only READS: every App Store request is a GET the write gate admits;
 * Play's are one token for the publisher scope, a read-only edit opened, GETs, and the edit deleted
 * (never committed, never patched); Microsoft's are one Entra token and GETs. Then the import
 * itself: a field-by-field diff that writes nothing, applied only with the diff's digest, the
 * applied rows `source = 'import'` with per-field provenance and an audit row; precedence ("the
 * store that is live wins", reorderable per field) across sources and across imports.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { admits } from "../src/core/storefront/gate.js";
import { APP_STORE_COMPILED_GATE } from "../src/core/storefront/rules/appStore.js";
import {
  canonicalCategory,
  normaliseLocale,
  planImport,
  type CurrentListing,
  type ListingSnapshot,
} from "../src/core/storefront/listingImport.js";
import { DistributeFake } from "./ascDistributeFake.js";
import {
  addOutlet,
  ascWorld,
  audits,
  APPLE_ID,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  MsStoreFake,
  SELLER_ID,
  STORE_ID,
  TENANT_ID,
  type StoreFixtures,
} from "./msstoreFake.js";
import { importRsaPublicKey, PLAY_PACKAGE, PlayFake } from "./playFake.js";
import {
  acquirePlayEditLease,
  readPlayEditLease,
  releasePlayEditLease,
} from "../src/services/distribution/connectors/play/lease.js";
import {
  CLIENT_EMAIL,
  PLAY_OUTLET_IDENTITY,
  playFixtures,
  rsaKeyPair,
} from "./playWorld.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { CONSOLE } from "./releaseRoutesFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MS_FIXTURES = JSON.parse(
  readFileSync(join(HERE, "fixtures", "msstore", "store.json"), "utf8"),
) as StoreFixtures;
const MS_PUBLISHED = "1152921504621086517";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface World extends AscWorld {
  fake: DistributeFake;
  play: PlayFake;
  ms: MsStoreFake;
}

/** The App Store listing the fake serves: a live version beside a newer pending one. */
function seedAppStore(fake: DistributeFake): void {
  fake.set("apps", APPLE_ID, { primaryLocale: "en-US" });
  const app = { data: { type: "apps", id: APPLE_ID } };
  fake.put({
    type: "appInfos",
    id: "ai-live",
    attributes: { state: "READY_FOR_DISTRIBUTION" },
    relationships: {
      app,
      primaryCategory: { data: { type: "appCategories", id: "GAMES_PUZZLE" } },
      ageRatingDeclaration: {
        data: { type: "ageRatingDeclarations", id: "ard-1" },
      },
    },
  });
  fake.put({
    type: "ageRatingDeclarations",
    id: "ard-1",
    attributes: {
      violenceCartoonOrFantasy: "INFREQUENT_OR_MILD",
      gamblingSimulated: "NONE",
      gambling: false,
      lootBox: false,
      messagingAndChat: true,
      kidsAgeBand: null,
    },
  });
  for (const [id, locale, name, subtitle] of [
    ["ail-en", "en-US", "djdl", "Download DJ sets"],
    ["ail-de", "de-DE", "djdl Profi", "DJ-Sets laden"],
  ] as const)
    fake.put({
      type: "appInfoLocalizations",
      id,
      attributes: {
        locale,
        name,
        subtitle,
        privacyPolicyUrl: `https://djdl.example/${locale}/privacy`,
      },
      relationships: { appInfo: { data: { type: "appInfos", id: "ai-live" } } },
    });
  fake.put({
    type: "appStoreVersions",
    id: "asv-105",
    attributes: {
      platform: "IOS",
      versionString: "1.0.5",
      appStoreState: "READY_FOR_SALE",
      appVersionState: "READY_FOR_DISTRIBUTION",
      copyright: "2026 Acme Audio",
      createdDate: "2026-09-01T10:00:00.000Z",
    },
    relationships: { app },
  });
  const v = { data: { type: "appStoreVersions", id: "asv-105" } };
  fake.put({
    type: "appStoreVersionLocalizations",
    id: "asvl-en",
    attributes: {
      locale: "en-US",
      description: "djdl downloads your DJ sets.",
      keywords: "dj, music,download",
      supportUrl: "https://djdl.example/support",
      marketingUrl: "https://djdl.example",
      promotionalText: "Now with crates.",
      whatsNew: "Bug fixes.",
    },
    relationships: { appStoreVersion: v },
  });
  fake.put({
    type: "appStoreVersionLocalizations",
    id: "asvl-de",
    attributes: { locale: "de-DE", description: "djdl lädt DJ-Sets." },
    relationships: { appStoreVersion: v },
  });
  fake.put({
    type: "appScreenshotSets",
    id: "ass-1",
    attributes: { screenshotDisplayType: "APP_IPHONE_67" },
    relationships: {
      appStoreVersionLocalization: {
        data: { type: "appStoreVersionLocalizations", id: "asvl-en" },
      },
      appScreenshots: { data: [{ type: "appScreenshots", id: "as-1" }] },
    },
  });
  fake.put({
    type: "appScreenshots",
    id: "as-1",
    attributes: {
      fileName: "1.png",
      imageAsset: {
        templateUrl: "https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.{f}",
        width: 1320,
        height: 2868,
      },
    },
  });
}

async function world(
  opts: { play?: boolean; ms?: boolean; asc?: boolean } = {},
): Promise<World> {
  const fake = new DistributeFake();
  seedAppStore(fake);
  const w = (await ascWorld({
    fake,
    ...(opts.asc === false ? { outlets: false, apiKey: false } : {}),
  })) as World;

  // Google Play: an outlet, a pinned service account, the fake.
  const keys = rsaKeyPair();
  w.play = new PlayFake(
    playFixtures(),
    await importRsaPublicKey(keys.publicPem),
    CLIENT_EMAIL,
  );
  // A-18c's import reads A-18e's live listing state (`store`), which every new edit copies.
  w.play.store.details = {
    defaultLanguage: "en-US",
    contactWebsite: "https://djdl.example",
    contactEmail: "support@djdl.example",
  };
  w.play.store.listings.clear();
  for (const l of [
    {
      language: "en-US",
      title: "djdl",
      shortDescription: "Download your DJ sets anywhere.",
      fullDescription: "djdl for Android downloads your DJ sets.",
      video: "https://www.youtube.com/watch?v=abc",
    },
    { language: "fr-FR", title: "djdl", shortDescription: "Vos sets DJ." },
  ])
    w.play.store.listings.set(l.language, l);
  w.play.store.images.set("en-US/phoneScreenshots", [
    {
      id: "img-1",
      url: "https://play-lh.googleusercontent.com/one",
      sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  ]);
  if (opts.play !== false) {
    await addOutlet(w.db, "play", "play", PLAY_OUTLET_IDENTITY);
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "play",
      kind: "google-service-account",
      outletId: null,
      value: {
        type: "service_account",
        project_id: "acme-djdl",
        private_key_id: "0123456789abcdef",
        client_email: CLIENT_EMAIL,
        private_key: keys.privatePem,
        token_uri: "https://oauth2.googleapis.com/token",
      },
      pin: PLAY_PACKAGE,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    if (!r.ok) throw new Error(r.message);
  }

  // The Microsoft Store: an outlet, a pinned Partner Center app, the fake.
  w.ms = new MsStoreFake(MS_FIXTURES);
  w.ms.patchSubmission(MS_PUBLISHED, {
    applicationCategory: "MusicAndAudio",
    listings: {
      "en-us": {
        baseListing: {
          title: "djdl",
          description: "djdl for Windows downloads your DJ sets.",
          shortDescription: "DJ sets, downloaded.",
          keywords: ["dj", "sets"],
          features: ["Crates", "Offline playback"],
          copyrightAndTrademarkInfo: "Acme Audio Ltd",
          releaseNotes: "Fixes.",
          images: [{ fileName: "shot.png", imageType: "Screenshot" }],
        },
      },
    },
  });
  if (opts.ms !== false) {
    await addOutlet(w.db, "ms-store", "ms-store", { productId: STORE_ID });
    const r = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "partner-center",
      kind: "ms-partner-center",
      outletId: null,
      value: {
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        sellerId: SELLER_ID,
      },
      pin: STORE_ID,
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    if (!r.ok) throw new Error(r.message);
  }

  const asc = w.fetchImpl;
  w.fetchImpl = (input: string, init?: RequestInit) => {
    const host = new URL(input).hostname;
    if (host.endsWith("googleapis.com")) return w.play.fetchImpl(input, init);
    if (host.endsWith("microsoft.com") || host.endsWith("microsoftonline.com"))
      return w.ms.fetchImpl(input, init);
    return asc(input, init);
  };
  return w;
}

async function call(
  w: World,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Loose }> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution/listing/import`;
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    const res = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
    return { status: res.status, json: await res.json() };
  } finally {
    globalThis.fetch = saved;
  }
}

/** Preview, then apply with the digest. */
async function importApplied(w: World, body: Record<string, unknown>) {
  const preview = await call(w, body);
  expect(preview.status).toBe(200);
  const applied = await call(w, {
    ...body,
    confirm: preview.json.import.digest,
  });
  expect(applied.status).toBe(200);
  return { preview: preview.json.import, applied: applied.json };
}

const change = (preview: Loose, field: string) =>
  preview.changes.find((c: Loose) => c.field === field);

const listingAudits = async (w: World) =>
  (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.listing"),
  );

describe("the App Store's readListing (A-17a's gate, reads only)", () => {
  it("reads the live app info and version: names, text, URLs, category, descriptors, screenshots", async () => {
    const w = await world({ play: false, ms: false });
    const { status, json } = await call(w, { source: "app-store" });
    expect(status).toBe(200);
    const p = json.import;
    expect(p.sources).toEqual([
      { source: "app-store", ref: APPLE_ID, ok: true },
    ]);
    expect(p.defaultLocale).toBe("en-US");
    expect(
      p.changes.map((c: Loose) => [c.field, c.action, c.proposed]),
    ).toEqual([
      ["name", "add", "djdl"],
      ["category", "add", "games-puzzle"],
      [
        "contentDescriptors",
        "add",
        {
          "violence-cartoon-fantasy": "infrequent",
          "simulated-gambling": "none",
          gambling: false,
          "loot-boxes": false,
          chat: true,
        },
      ],
      ["copyright", "add", "2026 Acme Audio"],
      ["urls.support", "add", "https://djdl.example/support"],
      ["urls.privacy", "add", "https://djdl.example/en-US/privacy"],
      ["urls.marketing", "add", "https://djdl.example"],
      ["locales.de-DE.name", "add", "djdl Profi"],
      ["locales.de-DE.subtitle", "add", "DJ-Sets laden"],
      ["locales.de-DE.description", "add", "djdl lädt DJ-Sets."],
      ["locales.en-US.subtitle", "add", "Download DJ sets"],
      ["locales.en-US.description", "add", "djdl downloads your DJ sets."],
      ["locales.en-US.keywords", "add", ["dj", "music", "download"]],
      ["locales.en-US.promotionalText", "add", "Now with crates."],
    ]);
    expect(
      p.changes.every((c: Loose) => c.proposedSource === "app-store"),
    ).toBe(true);
    // Screenshots are reported for the derivation, never written; release notes are per release.
    expect(p.assets).toEqual([
      {
        source: "app-store",
        slot: "screenshot:phone-portrait",
        locale: "en-US",
        ref: "https://is1-ssl.mzstatic.com/image/thumb/x/1320x2868bb.png",
        width: 1320,
        height: 2868,
        sha256: null,
        vendorSlot: "APP_IPHONE_67",
      },
    ]);
    expect(p.skipped.map((s: Loose) => s.field)).toEqual([
      "locales.en-US.whatsNew",
      "screenshots",
    ]);

    // Every request was a GET, and the gate admits each one; nothing was written.
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(w.fake.writes()).toEqual([]);
    for (const r of w.fake.requests) {
      expect(r.method).toBe("GET");
      expect(admits(APP_STORE_COMPILED_GATE, "GET", r.path)).toBe(true);
      expect(r.authorization).toMatch(/^Bearer /);
    }
    expect(w.fake.requests.map((r) => r.path)).toEqual([
      `/v1/apps/${APPLE_ID}`,
      `/v1/apps/${APPLE_ID}/appInfos`,
      "/v1/appInfos/ai-live/appInfoLocalizations",
      "/v1/appInfos/ai-live/ageRatingDeclaration",
      `/v1/apps/${APPLE_ID}/appStoreVersions`,
      "/v1/appStoreVersions/asv-105/appStoreVersionLocalizations",
      "/v1/appStoreVersionLocalizations/asvl-en/appScreenshotSets",
    ]);
    expect(await listingAudits(w)).toEqual([]);
  });

  it("refuses before any request when the store is not configured or the pin disagrees", async () => {
    const none = await world({ asc: false, play: false, ms: false });
    const r = await call(none, { source: "app-store" });
    expect(r.status).toBe(404);
    expect(r.json.reason).toBe("not_configured");
    expect(none.fake.requests).toEqual([]);

    const pinned = await world({ play: false, ms: false });
    await pinned.db.run(
      "UPDATE dist_outlets SET identity_json = ? WHERE product = ? AND outlet_id = 'app-store'",
      JSON.stringify({ appleId: "9999999999", bundleId: "gg.acme.djdl" }),
      SLUG,
    );
    await pinned.db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE product = ? AND outlet_id = 'testflight'",
      NOW,
      SLUG,
    );
    const p = await call(pinned, { source: "app-store" });
    expect(p.status).toBe(409);
    expect(p.json.reason).toBe("credential_pin_mismatch");
    expect(pinned.fake.requests).toEqual([]);
  });
});

describe("Google Play's readListing (a read-only edit, deleted)", () => {
  it("reads details, listings and the default language's images; the edit is deleted, never committed", async () => {
    const w = await world({ ms: false, asc: false });
    const { status, json } = await call(w, { source: "play" });
    expect(status).toBe(200);
    const p = json.import;
    expect(p.sources).toEqual([
      { source: "play", ref: PLAY_PACKAGE, ok: true },
    ]);
    expect(p.changes.map((c: Loose) => [c.field, c.proposed])).toEqual([
      ["name", "djdl"],
      ["contactEmail", "support@djdl.example"],
      ["urls.website", "https://djdl.example"],
      ["locales.en-US.shortDescription", "Download your DJ sets anywhere."],
      ["locales.en-US.description", "djdl for Android downloads your DJ sets."],
      ["locales.fr-FR.shortDescription", "Vos sets DJ."],
    ]);
    expect(p.assets.map((a: Loose) => [a.slot, a.vendorSlot, a.ref])).toEqual([
      ["youtube-url", "video", "https://www.youtube.com/watch?v=abc"],
      [
        "screenshot:phone-portrait",
        "phoneScreenshots",
        "https://play-lh.googleusercontent.com/one",
      ],
    ]);
    expect(p.assets[1].sha256).toMatch(/^e3b0c442/);

    // One token, for the publisher scope only; an edit opened, read, deleted.
    expect(w.play.tokenRequests).toEqual([
      {
        iss: CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/androidpublisher",
      },
    ]);
    const calls = w.play.calls();
    const edit = calls[0]!;
    expect(edit).toBe("POST edits");
    const id = /edits\/(\d+)/.exec(calls[1]!)![1]!;
    expect(calls).toEqual([
      "POST edits",
      `GET edits/${id}/details`,
      `GET edits/${id}/listings`,
      ...[
        "icon",
        "featureGraphic",
        "phoneScreenshots",
        "sevenInchScreenshots",
        "tenInchScreenshots",
        "tvScreenshots",
        "wearScreenshots",
        "tvBanner",
      ].map((t) => `GET edits/${id}/listings/en-US/${t}`),
      `DELETE edits/${id}`,
    ]);
    expect(
      calls.some((c) => c.startsWith("PATCH") || c.includes(":commit")),
    ).toBe(false);
    expect(w.play.openEdits()).toEqual([]);
  });

  it("an edit invalidated mid-read writes nothing, and is still deleted", async () => {
    const w = await world({ ms: false, asc: false });
    // Another edit lands while the import's is open (P5-03's poll, a Console change).
    const realFetch = w.play.fetchImpl;
    (w.play as Loose).fetchImpl = async (input: string, init?: RequestInit) => {
      if (input.includes("/listings") && !input.includes("/listings/"))
        for (const e of w.play.edits.values()) e.valid = false;
      return realFetch(input, init);
    };
    const r = await call(w, { source: "play" });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("store_refused");
    expect(w.play.calls().at(-1)).toMatch(/^DELETE edits\//);
    expect(await listingAudits(w)).toEqual([]);
  });

  it("takes A-18e's edit lease: a held lease answers 409 and opens nothing; the lease is released after", async () => {
    const w = await world({ ms: false, asc: false });
    const held = await acquirePlayEditLease(w.db, {
      packageName: PLAY_PACKAGE,
      purpose: "poll",
      actor: "connector:play",
    });
    const r = await call(w, { source: "play" });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("edit_lease_held");
    expect(w.play.calls()).toEqual([]);
    expect(w.play.tokenRequests).toEqual([]);
    if ("held" in held) throw new Error("expected to hold the lease");
    await releasePlayEditLease(w.db, held);
    expect((await call(w, { source: "play" })).status).toBe(200);
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE)).toBeNull();
  });
});

describe("the Microsoft Store's readListing (P5-04's GET-only client)", () => {
  it("reads the last published submission's listing with GETs only", async () => {
    const w = await world({ play: false, asc: false });
    const { status, json } = await call(w, { source: "ms-store" });
    expect(status).toBe(200);
    const p = json.import;
    expect(p.sources).toEqual([
      { source: "ms-store", ref: STORE_ID, ok: true },
    ]);
    expect(p.changes.map((c: Loose) => [c.field, c.proposed])).toEqual([
      ["name", "djdl"],
      ["category", "music-and-audio"],
      ["copyright", "Acme Audio Ltd"],
      ["locales.en-US.shortDescription", "DJ sets, downloaded."],
      ["locales.en-US.description", "djdl for Windows downloads your DJ sets."],
      ["locales.en-US.keywords", ["dj", "sets"]],
      ["locales.en-US.features", ["Crates", "Offline playback"]],
    ]);
    expect(p.skipped.map((s: Loose) => s.field)).toEqual(["images"]);
    expect(w.ms.calls()).toEqual(["GET ", `GET submissions/${MS_PUBLISHED}`]);
    expect(w.ms.requests.every((r) => r.method === "GET")).toBe(true);
    expect(w.ms.tokenRequests).toHaveLength(1);
    expect(w.ms.tokenRequests[0]!.form.resource).toBe(
      "https://manage.devcenter.microsoft.com",
    );
  });

  it("an app with no published submission has nothing to import", async () => {
    const w = await world({ play: false, asc: false });
    delete (w.ms.application as Loose).lastPublishedApplicationSubmission;
    const r = await call(w, { source: "ms-store" });
    expect(r.status).toBe(404);
    expect(r.json.reason).toBe("not_published");
  });
});

/** What `pkey listing import --godot` uploads for the fixture project. */
const GODOT = {
  project: "djdl",
  name: "djdl",
  nameLocalized: { de: "djdl Profi", pt_BR: "djdl Pro" },
  copyright: "2026 Acme Audio Ltd",
  company: "Acme Audio",
  versions: [
    { platform: "project", value: "1.2.0" },
    { platform: "android", value: "1.2.0" },
  ],
  bundleIds: [
    { platform: "ios", value: "gg.acme.djdl" },
    { platform: "android", value: "gg.acme.djdl.android" },
  ],
  categoryHints: [
    { platform: "macos", value: "Music" },
    { platform: "android", value: "audio" },
  ],
  icons: [
    {
      slot: "icon-master",
      path: "res://icons/app_store_1024.png",
      setting: "icons/app_store_1024x1024",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      width: 1024,
      height: 1024,
    },
  ],
};

describe("the Godot project upload", () => {
  it("previews name, localized names, copyright, company and the category hint; reports ids and icons", async () => {
    const w = await world({ play: false, ms: false });
    const { status, json } = await call(w, { source: "godot", godot: GODOT });
    expect(status).toBe(200);
    const p = json.import;
    expect(p.changes.map((c: Loose) => [c.field, c.proposed])).toEqual([
      ["name", "djdl"],
      ["developerName", "Acme Audio"],
      ["category", "music"],
      ["copyright", "2026 Acme Audio Ltd"],
      ["locales.de.name", "djdl Profi"],
      ["locales.pt-BR.name", "djdl Pro"],
    ]);
    expect(p.assets).toEqual([
      expect.objectContaining({
        source: "godot",
        slot: "icon-master",
        ref: "res://icons/app_store_1024.png",
        width: 1024,
      }),
    ]);
    // Bundle ids beside the outlets' identities: the iOS one matches, the Android one is new.
    expect(
      p.identifiers.map((i: Loose) => [
        i.kind,
        i.platform,
        i.value,
        i.outlets.map((o: Loose) => [o.outlet, o.matches]),
      ]),
    ).toEqual([
      ["version", "project", "1.2.0", []],
      ["version", "android", "1.2.0", []],
      [
        "bundleId",
        "ios",
        "gg.acme.djdl",
        [
          ["app-store", true],
          ["testflight", true],
        ],
      ],
      ["bundleId", "android", "gg.acme.djdl.android", []],
    ]);
  });

  it("takes exactly what the CLI uploads for its fixture project (the CLI suite pins the same file)", async () => {
    const upload = JSON.parse(
      readFileSync(
        join(
          HERE,
          "..",
          "..",
          "cli",
          "test",
          "fixtures",
          "godot-listing.upload.json",
        ),
        "utf8",
      ),
    );
    const w = await world({ play: false, ms: false });
    const { preview, applied } = await importApplied(w, {
      source: "godot",
      godot: upload,
    });
    expect(preview.sources).toEqual([
      { source: "godot", ref: "godot-listing", ok: true },
    ]);
    expect(preview.changes.map((c: Loose) => [c.field, c.proposed])).toEqual([
      ["name", "djdl"],
      ["developerName", "Acme Audio"],
      ["category", "music"],
      ["copyright", "2026 Acme Audio Ltd"],
      ["locales.de.name", "djdl Profi"],
      ["locales.pt-BR.name", "djdl Pro"],
    ]);
    expect(preview.assets.map((a: Loose) => a.slot)).toEqual([
      "icon-master",
      "icon-adaptive-fg",
      "icon-adaptive-mono",
    ]);
    expect(applied.listing.provenance).toEqual({
      name: "godot",
      developerName: "godot",
      category: "godot",
      copyright: "godot",
    });
    expect(
      applied.locales.map((l: Loose) => [l.locale, l.name, l.source]),
    ).toEqual([
      ["de", "djdl Profi", "import"],
      ["pt-BR", "djdl Pro", "import"],
    ]);
  });

  it("refuses a malformed upload, naming the field (it is operator-supplied data)", async () => {
    const w = await world({ play: false, ms: false, asc: false });
    const bad = await call(w, {
      source: "godot",
      godot: { ...GODOT, description: "a tooltip", icons: [{ slot: "x" }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.reason).toBe("invalid_import");
    expect(bad.json.fields).toEqual(["godot.description", "godot.icons[0]"]);
  });
});

describe("applying, precedence and provenance", () => {
  it("applies only on confirmation: source import, per-field provenance, one audit row", async () => {
    const w = await world({ play: false, ms: false });
    const { preview, applied } = await importApplied(w, {
      sources: [{ source: "app-store" }, { source: "godot", godot: GODOT }],
    });
    // The App Store outranks the Godot project on every field they share.
    expect(change(preview, "name")).toMatchObject({
      proposed: "djdl",
      proposedSource: "app-store",
      others: [{ source: "godot", value: "djdl" }],
    });
    expect(change(preview, "copyright")).toMatchObject({
      proposed: "2026 Acme Audio",
      proposedSource: "app-store",
      others: [{ source: "godot", value: "2026 Acme Audio Ltd" }],
    });
    // The Godot project fills what the store does not have.
    expect(change(preview, "developerName")).toMatchObject({
      proposedSource: "godot",
    });
    expect(applied.import.applied).toBe(true);
    expect(applied.listing.source).toBe("import");
    expect(applied.listing.provenance).toMatchObject({
      name: "app-store",
      copyright: "app-store",
      developerName: "godot",
      category: "app-store",
      "urls.support": "app-store",
    });
    const en = applied.locales.find((l: Loose) => l.locale === "en-US");
    expect(en).toMatchObject({
      source: "import",
      keywords: ["dj", "music", "download"],
      provenance: { subtitle: "app-store", keywords: "app-store" },
    });
    const rows = await listingAudits(w);
    expect(rows.map((a) => a.action)).toEqual(["distribution.listing.import"]);
    expect(rows[0]!.summary).toMatch(
      /^Imported the store listing from app-store, godot: /,
    );
    expect(rows[0]!.summary).not.toContain("Acme");
  });

  it("a later, lower-ranked import keeps what a higher one wrote; a reordered field lets it win", async () => {
    const w = await world({ play: false, ms: false });
    await importApplied(w, { source: "app-store" });
    const godot = await call(w, { source: "godot", godot: GODOT });
    expect(change(godot.json.import, "copyright")).toMatchObject({
      action: "keep",
      currentSource: "app-store",
      reason: "app-store outranks godot for this field",
    });
    // The operator puts the Godot project first for copyright.
    const { token, session } = await issueSession(
      w.env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const full = `/api/products/${SLUG}/distribution/listing`;
    const put = await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method: "PUT",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          precedence: { copyright: ["godot", "app-store"] },
        }),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    );
    expect(put.status).toBe(200);
    const again = await importApplied(w, { source: "godot", godot: GODOT });
    expect(change(again.preview, "copyright")).toMatchObject({
      action: "replace",
      currentSource: "app-store",
      proposedSource: "godot",
    });
    expect(again.applied.listing.app.copyright).toBe("2026 Acme Audio Ltd");
    expect(again.applied.listing.provenance.copyright).toBe("godot");
  });

  it("a higher-ranked import replaces what a lower one wrote; the same source refreshes its own value", async () => {
    const w = await world({ ms: false, asc: false });
    await importApplied(w, {
      source: "godot",
      godot: { ...GODOT, name: "DJDL" },
    });
    w.play.store.listings.get("en-US")!.title = "djdl for Android";
    const play = await call(w, { source: "play" });
    expect(change(play.json.import, "name")).toMatchObject({
      action: "replace",
      current: "DJDL",
      currentSource: "godot",
      proposed: "djdl for Android",
      proposedSource: "play",
    });
    await importApplied(w, { source: "play" });
    w.play.store.listings.get("en-US")!.title = "djdl: DJ sets";
    const refreshed = await call(w, { source: "play" });
    expect(change(refreshed.json.import, "name")).toMatchObject({
      action: "replace",
      currentSource: "play",
      proposedSource: "play",
    });
  });

  it("several stores in one import: one diff, each field from the highest-ranked source", async () => {
    const w = await world();
    const { status, json } = await call(w, {
      sources: [
        { source: "ms-store" },
        { source: "play" },
        { source: "app-store" },
      ],
    });
    expect(status).toBe(200);
    const p = json.import;
    expect(p.sources.map((s: Loose) => [s.source, s.ok])).toEqual([
      ["ms-store", true],
      ["play", true],
      ["app-store", true],
    ]);
    expect(change(p, "locales.en-US.description")).toMatchObject({
      proposedSource: "app-store",
      others: [
        { source: "play", value: "djdl for Android downloads your DJ sets." },
        {
          source: "ms-store",
          value: "djdl for Windows downloads your DJ sets.",
        },
      ],
    });
    // Play is the only one with a short description that fits; Microsoft's fits too, but ranks
    // below Play.
    expect(change(p, "locales.en-US.shortDescription")).toMatchObject({
      proposedSource: "play",
    });
    expect(change(p, "category")).toMatchObject({
      proposed: "games-puzzle",
      others: [{ source: "ms-store", value: "music-and-audio" }],
    });
  });

  it("a store that cannot be read is reported beside the ones that could", async () => {
    const w = await world({ ms: false });
    const { status, json } = await call(w, {
      sources: [{ source: "app-store" }, { source: "ms-store" }],
    });
    expect(status).toBe(200);
    expect(json.import.sources).toEqual([
      { source: "app-store", ref: APPLE_ID, ok: true },
      {
        source: "ms-store",
        ref: null,
        ok: false,
        reason: "not_configured",
        message: expect.stringMatching(/not configured/),
      },
    ]);
    expect(w.ms.requests).toEqual([]);
    expect(w.ms.tokenRequests).toEqual([]);
  });
});

describe("the precedence planner (pure)", () => {
  const empty: CurrentListing = {
    exists: false,
    defaultLocale: null,
    app: {},
    locales: {},
    appProvenance: {},
    localeProvenance: {},
    precedence: {},
  };
  const snap = (
    source: ListingSnapshot["source"],
    app: ListingSnapshot["app"],
    locales: ListingSnapshot["locales"] = {},
  ): ListingSnapshot => ({
    source,
    ref: null,
    defaultLocale: null,
    app,
    locales,
    assets: [],
    identifiers: [],
    skipped: [],
  });

  it("refuses an over-limit value and lets the next source win, never cutting it", () => {
    const plan = planImport(
      empty,
      [
        snap("app-store", {
          name: "A name that is far too long for any store",
        }),
        snap("godot", { name: "Short" }),
      ],
      { overwrite: false, locale: null },
    );
    expect(plan.refused).toEqual([
      {
        field: "name",
        message: "name must be at most 30 characters (it is 41)",
        source: "app-store",
      },
    ]);
    expect(plan.changes).toMatchObject([
      { field: "name", proposed: "Short", proposedSource: "godot" },
    ]);
  });

  it("a source left out of a field's order fills a gap but replaces nothing", () => {
    const current: CurrentListing = {
      ...empty,
      exists: true,
      defaultLocale: "en-US",
      app: { copyright: "Mine via play" },
      appProvenance: { copyright: "play" },
      precedence: { copyright: ["play"], name: ["play"] },
    };
    const plan = planImport(
      current,
      [snap("app-store", { copyright: "Apple's", name: "Apple name" })],
      { overwrite: false, locale: null },
    );
    expect(plan.changes.map((c) => [c.field, c.action])).toEqual([
      ["name", "add"],
      ["copyright", "keep"],
    ]);
  });

  it("normalises locales and categories", () => {
    expect(normaliseLocale("en-us")).toBe("en-US");
    expect(normaliseLocale("pt_BR")).toBe("pt-BR");
    expect(normaliseLocale("zh-hans")).toBe("zh-Hans");
    expect(normaliseLocale("not a locale")).toBeNull();
    expect(canonicalCategory("GAMES_PUZZLE")).toBe("games-puzzle");
    expect(canonicalCategory("BooksAndReference_EReader")).toBe(
      "books-and-reference-e-reader",
    );
    expect(canonicalCategory("Puzzle-games")).toBe("puzzle-games");
    expect(canonicalCategory("!!")).toBeNull();
  });
});
