/**
 * P3-03 fixtures: a product that publishes CI-signed releases through the real submit route and
 * serves the signed channel feed — Release, Distribution and Update on, declared release keys,
 * and four outlets (the implicit `direct`, `app-store`, `testflight`, `play`) plus `web`.
 *
 * Every release has three builds: a self-hosted `web` build and `macos` build (their payloads in
 * R2, so `direct`/`web` are derived live) and a store-only `ios` build. Store availability,
 * rollouts and halts are written straight into Distribution's tables, as P2b-03/P2b-04 would.
 */

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import {
  recordFor,
  releaseKeysJson,
  signRecord,
} from "./releaseKeysFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";

export const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    manualChannels: [{ name: "qa", regex: "^qa-.*$" }],
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        artifacts: [
          {
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            match: "djdl-*-web.zip",
          },
          {
            id: "macos",
            platform: "macos",
            arch: "universal",
            format: "dmg",
            match: "djdl-*-macos.dmg",
          },
          {
            id: "ios",
            platform: "ios",
            arch: "arm64",
            format: "ipa",
            match: "djdl-*-ios.ipa",
          },
        ],
      },
    },
  },
};

function appDeclaration() {
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
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

export const OUTLETS: Array<[string, string, Record<string, unknown>]> = [
  ["app-store", "app-store", { appleId: "1234567890" }],
  ["direct", "direct", {}],
  ["play", "play", { packageName: "com.acme.djdl" }],
  ["testflight", "testflight", { publicLink: "AbCdEf12" }],
  ["web", "web", {}],
];

export interface FeedWorld {
  db: Db;
  env: Env;
  r2: R2Mock;
  token: string;
  /** The clock every request sees (epoch seconds); tests move it. */
  now: number;
}

export const noFetch: FetchImpl = async () =>
  new Response("nf", { status: 404 });

export async function feedWorld(
  opts: { releaseKeys?: boolean } = {},
): Promise<FeedWorld> {
  const db = makeTestDb();
  const env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, {
    release_keys_json: opts.releaseKeys === false ? null : releaseKeysJson(),
    manual_channels_json: JSON.stringify(RELEASE_DOC.release.manualChannels),
  });
  await db.batch(manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
  for (const [id, kind, identity] of OUTLETS)
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
  const token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
      expiresAt: NOW + 30 * 86400,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
  return { db, env, r2, token, now: NOW };
}

function post(w: FeedWorld, path: string, body: unknown) {
  return call(
    w.env,
    w.db,
    noFetch,
    `${CONSOLE}/${SLUG}/release/publish/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${w.token}`,
      },
      body: JSON.stringify(body),
    },
  );
}

/** The descriptor CI would submit for one version. */
export function descriptorFor(
  version: string,
  seq: number,
  opts: { channel?: string; platforms?: string[] } = {},
): Record<string, any> {
  const platforms = opts.platforms ?? ["web", "macos", "ios"];
  const web = new TextEncoder().encode(`web ${version}`);
  const mac = new TextEncoder().encode(`mac ${version}`);
  const builds: any[] = [];
  if (platforms.includes("web"))
    builds.push({
      id: "web",
      platform: "web",
      arch: "wasm32",
      format: "zip",
      artifacts: [
        {
          name: `djdl-${version}-web.zip`,
          role: "payload",
          sha256: sha(web),
          size: web.length,
          locations: [{ provider: "r2", key: `blobs/sha256/${sha(web)}` }],
        },
      ],
    });
  if (platforms.includes("macos"))
    builds.push({
      id: "macos",
      platform: "macos",
      arch: "universal",
      format: "dmg",
      artifacts: [
        {
          name: `djdl-${version}-macos.dmg`,
          role: "payload",
          sha256: sha(mac),
          size: mac.length,
          locations: [{ provider: "r2", key: `blobs/sha256/${sha(mac)}` }],
        },
      ],
    });
  if (platforms.includes("ios"))
    builds.push({
      id: "ios",
      platform: "ios",
      arch: "arm64",
      format: "ipa",
      buildNumber: String(seq + 100),
      artifacts: [],
    });
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version,
    seq,
    channel: opts.channel ?? "stable",
    builds,
  };
}

