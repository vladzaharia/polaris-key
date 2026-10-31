// Seeds a product's Play Games server client credential for the redemption tests (Core's
// redeemer and Identity's verifier). The secret is an obviously fake value.

import { makeEnv, NOW, seedProduct } from "./seed.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { resetPgsSecretCache } from "../src/core/stores/playGames/serverAuth.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";

export const PGS_CLIENT_ID =
  "123456789012-fakeserverclient.apps.googleusercontent.com";
export const PGS_FAKE_SECRET = "FAKE-secret-not-real-0000";

export function putPgsServerCredential(
  env: Env,
  db: Db,
  over: {
    value?: unknown;
    pin?: string | undefined;
    credentialId?: string;
  } = {},
) {
  return putOutletCredential(env, db, {
    product: "djdl",
    credentialId: over.credentialId ?? "pgs-server",
    kind: "pgs-server-client",
    outletId: null,
    value: "value" in over ? over.value : { clientSecret: PGS_FAKE_SECRET },
    expiresAt: null,
    pin: "pin" in over ? over.pin : PGS_CLIENT_ID,
    actor: "admin-1",
    now: NOW,
  });
}

/** A fresh database and environment with product `djdl`, and an empty secret cache. */
export async function pgsTestWorld(): Promise<{ db: Db; env: Env }> {
  resetPgsSecretCache();
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
  return { db, env };
}
