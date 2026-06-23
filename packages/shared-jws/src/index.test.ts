import { describe, it, expect } from "vitest";
import { signJws, verifyJws, base64UrlDecode, base64UrlEncodeBytes, importVerifyKey, type TrustSet } from "./index.js";

const b64u = (o: unknown): string => base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));

// The committed djdl cross-platform vector (fixtures/config-jws.vector.json). Reproducing
// it here proves the Polaris Key JWS encoding is byte-identical to the original contract.
const DJDL_TEST_KID = "djdl-test-2026";
const DJDL_TEST_PUB = "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U";
const DJDL_TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----";
const DJDL_DOC = {
  schemaVersion: 1,
  licenseId: "abc123def456",
  deviceId: "device-fixture-01",
  issuedAt: 1700000000,
  expiresAt: 1700003600,
  graceUntil: 1702592000,
  profile: { name: "Ada Lovelace", firstName: "Ada", email: "ada@example.com", enrolledAt: 1690000000 },
  payload: {
    config: { "run.concurrency": { state: "managed", value: 4 } },
    secrets: { "proxy.subscriptionUrl": { state: "hidden", value: "https://vpn.example.com/sub/abc" } },
    entitlements: { polarisVpn: { state: "managed", value: true } },
  },
};
const DJDL_JWS =
  "eyJhbGciOiJFZERTQSIsImtpZCI6ImRqZGwtdGVzdC0yMDI2In0.eyJzY2hlbWFWZXJzaW9uIjoxLCJsaWNlbnNlSWQiOiJhYmMxMjNkZWY0NTYiLCJkZXZpY2VJZCI6ImRldmljZS1maXh0dXJlLTAxIiwiaXNzdWVkQXQiOjE3MDAwMDAwMDAsImV4cGlyZXNBdCI6MTcwMDAwMzYwMCwiZ3JhY2VVbnRpbCI6MTcwMjU5MjAwMCwicHJvZmlsZSI6eyJuYW1lIjoiQWRhIExvdmVsYWNlIiwiZmlyc3ROYW1lIjoiQWRhIiwiZW1haWwiOiJhZGFAZXhhbXBsZS5jb20iLCJlbnJvbGxlZEF0IjoxNjkwMDAwMDAwfSwicGF5bG9hZCI6eyJjb25maWciOnsicnVuLmNvbmN1cnJlbmN5Ijp7InN0YXRlIjoibWFuYWdlZCIsInZhbHVlIjo0fX0sInNlY3JldHMiOnsicHJveHkuc3Vic2NyaXB0aW9uVXJsIjp7InN0YXRlIjoiaGlkZGVuIiwidmFsdWUiOiJodHRwczovL3Zwbi5leGFtcGxlLmNvbS9zdWIvYWJjIn19LCJlbnRpdGxlbWVudHMiOnsicG9sYXJpc1ZwbiI6eyJzdGF0ZSI6Im1hbmFnZWQiLCJ2YWx1ZSI6dHJ1ZX19fX0.LhfMI8D6AdUg-_FaYodnmSZwonYQ1KDBzeZjtO-eYQmbDrFO2Y9Mnuji2jnLHuBhec5RBckN7f8g_9fevg5_BA";

// Second committed test key (Polaris Key rotation/wrong-kid cases).
const ROTATE_KID = "pkey-test-rotate-2026";
const ROTATE_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const ROTATE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const TRUST: TrustSet = { [DJDL_TEST_KID]: DJDL_TEST_PUB, [ROTATE_KID]: ROTATE_PUB };

describe("verifyJws — frozen contract", () => {
  it("verifies the committed djdl cross-platform vector and reproduces the doc", async () => {
    const result = await verifyJws(DJDL_JWS, TRUST);
    expect(result).not.toBeNull();
    expect(result!.kid).toBe(DJDL_TEST_KID);
    expect(result!.payload).toEqual(DJDL_DOC);
  });

  it("re-signs the same doc to the exact committed JWS bytes (deterministic Ed25519)", async () => {
    const jws = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(jws).toBe(DJDL_JWS);
  });

  it("round-trips a Polaris v1 doc (with aud/iss) under the rotation key", async () => {
    const doc = {
      schemaVersion: 1,
      aud: "djdl",
      iss: "key.plrs.im",
      licenseId: "lic_test",
      deviceId: "dev_test",
      issuedAt: 1700000000,
      expiresAt: 1700003600,
      graceUntil: 1702592000,
      profile: { name: "Grace Hopper", firstName: "Grace", email: "grace@example.com", enrolledAt: 1690000000 },
      payload: { config: {}, secrets: {}, entitlements: { polarisVpn: { state: "managed", value: true } } },
    };
    const jws = await signJws(doc, ROTATE_PEM, ROTATE_KID);
    const result = await verifyJws(jws, TRUST);
    expect(result?.kid).toBe(ROTATE_KID);
    expect(result?.payload).toEqual(doc);
  });

  it("rejects a tampered payload (flipped value, signature unchanged)", async () => {
    const [h, , s] = DJDL_JWS.split(".");
    const tampered = { ...DJDL_DOC, payload: { ...DJDL_DOC.payload, config: { "run.concurrency": { state: "managed", value: 999 } } } };
    const forged = `${h}.${b64u(tampered)}.${s}`;
    expect(await verifyJws(forged, TRUST)).toBeNull();
  });

  it("rejects an unknown kid (key not in the trust set)", async () => {
    const jws = await signJws(DJDL_DOC, ROTATE_PEM, "pkey-unknown-9999");
    expect(await verifyJws(jws, TRUST)).toBeNull();
  });

  it("rejects an alg!=EdDSA downgrade (none) before any signature math", async () => {
    const header = b64u({ alg: "none", kid: DJDL_TEST_KID });
    const payload = b64u(DJDL_DOC);
    expect(await verifyJws(`${header}.${payload}.`, TRUST)).toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "a", "a.b", "not-a-jws", "@@@.@@@.@@@"]) {
      expect(await verifyJws(bad, TRUST)).toBeNull();
    }
  });
});

describe("importVerifyKey", () => {
  it("rejects a non-32-byte key", async () => {
    await expect(importVerifyKey("AAAA")).rejects.toThrow(/32 bytes/);
  });

  it("base64UrlDecode handles unpadded -_ alphabet", () => {
    expect(base64UrlDecode(DJDL_TEST_PUB).length).toBe(32);
  });
});