/** Publish one version through the real routes, with a record signed by the release key. */
export async function publish(
  w: FeedWorld,
  version: string,
  opts: {
    channel?: string;
    platforms?: string[];
    minSupportedSeq?: number;
    record?: boolean;
  } = {},
): Promise<{ releaseId: string; seq: number; recordSha: string | null }> {
  const pre = (await (
    await post(w, "uploads", {
      objects: [{ sha256: "0".repeat(64), size: 1 }],
      releases: [{ deliverable: "app", version }],
    })
  ).json()) as Record<string, any>;
  const seq = pre.seqs[0].seq as number;
  const d = descriptorFor(version, seq, opts);
  const objects = d.builds.flatMap((b: any) =>
    b.artifacts.map((a: any) => ({ sha256: a.sha256, size: a.size })),
  );
  const ticket = (await (
    await post(w, "uploads", { objects })
  ).json()) as Record<string, any>;
  for (const b of d.builds) {
    if (b.id === "ios") continue;
    const bytes = new TextEncoder().encode(
      `${b.id === "web" ? "web" : "mac"} ${version}`,
    );
    w.r2.seed(`${ticket.prefix}${sha(bytes)}`, bytes, { withSha256: true });
  }
  const jws =
    opts.record === false
      ? undefined
      : await signRecord(
          recordFor(d, {
            seq,
            issuedAt: w.now,
            ...(opts.minSupportedSeq !== undefined
              ? { minSupportedSeq: opts.minSupportedSeq }
              : {}),
          }),
        );
  const res = await post(w, "submit", {
    ticket: ticket.ticket,
    descriptor: d,
    ...(jws ? { record: jws } : {}),
  });
  const body = (await res.json()) as Record<string, any>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return {
    releaseId: body.releaseId as string,
    seq,
    recordSha: jws ? sha(jws) : null,
  };
}

/** A store reports a release live on an outlet (P2b-03's table). */
export async function markLive(
  w: FeedWorld,
  releaseId: string,
  outlet: string,
  buildId = "",
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
     VALUES (?, ?, ?, ?, 'store', 'live', ?, 'ci', ?)
     ON CONFLICT (product, release_id, build_id, outlet_id) DO UPDATE SET state = 'live'`,
    SLUG,
    releaseId,
    buildId,
    outlet,
    w.now,
    w.now,
  );
}

/** An outlet rollout on a channel (P2b-04's table). */
export async function setRollout(
  w: FeedWorld,
  r: {
    outlet: string;
    channel: string;
    releaseId: string;
    bp: number;
    state?: "active" | "paused" | "halted" | "complete";
    mirrored?: boolean;
    salt?: string;
  },
): Promise<void> {
  await w.db.run(
    `INSERT INTO dist_rollouts
       (product, deliverable_id, outlet_id, channel, release_id, rollout_bp, rollout_salt,
        state, mirrored, source, started_at, updated_at, updated_by)
     VALUES (?, 'app', ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?, 'u1')
     ON CONFLICT (product, deliverable_id, outlet_id, channel) DO UPDATE SET
       release_id = excluded.release_id, rollout_bp = excluded.rollout_bp,
       rollout_salt = excluded.rollout_salt, state = excluded.state,
       mirrored = excluded.mirrored, updated_at = excluded.updated_at`,
    SLUG,
    r.outlet,
    r.channel,
    r.releaseId,
    r.bp,
    r.salt ?? "0123456789abcdef0123456789abcdef",
    r.state ?? "active",
    r.mirrored ? 1 : 0,
    w.now,
    w.now,
  );
}

/** `GET /<p>/update/<channel>/feed.jws?platform=` through the real dispatcher. */
export async function getFeed(
  w: FeedWorld,
  channel: string,
  platform = "macos",
  headers: Record<string, string> = {},
): Promise<{
  res: Response;
  jws: string;
  payload: Record<string, any> | null;
}> {
  const res = await call(
    w.env,
    w.db,
    noFetch,
    `${CONSOLE}/${SLUG}/update/${channel}/feed.jws?platform=${platform}`,
    { headers },
  );
  const jws = await res.text();
  let payload: Record<string, any> | null = null;
  if (res.status === 200) {
    const part = jws.split(".")[1] ?? "";
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  }
  return { res, jws, payload };
}
