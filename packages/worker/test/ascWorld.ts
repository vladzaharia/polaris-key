/**
 * Shared world for the App Store Connect connector suites (P5-02): the djdl release fixture
 * (Release + Distribution on, v1.0.0 and v1.1.0 synced), an `ios` build of v1.1.0 with build
 * number 42, `app-store` and `testflight` outlets for app 1234567890, an `asc-api-key` credential
 * whose `.p8` is generated here, pinned by the operator to that app (P5-02f; `pin` overrides it,
 * `pin: null` stores the key unpinned), an `asc-webhook-secret`, and the fake ASC server. No real
 * key, app or account anywhere.
 */

import { createHmac, generateKeyPairSync } from "node:crypto";
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
import { makeTestDb } from "./helpers.js";
import {
  call,
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import { AscFake, APPLE_ID } from "./ascFake.js";

export const WEBHOOK_SECRET = "whsec-test-only-0123456789abcdef";
export const HOOK_URL = `${CONSOLE}/${SLUG}/distribution/hooks/asc`;

export interface AscWorld {
  env: Env;
  db: Db;
  fake: AscFake;
  /** GitHub stub for Release, the fake for App Store Connect. */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
}

export function ascP8(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

export async function addOutlet(
  db: Db,
  id: string,
  kind: string,
  identity: Record<string, unknown>,
): Promise<void> {
  await db.run(
    `INSERT INTO dist_outlets
       (product, outlet_id, kind, identity_json, removed_at, created_at, modified_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

export async function putCredential(
  w: { env: Env; db: Db },
  id: string,
  kind: "asc-api-key" | "asc-webhook-secret",
  value: Record<string, unknown>,
  pin?: string,
): Promise<void> {
  const r = await putOutletCredential(w.env, w.db, {
    product: SLUG,
    credentialId: id,
    kind,
    outletId: null,
    value,
    ...(pin !== undefined ? { pin } : {}),
    expiresAt: null,
    actor: "admin-1",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.message);
}

export async function ascWorld(
  opts: {
    apiKey?: boolean;
    secret?: boolean;
    outlets?: boolean;
    /** The operator's pin on the `asc-api-key` (default: the outlets' app; `null`: none). */
    pin?: string | null;
    /** A fake with more routes (A-17d's `DistributeFake`); a plain `AscFake` by default. */
    fake?: AscFake;
  } = {},
): Promise<AscWorld> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  await upsertBuild(
    db,
    {
      product: SLUG,
      releaseId: "v1.1.0",
      buildId: "ios",
      platform: "ios",
      arch: "arm64",
      format: "ipa",
      buildNumber: "42",
    },
    NOW,
  );
  if (opts.outlets !== false) {
    await addOutlet(db, "app-store", "app-store", {
      appleId: APPLE_ID,
      bundleId: "gg.acme.djdl",
    });
    await addOutlet(db, "testflight", "testflight", {
      appleId: APPLE_ID,
      bundleId: "gg.acme.djdl",
    });
  }
  const w = { env, db };
  if (opts.apiKey !== false)
    await putCredential(
      w,
      "asc",
      "asc-api-key",
      {
        keyId: "ABC123DEFG",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: ascP8(),
      },
      opts.pin === null ? undefined : (opts.pin ?? APPLE_ID),
    );
  if (opts.secret !== false)
    await putCredential(w, "asc-webhook", "asc-webhook-secret", {
      secret: WEBHOOK_SECRET,
    });
  const fake = opts.fake ?? new AscFake();
  const fetchImpl = (input: string, init?: RequestInit) =>
    new URL(input).hostname === "api.appstoreconnect.apple.com"
      ? fake.fetchImpl(input, init)
      : gh.fetchImpl(input, init);
  return { env, db, fake, fetchImpl };
}

export function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `hmacsha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** POST a webhook body through the real dispatcher. */
export function deliver(
  w: AscWorld,
  body: string,
  signature: string | null = sign(body),
): Promise<Response> {
  return call(w.env, w.db, w.fetchImpl, HOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null ? { "x-apple-signature": signature } : {}),
    },
    body,
  });
}

/** Drive the real admin API as a platform admin, with the fakes as the global fetch. */
export async function admin(
  w: AscWorld,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}${path}`;
  const saved = globalThis.fetch;
  globalThis.fetch = w.fetchImpl as typeof fetch;
  try {
    return await handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      w.env,
      w.db,
      // The router sees the path; a query (a connector read's) stays on the URL.
      full.split("?")[0]!,
      { now: NOW },
    );
  } finally {
    globalThis.fetch = saved;
  }
}

/** Run `fn` with the fakes as the global fetch (the poller reads it late-bound). */
export async function withFetch<T>(
  w: AscWorld,
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

export async function audits(db: Db): Promise<
  Array<{
    action: string;
    actor_sub: string;
    target_id: string;
    summary: string;
  }>
> {
  return db.all(
    "SELECT action, actor_sub, target_id, summary FROM audit WHERE product = ? ORDER BY rowid",
    SLUG,
  );
}

export async function availability(db: Db): Promise<
  Array<{
    release_id: string;
    build_id: string;
    outlet_id: string;
    transport: string;
    state: string;
    source: string;
    platform_ref_json: string | null;
    detail_json: string | null;
  }>
> {
  return db.all(
    `SELECT release_id, build_id, outlet_id, transport, state, source, platform_ref_json, detail_json
       FROM dist_availability WHERE product = ? ORDER BY outlet_id, release_id, build_id`,
    SLUG,
  );
}

export async function submissions(db: Db): Promise<
  Array<{
    release_id: string;
    outlet_id: string;
    state: string;
    source: string;
  }>
> {
  return db.all(
    `SELECT release_id, outlet_id, state, source FROM dist_submissions
      WHERE product = ? ORDER BY release_id, outlet_id`,
    SLUG,
  );
}

export async function rollouts(db: Db): Promise<
  Array<{
    release_id: string;
    outlet_id: string;
    channel: string;
    rollout_bp: number;
    state: string;
    mirrored: number;
    source: string;
  }>
> {
  return db.all(
    `SELECT release_id, outlet_id, channel, rollout_bp, state, mirrored, source
       FROM dist_rollouts WHERE product = ? ORDER BY outlet_id, channel`,
    SLUG,
  );
}

export { APPLE_ID, NOW, SLUG };
