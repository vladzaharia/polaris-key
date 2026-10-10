/**
 * HA-12: discovery's `core.presentation` (WIRE-CONTRACT-V4 §5.5, plans/HA-12.md §2.3 and §9).
 *
 *   - the member is emitted only when something beyond the name resolves, and omitted otherwise;
 *   - a listing-only product (its `listing.icon` copy and `tintColor`) emits it;
 *   - the manifest's accents win over `tintColor`, and the `presentation.icon` copy over
 *     `listing.icon`'s, as the image host's `/icon` alias chooses;
 *   - only hash-verifiable bytes: no hosted copy, the kill switch off or no image host means no
 *     icon, and the manifest ref, a developer URL or the `/media` proxy never appear;
 *   - an empty ladder names the original alone;
 *   - the fixed point: client-core's `parsePresentation` returns what the Worker emitted;
 *   - the portal's tint follows the accent, and §12.7.2's client record does not change;
 *   - the column is manifest-only: link and resync write it (audited as `core.presentation`), the
 *     console cannot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { parsePresentation } from "@polaris-key/client-core/presentation";
import { PRESENTATION_ICON_TYPES } from "@polaris-key/protocol/core";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, TEST_KEK } from "./seed.js";
import { envFor } from "./releaseRoutesFixture.js";
import { seedHosted } from "./hostedFixture.js";
import { portalHooksFor } from "./portalHarness.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { withDefaultHead } from "./githubHead.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import {
  loadProduct,
  loadProductPublic,
  parseStoredPresentation,
  serializePresentation,
} from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { resolvePresentation } from "../src/core/presentation.js";
import { hostedImages } from "../src/core/hostedImages.js";
import { IMG_HOST_TYPES } from "../src/core/imgHost.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { writeSetting } from "../src/core/settings/write.js";
import { presentationFor } from "../src/services/identity/portal/library.js";
import { clientRecordFor } from "../src/services/identity/passthrough/client.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { parseManifest } from "@polaris-key/manifest";
import {
  ensureSystemProduct,
  linkSystemProduct,
} from "../src/admin/systemProduct.js";

// The kill switch, controllable per test (HA-10's settings read, `assetHostingEnabled(env, db)`).
const hosting = vi.hoisted(() => ({ on: true }));
vi.mock("../src/core/assetHosting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/assetHosting.js")>()),
  assetHostingEnabled: async () => hosting.on,
}));

const IMG = "https://img.example.test";
const DEV_ICON = "https://dev.example.com/brand/icon.png";
const A = "a".repeat(64);
const B = "b".repeat(64);
/** `hostedFixture.ts`'s variant hash for width `w`. */
const vh = (w: number) => w.toString(16).padStart(64, "f");
const ladder = (...ws: number[]) => ws.map((w) => ({ w, sha256: vh(w) }));

beforeEach(() => {
  hosting.on = true;
});

function envWith(img: string | null = IMG): Env {
  const env = makeEnv(new KvMock(), ["tidewater"]);
  if (img !== null) env.IMG_ORIGIN = img;
  return env;
}

/** `tidewater`, with Distribution on and `listing` as its root listing (none: Distribution off). */
async function tidewater(
  db: Db,
  listing: Record<string, unknown> | null,
  presentation: Record<string, unknown> | null = null,
): Promise<void> {
  await seedProduct(db, "tidewater");
  await setServices(
    db,
    "tidewater",
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: listing !== null },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  if (listing !== null)
    await db.run(
      "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
      "tidewater",
      JSON.stringify(listing),
      NOW,
    );
  if (presentation !== null)
    await db.run(
      "UPDATE products SET presentation_json = ? WHERE slug = 'tidewater'",
      JSON.stringify(presentation),
    );
}

