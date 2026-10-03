/**
 * P4-20 — save compatibility at publish, through the real dispatcher: a pack release that stops
 * providing a content id its predecessor provided at a shared live contentApi level is refused
 * with `provides-dropped` naming the id; the same drop acknowledged in `removes` passes (with a
 * warning for an id the predecessor never provided); a release that moves to a new contentApi
 * line passes; two unranged releases are always on one line; the dry run answers the same and
 * writes nothing; a malformed list, and a missing list under `provides.required`, are refused
 * with `pack-provides`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
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

installDigestStream();

const FOES = "djdl.foes";
const CORE = "djdl.core";

function releaseDoc() {
  return {
    release: {
      provider: { type: "github", owner: "acme", repo: "djdl" },
      binaryName: "djdl",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      deliverables: {
        app: {
          kind: "app",
          versioning: { scheme: "semver" },
          content: { contentApi: 3 },
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
          requires: { contentApi: { app: ">=3" } },
        },
        [CORE]: {
          kind: "pack",
          type: "files.tree",
          binding: "standalone",
          provides: { required: true },
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
let seqs = new Map<string, number>();
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  seqs = new Map();
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
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
    release: JSON.stringify(releaseDoc()),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  const rel = res.manifest.release!;
  await db.batch(
    manifestDeliverableStatements(SLUG, rel.app, NOW, rel.packDeliverables),
  );
  token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
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
  /** `requires.contentApi.app`; null signs none (a standalone pack). */
  contentApi?: string | null;
  provides?: unknown;
  removes?: unknown;
  dryRun?: boolean;
}

/** Stage and submit a pack release; answers the status and the parsed body. */
async function submitPack(pack: string, version: string, o: PackOpts = {}) {
  const seq = (seqs.get(pack) ?? 0) + 1;
  const built = await treeVariant({}, `${pack}-${version}`);
  await stage(pack, built.objects);
  const contentApi =
    o.contentApi === undefined ? (pack === FOES ? ">=3" : null) : o.contentApi;
  const record = {
    ...packRecord({
      aud: SLUG,
      deliverable: pack,
      version,
      seq,
      issuedAt: NOW,
      type: "files.tree",
      handler: { activation: "hot" },
      variants: [
        {
          ...built.variant,
          ...(contentApi !== null
            ? { requires: { contentApi: { app: contentApi } } }
            : {}),
        },
      ],
    }),
    ...(o.provides !== undefined ? { provides: o.provides } : {}),
    ...(o.removes !== undefined ? { removes: o.removes } : {}),
  };
  const res = await post("publish/submit", {
    record: await signRecord(record),
    ...(o.dryRun ? { dryRun: true } : {}),
  });
  const body = (await res.json()) as Record<string, any>;
  if (res.status === 200 && !o.dryRun) seqs.set(pack, seq);
  return { status: res.status, body };
}

async function publishPack(pack: string, version: string, o: PackOpts = {}) {
  const r = await submitPack(pack, version, o);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r;
}

const WEB = new TextEncoder().encode("web build bytes");
const WEB_SHA = sha(WEB);

