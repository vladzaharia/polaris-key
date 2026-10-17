/**
 * The service route tables against the dispatch they replaced (P0-25).
 *
 * P0-25 moved every service's hand-written `routes.ts` switch into a declarative table
 * (`core/http/routes.ts`). The refactor must not change what any route answers, and above all
 * must never loosen a check: a method, auth or cap that a route refused before, it still refuses.
 * `fixtures/service-route-oracle.json` was recorded from the hand dispatch BEFORE the move: for
 * every canonical service route (the descriptors' `surface`) and a set of near-miss paths, under
 * each HTTP method, with and without a JSON body, the status, the headers that matter and a
 * digest of the body. This test replays the same requests through the real `dispatchWith`
 * pipeline and compares. The requests carry no credentials, so what is recorded is the method
 * gate, the path match and the first refusal each route makes; the authorised paths are the
 * suites' and the transcripts'.
 *
 * Regenerating the fixture is a deliberate act (`PKEY_RECORD_ORACLE=1`) and a reviewer reads the
 * diff: a changed row is a changed route.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { dispatchWith } from "../src/dispatch.js";
import { SERVICES } from "../src/mount.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "service-route-oracle.json");
const SLUG = "djdl";
const BASE = "https://key.plrs.im";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const PARAMS: Record<string, string> = {
  product: SLUG,
  sha256: "a".repeat(64),
  mintId: "recipe-1",
  channel: "stable",
  version: "1.2.3",
  asset: "djdl-arm64",
};

/** Paths that are not canonical routes but sit next to them: each is a place a table could
 *  answer where the switch did not, or the reverse. */
const NEAR_MISSES: string[] = [
  "license",
  "license/activate/extra",
  "license/nope",
  "config",
  "config/report",
  "config/document/extra",
  "config/mint",
  "config/mint/recipe-1",
  "config/mint/Bad_Id/token",
  "config/mint/recipe-1/nope",
  "config/mint/recipe-1/token/extra",
  "update",
  "update/nope",
  "update/stable",
  "update/stable/nope",
  "update/Bad_Chan/appcast.xml",
  "update/stable/feed.jws",
  "update/stable/winsparkle.xml",
  "update/stable/velopack/releases.win.json",
  "update/stable/app.appinstaller",
  "update/stable/abc.AppImage.zsync",
  "update/stable/velopack/djdl-1.2.3-full.nupkg",
  "update/version?channel=Bad_Chan",
  "update/version?platform=macos",
  "update/appcast.xml/extra",
  "identity",
  "identity/auth",
  "identity/auth/nope",
  "identity/session/nope",
  "identity/auth/device/nope",
  "identity/auth/device/start/extra",
  "identity/nope",
  "release",
  "release/nope",
  "release/records",
  "release/records/a/b",
  "release/channels/stable/nope",
  "release/channels/stable/promote/extra",
  "release/channels/%zz/promote",
  "release/releases/r1/nope",
  "release/releases/%zz/yank",
  "release/publish",
  "release/publish/nope",
  "release/publish/token",
  "release/publish/uploads",
  "release/publish/submit",
  "release/packages",
  "release/packages/nope",
  "distribution",
  "distribution/nope",
  "distribution/download",
  "distribution/rollouts",
  "distribution/rollouts/o",
  "distribution/rollouts/o/stable/nope",
  "distribution/rollouts/o/stable/pause/extra",
  "distribution/rollouts/o/stable/halt",
  "distribution/rollouts/o/stable/complete",
  "distribution/report/extra",
  "distribution/listing",
  "distribution/listing/assets",
  "distribution/listing/nope",
  "distribution/listing/google-play",
  "distribution/listing/%zz",
  "distribution/pr",
  "distribution/pr/nope",
  "distribution/pr/winget",
  "distribution/hooks",
  "distribution/hooks/asc",
  "distribution/hooks/app-store",
  "distribution/hooks/play-rtdn",
  "distribution/hooks/sentry",
  "distribution/hooks/nope",
  "distribution/hooks/asc/extra",
  "distribution/commerce",
  "distribution/commerce/binding",
  "distribution/commerce/claim",
  "distribution/commerce/nope",
  "distribution/feeds",
  "distribution/feeds/fdroid",
  "distribution/feeds/fdroid/stable",
  "distribution/fdroid/stable/repo/entry.jar",
  "distribution/fdroid/stable/repo/a/b",
  "distribution/fdroid/stable",
  "distribution/altstore/stable/source.json",
  "distribution/altstore-pal/stable/source.json",
  "distribution/obtainium/stable.json",
  "distribution/scoop/stable.json",
  "distribution/flathub/stable.json",
  "distribution/download.json/extra",
  "distribution/dl",
  "distribution/dl/1.2.3",
  "distribution/builds/stable",
  "distribution/files/r1",
  "distribution/blobs/sha256",
  "distribution/blobs/sha1/abc",
  "distribution/packs/p/v/payload",
  "distribution/install.sh/extra",
  "sync",
  "sync/pull",
];

