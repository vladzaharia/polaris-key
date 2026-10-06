/**
 * A-18m — the Apple listing push through the real admin API, against the fake App Store Connect
 * (`ascDistributeFake.ts`) and a fake upload host. Nothing here reaches Apple.
 *
 *   - `listing/text` pushes the shared listing model's Apple projection in one locale into the
 *     version localization (description, keywords packed under 100 bytes, URLs, promotional text)
 *     and the editable app info localization (name, subtitle, privacy URL); a value over a limit
 *     refuses the push and sends nothing.
 *   - `listing/screenshots` creates the set of the size class's display type, reserves each stored
 *     screenshot, PUTs its bytes from the blob store to Apple's upload operations (no
 *     `Authorization`, the exact bytes) and commits it with its MD5; a repeat sends nothing.
 *   - Never a DELETE: a screenshot already in the set is counted and left, with a deep link.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnectorPolls } from "../src/scheduled.js";
import { blobKey } from "../src/core/blobs.js";
import {
  stmtUpsertAsset,
  stmtUpsertListing,
  stmtUpsertLocale,
} from "../src/services/distribution/listing/store.js";
import {
  putUploadOperations,
  uploadOperations,
} from "../src/core/asc/upload.js";
import { AscWriteDenied } from "../src/core/asc/client.js";
import type { AscResource } from "../src/core/asc/client.js";
import { DistributeFake } from "./ascDistributeFake.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import {
  admin,
  ascWorld,
  audits,
  withFetch,
  APPLE_ID,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const BASE = "/distribution/connectors/asc";
const UPLOAD_HOST = "store-032.blobstore.apple.com";

interface Put {
  url: string;
  authorization: string | null;
  contentType: string | null;
  bytes: Uint8Array;
}

/** The fake API plus Apple's screenshot life cycle: reserve → upload operations → commit. */
class ListingFake extends DistributeFake {
  /** Where the upload operations point (a test can make it hostile). */
  uploadUrl = `https://${UPLOAD_HOST}/itms/part?sig=s3cr3t`;
  /** Split the upload into this many operations. */
  parts = 1;

  protected override route(
    method: string,
    url: URL,
    body: unknown,
  ): { status: number; body: unknown } {
    const res = super.route(method, url, body);
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "POST" && url.pathname === "/v1/appScreenshots") {
      const created = (res.body as { data: AscResource }).data;
      const size = created.attributes!.fileSize as number;
      const per = Math.ceil(size / this.parts);
      const ops = [];
      for (let offset = 0; offset < size; offset += per)
        ops.push({
          method: "PUT",
          url: `${this.uploadUrl}&o=${offset}`,
          offset,
          length: Math.min(per, size - offset),
          requestHeaders: [{ name: "Content-Type", value: "image/png" }],
        });
      created.attributes = {
        ...created.attributes,
        uploadOperations: ops,
        assetDeliveryState: { state: "AWAITING_UPLOAD", errors: [] },
      };
      const set = this.all("appScreenshotSets").find(
        (s) =>
          s.id ===
          (
            created.relationships?.appScreenshotSet?.data as
              | { id: string }
              | undefined
          )?.id,
      );
      if (!set) return { status: 409, body: { errors: [{ code: "X" }] } };
    }
    if (
      method === "PATCH" &&
      parts[1] === "appScreenshots" &&
      res.status === 200
    ) {
      const r = (res.body as { data: AscResource }).data;
      if (r.attributes?.uploaded === true)
        r.attributes = {
          ...r.attributes,
          uploadOperations: null,
          assetDeliveryState: { state: "COMPLETE", errors: [] },
        };
    }
    return res;
  }
}

interface World extends AscWorld {
  fake: ListingFake;
  r2: R2Mock;
  puts: Put[];
}

async function world(): Promise<World> {
  const fake = new ListingFake();
  const base = await ascWorld({ fake });
  const r2 = new R2Mock();
  base.env.BLOBS = asR2(r2);
  const puts: Put[] = [];
  const inner = base.fetchImpl;
  const w = {
    ...base,
    fake,
    r2,
    puts,
    fetchImpl: async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      if (u.hostname.endsWith(".blobstore.apple.com")) {
        const h = new Headers(init?.headers);
        puts.push({
          url: input,
          authorization: h.get("authorization"),
          contentType: h.get("content-type"),
          bytes: new Uint8Array(init?.body as ArrayBuffer),
        });
        return new Response(null, { status: 200 });
      }
      return inner(input, init);
    },
  } as World;
  await withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));
  w.fake.requests.length = 0;
  return w;
}

