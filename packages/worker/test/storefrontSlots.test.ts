/**
 * A-18j — the slot board and the Google Play and Microsoft Store flow runtimes, through the real
 * admin dispatcher:
 *
 *   - every image slot of the listing model is on the board with its store specification; an
 *     asset is accepted for exactly the bytes shown, new bytes are unaccepted again, and only
 *     accepted assets are what a push sends; the preview serves image bytes only;
 *   - Play's and Microsoft's plans bind the steps A-18e and A-18f perform (listing text, images,
 *     testers, submit) and none they do not; submit is typed; release and rollout stay with P5-03.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import {
  acceptedAssets,
  IMAGE_SLOTS,
  imageTypeOf,
  SLOT_SPECS,
} from "../src/services/distribution/storefronts/slots.js";
import { playImageTypeOf } from "../src/services/distribution/storefronts/googlePlay.js";

let db: Db;
let env: Env;
let r2: R2Mock;
const SLUG = "acme";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

async function admin(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Loose; res: Response }> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution/storefronts${path}`;
  const res = await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full.split("?")[0]!,
    { now: NOW },
  );
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    json: type.includes("json") ? await res.clone().json() : null,
    res,
  };
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const sha = (c: string) => c.repeat(64);

async function asset(
  slot: string,
  digest: string,
  more: {
    source?: string;
    derivedFrom?: string | null;
    bytes?: Uint8Array;
  } = {},
): Promise<void> {
  const blob = `blobs/sha256/${digest}`;
  await r2.put(blob, more.bytes ?? PNG);
  await db.run(
    `INSERT INTO dist_listing_assets
       (product, slot, locale, blob, sha256, width, height, alpha, derived_from, text_allowed,
        source, modified_at, modified_by)
     VALUES (?, ?, '', ?, ?, 512, 512, 1, ?, 'free', ?, ?, 'ci')
     ON CONFLICT (product, slot, locale) DO UPDATE SET blob = excluded.blob,
       sha256 = excluded.sha256`,
    SLUG,
    slot,
    blob,
    digest,
    more.derivedFrom === undefined ? "icon-master" : more.derivedFrom,
    more.source ?? "import",
    NOW,
  );
}

async function outlet(id: string, kind: string, identity: object) {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  await seedProduct(db, SLUG);
  await enableServices(db, true, SLUG);
});

describe("the slot board", () => {
  it("names every image slot of the model with its store specification", () => {
    for (const slot of IMAGE_SLOTS) expect(SLOT_SPECS[slot], slot).toBeTruthy();
  });

  it("lists missing human slots red with their size, and stored assets for review", async () => {
    await asset("play:icon", sha("a"));
    const r = await admin("GET", "/slots");
    expect(r.status).toBe(200);
    const key = r.json.slots.find((s: Loose) => s.slot === "key-art");
    expect(key).toMatchObject({
      group: "masters",
      kind: "human",
      state: "missing",
      asset: null,
    });
    expect(key.spec).toContain("3840×2160");
    const icon = r.json.slots.find((s: Loose) => s.slot === "play:icon");
    expect(icon).toMatchObject({
      group: "play",
      kind: "derived",
      state: "review",
    });
    expect(icon.asset.image).toBe(
      `/manage/api/products/${SLUG}/distribution/storefronts/slots/image?slot=play%3Aicon&locale=`,
    );
    expect(r.json.slots.some((s: Loose) => s.slot.startsWith("pack:"))).toBe(
      false,
    );
  });

  it("accepts exactly the bytes shown; new bytes need a new look; only accepted assets push", async () => {
    await asset("play:icon", sha("a"));
    expect(await acceptedAssets(db, SLUG)).toEqual([]);
    const stale = await admin("POST", "/slots/accept", {
      slot: "play:icon",
      sha256: sha("b"),
    });
    expect(stale.status).toBe(409);
    expect(stale.json.reason).toBe("asset_changed");
    const ok = await admin("POST", "/slots/accept", {
      slot: "play:icon",
      sha256: sha("a"),
    });
    expect(ok.status).toBe(200);
    expect((await acceptedAssets(db, SLUG)).map((a) => a.slot)).toEqual([
      "play:icon",
    ]);
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND action = 'distribution.storefronts.accept'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    // CI re-derives the icon: the new bytes are not accepted.
    await asset("play:icon", sha("c"));
    expect(await acceptedAssets(db, SLUG)).toEqual([]);
    const v = await admin("GET", "/slots");
    expect(v.json.slots.find((s: Loose) => s.slot === "play:icon").state).toBe(
      "review",
    );
  });

  it("an operator's own upload counts as accepted", async () => {
    await asset("key-art", sha("d"), { source: "admin", derivedFrom: null });
    expect((await acceptedAssets(db, SLUG)).map((a) => a.slot)).toEqual([
      "key-art",
    ]);
  });

  it("refuses an unknown slot or a malformed digest", async () => {
    expect(
      (await admin("POST", "/slots/accept", { slot: "nope", sha256: sha("a") }))
        .status,
    ).toBe(422);
    expect(
      (await admin("POST", "/slots/accept", { slot: "play:icon", sha256: "x" }))
        .status,
    ).toBe(422);
    expect(
      (
        await admin("POST", "/slots/accept", {
          slot: "play:icon",
          sha256: sha("a"),
        })
      ).status,
    ).toBe(404);
  });

  it("previews image bytes only, typed from the bytes, never as a page", async () => {
    await asset("play:icon", sha("a"));
    const ok = await admin("GET", "/slots/image?slot=play%3Aicon&locale=");
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get("content-type")).toBe("image/png");
    expect(ok.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.res.headers.get("content-security-policy")).toContain("sandbox");
    await asset("play:feature-graphic", sha("e"), {
      bytes: new TextEncoder().encode("<html><script>alert(1)</script>"),
    });
    const html = await admin(
      "GET",
      "/slots/image?slot=play%3Afeature-graphic&locale=",
    );
    expect(html.status).toBe(415);
    expect(imageTypeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
  });
});

describe("Google Play's plan", () => {
  it("binds listing text, images, testers and a typed submit; release and rollout are P5-03's", async () => {
    await outlet("android", "play", { packageName: "gg.acme.dice" });
    const r = await admin("GET", "");
    const play = r.json.stores.find((s: Loose) => s.id === "google-play");
    expect(play.connection.state).toBe("not-configured");
    expect(play.readOnly).toContain("Store connections");
    const ids = play.steps.map((s: Loose) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "createApp",
        "writeListingText",
        "writeListingAssets",
        "testers",
        "submit",
      ]),
    );
    expect(ids).not.toContain("release");
    expect(ids).not.toContain("rollout");
    // No binding yet for in-app products and prices: absent, never "coming soon".
    expect(ids).not.toContain("pricing");
    expect(ids).not.toContain("iap");
    const submit = play.steps.find((s: Loose) => s.id === "submit");
    expect(submit.typed).toBe(true);
    expect(submit.run.confirm).toBe("typed");
    const create = play.steps.find((s: Loose) => s.id === "createApp");
    expect(create.copy).toEqual(
      expect.arrayContaining([
        { label: "Package name", value: "gg.acme.dice" },
      ]),
    );
    const images = play.steps.find((s: Loose) => s.id === "writeListingAssets");
    expect(images.blockedBy).toContain("Assign");
    expect(play.pushListing).toEqual({ stageOnly: true });
  });

  it("maps the accepted slots onto Play's image types", () => {
    expect(playImageTypeOf("play:icon")).toBe("icon");
    expect(playImageTypeOf("play:feature-graphic")).toBe("featureGraphic");
    expect(playImageTypeOf("play:screenshot:phone-portrait:2")).toBe(
      "phoneScreenshots",
    );
    expect(playImageTypeOf("play:screenshot:tablet:1")).toBe(
      "tenInchScreenshots",
    );
    expect(playImageTypeOf("steam:header-capsule")).toBeNull();
    expect(playImageTypeOf("play:screenshot:desktop-16x9:1")).toBeNull();
  });

  it("a step refuses while the team connection is missing, before any store call", async () => {
    const r = await admin("POST", "/google-play/steps/writeListingText", {});
    expect(r.status).toBe(428);
  });
});

describe("the Microsoft Store's plan", () => {
  it("binds the staged listing and a typed commit; nothing it cannot run", async () => {
    await outlet("windows", "ms-store", { productId: "9NBLGGH4R315" });
    const r = await admin("GET", "");
    const ms = r.json.stores.find((s: Loose) => s.id === "microsoft-store");
    const ids = ms.steps.map((s: Loose) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["createApp", "writeListingText", "submit"]),
    );
    for (const absent of ["pricing", "testers", "release", "rollout"])
      expect(ids).not.toContain(absent);
    const submit = ms.steps.find((s: Loose) => s.id === "submit");
    expect(submit.typed).toBe(true);
    expect(submit.blockedBy).toBeTruthy();
    const text = ms.steps.find((s: Loose) => s.id === "writeListingText");
    expect(text.run.consequences.join(" ")).toContain("uncommitted");
    // Microsoft keeps the pending submission uncommitted: no "stage only" choice.
    expect(ms.pushListing).toEqual({ stageOnly: false });
  });
});
