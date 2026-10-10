/**
 * P4-14's world: a product with Release, Distribution and Update on, a compatible required pack
 * (`djdl.foes`, contentApi >=4) and a standalone optional one (`djdl.l10n`), an app at contentApi
 * 4 with a `web` and an `ios` build, published through the real CI routes (the same steps as
 * `revocations.test.ts`), and outlets added as rows. Used by `packReadiness.test.ts` and
 * `blobGc.test.ts`.
 */

import { expect, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { base64UrlDecode } from "@polaris-key/jws";
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
import {
  chunksFor,
  packRecord,
  sha,
  treeVariant,
  type Obj,
} from "./packFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { loadProduct } from "../src/core/products.js";
import { buildHooks, type ServiceHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";

installDigestStream();

export { SLUG, CONSOLE, NOW };
export const FOES = "djdl.foes";
export const L10N = "djdl.l10n";

/** `android`: the app also ships an Android build (a Play outlet serves it; P4-15). */
export interface PackWorldOptions {
  android?: boolean;
}

/** The manifest documents the world declares, with the app at `contentApi`. */
function manifestOf(o: PackWorldOptions, contentApi = 4) {
  const doc = releaseDoc(o);
  doc.release.deliverables.app.content.contentApi = contentApi;
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
    release: JSON.stringify(doc),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!;
}

function releaseDoc(o: PackWorldOptions = {}) {
  return {
    release: {
      provider: { type: "github", owner: "acme", repo: "djdl" },
      binaryName: "djdl",
      releaseKeys: [{ kid: RELEASE_KID, publicKey: RELEASE_PUB }],
      deliverables: {
        app: {
          kind: "app",
          versioning: { scheme: "semver" },
          content: { contentApi: 4 },
          artifacts: [
            {
              id: "web",
              platform: "web",
              arch: "wasm32",
              format: "zip",
              match: "djdl-*-web.zip",
              embeds: [],
            },
            {
              id: "ios",
              platform: "ios",
              arch: "arm64",
              format: "ipa",
              match: "djdl-*.ipa",
              embeds: [],
            },
            ...(o.android
              ? [
                  {
                    id: "android",
                    platform: "android",
                    arch: "arm64",
                    format: "aab",
                    match: "djdl-*.aab",
                    embeds: [],
                  },
                ]
              : []),
          ],
        },
        [FOES]: {
          kind: "pack",
          type: "files.tree",
          binding: "compatible",
          required: true,
          delivery: "essential",
          requires: { contentApi: { app: ">=4" } },
        },
        [L10N]: { kind: "pack", type: "files.tree", binding: "standalone" },
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

export interface Published {
  sha256: string;
  seq: number;
  version: string;
  pack: string;
  releaseId: string;
  objects: Obj[];
  /** With `chunks` (P4-22): the chunk index and the bundle this release uploaded. */
  chunkIndex?: Obj;
  bundle?: Obj;
}

export const noFetch: FetchImpl = async () =>
  new Response("nf", { status: 404 });

export interface PackWorld {
  db: Db;
  env: Env;
  r2: R2Mock;
  token: string;
  post(path: string, body: unknown): Promise<Response>;
  /** Stage objects for `deliverable` (or an app ticket when `deliverable` is null). */
  stage(deliverable: string, objects: Obj[]): Promise<void>;
  publishPack(
    pack: string,
    version: string,
    o?: PublishPackOptions,
  ): Promise<Published>;
  submitApp(
    version: string,
    seq: number,
    content: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, any> }>;
  hooks(at?: number): Promise<ServiceHooks>;
  addOutlet(
    id: string,
    kind: string,
    identity?: Record<string, unknown>,
  ): Promise<void>;
  setTransport(
    deliverable: string,
    outlet: string,
    transport: string,
  ): Promise<void>;
  admin(method: string, path: string, body?: unknown): Promise<Response>;
  feed(platform: string): Promise<Record<string, any>>;
  /** Re-declare the app's `content.contentApi` (a resync of a changed `.pkey/release`). */
  declareContentApi(level: number): Promise<void>;
}

export interface PublishPackOptions {
  contentApi?: string | null;
  seed?: string;
  /** Give the variant a chunk index (P4-22); `reuse` names an earlier release's bundle. */
  chunks?: { reuse?: Obj };
}

export function pinOf(p: Published) {
  return {
    pack: p.pack,
    release: { sha256: p.sha256, seq: p.seq, version: p.version },
  };
}

/** The app's content at contentApi 4: expects foes (required) and l10n. */
export function appContent(): Record<string, unknown> {
  return {
    contentApi: 4,
    pins: [],
    expects: [
      { pack: FOES, required: true, delivery: "essential" },
      { pack: L10N, required: false, delivery: "prefetch" },
    ],
  };
}

export async function packWorld(
  opts: PackWorldOptions = {},
): Promise<PackWorld> {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  const db = makeTestDb();
  const env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  const r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, { release_keys_json: releaseKeysJson() });
  const rel = manifestOf(opts);
  await db.batch(
    manifestDeliverableStatements(SLUG, rel.app, NOW, rel.packDeliverables),
  );
  const token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: [
        "release:publish",
        "release:promote",
        "release:yank",
        "distribution:report",
        "distribution:rollout",
      ],
      expiresAt: NOW + 10 * 365 * 86400,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
  const seqs = new Map<string, number>();

  const post = (path: string, body: unknown) =>
    call(env, db, noFetch, `${CONSOLE}/${SLUG}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  async function stage(deliverable: string, objects: Obj[]) {
    const unique = [...new Map(objects.map((o) => [o.sha256, o])).values()];
    const up = await post("release/publish/uploads", {
      objects: unique.map((o) => ({
        sha256: o.sha256,
        size: o.bytes.length,
        gated: false,
      })),
    });
    expect(up.status, await up.clone().text()).toBe(200);
    const body = (await up.json()) as { ticket: string; prefix: string };
    for (const o of unique)
      r2.seed(`${body.prefix}${o.sha256}`, o.bytes, { withSha256: true });
    const res = await post("release/publish/stage", {
      ticket: body.ticket,
      deliverable,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }

  async function publishPack(
    pack: string,
    version: string,
    o: PublishPackOptions = {},
  ): Promise<Published> {
    const seq = (seqs.get(pack) ?? 0) + 1;
    const seed = o.seed ?? `${pack}-${version}`;
    const built = await treeVariant({}, seed);
    const chunked = o.chunks
      ? chunksFor(
          built.objects[0]!.bytes,
          built.variant.payload as { size: number; sha256: string },
          seed,
          { reuse: o.chunks.reuse },
        )
      : null;
    if (chunked) built.variant.chunks = chunked.chunks;
    await stage(pack, [
      ...built.objects,
      ...(chunked ? [chunked.index, chunked.bundle] : []),
    ]);
    const contentApi = o.contentApi === undefined ? ">=4" : o.contentApi;
    const record = packRecord({
      aud: SLUG,
      deliverable: pack,
      version,
      seq,
      issuedAt: Math.floor(Date.now() / 1000),
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
    });
    const jws = await signRecord(record);
    const res = await post("release/publish/submit", { record: jws });
    expect(res.status, await res.clone().text()).toBe(200);
    seqs.set(pack, seq);
    return {
      sha256: sha(jws),
      seq,
      version,
      pack,
      releaseId: `${pack}@${version}`,
      objects: built.objects,
      ...(chunked ? { chunkIndex: chunked.index, bundle: chunked.bundle } : {}),
    };
  }

  async function submitApp(
    version: string,
    seq: number,
    content: Record<string, unknown>,
  ) {
    const WEB = new TextEncoder().encode(`web build ${version}`);
    const IPA = new TextEncoder().encode(`ios build ${version}`);
    const AAB = new TextEncoder().encode(`android build ${version}`);
    const descriptor = {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "app",
      kind: "app",
      version,
      seq,
      channel: "stable",
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
              sha256: sha(WEB),
              size: WEB.length,
              locations: [{ provider: "r2", key: `blobs/sha256/${sha(WEB)}` }],
            },
          ],
        },
        {
          id: "ios",
          platform: "ios",
          arch: "arm64",
          format: "ipa",
          embeds: [],
          artifacts: [
            {
              name: `djdl-${version}.ipa`,
              role: "payload",
              sha256: sha(IPA),
              size: IPA.length,
              locations: [{ provider: "r2", key: `blobs/sha256/${sha(IPA)}` }],
            },
          ],
        },
        ...(opts.android
          ? [
              {
                id: "android",
                platform: "android",
                arch: "arm64",
                format: "aab",
                embeds: [],
                artifacts: [
                  {
                    name: `djdl-${version}.aab`,
                    role: "payload",
                    sha256: sha(AAB),
                    size: AAB.length,
                    locations: [
                      { provider: "r2", key: `blobs/sha256/${sha(AAB)}` },
                    ],
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const up = await post("release/publish/uploads", {
      objects: [
        { sha256: sha(WEB), size: WEB.length },
        { sha256: sha(IPA), size: IPA.length },
        ...(opts.android ? [{ sha256: sha(AAB), size: AAB.length }] : []),
      ],
    });
    const body = (await up.json()) as { ticket: string; prefix: string };
    r2.seed(`${body.prefix}${sha(WEB)}`, WEB, { withSha256: true });
    r2.seed(`${body.prefix}${sha(IPA)}`, IPA, { withSha256: true });
    if (opts.android)
      r2.seed(`${body.prefix}${sha(AAB)}`, AAB, { withSha256: true });
    const jws = await signRecord(
      recordFor(descriptor, {
        seq,
        issuedAt: Math.floor(Date.now() / 1000),
      }),
    );
    const res = await post("release/publish/submit", {
      ticket: body.ticket,
      descriptor,
      record: jws,
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  }

  async function hooks(at = Math.floor(Date.now() / 1000)) {
    const product = (await loadProduct(env, db, SLUG))!;
    return buildHooks(SERVICES, product.services, {
      env,
      db,
      product,
      now: at,
    });
  }

  async function addOutlet(
    id: string,
    kind: string,
    identity: Record<string, unknown> = {},
  ) {
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

  async function setTransport(
    deliverable: string,
    outlet: string,
    transport: string,
  ) {
    await db.run(
      `INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET transport = excluded.transport`,
      SLUG,
      deliverable,
      outlet,
      transport,
    );
  }

  async function admin(method: string, path: string, body?: unknown) {
    const now = Math.floor(Date.now() / 1000);
    const { token: cookie, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      now,
    );
    const full = `/api/products/${SLUG}${path}`;
    return handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${cookie}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      db,
      full.split("?")[0]!,
      { now },
    );
  }

  async function feed(platform: string) {
    const res = await call(
      env,
      db,
      noFetch,
      `${CONSOLE}/${SLUG}/update/stable/feed.jws?platform=${platform}`,
    );
    expect(res.status).toBe(200);
    const jws = await res.text();
    return JSON.parse(
      new TextDecoder().decode(base64UrlDecode(jws.split(".")[1]!)),
    ) as Record<string, any>;
  }

  async function declareContentApi(level: number) {
    const m = manifestOf(opts, level);
    await db.batch(
      manifestDeliverableStatements(SLUG, m.app, NOW, m.packDeliverables),
    );
  }

  return {
    declareContentApi,
    db,
    env,
    r2,
    token,
    post,
    stage,
    publishPack,
    submitApp,
    hooks,
    addOutlet,
    setTransport,
    admin,
    feed,
  };
}