async function discover(
  env: Env,
  db: Db,
): Promise<{ res: Response; text: string; doc: Record<string, any> }> {
  const product = (await loadProduct(env, db, "tidewater"))!;
  const res = await handleDiscovery(
    new Request(
      "https://key.plrs.im/tidewater/.well-known/polaris.json",
    ) as unknown as Request,
    env,
    db,
    product,
    SERVICES,
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return { res, text, doc: JSON.parse(text) as Record<string, any> };
}

/** The member, after asserting the fixed point: an SDK's parse returns it unchanged. */
async function member(env: Env, db: Db): Promise<unknown> {
  const { doc } = await discover(env, db);
  const emitted = doc.core.presentation as unknown;
  if (emitted !== undefined)
    expect(parsePresentation(doc.core, doc as { product: string })).toEqual(
      emitted,
    );
  return emitted;
}

describe("discovery's core.presentation", () => {
  it("a product with no presentation omits the member: today's core block", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, null);
    const { doc, res } = await discover(env, db);
    expect(Object.keys(doc.core).sort()).toEqual([
      "compat",
      "endpoints",
      "registration",
    ]);
    // Q4: no ETag; the cache window is what bounds a change.
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("a listing with only a name (or a name and art with no hosted copy) omits it too", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, {
      name: "Tidewater",
      icon: { kind: "url", src: DEV_ICON },
    });
    const { doc, text } = await discover(env, db);
    expect(doc.core.presentation).toBeUndefined();
    expect(text).not.toContain("dev.example.com");
  });

  it("a listing-only product (listing.icon's copy and tintColor, no manifest presentation) emits it", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, {
      name: "Tidewater",
      developerName: "Fennick Studio",
      tintColor: "#2ED6E6",
      icon: { kind: "url", src: DEV_ICON },
    });
    await seedHosted(db, "tidewater", "listing.icon", {
      sha256: B,
      width: 512,
      height: 512,
      widths: [128, 64, 256],
    });
    expect(await member(env, db)).toEqual({
      name: "Tidewater",
      developerName: "Fennick Studio",
      accent: "#2ed6e6",
      icon: {
        sha256: B,
        contentType: "image/png",
        width: 512,
        height: 512,
        original: `${IMG}/tidewater/a/${B}`,
        url: `${IMG}/tidewater/a/${B}/{w}.webp`,
        sizes: ladder(64, 128, 256),
      },
    });
  });

  it("the manifest's accents win over tintColor, and presentation.icon's copy over listing.icon's", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(
      db,
      { name: "Tidewater", tintColor: "#ABCDEF" },
      {
        icon: { kind: "url", src: DEV_ICON },
        accent: "#2ED6E6",
        accentDark: "#5EE6F0",
      },
    );
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      contentType: "image/webp",
      widths: [64],
    });
    await seedHosted(db, "tidewater", "listing.icon", { sha256: B });
    const { doc, text } = await discover(env, db);
    expect(doc.core.presentation).toEqual({
      name: "Tidewater",
      accent: "#2ed6e6",
      accentDark: "#5ee6f0",
      icon: {
        sha256: A,
        contentType: "image/webp",
        original: `${IMG}/tidewater/a/${A}`,
        url: `${IMG}/tidewater/a/${A}/{w}.webp`,
        sizes: ladder(64),
      },
    });
    // The manifest's icon ref (a developer URL here, a repo path elsewhere) never leaves the
    // Worker, and neither does the portal's proxy or the image host's redirecting alias.
    expect(text).not.toContain("dev.example.com");
    expect(text).not.toContain("/media/");
    expect(text).not.toContain("/tidewater/icon");
  });

  it("without Distribution, the manifest's presentation alone: the product's own name", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, null, { accentDark: "#000000" });
    expect(await member(env, db)).toEqual({
      name: "tidewater",
      accentDark: "#000000",
    });
  });

  it("an empty ladder (no Images binding): the original alone, sizes [] and no url", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, { name: "Tidewater" });
    await seedHosted(db, "tidewater", "listing.icon", {
      sha256: B,
      contentType: "image/avif",
    });
    expect(await member(env, db)).toEqual({
      name: "Tidewater",
      icon: {
        sha256: B,
        contentType: "image/avif",
        original: `${IMG}/tidewater/a/${B}`,
        sizes: [],
      },
    });
  });

  it("a stale re-pull keeps its last good copy, as the image host does; a pending first pull has none", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, { name: "Tidewater", tintColor: "#111111" });
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: null,
      status: "pending",
    });
    await seedHosted(db, "tidewater", "listing.icon", {
      sha256: B,
      status: "stale",
    });
    expect(
      ((await member(env, db)) as { icon: { sha256: string } }).icon.sha256,
    ).toBe(B);
  });

  it("the kill switch off, or no image host: the icon goes and the rest of the member stays", async () => {
    for (const setup of [
      () => {
        hosting.on = false;
        return envWith();
      },
      () => envWith(null),
      () => envWith("not a url"),
    ]) {
      hosting.on = true;
      const db = makeTestDb();
      const env = setup();
      await tidewater(db, { name: "Tidewater", developerName: "Fennick" });
      await seedHosted(db, "tidewater", "listing.icon", {
        sha256: B,
        widths: [64],
      });
      const { doc, text } = await discover(env, db);
      expect(doc.core.presentation).toEqual({
        name: "Tidewater",
        developerName: "Fennick",
      });
      expect(text).not.toContain("/media/");
    }
    // And with nothing else to show, the member is omitted altogether.
    hosting.on = false;
    const db = makeTestDb();
    await tidewater(db, { name: "Tidewater" });
    await seedHosted(db, "tidewater", "listing.icon", { sha256: B });
    expect((await discover(envWith(), db)).doc.core.presentation).toBe(
      undefined,
    );
  });

  it("emits only what every SDK keeps: a field §5.5 drops never leaves the Worker", async () => {
    const db = makeTestDb();
    const env = envWith();
    // A C1 control in the developer and a name over 1024 bytes are fine in a listing, not in §5.5.
    await tidewater(db, {
      name: "T".repeat(1025),
      developerName: "Fennick\u0085",
      tintColor: "#123456",
    });
    expect(await member(env, db)).toEqual({
      name: "tidewater",
      accent: "#123456",
    });
    // Nothing left beyond the name: omitted.
    await db.run(
      "UPDATE dist_listing SET listing_json = ? WHERE product = 'tidewater'",
      JSON.stringify({ developerName: "Fennick\u0085" }),
    );
    expect(await member(env, db)).toBeUndefined();
  });

  it("a failed read never fails discovery: the member is simply absent", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, null, { accent: "#123456" });
    const product = (await loadProductPublic(db, "tidewater"))!;
    expect(
      await resolvePresentation({
        product,
        env,
        db,
        hooks: {
          delivery: () =>
            ({
              listing: () => Promise.reject(new Error("D1_ERROR")),
            }) as never,
        },
      }),
    ).toBeNull();
  });
});

