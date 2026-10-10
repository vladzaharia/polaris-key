/**
 * `core/outletTokens.ts` (P5-01): the App Store Connect JWT and the Google JWT-bearer exchange,
 * against keys generated here and a fake token endpoint. No network, no real credential.
 *
 * Both token functions are cache-first: they check their cache by the credential's non-secret
 * version marker and open (and audit) the credential only on a miss. These tests pin that a hit
 * writes no `outlet_credential.use` row and does not touch `last_used_at`.
 */

import {
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { open } from "../src/platform/keyvault.js";
import { listAudit } from "../src/core/repo.js";
import {
  GOOGLE_TOKEN_URI,
  listOutletCredentials,
  outletCredentialVersion,
  putOutletCredential,
  type OutletCredentialKind,
} from "../src/core/outletCredentials.js";
import {
  ASC_AUDIENCE,
  ascToken,
  GOOGLE_JWT_BEARER_GRANT,
  googleAccessToken,
  outletTokenSlot,
  outletTokenSlotHash,
  readSealedToken,
  writeSealedToken,
} from "../src/core/outletTokens.js";

const part = (s: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;

let db: Db;
let kv: KvMock;
let env: Env;
beforeEach(async () => {
  db = makeTestDb();
  kv = new KvMock();
  env = makeEnv(kv, ["djdl"]);
  await seedProduct(db, "djdl");
});

async function put(
  credentialId: string,
  kind: OutletCredentialKind,
  value: Record<string, unknown>,
): Promise<void> {
  const r = await putOutletCredential(env, db, {
    product: "djdl",
    credentialId,
    kind,
    outletId: null,
    value,
    expiresAt: null,
    actor: "admin-1",
    now: NOW,
  });
  expect(r.ok).toBe(true);
}

/** The `outlet_credential.use` rows written so far: one per open. */
const opens = async () =>
  (await listAudit(db, "djdl", {})).filter(
    (a) => a.action === "outlet_credential.use",
  );

const lastUsed = async (id: string) =>
  (await listOutletCredentials(db, "djdl")).find((c) => c.id === id)
    ?.lastUsedAt;

const ASC_VALUE = {
  keyId: "ABC123DEFG",
  issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
};

function ascKey(): { p8: string; publicKey: KeyObject } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey: createPublicKey(privateKey),
    p8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

function verifiesEs256(token: string, publicKey: KeyObject): boolean {
  const [h, p, s] = token.split(".") as [string, string, string];
  return verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url"),
  );
}

describe("ascToken", () => {
  it("produces an ES256 token that verifies with the public key, with exp - iat ≤ 1200", async () => {
    const { p8, publicKey } = ascKey();
    await put("asc", "asc-api-key", { ...ASC_VALUE, p8 });
    const token = await ascToken(env, db, "djdl", "asc", "asc:poll", NOW);
    expect(token).not.toBeNull();
    const [h, p] = token!.split(".") as [string, string, string];
    expect(part(h)).toEqual({ alg: "ES256", typ: "JWT", kid: "ABC123DEFG" });
    const claims = part(p);
    expect(claims).toEqual({
      iss: ASC_VALUE.issuerId,
      iat: NOW,
      exp: NOW + 1200,
      aud: ASC_AUDIENCE,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      1200,
    );
    expect(verifiesEs256(token!, publicKey)).toBe(true);
  });

  it("re-uses the token until 60 s before expiry without opening the credential, then mints a new one", async () => {
    await put("asc", "asc-api-key", { ...ASC_VALUE, p8: ascKey().p8 });
    const first = await ascToken(env, db, "djdl", "asc", "asc:poll", NOW);
    expect(await opens()).toHaveLength(1);
    expect(await lastUsed("asc")).toBe(NOW);

    // A memo hit: same token, no audit row, no last_used_at write.
    expect(await ascToken(env, db, "djdl", "asc", "asc:poll", NOW + 1139)).toBe(
      first,
    );
    expect(await opens()).toHaveLength(1);
    expect(await lastUsed("asc")).toBe(NOW);

    const next = await ascToken(env, db, "djdl", "asc", "asc:poll", NOW + 1140);
    expect(next).not.toBe(first);
    expect(part(next!.split(".")[1]!).iat).toBe(NOW + 1140);
    expect(await opens()).toHaveLength(2);
  });

  it("never serves a token signed by a rotated-away key", async () => {
    await put("asc", "asc-api-key", { ...ASC_VALUE, p8: ascKey().p8 });
    const first = await ascToken(env, db, "djdl", "asc", "asc:poll", NOW);
    const rotated = ascKey();
    await put("asc", "asc-api-key", { ...ASC_VALUE, p8: rotated.p8 });
    const second = await ascToken(env, db, "djdl", "asc", "asc:poll", NOW + 1);
    expect(second).not.toBe(first);
    expect(verifiesEs256(second!, rotated.publicKey)).toBe(true);
  });

  it("answers null for an unknown id or a credential of another kind, without opening anything", async () => {
    await put("whsec", "asc-webhook-secret", { secret: "whsec-test-only" });
    expect(await ascToken(env, db, "djdl", "nope", "asc:poll", NOW)).toBeNull();
    expect(
      await ascToken(env, db, "djdl", "whsec", "asc:poll", NOW),
    ).toBeNull();
    expect(await opens()).toHaveLength(0);
  });
});

function googleKey(): Record<string, unknown> & { private_key: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    type: "service_account",
    client_email: "play-publisher@test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    token_uri: GOOGLE_TOKEN_URI,
  };
}

/** A fake Google token endpoint: records each call and answers with a numbered token. */
function fakeTokenEndpoint(expiresIn = 3600) {
  const calls: Array<{ url: string; body: URLSearchParams; type: string }> = [];
  const fetchImpl = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url,
      body: new URLSearchParams(String(init?.body)),
      type: new Headers(init?.headers).get("content-type") ?? "",
    });
    return new Response(
      JSON.stringify({
        access_token: `ya29.test-${calls.length}`,
        expires_in: expiresIn,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
}

const SCOPES = ["https://www.googleapis.com/auth/androidpublisher"];

const google = (
  now: number,
  fetchImpl: ReturnType<typeof fakeTokenEndpoint>["fetchImpl"],
  scopes = SCOPES,
) =>
  googleAccessToken(
    env,
    db,
    "djdl",
    "play",
    scopes,
    "play:token",
    now,
    fetchImpl,
  );

describe("googleAccessToken", () => {
  it("exchanges an RS256 JWT-bearer assertion at Google's token endpoint", async () => {
    const key = googleKey();
    await put("play", "google-service-account", key);
    const { calls, fetchImpl } = fakeTokenEndpoint();
    expect(await google(NOW, fetchImpl)).toBe("ya29.test-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]!.type).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.body.get("grant_type")).toBe(GOOGLE_JWT_BEARER_GRANT);
    const [h, p, s] = calls[0]!.body.get("assertion")!.split(".") as [
      string,
      string,
      string,
    ];
    expect(part(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(part(p)).toEqual({
      iss: key.client_email,
      scope: SCOPES[0],
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW,
      exp: NOW + 3600,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        createPublicKey(key.private_key),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
  });

  it("caches the token sealed in KV, re-uses it without opening the credential, and refreshes it after expiry", async () => {
    await put("play", "google-service-account", googleKey());
    const { calls, fetchImpl } = fakeTokenEndpoint(3600);

    expect(await google(NOW, fetchImpl)).toBe("ya29.test-1");
    expect(await opens()).toHaveLength(1);
    // Cached: sealed (no plaintext token in KV), TTL `expires_in - 300`.
    const [key] = kv.keys();
    expect(key).toMatch(/^p:djdl:outlet-token:play:[0-9a-f]{32}$/);
    const raw = (await kv.get(key!))!;
    expect(raw).not.toContain("ya29");
    expect(kv.ttlOf(key!)).toBe(3300);
    const hash = key!.split(":").at(-1)!;
    const plain = await open(env, raw, {
      product: "djdl",
      kind: "outlet-credential",
      id: `token:play:${hash}`,
    });
    expect(JSON.parse(plain)).toEqual({
      token: "ya29.test-1",
      expiresAt: NOW + 3300,
    });

    // Re-used inside the window: no second exchange, no open, no audit row, no last_used_at.
    expect(await google(NOW + 3299, fetchImpl)).toBe("ya29.test-1");
    expect(calls).toHaveLength(1);
    expect(await opens()).toHaveLength(1);
    expect(await lastUsed("play")).toBe(NOW);

    // Refreshed once the cached copy has expired (KV may still hold it): one more open.
    expect(await google(NOW + 3300, fetchImpl)).toBe("ya29.test-2");
    expect(calls).toHaveLength(2);
    expect(await opens()).toHaveLength(2);
  });

  it("derives the cache slot from the scope and the version marker alone — computable before any open", async () => {
    await put("play", "google-service-account", googleKey());
    const { fetchImpl } = fakeTokenEndpoint();
    await google(NOW, fetchImpl);
    const version = await outletCredentialVersion(
      db,
      "djdl",
      "play",
      "google-service-account",
    );
    expect(version).toMatch(/^[0-9a-f]{32}$/);
    const slot = outletTokenSlot(
      "djdl",
      "play",
      await outletTokenSlotHash(SCOPES[0]!, version!),
    );
    expect(kv.keys()).toEqual([slot.key]);
    expect((await readSealedToken(env, slot, NOW))?.token).toBe("ya29.test-1");
  });

  it("keys the cache by scope and by stored value, so neither can serve the other's token", async () => {
    await put("play", "google-service-account", googleKey());
    const { calls, fetchImpl } = fakeTokenEndpoint();
    await google(NOW, fetchImpl);
    await google(NOW, fetchImpl, [
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
    // Rotated in place: a new version marker, so the old slot is never consulted.
    await put("play", "google-service-account", googleKey());
    expect(await google(NOW, fetchImpl)).toBe("ya29.test-3");
    expect(calls).toHaveLength(3);
  });

  it("answers null for an unusable credential without calling the token endpoint", async () => {
    await put("asc", "asc-api-key", { ...ASC_VALUE, p8: ascKey().p8 });
    const { calls, fetchImpl } = fakeTokenEndpoint();
    expect(await google(NOW, fetchImpl)).toBeNull();
    expect(
      await googleAccessToken(
        env,
        db,
        "djdl",
        "asc",
        SCOPES,
        "play:token",
        NOW,
        fetchImpl,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await opens()).toHaveLength(0);
  });

  it("throws with the status only on a failed exchange, and caches nothing", async () => {
    await put("play", "google-service-account", googleKey());
    const failing = async (): Promise<Response> =>
      new Response('{"error":"invalid_grant","error_description":"secret"}', {
        status: 400,
      });
    await expect(google(NOW, failing)).rejects.toThrow(
      /^google token exchange failed: 400$/,
    );
    expect(kv.keys()).toEqual([]);
  });

  it("does not cache a token whose lifetime leaves less than KV's minimum TTL", async () => {
    await put("play", "google-service-account", googleKey());
    const { fetchImpl } = fakeTokenEndpoint(330);
    await google(NOW, fetchImpl);
    expect(kv.keys()).toEqual([]);
  });
});

describe("the sealed token cache helper", () => {
  it("round-trips, misses on expiry, and misses on a blob sealed for another slot", async () => {
    const slot = outletTokenSlot("djdl", "entra", "h1");
    await writeSealedToken(env, slot, "tok", 600, NOW);
    expect(await readSealedToken(env, slot, NOW + 599)).toEqual({
      token: "tok",
      expiresAt: NOW + 600,
    });
    expect(await readSealedToken(env, slot, NOW + 600)).toBeNull();

    const other = outletTokenSlot("djdl", "entra", "h2");
    await env.HOT.put(other.key, (await env.HOT.get(slot.key))!);
    expect(await readSealedToken(env, other, NOW)).toBeNull();
  });
});