/** Publish an app release at `contentApi` so that level is live on stable. */
async function publishApp(
  version: string,
  seq: number,
  contentApi: number,
  extra: Record<string, unknown> = {},
) {
  const descriptor = {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel: "stable",
    content: { contentApi, pins: [], expects: [] },
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
  const res = await post("publish/submit", {
    ticket: body.ticket,
    descriptor,
    record: await signRecord(recordFor(descriptor, { seq, issuedAt: NOW })),
    ...extra,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function records(pack: string): Promise<number> {
  return (
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM release_records WHERE product = ? AND deliverable_id = ?",
        SLUG,
        pack,
      )
    )?.n ?? 0
  );
}

describe("provides and removes at publish (P4-20)", () => {
  beforeEach(async () => {
    await publishApp("1.0.0", 1, 3);
    await publishPack(FOES, "1.0.0", {
      provides: ["foe.goblin", "foe.orc", "foe.troll"],
    });
  });

  it("refuses a release that drops a provided id at a shared live level, naming it", async () => {
    const r = await submitPack(FOES, "1.1.0", {
      provides: ["foe.goblin", "foe.orc"],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("release_record_rejected");
    expect(r.body.reason).toBe("provides-dropped");
    expect(r.body.message).toContain("foe.troll");
    expect(r.body.message).toContain("contentApi 3");
    expect(r.body.message).toContain(`${FOES}@1.0.0`);
    expect(await records(FOES)).toBe(1);
  });

  it("passes the same drop acknowledged in removes, warning about an id never provided", async () => {
    const r = await publishPack(FOES, "1.1.0", {
      provides: ["foe.goblin", "foe.orc"],
      removes: ["foe.troll", "foe.wraith"],
    });
    expect(r.body.warnings).toEqual([
      `removes lists foe.wraith, which ${FOES}@1.0.0 never provided.`,
    ]);
    expect(await records(FOES)).toBe(2);
    // The next release compares with 1.1.0, which no longer provides foe.troll.
    await publishPack(FOES, "1.2.0", { provides: ["foe.goblin", "foe.orc"] });
  });

  it("passes a release that supports only a new contentApi level", async () => {
    const r = await publishPack(FOES, "2.0.0", {
      contentApi: ">=4",
      provides: ["foe.goblin"],
    });
    expect(r.body.warnings).toBeUndefined();
  });

  it("refuses a drop that a range change still shares a live level with", async () => {
    const r = await submitPack(FOES, "2.0.0", {
      contentApi: ">=2 <4",
      provides: ["foe.goblin"],
    });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("provides-dropped");
    expect(r.body.message).toContain("foe.orc, foe.troll");
  });

  it("reads a missing provides after a listing predecessor as dropping every id", async () => {
    const r = await submitPack(FOES, "1.1.0");
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("provides-dropped");
    expect(r.body.message).toContain("3 content ids");
  });

  it("the dry run answers the same and writes nothing", async () => {
    const refused = await submitPack(FOES, "1.1.0", {
      provides: ["foe.goblin"],
      dryRun: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("provides-dropped");
    const passed = await submitPack(FOES, "1.1.0", {
      provides: ["foe.goblin"],
      removes: ["foe.orc", "foe.troll"],
      dryRun: true,
    });
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(passed.body.dryRun).toBe(true);
    expect(await records(FOES)).toBe(1);
  });
});

describe("unranged releases and the list rules (P4-20)", () => {
  it("holds two unranged releases to one line whatever is live", async () => {
    await publishPack(CORE, "1.0.0", { provides: ["dice.d6", "dice.d20"] });
    const r = await submitPack(CORE, "1.1.0", { provides: ["dice.d6"] });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("provides-dropped");
    expect(r.body.message).toContain("every contentApi level");
    expect(r.body.message).toContain("dice.d20");
  });

  it("refuses a release without provides when the policy requires it", async () => {
    const r = await submitPack(CORE, "1.0.0");
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("pack-provides");
    expect(r.body.message).toContain("provides.required");
  });

  it("refuses a malformed provides or removes list", async () => {
    for (const o of [
      { provides: ["dice.d6", "dice.d6"] },
      { provides: ["dice d6"] },
      { provides: "dice.d6" },
      { provides: ["dice.d6"], removes: [7] },
    ]) {
      const r = await submitPack(CORE, "1.0.0", o);
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect(r.body.reason).toBe("pack-provides");
    }
    expect(await records(CORE)).toBe(0);
  });

  it("warns on a removes id the release still provides, and on a predecessor without provides", async () => {
    await publishPack(FOES, "1.0.0");
    const r = await publishPack(FOES, "1.1.0", {
      provides: ["foe.goblin"],
      removes: ["foe.goblin", "foe.orc"],
    });
    expect(r.body.warnings).toEqual([
      "removes lists foe.goblin, which this release still provides; the acknowledgement has no effect.",
      `removes lists foe.orc, but ${FOES}@1.0.0 declares no provides.`,
    ]);
  });
});

describe("the content-interface fingerprint (P4-20)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("stores it as unsigned metadata and answers the channel's current one", async () => {
    const first = await publishApp("1.0.0", 1, 3, { contentInterface: A });
    expect(first.contentInterface).toEqual({ sha256: A, previous: null });
    const row = await db.first<{ content_interface: string | null }>(
      "SELECT content_interface FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      first.releaseId,
    );
    expect(row?.content_interface).toBe(A);
    const dry = await publishApp("1.1.0", 2, 3, {
      contentInterface: B,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.contentInterface).toEqual({
      sha256: B,
      previous: {
        releaseId: first.releaseId,
        version: "1.0.0",
        contentApi: 3,
        sha256: A,
      },
    });
    // A release without one answers no comparison and stores none.
    const plain = await publishApp("1.1.0", 2, 3);
    expect(plain.contentInterface).toBeUndefined();
  });

  it("refuses a malformed fingerprint", async () => {
    const up = await post("publish/uploads", {
      objects: [{ sha256: WEB_SHA, size: WEB.length }],
    });
    const { ticket } = (await up.json()) as { ticket: string };
    const res = await post("publish/submit", {
      ticket,
      descriptor: {},
      contentInterface: "nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("bad_body");
  });
});