describe("hostedImages: the sniffed type and each width's own hash (HA-12)", () => {
  it("carries contentType and the deduplicated, ascending ladder; widths follow it", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, null);
    await seedHosted(db, "tidewater", "listing.icon", {
      sha256: B,
      contentType: "image/jpeg",
      widths: [256, 64],
    });
    // A duplicate width: the first entry wins.
    await db.run(
      "UPDATE hosted_assets SET variants_json = ? WHERE product = 'tidewater' AND slot = 'listing.icon'",
      JSON.stringify([
        { w: 256, format: "image/webp", sha256: vh(256), size: 5 },
        { w: 64, format: "image/webp", sha256: vh(64), size: 5 },
        { w: 256, format: "image/webp", sha256: A, size: 5 },
      ]),
    );
    const copy = (
      await hostedImages(env, db, "tidewater", ["listing.icon"])
    ).get("listing.icon")!;
    expect(copy.contentType).toBe("image/jpeg");
    expect(copy.variants).toEqual(ladder(64, 256));
    expect(copy.widths).toEqual([64, 256]);
  });

  it("the protocol's icon types are exactly the image host's", () => {
    expect(new Set(PRESENTATION_ICON_TYPES)).toEqual(new Set(IMG_HOST_TYPES));
  });
});

describe("the portal shares the text half; its art and the client record do not change", () => {
  it("the portal's tint follows a declared accent, else the listing's tintColor", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, { name: "Tidewater", tintColor: "#ABCDEF" });
    const at = async () =>
      presentationFor(
        env,
        db,
        (await loadProductPublic(db, "tidewater"))!,
        portalHooksFor(env, db),
        NOW,
        "library",
      );
    expect((await at()).tintColor).toBe("#abcdef");
    await db.run(
      "UPDATE products SET presentation_json = ? WHERE slug = 'tidewater'",
      serializePresentation({ accent: "#123456" }),
    );
    expect(await at()).toMatchObject({
      name: "Tidewater",
      tintColor: "#123456",
    });
  });

  it("the client record (§12.7.2) is unchanged by a presentation, and keeps /media/<p>/icon", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, {
      name: "Tidewater",
      icon: { kind: "url", src: DEV_ICON },
    });
    const record = async () =>
      clientRecordFor(
        env,
        db,
        (await loadProductPublic(db, "tidewater"))!,
        "web",
        NOW,
        portalHooksFor(env, db),
      );
    const before = await record();
    await db.run(
      "UPDATE products SET presentation_json = ? WHERE slug = 'tidewater'",
      serializePresentation({
        icon: { kind: "url", src: DEV_ICON },
        accent: "#123456",
      }),
    );
    expect(await record()).toEqual(before);
    // With a hosted copy, the same-origin path the contract names, versioned by the copy.
    await seedHosted(db, "tidewater", "listing.icon", { sha256: B });
    expect((await record()).iconUrl).toBe(
      `/media/tidewater/icon?v=${B.slice(0, 16)}`,
    );
  });
});

