/**
 * P4-12 — compatible and standalone packs through the real dispatcher and admin API: a pack
 * publish writes `release_sets`; a floor change, a pointer move and a yank each re-resolve; an
 * unsatisfiable floor change succeeds and stores the `unsatisfied` marker; an unsatisfiable pack
 * publish fails with the selector and the constraint; an app publish mirrors holds into
 * `release_holds` and refuses a hold that breaks its set; a dry run writes nothing and returns
 * the report; and the record's signed requirements are held to the binding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  admin,
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import {
  RELEASE_KID,
  RELEASE_PUB,
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import { packRecord, sha, treeVariant, type Obj } from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";

installDigestStream();

const FOES = "djdl.foes";
const LORE = "djdl.lore";
const L10N = "djdl.l10n";
const EVENTS = "djdl.events.halloween";

function releaseDoc(
  contentApi: number,
  packChannels: Record<string, string> = { "djdl.events.*": "events" },
) {
  return {
    release: {
      provider: { type: "github", owner: "acme", repo: "djdl" },
      binaryName: "djdl",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      deliverables: {
        app: {
          kind: "app",
          versioning: { scheme: "semver" },
          content: { contentApi, packChannels },
          artifacts: [
            {
              id: "web",
              platform: "web",
              arch: "wasm32",
              format: "zip",
              match: "djdl-*-web.zip",
              embeds: [],
            },
          ],
        },
        [FOES]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          required: true,
          delivery: "essential",
          requires: { contentApi: { app: ">=3" } },
        },
        [LORE]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          requires: { contentApi: { app: ">=3" } },
        },
        [L10N]: {
          kind: "pack",
          type: "files.tree",
          binding: "standalone",
          variants: { locale: ["en", "fr"] },
        },
        [EVENTS]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          channels: ["events"],
          requires: { contentApi: { app: ">=3" } },
        },
      },
    },
  };
}

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

async function syncDeliverables(
  contentApi: number,
  packChannels?: Record<string, string>,
) {
  const res = parseManifest({
    product: JSON.stringify({
      slug: SLUG,
      name: "djdl",
      modules: {
        license: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
    }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(releaseDoc(contentApi, packChannels)),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const rel = res.manifest.release!;
  await db.batch(
    manifestDeliverableStatements(SLUG, rel.app, NOW, rel.packDeliverables),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  await syncDeliverables(3);
  token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish", "release:promote", "release:yank"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
});

afterEach(() => vi.useRealTimers());

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function stage(deliverable: string, objects: Obj[]) {
  const unique = [...new Map(objects.map((o) => [o.sha256, o])).values()];
  const up = await post("publish/uploads", {
    objects: unique.map((o) => ({
      sha256: o.sha256,
      size: o.bytes.length,
      gated: false,
    })),
  });
  expect(up.status).toBe(200);
  const body = (await up.json()) as { ticket: string; prefix: string };
  for (const o of unique)
    r2.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
  const res = await post("publish/stage", { ticket: body.ticket, deliverable });
  expect(res.status, await res.clone().text()).toBe(200);
}

interface PackOpts {
  contentApi?: string | null;
  variants?: Record<string, string>[];
  packs?: Record<string, string>;
  conflicts?: string[];
  channel?: string;
  dryRun?: boolean;
}

let seqs = new Map<string, number>();
beforeEach(() => {
  seqs = new Map();
});

/** Stage and submit a pack release; answers the parsed response. */
async function submitPack(pack: string, version: string, o: PackOpts = {}) {
  const seq = (seqs.get(pack) ?? 0) + 1;
  const built = await Promise.all(
    (o.variants ?? [{}]).map((v, i) =>
      treeVariant(v, `${pack}-${version}-${i}`),
    ),
  );
  await stage(
    pack,
    built.flatMap((b) => b.objects),
  );
  const contentApi = o.contentApi === undefined ? ">=3" : o.contentApi;
  const variants = built.map((b) => ({
    ...b.variant,
    ...(contentApi !== null || o.packs
      ? {
          requires: {
            ...(contentApi !== null ? { contentApi: { app: contentApi } } : {}),
            ...(o.packs ? { packs: o.packs } : {}),
          },
        }
      : {}),
    ...(o.conflicts ? { conflicts: o.conflicts } : {}),
  }));
  const record = {
    ...packRecord({
      aud: SLUG,
      deliverable: pack,
      version,
      seq,
      issuedAt: NOW,
      type: "files.tree",
      handler: { activation: "hot" },
      variants,
    }),
    ...(o.channel ? { channel: o.channel } : {}),
  };
  const jws = await signRecord(record);
  const res = await post("publish/submit", {
    record: jws,
    ...(o.dryRun ? { dryRun: true } : {}),
  });
  const body = (await res.json()) as Record<string, any>;
  if (res.status === 200 && !o.dryRun) seqs.set(pack, seq);
  return { status: res.status, body, sha256: sha(jws), seq };
}

