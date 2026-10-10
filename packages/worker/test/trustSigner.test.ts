// Trust-manifest signer choice, 400-day revoked listing
// and canonical base64url MAC / pull-token decoding.

import { describe, expect, it } from "vitest";
import { inspectBundle } from "@polaris-key/client-core";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  seedLicenseWithKey,
  NOW,
  seedProduct,
  TEST_KID,
} from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { loadProduct } from "../src/core/products.js";
import { handleTrustManifest } from "../src/core/trust/trust.js";
import { REVOKED_KEY_LISTING_SECONDS } from "@polaris-key/protocol/trust";
import { insertProductKey } from "../src/core/repo.js";
import { seal } from "../src/platform/keyvault.js";
import { b64urlDecodeStrict, b64urlEncode } from "../src/platform/bytes.js";
import {
  mintDownloadTicket,
  verifyDownloadTicket,
} from "../src/core/downloadTicket.js";
import {
  signPullToken,
  verifyPullToken,
} from "../src/core/registry/registryTokens.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";

const SLUG = "djdl";

/** A fresh Ed25519 key, sealed into product_keys under `status`; returns its kid and pub. */
async function addKey(
  db: Db,
  env: Env,
  kid: string,
  status: "staged" | "retired" | "revoked",
  revokedAt: number | null = null,
): Promise<string> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  const pub = b64urlEncode(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
  );
  await insertProductKey(db, {
    product: SLUG,
    kid,
    alg: "Ed25519",
    public_b64url: pub,
    enc_private_json: await seal(env, pem, {
      product: SLUG,
      kind: "signing-key",
      id: kid,
    }),
    status,
    created_at: NOW - 1000,
    rotated_at: null,
    revoked_at: revokedAt,
  });
  // insertProductKey does not write revoked_at.
  await db.run(
    "UPDATE product_keys SET revoked_at = ? WHERE product = ? AND kid = ?",
    revokedAt,
    SLUG,
    kid,
  );
  return pub;
}

function header(jws: string): { kid: string } {
  return JSON.parse(Buffer.from(jws.split(".")[0]!, "base64url").toString());
}
function payload(jws: string): TrustManifestDoc {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString());
}

async function serve(
  env: Env,
  db: Db,
  qs: string,
): Promise<{ status: number; jws: string }> {
  const product = (await loadProduct(env, db, SLUG))!;
  const req = new Request(
    `https://key.plrs.im/${SLUG}/.well-known/polaris-trust.jws${qs}`,
  );
  const res = await handleTrustManifest(req, env, db, product, NOW);
  return { status: res.status, jws: await res.text() };
}

async function world(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG);
  return { db, env };
}

describe("trust manifest signer choice", () => {
  it("default is the active key; ?signer= serves the same manifest under a staged or retired key", async () => {
    const { db, env } = await world();
    await addKey(db, env, "kid-staged", "staged");
    await addKey(db, env, "kid-retired", "retired");

    const def = await serve(env, db, "");
    expect(header(def.jws).kid).toBe(TEST_KID);

    for (const kid of ["kid-staged", "kid-retired"]) {
      const r = await serve(env, db, `?signer=${kid}`);
      expect(r.status).toBe(200);
      expect(header(r.jws).kid).toBe(kid);
      expect(payload(r.jws).keys).toEqual(payload(def.jws).keys);
    }
  });

  it("a revoked, unknown or active signer falls back to the default and never signs with a revoked key", async () => {
    const { db, env } = await world();
    await addKey(db, env, "kid-revoked", "revoked", NOW - 10);
    for (const qs of [
      "?signer=kid-revoked",
      "?signer=nope",
      `?signer=${TEST_KID}`,
      "?signer=",
    ]) {
      const r = await serve(env, db, qs);
      expect(r.status).toBe(200);
      expect(header(r.jws).kid).toBe(TEST_KID);
    }
  });

  it("lists a key revoked 300 days ago, not one revoked 401 days ago", async () => {
    const { db, env } = await world();
    const DAY = 86_400;
    await addKey(db, env, "kid-rev-300d", "revoked", NOW - 300 * DAY);
    await addKey(db, env, "kid-rev-401d", "revoked", NOW - 401 * DAY);
    expect(REVOKED_KEY_LISTING_SECONDS).toBe(400 * DAY);
    const byKid = Object.fromEntries(
      payload((await serve(env, db, "")).jws).keys.map((k) => [
        k.kid,
        k.status,
      ]),
    );
    expect(byKid["kid-rev-300d"]).toBe("revoked");
    expect(byKid["kid-rev-401d"]).toBeUndefined();
  });
});