function instantiate(template: string): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_m, name: string) => PARAMS[name] ?? "a1",
  );
}

function paths(): string[] {
  const out = new Set<string>();
  for (const d of SERVICES.values())
    for (const r of d.surface) out.add(instantiate(r.path));
  for (const n of NEAR_MISSES) out.add(`/${SLUG}/${n}`);
  return [...out].sort();
}

const CARRIED = [
  "allow",
  "content-type",
  "cache-control",
  "www-authenticate",
  "vary",
  "location",
  "retry-after",
  "content-length",
];

/** Opaque tokens and times differ per run; their shape does not. */
function normalise(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{24,}/g, "<tok>")
    .replace(/\b1[67]\d{8}\b/g, "<ts>");
}

interface Row {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

async function observe(res: Response): Promise<Row> {
  const headers: Record<string, string> = {};
  for (const name of CARRIED) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = normalise(v);
  }
  const setCookies =
    (
      res.headers as unknown as { getSetCookie?(): string[] }
    ).getSetCookie?.() ?? [];
  const cookies = setCookies.map((c) => c.split("=")[0]!).sort();
  const text = normalise(await res.text());
  return {
    status: res.status,
    headers,
    cookies,
    body: `${text.length}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
  };
}

async function seed(db: Db): Promise<void> {
  await seedProduct(db, SLUG);
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
        sync: { enabled: true },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access, operator_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "acme",
    "djdl",
    42,
    "channel.yml",
    "main",
    "[]",
    "djdl",
    null,
    null,
    "pkey:summary",
    "{}",
    "public",
    "public",
    JSON.stringify({ requireSparkleSignature: false }),
  );
  await seedDeliveryAccess(db, SLUG, "public");
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

describe("service route tables replay the hand dispatch", () => {
  let db: Db;
  beforeEach(async () => {
    db = makeTestDb();
    await seed(db);
    vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] });
    // GitHub, Apple and every other upstream is unreachable and answers the same way each time.
    vi.stubGlobal(
      "fetch",
      async () => new Response("upstream", { status: 503 }),
    );
    vi.stubGlobal("caches", {
      default: {
        async match() {
          return undefined;
        },
        async put() {},
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers every request as the recorded dispatch did", async () => {
    const observed: Record<string, Row> = {};
    for (const path of paths()) {
      for (const method of METHODS) {
        for (const withBody of method === "GET" || method === "HEAD"
          ? [false]
          : [false, true]) {
          const env = envFor();
          const init: RequestInit = { method };
          if (withBody) {
            init.body = "{}";
            init.headers = { "content-type": "application/json" };
          }
          let row: Row;
          try {
            const res = await dispatchWith(
              new Request(`${BASE}${path}`, init) as unknown as Request,
              env,
              db,
              NOW,
            );
            row = await observe(res);
          } catch (e) {
            // An upstream that is down surfaces as a throw; that, too, is behaviour to keep.
            row = {
              status: -1,
              headers: {},
              cookies: [],
              body: normalise(e instanceof Error ? e.message : String(e)),
            };
          }
          observed[`${method}${withBody ? "+body" : ""} ${path}`] = row;
        }
      }
    }
    if (process.env.PKEY_RECORD_ORACLE === "1") {
      writeFileSync(FIXTURE, JSON.stringify(observed, null, 1) + "\n");
      return;
    }
    const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
      string,
      Row
    >;
    expect(Object.keys(observed)).toEqual(Object.keys(recorded));
    for (const key of Object.keys(recorded))
      expect(observed[key], key).toEqual(recorded[key]);
  }, 120_000);
});