async function publishPack(pack: string, version: string, o: PackOpts = {}) {
  const r = await submitPack(pack, version, o);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);

/** Submit an app release with `content` and its record; answers the parsed response. */
async function submitApp(
  version: string,
  seq: number,
  content: Record<string, unknown>,
  opts: { dryRun?: boolean; channel?: string } = {},
) {
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel: opts.channel ?? "stable",
    content,
    builds: [
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        embeds: [],
        artifacts: [
          {
            name: `djdl-${version}-web.zip`,
            role: "payload",
            sha256: WEB_SHA,
            size: WEB.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${WEB_SHA}` }],
          },
        ],
      },
    ],
  };
  const up = await post("publish/uploads", {
    objects: [{ sha256: WEB_SHA, size: WEB.length }],
  });
  const body = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${body.prefix}${WEB_SHA}`, WEB, { withSha256: true });
  const jws = await signRecord(recordFor(descriptor, { seq, issuedAt: NOW }));
  const res = await post("publish/submit", {
    ticket: body.ticket,
    descriptor,
    record: jws,
    ...(opts.dryRun ? { dryRun: true } : {}),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

function appContent(
  contentApi: number,
  holds: { pack: string; sha256: string; seq: number; version: string }[] = [],
) {
  return {
    contentApi,
    pins: [],
    expects: [
      { pack: FOES, required: true, delivery: "essential" },
      { pack: L10N, required: false, delivery: "prefetch" },
    ],
    packChannels: { "djdl.events.*": "events" },
    ...(holds.length > 0
      ? {
          holds: holds.map((h) => ({
            pack: h.pack,
            release: { sha256: h.sha256, seq: h.seq, version: h.version },
            reason: "keeps a quest working",
          })),
        }
      : {}),
  };
}

async function publishApp(version: string, seq: number, contentApi = 3) {
  const r = await submitApp(version, seq, appContent(contentApi));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

interface SetRow {
  channel: string;
  content_api: number;
  platform: string;
  variant: string;
  pack_set_id: string;
  set_json: string;
  unsatisfied_json: string | null;
}

async function sets(): Promise<SetRow[]> {
  return db.all<SetRow>(
    `SELECT channel, content_api, platform, variant, pack_set_id, set_json, unsatisfied_json
       FROM release_sets WHERE product = ? ORDER BY channel, content_api, platform, variant`,
    SLUG,
  );
}

/** pack → version at one selector. */
async function setAt(
  contentApi: number,
  variant = "locale=en",
  channel = "stable",
): Promise<{
  packs: Record<string, string>;
  unsatisfied: Record<string, string>;
}> {
  const row = (await sets()).find(
    (s) =>
      s.channel === channel &&
      s.content_api === contentApi &&
      s.variant === variant,
  );
  expect(row, `${channel}/${contentApi}/${variant}`).toBeDefined();
  const packs = (
    JSON.parse(row!.set_json) as { packs: { pack: string; version: string }[] }
  ).packs;
  const unsat = JSON.parse(row!.unsatisfied_json ?? "[]") as {
    pack: string;
    reason: string;
  }[];
  return {
    packs: Object.fromEntries(packs.map((p) => [p.pack, p.version])),
    unsatisfied: Object.fromEntries(unsat.map((u) => [u.pack, u.reason])),
  };
}

async function catalog() {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  }).releaseCatalog()!;
}

/** A Diceroll-like product: foes 1.0.0 (contentApi 3), l10n 1.0.0, app 1.4.0 at contentApi 3. */
async function baseline() {
  const foes = await publishPack(FOES, "1.0.0", { contentApi: ">=3 <4" });
  await publishPack(L10N, "1.0.0", {
    contentApi: null,
    variants: [{ locale: "en" }, { locale: "fr" }],
  });
  await publishApp("1.4.0", 14, 3);
  return { foes };
}

describe("resolution on publish (P4-12)", () => {
  it("a pack publish writes release_sets; two live levels resolve two lines (CONTENT §6.8 row 1)", async () => {
    await baseline();
    expect(await setAt(3)).toEqual({
      packs: { [FOES]: "1.0.0", [L10N]: "1.0.0" },
      unsatisfied: { [EVENTS]: "no-release", [LORE]: "no-release" },
    });
    // The app moves to contentApi 4 (1.5.0) while 1.4.0 is still live.
    await syncDeliverables(4);
    const blocked = await submitApp("1.5.0", 15, appContent(4));
    // foes is required and has no release for contentApi 4 yet.
    expect([blocked.status, blocked.body.reason]).toEqual([
      400,
      "content-unsatisfied",
    ]);
    // beta includes stable, so the release is live on both; the first selector is named.
    expect(blocked.body.message).toMatch(
      /channel (beta|stable), contentApi 4, platform web/,
    );
    const f2 = await publishPack(FOES, "2.0.0", { contentApi: ">=4" });
    expect(f2.body.packSets).toBeDefined();
    await publishApp("1.5.0", 15, 4);
    expect((await setAt(3)).packs[FOES]).toBe("1.0.0");
    expect((await setAt(4)).packs[FOES]).toBe("2.0.0");
    // A newer release on the 4 line moves only that line's sets.
    const before3 = (await sets()).filter((s) => s.content_api === 3);
    await publishPack(FOES, "2.0.1", { contentApi: ">=4" });
    expect((await setAt(4)).packs[FOES]).toBe("2.0.1");
    expect((await sets()).filter((s) => s.content_api === 3)).toEqual(before3);
    const cat = await catalog();
    expect(await cat.liveLevels("app", "stable")).toEqual([
      { contentApi: 3, appReleases: ["app@1.4.0"] },
      { contentApi: 4, appReleases: ["app@1.5.0"] },
    ]);
    const stored = await cat.packSets("stable");
    expect(stored.map((s) => [s.contentApi, s.platform, s.variant])).toEqual([
      [3, "web", "locale=en"],
      [3, "web", "locale=fr"],
      [4, "web", "locale=en"],
      [4, "web", "locale=fr"],
    ]);
    expect(stored[0]!.packSetId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("packChannels routes the event pack to the events channel", async () => {
    await baseline();
    await publishPack(EVENTS, "1.0.0", { channel: "events" });
    expect((await setAt(3)).packs[EVENTS]).toBe("1.0.0");
    // A record on a channel the pack does not declare is refused.
    const bad = await submitPack(EVENTS, "1.0.1", { channel: "nightly" });
    expect([bad.status, bad.body.reason]).toEqual([400, "pack-channel"]);
  });

  it("a dry run writes nothing and returns the report", async () => {
    await baseline();
    const before = await sets();
    const dry = await submitPack(FOES, "1.1.0", {
      contentApi: ">=3 <4",
      dryRun: true,
    });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    // Both locales on stable and on beta (which includes stable).
    expect(dry.body.packSets.changed.length).toBe(4);
    expect(
      dry.body.packSets.sets.some((s: any) =>
        s.packs.some((p: any) => p.pack === FOES && p.version === "1.1.0"),
      ),
    ).toBe(true);
    expect(dry.body.packSets.sets[0].appReleases).toEqual(["app@1.4.0"]);
    expect(await sets()).toEqual(before);
    expect(
      await db.first(
        "SELECT 1 AS one FROM release_metadata WHERE product = ? AND release_id = ?",
        SLUG,
        `${FOES}@1.1.0`,
      ),
    ).toBeNull();
    // An app release's dry run reports too, and writes nothing.
    const appDry = await submitApp("1.4.1", 15, appContent(3), {
      dryRun: true,
    });
    expect(appDry.status, JSON.stringify(appDry.body)).toBe(200);
    expect(appDry.body.packSets.sets.length).toBeGreaterThan(0);
    expect(await sets()).toEqual(before);
  });
});

describe("re-resolution on floor changes, pointer moves and yanks (P4-12)", () => {
  it("an unsatisfiable floor change succeeds and stores the unsatisfied marker; the backport clears it", async () => {
    await baseline();
    const res = await admin(env, db, "PUT", "/channels/stable", {
      deliverable: FOES,
      contentApi: 3,
      minSupported: "1.0.1",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { policy: { packFloors: unknown[] } };
    expect(body.policy.packFloors).toEqual([
      {
        contentApi: 3,
        minSupported: "1.0.1",
        modifiedAt: NOW,
        modifiedBy: "admin:u1",
      },
    ]);
    expect(await setAt(3)).toEqual({
      packs: { [L10N]: "1.0.0" },
      unsatisfied: {
        [EVENTS]: "no-release",
        [FOES]: "content-floor",
        [LORE]: "no-release",
      },
    });
    expect(await (await catalog()).packFloors("stable")).toEqual([
      {
        deliverableId: FOES,
        channel: "stable",
        contentApi: 3,
        minSupported: "1.0.1",
        modifiedAt: NOW,
      },
    ]);
    // The backport on the 3 line satisfies the floor (CONTENT §6.8 row 3).
    await publishPack(FOES, "1.0.1", { contentApi: ">=3 <4" });
    expect((await setAt(3)).packs[FOES]).toBe("1.0.1");
    // Clearing the floor re-resolves too.
    const cleared = await admin(env, db, "PUT", "/channels/stable", {
      deliverable: FOES,
      contentApi: 3,
      minSupported: null,
    });
    expect(cleared.status).toBe(200);
    expect(await (await catalog()).packFloors("stable")).toEqual([]);
  });

  it("the floor operation refuses the app, extra fields and a bad version", async () => {
    await baseline();
    const app = await admin(env, db, "PUT", "/channels/stable", {
      contentApi: 3,
      minSupported: "1.0.0",
    });
    expect(app.status).toBe(422);
    expect(((await app.json()) as { reason: string }).reason).toBe(
      "bad_content_api",
    );
    const extra = await admin(env, db, "PUT", "/channels/stable", {
      deliverable: FOES,
      contentApi: 3,
      minSupported: "1.0.0",
      critical: true,
    });
    expect(((await extra.json()) as { reason: string }).reason).toBe(
      "content_api_floor_only",
    );
    const bad = await admin(env, db, "PUT", "/channels/stable", {
      deliverable: FOES,
      contentApi: 3,
      minSupported: "one",
    });
    expect(((await bad.json()) as { reason: string }).reason).toBe(
      "bad_min_supported",
    );
  });

  it("a pointer move re-resolves (a pinned channel serves at or below its pointer)", async () => {
    await baseline();
    await publishPack(FOES, "1.1.0", { contentApi: ">=3 <4" });
    expect((await setAt(3)).packs[FOES]).toBe("1.1.0");
    const res = await post("channels/stable/pin", {
      deliverable: FOES,
      releaseId: `${FOES}@1.0.0`,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await setAt(3)).packs[FOES]).toBe("1.0.0");
  });

  it("a yank re-resolves; an unyank restores", async () => {
    await baseline();
    await publishPack(FOES, "1.1.0", { contentApi: ">=3 <4" });
    const res = await post(
      `releases/${encodeURIComponent(`${FOES}@1.1.0`)}/yank`,
      {
        reason: "breaks a quest",
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await setAt(3)).packs[FOES]).toBe("1.0.0");
    const un = await admin(
      env,
      db,
      "DELETE",
      `/releases/${encodeURIComponent(`${FOES}@1.1.0`)}/yank`,
    );
    expect(un.status).toBe(200);
    expect((await setAt(3)).packs[FOES]).toBe("1.1.0");
  });

  it("a pack channel's policy is reachable for the pack that declares it", async () => {
    await baseline();
    await publishPack(EVENTS, "1.0.0", { channel: "events" });
    await publishPack(EVENTS, "1.1.0", { channel: "events" });
    const res = await post("channels/events/pin", {
      deliverable: EVENTS,
      releaseId: `${EVENTS}@1.0.0`,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await setAt(3)).packs[EVENTS]).toBe("1.0.0");
    // ...and not for the app, which never publishes to it.
    const app = await post("channels/events/pin", {
      releaseId: "app@1.4.0",
    });
    expect(app.status).toBe(404);
  });
});

describe("publish checks (P4-12)", () => {
  it("an unsatisfiable pack publish fails with the selector and the constraint", async () => {
    await baseline();
    // A release missing a declared variant for a live selector.
    const variant = await submitPack(L10N, "1.1.0", {
      contentApi: null,
      variants: [{ locale: "en" }],
    });
    expect([variant.status, variant.body.error, variant.body.reason]).toEqual([
      400,
      "release_record_rejected",
      "pack-unsatisfiable",
    ]);
    expect(variant.body.message).toMatch(
      /channel (beta|stable), contentApi 3, platform web, variant locale=fr/,
    );
    expect(variant.body.message).toContain("(variant)");
    // A release whose dependency no stored release satisfies.
    const dep = await submitPack(FOES, "1.1.0", {
      contentApi: ">=3 <4",
      packs: { [LORE]: ">=2.0.0" },
    });
    expect([dep.status, dep.body.reason]).toEqual([400, "pack-unsatisfiable"]);
    expect(dep.body.message).toContain(`requires ${LORE} >=2.0.0`);
    expect(dep.body.message).toContain("(dependency)");
    // Nothing was stored for either.
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM release_metadata WHERE product = ? AND version = '1.1.0'",
        SLUG,
      ),
    ).toEqual({ n: 0 });
  });

  it("an app publish mirrors holds into release_holds and refuses a hold that breaks its set", async () => {
    await baseline();
    const lore1 = await publishPack(LORE, "1.0.0");
    await publishPack(LORE, "1.5.0");
    await publishPack(FOES, "1.1.0", {
      contentApi: ">=3 <4",
      packs: { [LORE]: ">=1.5.0" },
    });
    // Holding lore at 1.0.0 breaks foes 1.1.0's dependency.
    const broken = await submitApp(
      "1.4.1",
      15,
      appContent(3, [
        { pack: LORE, sha256: lore1.sha256, seq: lore1.seq, version: "1.0.0" },
      ]),
    );
    expect([broken.status, broken.body.reason]).toEqual([
      400,
      "hold-unsatisfiable",
    ]);
    expect(broken.body.message).toContain(`requires ${LORE} >=1.5.0`);
    // Holding foes at 1.0.0 (no dependency) is fine, and is mirrored.
    const foes1 = await db.first<{ record_sha256: string }>(
      "SELECT record_sha256 FROM release_records WHERE product = ? AND release_id = ?",
      SLUG,
      `${FOES}@1.0.0`,
    );
    const ok = await submitApp(
      "1.4.1",
      15,
      appContent(3, [
        {
          pack: FOES,
          sha256: foes1!.record_sha256,
          seq: 1,
          version: "1.0.0",
        },
      ]),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const cat = await catalog();
    const hold = {
      appReleaseId: "app@1.4.1",
      pack: FOES,
      packReleaseId: `${FOES}@1.0.0`,
      recordSha256: foes1!.record_sha256,
      reason: "keeps a quest working",
    };
    expect(await cat.holdsFor("app@1.4.1")).toEqual([hold]);
    expect(await cat.heldBy(`${FOES}@1.0.0`)).toEqual([hold]);
  });

  it("refuses holds of an unknown, yanked or non-compatible release", async () => {
    await baseline();
    const l10n = await db.first<{ record_sha256: string }>(
      "SELECT record_sha256 FROM release_records WHERE product = ? AND release_id = ?",
      SLUG,
      `${L10N}@1.0.0`,
    );
    const standalone = await submitApp(
      "1.4.1",
      15,
      appContent(3, [
        { pack: L10N, sha256: l10n!.record_sha256, seq: 1, version: "1.0.0" },
      ]),
    );
    expect(standalone.body.reason).toBe("hold-binding");
    const unknown = await submitApp(
      "1.4.1",
      15,
      appContent(3, [
        { pack: FOES, sha256: "d".repeat(64), seq: 1, version: "1.0.0" },
      ]),
    );
    expect(unknown.body.reason).toBe("hold-unknown");
    const foes1 = await db.first<{ record_sha256: string }>(
      "SELECT record_sha256 FROM release_records WHERE product = ? AND release_id = ?",
      SLUG,
      `${FOES}@1.0.0`,
    );
    await post(`releases/${encodeURIComponent(`${FOES}@1.0.0`)}/yank`, {
      reason: "bad",
    });
    const yanked = await submitApp(
      "1.4.1",
      15,
      appContent(3, [
        { pack: FOES, sha256: foes1!.record_sha256, seq: 1, version: "1.0.0" },
      ]),
    );
    expect(yanked.body.reason).toBe("hold-yanked");
  });

  it("refuses an app release whose packChannels differs from a live one at the same level", async () => {
    await baseline();
    // The manifest changes the mapping without a contentApi bump: 1.4.0 (live, contentApi 3)
    // still routes event packs to events.
    await syncDeliverables(3, { "djdl.events.*": "beta" });
    const changed = await submitApp("1.4.1", 15, {
      ...appContent(3),
      packChannels: { "djdl.events.*": "beta" },
    });
    expect([changed.status, changed.body.reason]).toEqual([
      400,
      "pack-channels-conflict",
    ]);
    expect(changed.body.message).toContain("needs a contentApi bump");
    await syncDeliverables(3);
    const r = await submitApp("1.4.1", 15, {
      ...appContent(3),
      packChannels: { "djdl.events.*": "beta" },
    });
    // The validator holds the descriptor to the manifest's mapping first.
    expect([r.status, r.body.reason]).toEqual([400, "invalid_descriptor"]);
    expect(r.body.message).toContain("packChannels");
  });

  it("holds the record's signed requirements to the pack's binding", async () => {
    const missing = await submitPack(FOES, "1.0.0", { contentApi: null });
    expect([missing.status, missing.body.reason]).toEqual([
      400,
      "pack-requires",
    ]);
    const standalone = await submitPack(L10N, "1.0.0", {
      contentApi: ">=3",
      variants: [{ locale: "en" }, { locale: "fr" }],
    });
    expect(standalone.body.reason).toBe("pack-requires");
    const conflicts = await submitPack(LORE, "1.0.0", {
      conflicts: ["djdl.nope"],
    });
    expect(conflicts.body.reason).toBe("pack-requires");
    const ok = await submitPack(LORE, "1.0.0", { conflicts: [FOES] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      await db.first(
        "SELECT conflicts_json FROM release_builds WHERE product = ? AND release_id = ?",
        SLUG,
        `${LORE}@1.0.0`,
      ),
    ).toEqual({ conflicts_json: JSON.stringify([FOES]) });
  });
});

describe("migration 0046 (P4-12)", () => {
  it("applies on a fresh database and on one migrated through 0045", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "..", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const tables = (s: Database.Database) =>
      (
        s
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('release_sets', 'release_holds', 'release_pack_floors') ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
    const columns = (s: Database.Database, t: string) =>
      (s.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
    // Migrated through 0045, with rows, then 0046.
    const old = new Database(":memory:");
    const runOld = old.exec.bind(old);
    for (const f of files.filter((f) => f < "0046"))
      runOld(readFileSync(join(dir, f), "utf8"));
    expect(tables(old)).toEqual([]);
    for (const f of files.filter((f) => f >= "0046"))
      runOld(readFileSync(join(dir, f), "utf8"));
    expect(tables(old)).toEqual([
      "release_holds",
      "release_pack_floors",
      "release_sets",
    ]);
    expect(columns(old, "release_metadata")).toContain("pack_channels_json");
    expect(columns(old, "release_builds")).toContain("conflicts_json");
    // Fresh: every migration in order (`makeTestDb`).
    expect(db).toBeDefined();
  });
});
