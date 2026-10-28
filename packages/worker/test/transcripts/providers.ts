/// <reference types="@cloudflare/workers-types" />
// The platform providers the exchange transcripts (I-13.7, WIRE-CONTRACT-V5 §12.11.3) sign in
// through: Google's and Apple's discovery documents (recorded, `test/fixtures/signin/`) and a
// key set served from one fixed local Ed25519 key. Nothing here calls Google or Apple; an
// unexpected outbound request fails the scenario.
//
// Everything is deterministic, so a transcript is byte-stable: the key derives from a label, an
// Ed25519 signature is deterministic, and `iat`/`exp` come from the pinned clock. The fixture
// device keys derive from a label too, which is what lets a replaying client reproduce the
// recorded proof byte for byte (the derivation is in `format.ts`, "exchange").
//
// This module must not import `jose` (it is loaded beside the `vi.mock("jose")` factory).

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { vi } from "vitest";
import { resetOidcClientCaches } from "../../src/core/oidc/client.js";
import { ed25519Pem } from "./idp.js";

const FIXTURES = new URL("../fixtures/signin/", import.meta.url);
const fixture = (name: string): string =>
  readFileSync(new URL(name, FIXTURES), "utf8");

export const PROVIDER_KID = "transcript-provider";

// The providers sign RS256 and the login-card verifier accepts nothing else from them, so the
// fixture key is RSA. RSASSA-PKCS1-v1_5 is deterministic, so a token is byte-stable for a given
// key and claims. A throwaway 2048-bit key made for these transcripts and used nowhere else; it
// is stored as the PKCS#8 body without PEM armour (added at use).
const PROVIDER_KEY_BODY = [
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9qqRiAiprt0fh",
  "lYFnwCof2CWcgGjz7F6UFZSjiToudbjfCSykbd/yN9hTd8wY4XP2s4iSQww1tGDZ",
  "9OWHdz6CoDyLZwB1SyRfxxctdO4FABBtPIglcYGGEXGnT8EIweORQG4f6i/shf2l",
  "ZM26muZB+WTpzRiEPOHgo/5+aPwBpWupLQ8mOhe+Xt1NgmDwlp/85zUjpfcZeRtY",
  "4guHIK3KMk1d2QWU9yLfU9f+V8mevIDt8WlSE6Pt0fWAR0NWYkvnB5lqK8IDTTaI",
  "facQWi6eh0V3CvtNPPHkRRRX7ygd6OVt8L6WWZtpKlG+Zy5p1ZIisCScfshouNWE",
  "o4DZLHUzAgMBAAECggEAFxBkq/xqby3bAl4dXeH63WN582WUHbFtMOHM8PQTjKnJ",
  "IOorMRWhaYGL/15uhcoIwYPEhFC979vu+SI0NTx1cAoPQr50Sk8obbM2qNLyzM3c",
  "sYPuZGtAnm6JnRhwN2Hoi/XDToM6b689kHrJH7uNa5FpyZqktBP5PcmDfZjDqGlg",
  "0Ww7Nlz/gCj1Uh2GqrbjjeB23TDKAAvqUNMXm8+kVNHKmXlrNcRP/9So2GzfWg/1",
  "/wEYhJ2vvOND7ZsJgXWB9OC6+vROEewEaoKSfCcBkpa7JyCnWVkSHaWsAna0Ojx0",
  "M3r/vUgo8aaFwuNFIoRrX26g0J6Megky2spbB5m/rQKBgQD3hNm2zjlMk5xz+Jqn",
  "TCHvEUVxqeA9pn4/kXOjHTLn5AgoO6sMwwqqlm9i3wx9LC9jJBPUAN9f/ggsHCnc",
  "vWFYjD5pPlgMBaCCwEKDwyOrbWycUm+rsJppL3v6e7IEe4/Aj52da9izBzzvqNWX",
  "Y6WGsTFb96AHaO5/U+8eG98hvQKBgQDEKlS0uZWa9lIgw7+ozXE6s4NqiiZf8fZ2",
  "UAC+cNv04SIuaIsSsE6MGYXRri8WEPQAs+gqumHyvqgk8bpU3b7QKwvAH0II5Eds",
  "4xHYOWTHFGB8uN/H4Nl7DBGxWHMVLlUErxDvJG+FsT0dKxsW5PzDxE6TeTAd9Xky",
  "53FNv7PJrwKBgBgjLXQFQlM0ZeJtUO+Vng2JOqNt9H8umEssrQEwHMG+XAlIYFLb",
  "RlQCXZRfugEO6QQbBY/8EcxzompiyLZNBYw0CPYMbVumxNNbWmEtC3JxNlE8PMWa",
  "cERnrAhuPZrwTcFyf+VVGgnDX+7jIQklX4P2DaExUbrHQdLK5ZujDixlAoGALhVT",
  "uPEwOCtNt+zEhb9drlClus2hnkCVic3ZnuOciLaq9QQSR92rVjZYvZ2R6jkpWVDq",
  "Zb9La19m2OcAwxck0HqMVCIDvVsDfI0LkCRLjIk48ZPs3mPwM3vuXB9PSdaMmoEW",
  "FVgV6u5sUQHjZ0l8J/FiFDsQFrmoM1EzyPQUJHkCgYEAotf1go2Igj5r6FYvjQ/k",
  "bI9UBNMkgoY5/NnTIR+U8YD9qBgl0KBfsheKfm/ku8r594x5wlwZRZPbY6x8XMWU",
  "BdpS+P8MDnF+4eCezZoAOmHoVWIs82hK0zGqK00lkSx5wu0SO4DtNLH7I5bCowGH",
  "Z1KRBIR0K2Z32ZtCfUFo71M=",
].join("");
const PROVIDER_KEY = createPrivateKey({
  key: Buffer.from(PROVIDER_KEY_BODY, "base64"),
  format: "der",
  type: "pkcs8",
});