describe("bundle mint signer choice", () => {
  async function mint(
    body0: Record<string, unknown>,
  ): Promise<{ res: Response; pub: string; env: Env }> {
    const { db, env } = await world();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    const { licenseId } = await seedLicenseWithKey(db, SLUG, {});
    const body = { licenseId, ...body0 };
    const pub = await addKey(db, env, "kid-staged", "staged");
    await addKey(db, env, "kid-revoked", "revoked", NOW - 10);
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: ["platform-admins"] },
      NOW,
    );
    const path = `/api/products/${SLUG}/bundles`;
    const res = await handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
          graceDays: 30,
          ...body,
        }),
      }) as unknown as Request,
      env,
      db,
      path,
      { now: NOW },
    );
    return { res, pub, env };
  }

  it("signerKid mints a bundle that verifies against a client pinning only that key", async () => {
    const { res, pub } = await mint({ signerKid: "kid-staged" });
    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as { bundle: string };
    expect(header(bundle).kid).toBe("kid-staged");
    const r = await inspectBundle(bundle, {
      pinned: { "kid-staged": pub },
      product: SLUG,
      floors: { license: null, config: null },
      profile: "import",
      deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("a revoked or unknown signerKid is a 400, and without one the active key signs", async () => {
    for (const signerKid of ["kid-revoked", "nope"]) {
      const { res } = await mint({ signerKid });
      expect(res.status).toBe(400);
    }
    const { res } = await mint({});
    expect(res.status).toBe(200);
    expect(header(((await res.json()) as { bundle: string }).bundle).kid).toBe(
      TEST_KID,
    );
  });
});

describe("canonical base64url", () => {
  const ALPHA =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  /** The same bytes spelled with every other value of the unused low bits of the last char. */
  function respellings(s: string, unusedBits: number): string[] {
    const last = ALPHA.indexOf(s.at(-1)!);
    const base = last & ~((1 << unusedBits) - 1);
    return Array.from({ length: 1 << unusedBits }, (_, i) => base + i)
      .filter((v) => v !== last)
      .map((v) => s.slice(0, -1) + ALPHA[v]);
  }

  it("the strict decoder rejects non-canonical trailing bits", () => {
    const s = b64urlEncode(new Uint8Array(32).fill(7)); // 43 chars, 2 unused bits
    expect(b64urlDecodeStrict(s)).not.toBeNull();
    for (const v of respellings(s, 2)) expect(b64urlDecodeStrict(v)).toBeNull();
  });

  const env = {
    PLATFORM_KEK: "BRIfLDlGU2BteoeUoa67yNXi7/wJFiMwPUpXZHF+i5g=",
    DOWNLOAD_TICKET_KEY: "spell-ticket-key",
    BLOB_ORIGIN: "https://dl.example.test",
    REGISTRY_TOKEN_KEY: "spell-registry-key",
  } as unknown as Env;

  it("a download ticket's MAC has one spelling", async () => {
    const file = {
      product: "p",
      releaseId: "r1",
      name: "a.zip",
      sha256: "b".repeat(64),
    };
    const t = (await mintDownloadTicket(env, file, NOW))!;
    const at = { ...file, host: "dl.example.test" };
    expect(await verifyDownloadTicket(env, t, at, NOW)).toBe(true);
    for (const v of respellings(t, 2))
      expect(await verifyDownloadTicket(env, v, at, NOW)).toBe(false);
  });

  it("a pull token's signature has one spelling", async () => {
    const { token } = (await signPullToken(
      env,
      { sub: "acct", own: null, repos: ["o/r"] },
      NOW,
    ))!;
    expect(await verifyPullToken(env, token, NOW + 1)).not.toBeNull();
    for (const v of respellings(token, 2))
      expect(await verifyPullToken(env, v, NOW + 1)).toBeNull();
  });
});
