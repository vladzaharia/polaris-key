/**
 * `core/outletTokens.ts` (P5-01): the App Store Connect JWT and the Google JWT-bearer exchange,
 * against keys generated here and a fake token endpoint. No network, no real credential.
 */

import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Env } from "../src/env.js";
import { open } from "../src/keyvault.js";
import {
  GOOGLE_TOKEN_URI,
  type OpenedOutletCredential,
} from "../src/core/outletCredentials.js";
import {
  ASC_AUDIENCE,
  ascToken,
  GOOGLE_JWT_BEARER_GRANT,
  googleAccessToken,
  outletTokenSlot,
  readSealedToken,
  writeSealedToken,
} from "../src/core/outletTokens.js";

const part = (s: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;

function ascCred(): {
  cred: OpenedOutletCredential<"asc-api-key">;
  publicKey: ReturnType<typeof createPublicKey>;
} {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey: createPublicKey(privateKey),
    cred: {
      product: "djdl",
      credentialId: `asc-${Math.random().toString(36).slice(2)}`,
      kind: "asc-api-key",
      outletId: "app-store",
      value: {
        keyId: "ABC123DEFG",
        issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
        p8: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      },
    },
  };
}

describe("ascToken", () => {
  it("produces an ES256 token that verifies with the public key, with exp - iat ≤ 1200", async () => {
    const { cred, publicKey } = ascCred();
    const token = await ascToken(cred, NOW);
    const [h, p, s] = token.split(".") as [string, string, string];
    expect(part(h)).toEqual({ alg: "ES256", typ: "JWT", kid: "ABC123DEFG" });
    const claims = part(p);
    expect(claims).toEqual({
      iss: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
      iat: NOW,
      exp: NOW + 1200,
      aud: ASC_AUDIENCE,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      1200,
    );
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
  });

  it("re-uses the token until 60 s before expiry, then mints a new one", async () => {
    const { cred } = ascCred();
    const first = await ascToken(cred, NOW);
    expect(await ascToken(cred, NOW + 1139)).toBe(first);
    const next = await ascToken(cred, NOW + 1140);
    expect(next).not.toBe(first);
    expect(part(next.split(".")[1]!).iat).toBe(NOW + 1140);
  });

  it("never serves a token signed by a rotated-away key", async () => {
    const { cred } = ascCred();
    const first = await ascToken(cred, NOW);
    const rotated = ascCred().cred;
    const second = await ascToken(
      { ...cred, value: { ...cred.value, p8: rotated.value.p8 } },
      NOW + 1,
    );
    expect(second).not.toBe(first);
  });
});

function googleCred(): OpenedOutletCredential<"google-service-account"> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    product: "djdl",
    credentialId: "play",
    kind: "google-service-account",
    outletId: "play",
    value: {
      client_email: "play-publisher@test-project.iam.gserviceaccount.com",
      private_key: privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string,
      token_uri: GOOGLE_TOKEN_URI,
    },
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

describe("googleAccessToken", () => {
  it("exchanges an RS256 JWT-bearer assertion at Google's token endpoint", async () => {
    const env = makeEnv(new KvMock(), []);
    const cred = googleCred();
    const { calls, fetchImpl } = fakeTokenEndpoint();
    expect(await googleAccessToken(env, cred, SCOPES, NOW, fetchImpl)).toBe(
      "ya29.test-1",
    );
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
      iss: cred.value.client_email,
      scope: SCOPES[0],
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW,
      exp: NOW + 3600,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        createPublicKey(cred.value.private_key),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
  });

  it("caches the token sealed in KV, re-uses it, and refreshes it after expiry", async () => {
    const kv = new KvMock();
    const env = makeEnv(kv, []);
    const cred = googleCred();
    const { calls, fetchImpl } = fakeTokenEndpoint(3600);

    expect(await googleAccessToken(env, cred, SCOPES, NOW, fetchImpl)).toBe(
      "ya29.test-1",
    );
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

    // Re-used inside the window: no second exchange.
    expect(
      await googleAccessToken(env, cred, SCOPES, NOW + 3299, fetchImpl),
    ).toBe("ya29.test-1");
    expect(calls).toHaveLength(1);

    // Refreshed once the cached copy has expired (KV may still hold it).
    expect(
      await googleAccessToken(env, cred, SCOPES, NOW + 3300, fetchImpl),
    ).toBe("ya29.test-2");
    expect(calls).toHaveLength(2);
  });

  it("keys the cache by scope and by key, so neither can serve the other's token", async () => {
    const env = makeEnv(new KvMock(), []);
    const cred = googleCred();
    const { calls, fetchImpl } = fakeTokenEndpoint();
    await googleAccessToken(env, cred, SCOPES, NOW, fetchImpl);
    await googleAccessToken(
      env,
      cred,
      ["https://www.googleapis.com/auth/cloud-platform"],
      NOW,
      fetchImpl,
    );
    const rotated = { ...cred, value: googleCred().value };
    await googleAccessToken(env, rotated, SCOPES, NOW, fetchImpl);
    expect(calls).toHaveLength(3);
  });

  it("throws with the status only on a failed exchange, and caches nothing", async () => {
    const kv = new KvMock();
    const env = makeEnv(kv, []);
    const failing = async (): Promise<Response> =>
      new Response('{"error":"invalid_grant","error_description":"secret"}', {
        status: 400,
      });
    await expect(
      googleAccessToken(env, googleCred(), SCOPES, NOW, failing),
    ).rejects.toThrow(/^google token exchange failed: 400$/);
    expect(kv.keys()).toEqual([]);
  });

  it("does not cache a token whose lifetime leaves less than KV's minimum TTL", async () => {
    const kv = new KvMock();
    const env = makeEnv(kv, []);
    const { fetchImpl } = fakeTokenEndpoint(330);
    await googleAccessToken(env, googleCred(), SCOPES, NOW, fetchImpl);
    expect(kv.keys()).toEqual([]);
  });
});

describe("the sealed token cache helper", () => {
  it("round-trips, misses on expiry, and misses on a blob sealed for another slot", async () => {
    const env: Env = makeEnv(new KvMock(), []);
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
