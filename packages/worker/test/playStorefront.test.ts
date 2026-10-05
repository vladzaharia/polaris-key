/**
 * A-18e — the Google Play storefront adapter against the fake Google: the gate's Play rules (what
 * passes, what is refused before any token), and the runtime (`connectors/play/storefront.ts`):
 * one edit under the lease, every write a ledger step with its natural-key pre-read, typed
 * confirmation for production and price changes, no image deletes (decision 6), tester groups
 * stored as a count, the budget, and the reads (listing, status, the app verifier).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkPlayRequest,
  PLAY_EDIT_SCOPE,
  PlayWriteDenied,
} from "../src/core/storefront/rules/googlePlay.js";
import { GOOGLE_PLAY_ADAPTER } from "../src/core/storefront/stores/googlePlay.js";
import { storeMeter } from "../src/core/storefront/budget.js";
import { renderDeepLink } from "../src/core/storefront/deeplinks.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  GoogleApiClient,
} from "../src/services/distribution/connectors/play/client.js";
import {
  acquirePlayEditLease,
  readPlayEditLease,
} from "../src/services/distribution/connectors/play/lease.js";
import {
  isPlayRefusal,
  PlayEditLeaseLost,
  PlayEditSession,
  playCommit,
  playCreateClosedTrack,
  playSetReleaseNotes,
  playSetTesters,
  playStatus,
  playTypedConfirmation,
  playUploadImage,
  playUpsertOneTimeProduct,
  playWriteDetails,
  playWriteListing,
  readPlayListing,
  verifyPlayApp,
  withPlayEditSession,
  type PlayImageSource,
  type PlayStoreContext,
} from "../src/services/distribution/connectors/play/storefront.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProductPublic } from "../src/core/products.js";
import { SERVICES } from "../src/mount.js";
import type { AdminSession } from "../src/admin/session.js";
import {
  playWorld,
  NOW,
  PLAY_PACKAGE,
  SLUG,
  type PlayWorld,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const APP = `/androidpublisher/v3/applications/${PLAY_PACKAGE}`;
const SESSION: AdminSession = {
  sub: "u1",
  name: "Ada",
  email: "ada@example.test",
  groups: ["platform-admins"],
  csrf: "c",
  exp: NOW + 3600,
};

let keyN = 0;
const key = () =>
  `${(++keyN).toString(16).padStart(8, "0")}-1111-4222-8333-944455556666`;

async function ctxFor(w: PlayWorld): Promise<PlayStoreContext> {
  const product = (await loadProductPublic(w.db, SLUG))!;
  return {
    env: w.env,
    db: w.db,
    product: SLUG,
    hooks: buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    }),
    session: SESSION,
    now: NOW,
    fetchImpl: w.fetchImpl,
    clock: () => NOW,
  };
}

async function session(w: PlayWorld): Promise<PlayEditSession> {
  const s = await PlayEditSession.begin(await ctxFor(w));
  if (isPlayRefusal(s)) throw new Error(s.message);
  return s;
}

async function image(bytes: number, fill = 1): Promise<PlayImageSource> {
  const data = new Uint8Array(bytes).fill(fill);
  const sha256 = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    contentType: "image/png",
    size: bytes,
    sha256,
    read: async () => data,
  };
}

const rows = (w: PlayWorld) =>
  w.db.all<{
    op: string;
    natural_key: string;
    state: string;
    before_json: string | null;
    after_json: string | null;
  }>(
    "SELECT op, natural_key, state, before_json, after_json FROM store_operations WHERE store = 'google-play' ORDER BY rowid",
  );

// ── The gate ─────────────────────────────────────────────────────────────────────────────────

describe("the Play gate", () => {
  const commit =
    (q: Record<string, string>, ctx = {}) =>
    () =>
      checkPlayRequest("POST", `${APP}/edits/1:commit`, { query: q }, ctx);

  it("commits only with ERROR_IF_IN_REVIEW, and plainly only for a testing edit or a rollout control", () => {
    const q = { changesInReviewBehavior: "ERROR_IF_IN_REVIEW" };
    expect(commit(q, { resourceState: PLAY_EDIT_SCOPE.testing })).not.toThrow();
    expect(
      commit(q, { resourceState: PLAY_EDIT_SCOPE.rolloutControl }),
    ).not.toThrow();
    expect(commit(q)).toThrow(/typed_confirmation_required/);
    expect(
      commit(
        { changesInReviewBehavior: "CANCEL_IN_REVIEW_AND_SUBMIT" },
        {
          resourceState: PLAY_EDIT_SCOPE.testing,
        },
      ),
    ).toThrow(/value_not_allowed/);
    expect(commit({}, { resourceState: PLAY_EDIT_SCOPE.testing })).toThrow(
      /invalid_body/,
    );
  });

  it("listing text: declared keys only, a YouTube video, the path's language", () => {
    const put = (json: unknown, lang = "en-US") =>
      checkPlayRequest("PATCH", `${APP}/edits/1/listings/${lang}`, { json });
    expect(() => put({ title: "djdl" })).not.toThrow();
    expect(() => put({ title: "x".repeat(31) })).toThrow(/value_not_allowed/);
    expect(() => put({ video: "https://evil.example/v" })).toThrow(
      /value_not_allowed/,
    );
    expect(() =>
      put({ video: "https://www.youtube.com/watch?v=1" }),
    ).not.toThrow();
    expect(() => put({ language: "fr-FR" })).toThrow(/value_not_allowed/);
    expect(() =>
      checkPlayRequest("PATCH", `${APP}/edits/1/details`, {
        json: { contactPhone: "+1" },
      }),
    ).toThrow(/attribute_not_allowed/);
  });

  it("images: PNG or JPEG, at most 15 MiB, one of the 8 image types", () => {
    const up = (contentType: string, size: number, type = "phoneScreenshots") =>
      checkPlayRequest("POST", `${APP}/edits/1/listings/en-US/${type}`, {
        query: { uploadType: "media" },
        upload: { contentType, size },
      });
    expect(() => up("image/png", 1000)).not.toThrow();
    expect(() => up("image/gif", 1000)).toThrow(/content_type_not_allowed/);
    expect(() => up("image/png", 15 * 1024 * 1024 + 1)).toThrow(/too_large/);
    expect(() => up("image/png", 1000, "appImageTypeUnspecified")).toThrow(
      /value_not_allowed/,
    );
  });

  it("testing: closed tracks only, never a standard name; Google Groups only, never on production", () => {
    expect(() =>
      checkPlayRequest("POST", `${APP}/edits/1/tracks`, {
        json: { track: "qa-closed", type: "CLOSED_TESTING" },
      }),
    ).not.toThrow();
    expect(() =>
      checkPlayRequest("POST", `${APP}/edits/1/tracks`, {
        json: { track: "Production", type: "CLOSED_TESTING" },
      }),
    ).toThrow(/value_not_allowed/);
    expect(() =>
      checkPlayRequest("PATCH", `${APP}/edits/1/testers/production`, {
        json: { googleGroups: ["qa@googlegroups.com"] },
      }),
    ).toThrow(/value_not_allowed/);
    expect(() =>
      checkPlayRequest("PATCH", `${APP}/edits/1/testers/beta`, {
        json: { googleGroups: ["qa@googlegroups.com"] },
      }),
    ).not.toThrow();
  });

  it("refuses the Permissions API for reads too, and every DELETE, before a token", async () => {
    expect(() =>
      checkPlayRequest(
        "GET",
        "/androidpublisher/v3/developers/1/users",
        undefined,
      ),
    ).toThrow(/personal_data/);
    let tokens = 0;
    let sent: string[] = [];
    const c = new GoogleApiClient({
      origin: ANDROID_PUBLISHER_ORIGIN,
      packageName: PLAY_PACKAGE,
      gated: true,
      token: async () => {
        tokens++;
        return "t";
      },
      fetchImpl: async (u, i) => {
        sent.push(`${i?.method} ${new URL(u).pathname}`);
        return new Response(null, { status: 204 });
      },
    });
    await expect(
      c.request("DELETE", ["edits", "1", "listings", "en-US"], "x"),
    ).rejects.toBeInstanceOf(PlayWriteDenied);
    await expect(
      c.request("POST", ["orders", "o1"], "x", { custom: "acknowledge" }),
    ).rejects.toBeInstanceOf(PlayWriteDenied);
    expect(tokens).toBe(0);
    expect(sent).toEqual([]);
    // The one ungated request: discarding a throwaway edit, by its fixed shape.
    await c.discardEdit("123");
    expect(sent).toEqual([`DELETE ${APP}/edits/123`]);
    sent = [];
    await expect(c.discardEdit("../x")).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("an edits-workflow client must be gated", () => {
    expect(
      () =>
        new GoogleApiClient({
          origin: "https://playdeveloperreporting.googleapis.com",
          packageName: PLAY_PACKAGE,
          gated: true,
          token: async () => "t",
        }),
    ).toThrow(/gated/);
  });

  it("renders every Play deep link", () => {
    expect(renderDeepLink("google-play.integrity")).toBe(
      "https://play.google.com/console/developers/app/protect-with-play",
    );
    expect(
      renderDeepLink("google-play.main-store-listing", {
        developerId: "123",
        appId: "456",
      }),
    ).toBe(
      "https://play.google.com/console/developers/123/app/456/main-store-listing",
    );
  });
});

// ── The runtime ──────────────────────────────────────────────────────────────────────────────

describe("provisioning in one edit", () => {
  it("writes details, listings, a closed track, its testers and release notes, then commits a testing edit plainly", async () => {
    const w = await playWorld();
    const s = await session(w);
    try {
      expect(
        (
          await playWriteDetails(
            s,
            { contactWebsite: "https://acme.test" },
            key(),
          )
        ).outcome,
      ).toBe("written");
      const en = await playWriteListing(
        s,
        "en-US",
        { shortDescription: "Dice, juggled harder." },
        key(),
      );
      expect(en).toMatchObject({ outcome: "written" });
      const fr = await playWriteListing(
        s,
        "fr-FR",
        {
          title: "djdl",
          shortDescription: "Des dés.",
          fullDescription: "Un jeu.",
        },
        key(),
      );
      expect(fr).toMatchObject({ outcome: "written" });
      expect(
        await playCreateClosedTrack(s, { track: "qa-closed" }, key()),
      ).toMatchObject({ outcome: "written" });
      expect(
        await playSetTesters(
          s,
          "qa-closed",
          ["QA@googlegroups.com", "beta@googlegroups.com"],
          key(),
        ),
      ).toMatchObject({ outcome: "written" });
      expect(
        await playSetReleaseNotes(
          s,
          {
            track: "beta",
            versionCode: w.fake.track("beta")[0]!.versionCodes
              ? String((w.fake.track("beta")[0]!.versionCodes as string[])[0])
              : "110",
            notes: [{ language: "en-US", text: "Faster dice." }],
          },
          key(),
        ),
      ).toMatchObject({ outcome: "written" });
      // Nothing is live before the commit.
      expect(w.fake.store.listings.has("fr-FR")).toBe(false);
      expect((await playCommit(s, {}, key())).outcome).toBe("written");
    } finally {
      await s.close();
    }
    expect(w.fake.store.listings.get("fr-FR")?.title).toBe("djdl");
    expect(w.fake.store.details.contactWebsite).toBe("https://acme.test");
    expect(w.fake.store.testers.get("qa-closed")).toEqual([
      "beta@googlegroups.com",
      "qa@googlegroups.com",
    ]);
    expect(w.fake.live.has("qa-closed")).toBe(true);
    // A testing edit committed without typing; ERROR_IF_IN_REVIEW on the commit.
    const commitReq = w.fake.requests.find((r) => r.path.endsWith(":commit"))!;
    expect(commitReq.query.changesInReviewBehavior).toBe("ERROR_IF_IN_REVIEW");
    // One edit for the whole run, discarded by nothing (it was committed), lease released.
    expect(
      w.fake.requests.filter((r) => r.method === "POST" && r.path === "edits"),
    ).toHaveLength(1);
    expect(w.fake.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE)).toBeNull();
  });

  it("tester groups are stored as a count, never an address", async () => {
    const w = await playWorld();
    await withPlayEditSession(await ctxFor(w), "provisioning", async (s) => {
      await playSetTesters(s, "beta", ["qa@googlegroups.com"], key());
    });
    const [row] = await rows(w);
    expect(JSON.parse(row!.after_json!).attributes).toEqual({
      track: "beta",
      googleGroupCount: 1,
    });
    const all = JSON.stringify(await rows(w));
    expect(all).not.toContain("googlegroups");
    const audit = JSON.stringify(
      await w.db.all(
        "SELECT * FROM audit WHERE action LIKE 'distribution.play.%'",
      ),
    );
    expect(audit).not.toContain("googlegroups");
    expect(audit).toContain("Set 1 Google Group as testers");
  });

  it("every step is idempotent: a replay answers the row, a new intent pre-reads and sends nothing", async () => {
    const w = await playWorld();
    const k = key();
    const s = await session(w);
    try {
      expect(
        (await playWriteListing(s, "en-US", { title: "djdl 2" }, k)) as {
          outcome: string;
        },
      ).toMatchObject({ outcome: "written" });
      const patches = () =>
        w.fake.requests.filter((r) => r.method === "PATCH").length;
      const before = patches();
      expect(
        await playWriteListing(s, "en-US", { title: "djdl 2" }, k),
      ).toMatchObject({ outcome: "replayed" });
      expect(
        await playWriteListing(s, "en-US", { title: "djdl 2" }, key()),
      ).toMatchObject({ outcome: "existing" });
      expect(patches()).toBe(before);
    } finally {
      await s.close();
    }
    // Not committed: the edit was discarded, nothing went live.
    expect(w.fake.store.listings.get("en-US")?.title).toBe("djdl");
  });
});

describe("listing images (decision 6: never deleted)", () => {
  it("uploads from the blob store's record, skips the same bytes, and leaves old images for the Console", async () => {
    const w = await playWorld();
    const a = await image(2048, 1);
    const b = await image(4096, 2);
    const s = await session(w);
    try {
      const first = await playUploadImage(
        s,
        {
          language: "en-US",
          imageType: "phoneScreenshots",
          image: a,
          aiGenerated: false,
        },
        key(),
      );
      expect(first).toMatchObject({
        result: { outcome: "written" },
        oldImages: 0,
        removeOldAt: null,
      });
      // The same bytes under a new intent: found by hash, not uploaded again.
      const again = await playUploadImage(
        s,
        {
          language: "en-US",
          imageType: "phoneScreenshots",
          image: a,
          aiGenerated: false,
        },
        key(),
      );
      expect(again).toMatchObject({ result: { outcome: "existing" } });
      expect(w.fake.uploads).toHaveLength(1);
      // A replacement: uploaded, and the old one is left with a link to remove it.
      const next = await playUploadImage(
        s,
        {
          language: "en-US",
          imageType: "phoneScreenshots",
          image: b,
          aiGenerated: true,
        },
        key(),
      );
      expect(next).toMatchObject({
        result: { outcome: "written" },
        oldImages: 1,
        removeOldAt: "google-play.main-store-listing",
      });
      const up = w.fake.requests.filter(
        (r) => r.path.endsWith("/phoneScreenshots") && r.method === "POST",
      );
      expect(up.map((r) => r.query.aiGeneratedState)).toEqual([
        "aiGeneratedStateNotAiGenerated",
        "aiGeneratedStateAiGeneratedDeveloperAttested",
      ]);
      expect(up.every((r) => r.query.uploadType === "media")).toBe(true);
    } finally {
      await s.close();
    }
    expect(
      w.fake.requests.some(
        (r) => r.method === "DELETE" && r.path.includes("listings"),
      ),
    ).toBe(false);
  });

  it("falls back to the ledger's own upload record when Play reports no hashes", async () => {
    const w = await playWorld();
    w.fake.imageHashes = false;
    const a = await image(1024, 3);
    const s = await session(w);
    try {
      await playUploadImage(
        s,
        { language: "en-US", imageType: "icon", image: a, aiGenerated: false },
        key(),
      );
      const again = await playUploadImage(
        s,
        { language: "en-US", imageType: "icon", image: a, aiGenerated: false },
        key(),
      );
      expect(again).toMatchObject({ result: { outcome: "existing" } });
      expect(w.fake.uploads).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("refuses an over-cap image and bytes that do not match the record, before or without an upload", async () => {
    const w = await playWorld();
    const s = await session(w);
    try {
      const big = { ...(await image(16, 1)), size: 15 * 1024 * 1024 + 1 };
      expect(
        await playUploadImage(
          s,
          {
            language: "en-US",
            imageType: "icon",
            image: big,
            aiGenerated: false,
          },
          key(),
        ),
      ).toMatchObject({ ok: false, reason: "too_large" });
      const lying = {
        ...(await image(64, 1)),
        read: async () => new Uint8Array(64).fill(9),
      };
      await expect(
        playUploadImage(
          s,
          {
            language: "en-US",
            imageType: "icon",
            image: lying,
            aiGenerated: false,
          },
          key(),
        ),
      ).rejects.toThrow(/do not match/);
      expect(w.fake.uploads).toHaveLength(0);
    } finally {
      await s.close();
    }
  });
});

describe("typed confirmation (Play's default-language title)", () => {
  it("an edit that touched production commits only with the typed title", async () => {
    const w = await playWorld();
    const s = await session(w);
    try {
      const prodCode = String(
        (w.fake.track("production")[0]!.versionCodes as string[])[0],
      );
      const input = {
        track: "production",
        versionCode: prodCode,
        notes: [{ language: "en-US", text: "Hotfix." }],
      };
      // Production holds a completed release: patching its track is typed too.
      await expect(playSetReleaseNotes(s, input, key())).rejects.toBeInstanceOf(
        PlayWriteDenied,
      );
      const notes = await playSetReleaseNotes(
        s,
        { ...input, typed: true },
        key(),
      );
      expect(notes).toMatchObject({ outcome: "written" });
      expect(s.touched.production).toBe(true);
      await expect(playCommit(s, {}, key())).rejects.toBeInstanceOf(
        PlayWriteDenied,
      );
      expect(await playTypedConfirmation(s, "DJDL", "submit")).toMatchObject({
        reason: "confirmation_mismatch",
      });
      expect(await playTypedConfirmation(s, "", "submit")).toMatchObject({
        reason: "confirmation_required",
      });
      expect(await playTypedConfirmation(s, " djdl ", "submit")).toBeNull();
      expect(
        (await playCommit(s, { typed: true, stageOnly: true }, key())).outcome,
      ).toBe("written");
      const commitReq = w.fake.requests.find((r) =>
        r.path.endsWith(":commit"),
      )!;
      expect(commitReq.query.changesNotSentForReview).toBe("true");
    } finally {
      await s.close();
    }
    const failed = (await rows(w)).filter((r) => r.state === "failed");
    expect(failed.map((r) => r.op)).toEqual([
      "release_notes.update",
      "edit.commit",
    ]);
  });

  it("the phrase is the adapter's: Play's title", () => {
    expect(GOOGLE_PLAY_ADAPTER.confirmation).toEqual({
      phrase: "app-name",
      label: "Google Play",
    });
  });
});

describe("one-time products from the commerce map", () => {
  async function mapped(w: PlayWorld, id: string) {
    await w.db.run(
      `INSERT INTO dist_store_products (product, store, store_product_id, deliverable_id, flag, modified_at, modified_by)
       VALUES (?, 'play', ?, 'app', 'pro', ?, 'u1')`,
      SLUG,
      id,
      NOW,
    );
  }
  const price = (units: string) => ({
    purchaseOptionId: "buy",
    regions: [{ regionCode: "US", price: { currencyCode: "USD", units } }],
  });

  it("refuses an unmapped product; the first price is initial; a change is typed; listings alone are plain", async () => {
    const w = await playWorld();
    const ctx = await ctxFor(w);
    expect(
      await playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Sword" }],
          regionsVersion: "2022/02",
        },
        key(),
      ),
    ).toMatchObject({ ok: false, status: 404, reason: "unmapped_product" });
    await mapped(w, "sword");
    expect(
      await playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Sword" }],
          purchaseOption: price("3"),
          regionsVersion: "2022/02",
        },
        key(),
      ),
    ).toMatchObject({ outcome: "written" });
    const first = w.fake.requests.find(
      (r) => r.method === "PATCH" && r.path.startsWith("onetimeproducts"),
    )!;
    expect(first.query).toMatchObject({
      allowMissing: "true",
      updateMask: "listings,purchaseOptions",
    });
    // The same price again: nothing to send.
    expect(
      await playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Sword" }],
          purchaseOption: price("3"),
          regionsVersion: "2022/02",
        },
        key(),
      ),
    ).toMatchObject({ outcome: "existing" });
    // A price change without typing is refused by the gate, before any token for that request.
    await expect(
      playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Sword" }],
          purchaseOption: price("4"),
          regionsVersion: "2022/02",
        },
        key(),
      ),
    ).rejects.toBeInstanceOf(PlayWriteDenied);
    expect(
      await playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Sword" }],
          purchaseOption: price("4"),
          regionsVersion: "2022/02",
          typed: true,
        },
        key(),
      ),
    ).toMatchObject({ outcome: "written" });
    // A listing change with the price unchanged: plain, and no price is re-sent.
    expect(
      await playUpsertOneTimeProduct(
        ctx,
        {
          productId: "sword",
          listings: [{ languageCode: "en-US", title: "Great Sword" }],
          purchaseOption: price("4"),
          regionsVersion: "2022/02",
        },
        key(),
      ),
    ).toMatchObject({ outcome: "written" });
    const last = w.fake.requests
      .filter(
        (r) => r.method === "PATCH" && r.path.startsWith("onetimeproducts"),
      )
      .at(-1)!;
    expect(last.query.updateMask).toBe("listings");
    expect(
      (last.body as Record<string, unknown>).purchaseOptions,
    ).toBeUndefined();
  });
});

describe("the lease, the budget and the reads", () => {
  it("a session refuses while another caller holds the lease, and stops when its own is lost", async () => {
    const w = await playWorld();
    await acquirePlayEditLease(w.db, {
      packageName: PLAY_PACKAGE,
      purpose: "control",
      actor: "admin:u2",
    });
    expect(await PlayEditSession.begin(await ctxFor(w))).toMatchObject({
      ok: false,
      status: 409,
      reason: "edit_lease_held",
    });
    expect(w.fake.tokenRequests).toEqual([]);

    const w2 = await playWorld();
    const s = await PlayEditSession.begin(await ctxFor(w2));
    if (isPlayRefusal(s)) throw new Error(s.message);
    try {
      vi.setSystemTime((NOW + 601) * 1000); // the lease expired (by the wall clock)
      await acquirePlayEditLease(w2.db, {
        packageName: PLAY_PACKAGE,
        purpose: "poll",
        actor: "connector:play",
      });
      await expect(
        playWriteListing(s, "en-US", { title: "x" }, key()),
      ).rejects.toBeInstanceOf(PlayEditLeaseLost);
    } finally {
      await s.close();
    }
  });

  it("each request spends the per-minute budget; a spent budget refuses with 429 before any token", async () => {
    const w = await playWorld();
    await withPlayEditSession(await ctxFor(w), "provisioning", async (s) => {
      await playWriteListing(s, "en-US", { title: "djdl" }, key());
    });
    const meter = storeMeter(w.env, "google-play", SLUG, {
      source: "product",
      credentialId: "play",
    });
    const rate = await meter.read(NOW);
    expect(rate?.limit).toBe(3000);
    expect(3000 - rate!.remaining).toBe(w.fake.requests.length);
    for (let i = rate!.remaining; i > 0; i--) await meter.spend(NOW);
    const tokens = w.fake.tokenRequests.length;
    // Background spend (status) is refused; nothing is sent.
    expect(await playStatus(await ctxFor(w))).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(w.fake.tokenRequests.length).toBe(tokens);
  });

  it("readListing reads a read-only edit and discards it", async () => {
    const w = await playWorld();
    const read = await readPlayListing(await ctxFor(w));
    expect(read).toMatchObject({
      defaultLanguage: "en-US",
      locales: {
        "en-US": { title: "djdl", shortDescription: "Dice, juggled." },
      },
    });
    expect(w.fake.openEdits()).toEqual([]);
    expect(w.fake.requests.at(-1)!.method).toBe("DELETE");
    expect(await readPlayEditLease(w.db, PLAY_PACKAGE)).toBeNull();
  });

  it("status maps releaseLifecycleState per mapped track, without an edit", async () => {
    const w = await playWorld();
    w.fake.releaseSummaries.set("production", [
      {
        track: "production",
        releaseName: "1.1.0",
        releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
      },
    ]);
    expect(await playStatus(await ctxFor(w))).toEqual([
      { track: "production", releaseName: "1.1.0", state: "IN_REVIEW" },
    ]);
    expect(w.fake.requests.some((r) => r.path === "edits")).toBe(false);
  });

  it("the app verifier: true once a read-only edit opens on the package", async () => {
    const w = await playWorld();
    expect(await verifyPlayApp(await ctxFor(w))).toBe(true);
    expect(w.fake.openEdits()).toEqual([]);
  });
});
