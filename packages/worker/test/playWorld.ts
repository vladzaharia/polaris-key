/**
 * Shared world for the Google Play connector suites (P5-03): the djdl release fixture (Release +
 * Distribution on, v1.0.0 and v1.1.0 synced), android builds — v1.0.0 `android` (version code
 * 100), v1.1.0 `android-armv7` (110) and `android-arm64` (111) — a `play` outlet for
 * `gg.acme.djdl` mapping `stable → production` and `beta → beta`, a `google-service-account`
 * credential whose RSA key is generated here, and the fake Google (`playFake.ts`). No real key,
 * app or account anywhere.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { upsertBuild } from "../src/services/release/model.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { makeTestDb } from "./helpers.js";
import {
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import {
  importRsaPublicKey,
  PLAY_PACKAGE,
  PlayFake,
  type PlayFixtures,
} from "./playFake.js";
import { addOutlet, audits, availability, rollouts } from "./ascWorld.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLAY_FIXTURES = join(HERE, "fixtures", "play");
export const CLIENT_EMAIL = "pkey-release@acme-djdl.iam.gserviceaccount.com";

export function playFixtures(): PlayFixtures {
  return {
    publisher: JSON.parse(
      readFileSync(join(PLAY_FIXTURES, "publisher.json"), "utf8"),
    ) as Record<string, unknown>,
    reporting: JSON.parse(
      readFileSync(join(PLAY_FIXTURES, "reporting.json"), "utf8"),
    ) as Record<string, unknown>,
  };
}

export interface PlayWorld {
  env: Env;
  db: Db;
  fake: PlayFake;
  /** GitHub stub for Release, the fake for Google. */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** Recorded `sleep` calls (the client's 429 backoff). */
  sleeps: number[];
}

export function rsaKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

export const PLAY_OUTLET_IDENTITY = {
  packageName: PLAY_PACKAGE,
  tracks: { stable: "production", beta: "beta" },
};

export async function playWorld(
  opts: {
    credential?: boolean;
    outlets?: boolean;
    /** Extra outlets, e.g. a `play-testing` one mapping an internal channel. */
    extraOutlets?: Array<{
      id: string;
      kind: string;
      identity: Record<string, unknown>;
    }>;
  } = {},
): Promise<PlayWorld> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  const builds: Array<[string, string, string, string]> = [
    ["v1.0.0", "android", "arm64", "100"],
    ["v1.1.0", "android-armv7", "armv7", "110"],
    ["v1.1.0", "android-arm64", "arm64", "111"],
  ];
  for (const [releaseId, buildId, arch, buildNumber] of builds)
    await upsertBuild(
      db,
      {
        product: SLUG,
        releaseId,
        buildId,
        platform: "android",
        arch,
        format: "aab",
        buildNumber,
      },
      NOW,
    );
  if (opts.outlets !== false)
    await addOutlet(db, "play", "play", PLAY_OUTLET_IDENTITY);
  for (const o of opts.extraOutlets ?? [])
    await addOutlet(db, o.id, o.kind, o.identity);
  const keys = rsaKeyPair();
  if (opts.credential !== false) {
    const r = await putOutletCredential(env, db, {
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
      expiresAt: null,
      actor: "admin-1",
      now: NOW,
    });
    if (!r.ok) throw new Error(r.message);
  }
  const fake = new PlayFake(
    playFixtures(),
    await importRsaPublicKey(keys.publicPem),
    CLIENT_EMAIL,
  );
  const fetchImpl = (input: string, init?: RequestInit) => {
    const host = new URL(input).hostname;
    return host.endsWith("googleapis.com")
      ? fake.fetchImpl(input, init)
      : gh.fetchImpl(input, init);
  };
  return { env, db, fake, fetchImpl, sleeps: [] };
}

/** Run `fn` with the fakes as the global fetch (the poller reads it late-bound). */
export async function withFetch<T>(
  w: PlayWorld,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

/** One connector-cron tick through the real `scheduled.ts` entry. */
export function poll(w: PlayWorld, now = NOW) {
  return withFetch(w, () => runConnectorPolls(w.env, w.db, now));
}

/** Drive the real admin API as a platform admin, with the fakes as the global fetch. */
export async function admin(
  w: PlayWorld,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}${path}`;
  return withFetch(w, () =>
    handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      w.env,
      w.db,
      full,
      { now: NOW },
    ),
  );
}

export async function trackObjects(db: Db) {
  return db.all<{
    object_id: string;
    outlet_id: string | null;
    release_id: string | null;
    store_state: string | null;
    state: string | null;
    terminal: number;
    detail_json: string;
  }>(
    `SELECT object_id, outlet_id, release_id, store_state, state, terminal, detail_json
       FROM dist_connector_objects
      WHERE product = ? AND connector = 'play' AND object_type = 'track'
      ORDER BY object_id`,
    SLUG,
  );
}

export { audits, availability, rollouts, NOW, SLUG, PLAY_PACKAGE };