describe("products.presentation_json: manifest-only", () => {
  it("round-trips, and reads anything else defensively as none", () => {
    const declared = {
      icon: { kind: "repo" as const, src: "assets/icon.png", sha256: A },
      accent: "#2ED6E6",
      accentDark: "#5ee6f0",
    };
    const stored = serializePresentation(declared)!;
    expect(parseStoredPresentation(stored)).toEqual(declared);
    expect(serializePresentation(undefined)).toBeNull();
    expect(serializePresentation({})).toBeNull();
    for (const bad of [
      null,
      "",
      "{",
      "[]",
      '"#123456"',
      "{}",
      '{"accent":"teal"}',
      '{"icon":{"kind":"url","src":"http://x.example/i.png"}}',
      // A stored ref whose kind disagrees with its src is not one serializePresentation wrote.
      '{"icon":{"kind":"url","src":"assets/icon.png"}}',
    ])
      expect(parseStoredPresentation(bad), String(bad)).toBeNull();
    expect(
      parseStoredPresentation('{"accent":"#123456","accentDark":7,"x":1}'),
    ).toEqual({ accent: "#123456" });
  });

  it("the console cannot write it (decode-only adapter, manifest ownership)", async () => {
    const db = makeTestDb();
    const env = envWith();
    await tidewater(db, null);
    const res = await writeSetting(
      { env, db, registry: SETTINGS },
      { key: "core.presentation", value: { accent: "#123456" } },
      {
        actor: { sub: "u1", name: null, email: null },
        origin: "console",
        now: NOW,
        product: "tidewater",
        strict: false,
      },
    );
    expect(res.ok).toBe(false);
    expect(
      (
        await db.first<{ p: string | null }>(
          "SELECT presentation_json AS p FROM products WHERE slug = 'tidewater'",
        )
      )?.p,
    ).toBeNull();
  });
});

// ── link and resync write the column (a stubbed GitHub, as settingsClaims.test.ts does) ──────

function productJson(presentation?: Record<string, unknown>): string {
  return JSON.stringify({
    slug: "acme",
    name: "Acme",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: "acme-admins",
    profiles: [{ id: "standard", name: "standard" }],
    tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
    provisioning: [],
    ...(presentation ? { presentation } : {}),
  });
}