let keyN = 0;
const newKey = () =>
  `00000000-0000-4000-8000-${String(++keyN).padStart(12, "0")}`;

async function post(
  w: World,
  path: string,
  body: Record<string, unknown>,
  key: string | null = newKey(),
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await admin(
    w,
    "POST",
    `${BASE}/${path}`,
    body,
    key === null ? {} : { "Idempotency-Key": key },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const writes = (w: World) =>
  w.fake
    .writes()
    .map((r) => ({ method: r.method, path: r.path, body: r.body }));

function preparedVersion(w: World): void {
  w.fake.put({
    type: "appStoreVersions",
    id: "asv-120",
    attributes: {
      platform: "IOS",
      versionString: "1.2.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      appVersionState: "PREPARE_FOR_SUBMISSION",
      createdDate: "2026-10-01T10:00:00.000Z",
    },
    relationships: {
      app: { data: { type: "apps", id: APPLE_ID } },
      build: { data: null },
    },
  });
}

function appInfos(w: World, editable = true): void {
  w.fake.put({
    type: "appInfos",
    id: "ai-live",
    attributes: { state: "READY_FOR_DISTRIBUTION" },
    relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
  });
  if (editable)
    w.fake.put({
      type: "appInfos",
      id: "ai-next",
      attributes: { state: "PREPARE_FOR_SUBMISSION" },
      relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
    });
}

const KEYWORDS = Array.from({ length: 30 }, (_, i) => `keyword${i}`);

async function seedListing(
  w: World,
  locale: Record<string, unknown> = {},
): Promise<void> {
  await w.db.batch([
    stmtUpsertListing(
      SLUG,
      {
        name: "Dice Dungeon",
        urls: {
          support: "https://acme.example/help",
          marketing: "https://acme.example/",
          privacy: "https://acme.example/privacy",
        },
      },
      undefined,
      "admin",
      "u1",
      NOW,
      "en-US",
    ),
    stmtUpsertLocale(
      SLUG,
      "en-US",
      {
        subtitle: "Roll deep",
        description: "Roll dice. Go deeper.",
        keywords: KEYWORDS,
        promotionalText: "New floors!",
        ...locale,
      },
      "admin",
      "u1",
      NOW,
    ),
  ]);
}

function png(seed: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  return b;
}

async function seedShot(
  w: World,
  n: number,
  bytes: Uint8Array,
  opts: { locale?: string | null; alpha?: boolean; cls?: string } = {},
): Promise<{ sha256: string; md5: string }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await w.r2.put(blobKey(sha256), bytes);
  await w.db.batch([
    stmtUpsertAsset(
      SLUG,
      {
        slot: `app-store:screenshot:${opts.cls ?? "phone-portrait"}:${n}`,
        locale: opts.locale ?? null,
        blob: blobKey(sha256),
        sha256,
        width: 1320,
        height: 2868,
        alpha: opts.alpha ?? false,
        derivedFrom: "screenshot:phone-portrait",
        textAllowed: "free",
      },
      "import",
      NOW,
      "ci",
    ),
  ]);
  return { sha256, md5: createHash("md5").update(bytes).digest("hex") };
}

function localization(w: World, locale = "en-US"): void {
  w.fake.put({
    type: "appStoreVersionLocalizations",
    id: `loc-${locale}`,
    attributes: { locale },
    relationships: {
      appStoreVersion: { data: { type: "appStoreVersions", id: "asv-120" } },
    },
  });
}

describe("A-18m: listing/text", () => {
  it("pushes the projection into the version and app info localizations, once", async () => {
    const w = await world();
    preparedVersion(w);
    appInfos(w);
    await seedListing(w);
    const r = await post(w, "listing/text", {
      versionId: "asv-120",
      locale: "en-US",
    });
    expect(r.status).toBe(200);
    const sent = writes(w);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /v1/appStoreVersionLocalizations",
      "POST /v1/appInfoLocalizations",
    ]);
    const v = (
      sent[0]!.body as { data: { attributes: Record<string, string> } }
    ).data.attributes;
    expect(v).toMatchObject({
      locale: "en-US",
      description: "Roll dice. Go deeper.",
      marketingUrl: "https://acme.example/",
      supportUrl: "https://acme.example/help",
      promotionalText: "New floors!",
    });
    // Keywords: packed under Apple's 100 bytes, comma-joined; the rest is an amber warning.
    const keywords = v.keywords ?? "";
    expect(new TextEncoder().encode(keywords).length).toBeLessThanOrEqual(100);
    expect(keywords.split(",").length).toBeGreaterThan(5);
    expect(keywords.split(",")).toEqual(
      KEYWORDS.slice(0, keywords.split(",").length),
    );
    expect(v).not.toHaveProperty("whatsNew");
    const i = sent[1]!.body as {
      data: {
        attributes: Record<string, string>;
        relationships: Record<string, unknown>;
      };
    };
    expect(i.data.attributes).toEqual({
      locale: "en-US",
      name: "Dice Dungeon",
      subtitle: "Roll deep",
      privacyPolicyUrl: "https://acme.example/privacy",
    });
    // The editable app info, never the live one.
    expect(i.data.relationships).toEqual({
      appInfo: { data: { type: "appInfos", id: "ai-next" } },
    });
    expect(
      (r.json.warnings as { issue: string }[]).map((x) => x.issue),
    ).toEqual(["packed"]);
    const acts = (await audits(w.db))
      .map((a) => a.action)
      .filter((a) => a.startsWith("distribution.asc.listing"));
    expect(acts).toEqual([
      "distribution.asc.listing.version_text",
      "distribution.asc.listing.app_info_text",
    ]);

    // A new intent finds both localizations already as the model has them: nothing is sent.
    w.fake.requests.length = 0;
    const again = await post(w, "listing/text", {
      versionId: "asv-120",
      locale: "en-US",
    });
    expect(again.status).toBe(200);
    expect(writes(w)).toEqual([]);
    expect((again.json.version as { outcome: string }).outcome).toBe(
      "existing",
    );

    // A changed description PATCHes the existing localization.
    await w.db.batch([
      stmtUpsertLocale(
        SLUG,
        "en-US",
        { description: "Roll dice. Go even deeper." },
        "admin",
        "u1",
        NOW,
      ),
    ]);
    w.fake.requests.length = 0;
    expect(
      (await post(w, "listing/text", { versionId: "asv-120", locale: "en-US" }))
        .status,
    ).toBe(200);
    expect(writes(w).map((s) => `${s.method} ${s.path}`)).toEqual([
      expect.stringMatching(/^PATCH \/v1\/appStoreVersionLocalizations\//),
    ]);
  });

  it("refuses a listing over Apple's limits and sends nothing (never a cut)", async () => {
    const w = await world();
    preparedVersion(w);
    appInfos(w);
    await seedListing(w, { name: "N".repeat(31) });
    const r = await post(w, "listing/text", {
      versionId: "asv-120",
      locale: "en-US",
    });
    expect(r.status).toBe(422);
    expect(r.json.reason).toBe("listing_does_not_fit");
    expect(r.json.fields).toEqual(["name"]);
    expect(writes(w)).toEqual([]);
  });

  it("refuses without an editable app info, a listing, or an Idempotency-Key", async () => {
    const w = await world();
    preparedVersion(w);
    appInfos(w, false);
    const none = await post(w, "listing/text", {
      versionId: "asv-120",
      locale: "en-US",
    });
    expect(none.json.reason).toBe("no_listing");
    await seedListing(w);
    const r = await post(w, "listing/text", {
      versionId: "asv-120",
      locale: "en-US",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("app_info_not_editable");
    const noKey = await post(
      w,
      "listing/text",
      { versionId: "asv-120", locale: "en-US" },
      null,
    );
    expect(noKey.status).toBe(428);
    const foreign = await post(w, "listing/text", {
      versionId: "asv-110",
      locale: "en-US",
    });
    expect(foreign.json.reason).toBe("version_not_editable");
    expect(writes(w)).toEqual([]);
  });
});

describe("A-18m: listing/screenshots", () => {
  it("creates the set, reserves, uploads the exact bytes without a credential, commits with the MD5", async () => {
    const w = await world();
    preparedVersion(w);
    localization(w);
    w.fake.parts = 3;
    const a = png(1, 5000);
    const b = png(2, 3000);
    const sa = await seedShot(w, 1, a);
    const sb = await seedShot(w, 2, b);
    // Another locale's screenshots are not this locale's.
    await seedShot(w, 1, png(9), { locale: "de-DE" });
    const r = await post(w, "listing/screenshots", {
      versionId: "asv-120",
      locale: "en-US",
      sizeClass: "phone-portrait",
    });
    expect(r.status).toBe(200);
    expect(r.json.displayType).toBe("APP_IPHONE_67");
    const sent = writes(w);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /v1/appScreenshotSets",
      "POST /v1/appScreenshots",
      expect.stringMatching(/^PATCH \/v1\/appScreenshots\//),
      "POST /v1/appScreenshots",
      expect.stringMatching(/^PATCH \/v1\/appScreenshots\//),
    ]);
    expect(
      (sent[1]!.body as { data: { attributes: unknown } }).data.attributes,
    ).toEqual({ fileName: `${sa.sha256.slice(0, 40)}.png`, fileSize: 5000 });
    expect(
      (sent[2]!.body as { data: { attributes: unknown } }).data.attributes,
    ).toEqual({ uploaded: true, sourceFileChecksum: sa.md5 });
    expect(
      (sent[4]!.body as { data: { attributes: unknown } }).data.attributes,
    ).toEqual({ uploaded: true, sourceFileChecksum: sb.md5 });
    // Three parts per file, in order, reassembling the stored bytes exactly; no Authorization.
    expect(w.puts).toHaveLength(6);
    for (const p of w.puts) {
      expect(p.authorization).toBeNull();
      expect(p.contentType).toBe("image/png");
    }
    const join = (ps: Put[]) =>
      Buffer.concat(ps.map((p) => Buffer.from(p.bytes)));
    expect(join(w.puts.slice(0, 3)).equals(Buffer.from(a))).toBe(true);
    expect(join(w.puts.slice(3)).equals(Buffer.from(b))).toBe(true);
    expect(w.fake.requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(r.json.otherScreenshots).toBe(0);
    expect(r.json.manage).toBeNull();
    const acts = (await audits(w.db))
      .map((x) => x.action)
      .filter((x) => x.startsWith("distribution.asc.listing"));
    expect(acts).toEqual([
      "distribution.asc.listing.screenshot_set",
      "distribution.asc.listing.screenshot",
      "distribution.asc.listing.screenshot",
    ]);

    // Again, under a new intent: the set and both screenshots are found; nothing is sent.
    w.fake.requests.length = 0;
    w.puts.length = 0;
    const again = await post(w, "listing/screenshots", {
      versionId: "asv-120",
      locale: "en-US",
      sizeClass: "phone-portrait",
    });
    expect(again.status).toBe(200);
    expect(writes(w)).toEqual([]);
    expect(w.puts).toEqual([]);
  });

  it("never deletes: a screenshot the listing lacks is counted and left, with a deep link", async () => {
    const w = await world();
    preparedVersion(w);
    localization(w);
    w.fake.put({
      type: "appScreenshotSets",
      id: "set-old",
      attributes: { screenshotDisplayType: "APP_IPHONE_67" },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: "loc-en-US" },
        },
      },
    });
    w.fake.put({
      type: "appScreenshots",
      id: "shot-old",
      attributes: {
        fileName: "old.png",
        sourceFileChecksum: "0".repeat(32),
        assetDeliveryState: { state: "COMPLETE" },
      },
      relationships: {
        appScreenshotSet: {
          data: { type: "appScreenshotSets", id: "set-old" },
        },
      },
    });
    await seedShot(w, 1, png(3));
    const r = await post(w, "listing/screenshots", {
      versionId: "asv-120",
      locale: "en-US",
      sizeClass: "phone-portrait",
    });
    expect(r.status).toBe(200);
    expect(r.json.setId).toBe("set-old");
    expect(r.json.otherScreenshots).toBe(1);
    expect(r.json.manage).toBe(
      `https://appstoreconnect.apple.com/apps/${APPLE_ID}/distribution`,
    );
    expect(
      w.fake.requests.filter(
        (q) => q.method === "DELETE" || q.path.includes("/relationships/"),
      ),
    ).toEqual([]);
    expect(w.fake.get("appScreenshots", "shot-old")).toBeDefined();
  });

  it("refuses before any write: no localization, alpha, too many, nothing stored, a bad class", async () => {
    const w = await world();
    preparedVersion(w);
    const body = {
      versionId: "asv-120",
      locale: "en-US",
      sizeClass: "phone-portrait",
    };
    expect((await post(w, "listing/screenshots", body)).json.reason).toBe(
      "no_screenshots",
    );
    await seedShot(w, 1, png(4));
    expect((await post(w, "listing/screenshots", body)).json.reason).toBe(
      "localization_missing",
    );
    expect(
      (
        await post(w, "listing/screenshots", {
          ...body,
          sizeClass: "wear",
        })
      ).json.reason,
    ).toBe("invalid_body");
    localization(w);
    await seedShot(w, 2, png(5), { alpha: true });
    expect((await post(w, "listing/screenshots", body)).json.reason).toBe(
      "screenshot_has_alpha",
    );
    for (let n = 2; n <= 11; n++) await seedShot(w, n, png(10 + n));
    expect((await post(w, "listing/screenshots", body)).json.reason).toBe(
      "too_many_screenshots",
    );
    expect(writes(w)).toEqual([]);
    expect(w.puts).toEqual([]);
  });

  it("an upload operation off Apple's hosts is refused: no byte leaves, nothing is committed", async () => {
    const w = await world();
    preparedVersion(w);
    localization(w);
    w.fake.uploadUrl = "https://attacker.example/part?sig=s3cr3t";
    await seedShot(w, 1, png(6));
    const r = await post(w, "listing/screenshots", {
      versionId: "asv-120",
      locale: "en-US",
      sizeClass: "phone-portrait",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("write_denied");
    expect(JSON.stringify(r.json)).not.toContain("s3cr3t");
    expect(w.puts).toEqual([]);
    expect(writes(w).filter((s) => s.method === "PATCH")).toEqual([]);
  });
});

describe("A-18m: upload operations", () => {
  const op = (offset: number, length: number, extra = {}) => ({
    method: "PUT",
    url: `https://${UPLOAD_HOST}/p?o=${offset}`,
    offset,
    length,
    requestHeaders: [{ name: "Content-Type", value: "image/png" }],
    ...extra,
  });

  it("must cover the file exactly, in order", () => {
    expect(uploadOperations([op(0, 5), op(5, 5)], 10)).toHaveLength(2);
    expect(uploadOperations([op(0, 5)], 10)).toBeNull();
    expect(uploadOperations([op(0, 5), op(4, 6)], 10)).toBeNull();
    expect(uploadOperations([op(5, 5), op(0, 5)], 10)).toBeNull();
    expect(uploadOperations([], 0)).toBeNull();
    expect(
      uploadOperations(
        [op(0, 10, { requestHeaders: [{ name: "X", value: "a\r\nb" }] })],
        10,
      ),
    ).toBeNull();
  });

  it("refuses a credential header or another content type before reading a byte", async () => {
    let reads = 0;
    const send = (headers: { name: string; value: string }[]) =>
      putUploadOperations({
        operations: uploadOperations(
          [op(0, 4, { requestHeaders: headers })],
          4,
        )!,
        upload: { contentType: "image/png", size: 4 },
        read: async () => {
          reads++;
          return new ArrayBuffer(4);
        },
        fetchImpl: async () => new Response(null, { status: 200 }),
      });
    for (const h of [
      [{ name: "Authorization", value: "Bearer x" }],
      [{ name: "Cookie", value: "a=b" }],
      [{ name: "Content-Type", value: "text/html" }],
    ])
      await expect(send(h)).rejects.toBeInstanceOf(AscWriteDenied);
    expect(reads).toBe(0);
    await expect(
      send([{ name: "Content-Type", value: "image/png" }]),
    ).resolves.toBeUndefined();
    expect(reads).toBe(1);
  });

  it("a redirect or an error from the upload host fails, naming no URL", async () => {
    for (const res of [
      new Response(null, { status: 302, headers: { location: "https://x" } }),
      new Response("nope", { status: 500 }),
    ]) {
      const p = putUploadOperations({
        operations: uploadOperations([op(0, 4)], 4)!,
        upload: { contentType: "image/png", size: 4 },
        read: async () => new ArrayBuffer(4),
        fetchImpl: async () => res,
      });
      await expect(p).rejects.toThrow(/upload operation/);
      await expect(p).rejects.not.toThrow(/blobstore/);
    }
  });
});