/** The key set both providers serve (the fixture key stands in for Google's and Apple's). */
export function providerJwks(): { keys: Record<string, unknown>[] } {
  const jwk = createPublicKey(PROVIDER_KEY).export({
    format: "jwk",
  }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid: PROVIDER_KID, alg: "RS256", use: "sig" }] };
}

const b64s = (text: string): string => b64(Buffer.from(text, "utf8"));

/** An RS256 ID token for `claims`, signed by the fixture provider key. */
export async function signProviderToken(
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${b64s(JSON.stringify({ alg: "RS256", kid: PROVIDER_KID, typ: "JWT" }))}.${b64s(JSON.stringify(claims))}`;
  return `${input}.${b64(sign("sha256", Buffer.from(input, "utf8"), PROVIDER_KEY))}`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export const PRODUCT_AUDIENCES = {
  googleServer: "1234-web.apps.googleusercontent.com",
  googleAndroid: "1234-and.apps.googleusercontent.com",
  appleTeam: "ABCDE12345",
  appleBundle: "com.acme.mac",
} as const;

/** A Google ID token as Credential Manager returns it: `aud` the server client, `azp` the
 *  Android client, `nonce` the Worker's nonce. */
export function googleToken(
  nonce: string,
  sub: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const t = nowSec();
  return signProviderToken({
    iss: "https://accounts.google.com",
    azp: PRODUCT_AUDIENCES.googleAndroid,
    aud: PRODUCT_AUDIENCES.googleServer,
    sub,
    email: "ada@example.com",
    email_verified: true,
    nonce,
    iat: t,
    exp: t + 3600,
    ...over,
  });
}

/** An Apple identity token as Sign in with Apple returns it to the product's bundle. */
export function appleToken(
  nonce: string,
  sub: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const t = nowSec();
  return signProviderToken({
    iss: "https://appleid.apple.com",
    aud: PRODUCT_AUDIENCES.appleBundle,
    sub,
    email: "ada@example.com",
    email_verified: "true",
    nonce,
    iat: t,
    exp: t + 600,
    ...over,
  });
}

/** Serve the providers' discovery documents and key set while `body` runs; any other outbound
 *  request is a scenario bug. */
export async function withProviders<T>(body: () => Promise<T>): Promise<T> {
  resetOidcClientCaches();
  const json = (text: string) =>
    new Response(text, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const routes: Record<string, () => Response> = {
    "https://accounts.google.com/.well-known/openid-configuration": () =>
      json(fixture("google-openid-configuration.json")),
    "https://www.googleapis.com/oauth2/v3/certs": () =>
      json(JSON.stringify(providerJwks())),
    "https://appleid.apple.com/.well-known/openid-configuration": () =>
      json(fixture("apple-openid-configuration.json")),
    "https://appleid.apple.com/auth/keys": () =>
      json(JSON.stringify(providerJwks())),
  };
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const route = routes[url];
      if (!route)
        throw new Error(`transcript provider: unexpected fetch ${url}`);
      return route();
    });
  try {
    return await body();
  } finally {
    spy.mockRestore();
    resetOidcClientCaches();
  }
}

// ── The device keys a client holds (P-1) ─────────────────────────────────────────────────────

const b64 = (b: Uint8Array | Buffer): string =>
  base64UrlEncodeBytes(new Uint8Array(b));

export interface FixtureDeviceKeys {
  signKey: string;
  agreeKey: string;
  /** The `pkey-proof/1` signature (§12.11.1) over the six lines. */
  proof(o: {
    purpose: string;
    product: string;
    deviceId: string;
    value: string;
    token: string | null;
  }): string;
}

/**
 * The device keys for `label`: the Ed25519 signing key is seeded by SHA-256(label), the
 * agreement key's 32 bytes are SHA-256(label + ":agree") with the top bit of the last byte clear.
 * A fixture, not a derivation any SDK uses: it exists so a replaying client sends the recorded
 * bytes.
 */
export function fixtureDeviceKeys(label: string): FixtureDeviceKeys {
  const priv = createPrivateKey(ed25519Pem(label));
  const signKey = (
    createPublicKey(priv).export({ format: "jwk" }) as { x: string }
  ).x;
  const agree = createHash("sha256").update(`${label}:agree`).digest();
  agree[31]! &= 0x7f;
  return {
    signKey,
    agreeKey: b64(agree),
    proof(o) {
      const tokenHash =
        o.token === null
          ? "-"
          : b64(createHash("sha256").update(o.token).digest());
      const msg = [
        "pkey-proof/1",
        o.purpose,
        o.product,
        o.deviceId,
        o.value,
        tokenHash,
      ].join("\n");
      return b64(sign(null, Buffer.from(msg, "utf8"), priv));
    },
  };
}