function github(presentation?: Record<string, unknown>): FetchImpl {
  const docs: Record<string, string> = {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": productJson(presentation),
    ".pkey/release.json": JSON.stringify({
      release: {
        ghOwner: "acme-org",
        ghRepo: "acme-app",
        binaryName: "acme",
        betaBranch: "main",
        summaryMarker: "pkey:summary",
      },
    }),
  };
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(docs))
        if (url.includes(`/contents/${path}`))
          return new Response(
            JSON.stringify({
              content: Buffer.from(body, "utf8").toString("base64"),
              encoding: "base64",
            }),
            { status: 200 },
          );
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("link and resync write products.presentation_json", () => {
  it("link stores the manifest's presentation; resync rewrites it, audited as core.presentation; dropping it clears it", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.GITHUB_APP_ID = "12345";
    env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
    const ingest = manifestIngestFor(SERVICES);
    const stored = async () =>
      (
        await db.first<{ p: string | null }>(
          "SELECT presentation_json AS p FROM products WHERE slug = 'acme'",
        )
      )?.p ?? null;
    const audits = async () =>
      (
        await db.all<{ target_id: string; summary: string }>(
          "SELECT target_id, summary FROM audit WHERE product = 'acme' AND action = 'setting.resync' ORDER BY at, id",
        )
      ).filter((a) => a.target_id === "core.presentation");

    const linked = await linkRepo(
      env,
      db,
      "acme-org/acme-app",
      NOW,
      github({ accent: "#2ED6E6" }),
      ingest,
    );
    expect(linked.ok).toBe(true);
    expect(parseStoredPresentation(await stored())).toEqual({
      accent: "#2ED6E6",
    });
    expect((await loadProduct(env, db, "acme"))!.presentation).toEqual({
      accent: "#2ED6E6",
    });

    // Unchanged: no audit row.
    let res = await resyncRepo(
      env,
      db,
      "acme",
      NOW + 60,
      github({ accent: "#2ED6E6" }),
      ingest,
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await audits()).toEqual([]);

    res = await resyncRepo(
      env,
      db,
      "acme",
      NOW + 120,
      github({ accent: "#000000", accentDark: "#FFFFFF" }),
      ingest,
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(parseStoredPresentation(await stored())).toEqual({
      accent: "#000000",
      accentDark: "#FFFFFF",
    });
    expect(await audits()).toHaveLength(1);

    res = await resyncRepo(env, db, "acme", NOW + 180, github(), ingest);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await stored()).toBeNull();
    const rows = await audits();
    expect(rows).toHaveLength(2);
    // Never filed under the unkeyed rows' `core.adminGroup` fallback.
    expect(rows.every((r) => r.target_id === "core.presentation")).toBe(true);
  });
});

describe("linkSystemProduct writes products.presentation_json", () => {
  it("the deploy hook stores the platform manifest's presentation, and NULL when it declares none", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.PLATFORM_KEK = TEST_KEK;
    expect((await ensureSystemProduct(env, db, "u1", NOW)).ok).toBe(true);
    // The monorepo's own `.pkey/`, as the deploy hook applies it.
    const root = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "..",
      ".pkey",
    );
    const files = {
      product: readFileSync(join(root, "product.yaml"), "utf8"),
      schema: readFileSync(join(root, "schema.yaml"), "utf8"),
      release: readFileSync(join(root, "release.yaml"), "utf8"),
    };
    const parsed = parseManifest(files);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const repo = {
      repository: "vladzaharia/polaris-key",
      repositoryId: 1,
      repositoryOwnerId: 2,
    };
    const stored = async () =>
      (
        await db.first<{ p: string | null }>(
          "SELECT presentation_json AS p FROM products WHERE slug = ?",
          SYSTEM_PRODUCT_SLUG,
        )
      )?.p ?? null;

    const declared = { accent: "#123456", accentDark: "#ABCDEF" };
    const linked = await linkSystemProduct(
      db,
      { ...parsed.manifest, presentation: declared },
      repo,
      { files, sha: null },
      NOW + 1,
    );
    expect(linked.ok).toBe(true);
    expect(parseStoredPresentation(await stored())).toEqual(declared);

    const { presentation: _dropped, ...undeclared } = parsed.manifest;
    const again = await linkSystemProduct(
      db,
      undeclared,
      repo,
      { files, sha: null },
      NOW + 2,
    );
    expect(again.ok).toBe(true);
    expect(await stored()).toBeNull();
  });
});
