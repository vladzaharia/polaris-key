// The own client's redirect answers (WIRE-CONTRACT-V5 §12.4 rule 4, §12.9): with the card on the
// customer host, Continue, Cancel and the key return carry an `iss` equal to the issuer discovery
// names, not the card host's own origin.

import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { dispatchWith } from "../../src/dispatch.js";
import { SETTINGS } from "../../src/mount.js";
import { KvMock } from "../kvMock.js";
import { makeTestDb } from "../helpers.js";
import { portalHooksFor } from "../portalHarness.js";
import { issuePortalSessionRow } from "../portalSessionRow.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "../seed.js";
import { setServices } from "../../src/core/products/store.js";
import {
  SERVICE_SLUGS,
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { getOrCreateAccountByEmail } from "../../src/services/identity/portal/repo.js";
import { handlePortalApi as portalApi } from "../../src/services/identity/portal/api.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../src/services/identity/portal/session.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import type { Env } from "../../src/platform/env.js";

const SLUG = "tidewater";
const BASE = "https://key.plrs.im";
const CARD = "https://polaris.locker";
const APP = "https://app.example";
const CB = `${APP}/auth/callback`;
const VERIFIER = "v".repeat(48);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let db: SqliteDb;
let env: Env;
let key: string;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  const e = env as unknown as Record<string, unknown>;
  e.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  e.CONSOLE_ORIGIN = BASE;
  e.CUSTOMER_ORIGIN = CARD;
  e.LAUNCH_IDENTITY_RETURNKEY = "on";
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET web_origins_json = ? WHERE slug = ?",
    JSON.stringify([APP]),
    SLUG,
  );
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
     VALUES (?, 'identity.redirectPaths', ?, 'manifest', ?, 'test')`,
    SLUG,
    '["/auth/callback"]',
    NOW,
  );
  const map = Object.fromEntries(
    SERVICE_SLUGS.map((s) => [
      s,
      { enabled: ["license", "config", "identity"].includes(s) },
    ]),
  ) as ServicesMap;
  await setServices(
    db,
    SLUG,
    serializeServices({ services: map }),
    "manifest",
    NOW,
  );
});

const send = (url: string) =>
  dispatchWith(new Request(url) as never, env, db, NOW);

/** The issuer a client reads from discovery. */
async function discoveredIssuer(): Promise<string> {
  const res = await send(`${BASE}/${SLUG}/.well-known/polaris.json`);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    services: { identity: { issuer: string } };
  };
  return doc.services.identity.issuer;
}

/** authorize on the API host, then the bind hop on the customer host: the handle and binder. */
async function begin() {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: SLUG,
    redirect_uri: CB,
    state: "s".repeat(24),
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    key_return: "allow",
  });
  const auth = await send(`${BASE}/${SLUG}/identity/authorize?${q}`);
  expect(auth.status).toBe(303);
  const hop = new URL(auth.headers.get("location")!);
  expect(hop.origin).toBe(CARD);
  const hopped = await send(hop.href);
  expect(hopped.status).toBe(303);
  return {
    handle: hop.searchParams.get("request")!,
    binder: hopped.headers.get("set-cookie")!.split(";")[0]!,
  };
}

async function press(
  handle: string,
  verb: "continue" | "cancel" | "key",
  binder: string,
): Promise<string> {
  const path = `/api/signin/requests/${handle}/${verb}`;
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  const res = await portalApi(
    new Request(`${CARD}${path}`, {
      method: "POST",
      headers: {
        cookie: `${PORTAL_COOKIE}=${token}; ${binder}`,
        [PORTAL_CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(verb === "key" ? { key } : {}),
    }),
    env,
    db,
    path,
    NOW,
    portalHooksFor(env, db),
    SETTINGS,
  );
  expect(res.status).toBe(200);
  const to = new URL(((await res.json()) as { redirect: string }).redirect);
  return to.searchParams.get("iss")!;
}

describe("the own client's iss on the customer host", () => {
  for (const verb of ["continue", "cancel", "key"] as const) {
    it(`${verb} carries the issuer discovery names`, async () => {
      if (verb === "key") ({ key } = await seedLicenseWithKey(db, SLUG));
      const issuer = await discoveredIssuer();
      expect(new URL(issuer).origin).toBe(BASE);
      const { handle, binder } = await begin();
      expect(await press(handle, verb, binder)).toBe(issuer);
    });
  }
});
