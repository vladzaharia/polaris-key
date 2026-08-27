import { describe, it, expect } from "vitest";
import {
  signJws,
  verifyJws,
  base64UrlDecode,
  base64UrlEncodeBytes,
  importVerifyKey,
  sha256Base64Url,
  type TrustSet,
} from "./index.js";

const b64u = (o: unknown): string =>
  base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(o)));

// The committed djdl cross-platform vector. Reproducing it here proves the Polaris Key JWS
// encoding is byte-identical to the current signed contract.
const DJDL_TEST_KID = "djdl-test-2026";
const DJDL_TEST_PUB = "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U";
const DJDL_TEST_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIIXpeKmxx2+0A+lz89t+5fp5PPjd2vFGhXqwTpWYeL5O\n-----END PRIVATE KEY-----";
const DJDL_DOC = {
  schemaVersion: 1,
  aud: "djdl",
  iss: "key.plrs.im",
  licenseId: "abc123def456",
  deviceId: "device-fixture-01",
  issuedAt: 1700000000,
  expiresAt: 1700003600,
  graceUntil: 1702592000,
  profile: {
    name: "Ada Lovelace",
    firstName: "Ada",
    email: "ada@example.com",
    activatedAt: 1690000000,
  },
  payload: {
    config: {
      "run.concurrency": {
        state: "enforced",
        value: 4,
        updatedAt: 1699990000,
      },
    },
    secrets: {
      "proxy.subscriptionUrl": {
        state: "hidden",
        value: "https://vpn.example.com/sub/abc",
        updatedAt: 1699990000,
      },
    },
    entitlements: {
      polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
    },
  },
};
const DJDL_JWS =
  "eyJhbGciOiJFZERTQSIsImtpZCI6ImRqZGwtdGVzdC0yMDI2In0.eyJzY2hlbWFWZXJzaW9uIjoxLCJhdWQiOiJkamRsIiwiaXNzIjoia2V5LnBscnMuaW0iLCJsaWNlbnNlSWQiOiJhYmMxMjNkZWY0NTYiLCJkZXZpY2VJZCI6ImRldmljZS1maXh0dXJlLTAxIiwiaXNzdWVkQXQiOjE3MDAwMDAwMDAsImV4cGlyZXNBdCI6MTcwMDAwMzYwMCwiZ3JhY2VVbnRpbCI6MTcwMjU5MjAwMCwicHJvZmlsZSI6eyJuYW1lIjoiQWRhIExvdmVsYWNlIiwiZmlyc3ROYW1lIjoiQWRhIiwiZW1haWwiOiJhZGFAZXhhbXBsZS5jb20iLCJhY3RpdmF0ZWRBdCI6MTY5MDAwMDAwMH0sInBheWxvYWQiOnsiY29uZmlnIjp7InJ1bi5jb25jdXJyZW5jeSI6eyJzdGF0ZSI6ImVuZm9yY2VkIiwidmFsdWUiOjQsInVwZGF0ZWRBdCI6MTY5OTk5MDAwMH19LCJzZWNyZXRzIjp7InByb3h5LnN1YnNjcmlwdGlvblVybCI6eyJzdGF0ZSI6ImhpZGRlbiIsInZhbHVlIjoiaHR0cHM6Ly92cG4uZXhhbXBsZS5jb20vc3ViL2FiYyIsInVwZGF0ZWRBdCI6MTY5OTk5MDAwMH19LCJlbnRpdGxlbWVudHMiOnsicG9sYXJpc1ZwbiI6eyJzdGF0ZSI6ImVuZm9yY2VkIiwidmFsdWUiOnRydWUsInVwZGF0ZWRBdCI6MTY5OTk5MDAwMH19fX0.6uPFqKrtFQt-AyXTXRnvNpdOqcDajzL6fj4zCR_z7LMIq0tYPtuM5oCAO1UrYnju0jpUOEdxo7tJwhjfUbXYAA";

// Second committed test key (Polaris Key rotation/wrong-kid cases).
const ROTATE_KID = "pkey-test-rotate-2026";
const ROTATE_PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";
const ROTATE_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----";

const TRUST: TrustSet = {
  [DJDL_TEST_KID]: DJDL_TEST_PUB,
  [ROTATE_KID]: ROTATE_PUB,
};

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
      profile: {
        name: "Grace Hopper",
        firstName: "Grace",
        email: "grace@example.com",
        activatedAt: 1690000000,
      },
      payload: {
        config: {},
        secrets: {},
        entitlements: {
          polarisVpn: { state: "enforced", value: true, updatedAt: 1699990000 },
        },
      },
    };
    const jws = await signJws(doc, ROTATE_PEM, ROTATE_KID);
    const result = await verifyJws(jws, TRUST);
    expect(result?.kid).toBe(ROTATE_KID);
    expect(result?.payload).toEqual(doc);
  });

  it("rejects a tampered payload (flipped value, signature unchanged)", async () => {
    const [h, , s] = DJDL_JWS.split(".");
    const tampered = {
      ...DJDL_DOC,
      payload: {
        ...DJDL_DOC.payload,
        config: {
          "run.concurrency": {
            state: "enforced",
            value: 999,
            updatedAt: 1699990000,
          },
        },
      },
    };
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

  it("rejects an empty key (0 bytes)", async () => {
    await expect(importVerifyKey("")).rejects.toThrow(/0/);
  });

  it("rejects a 33-byte key (off-by-one too long)", async () => {
    const tooLong = base64UrlEncodeBytes(new Uint8Array(33));
    await expect(importVerifyKey(tooLong)).rejects.toThrow(/33/);
  });

  it("accepts the exact 32-byte corpus key without throwing", async () => {
    await expect(importVerifyKey(DJDL_TEST_PUB)).resolves.toBeDefined();
  });

  it("base64UrlDecode handles unpadded -_ alphabet", () => {
    expect(base64UrlDecode(DJDL_TEST_PUB).length).toBe(32);
  });
});

describe("base64url encode/decode edge cases", () => {
  it("round-trips every byte value 0..255 byte-for-byte", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const enc = base64UrlEncodeBytes(all);
    // Unpadded, URL-safe alphabet only.
    expect(enc).not.toContain("=");
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
    expect([...base64UrlDecode(enc)]).toEqual([...all]);
  });

  it("encodes 0xFB 0xFF to the URL-safe '-_' alphabet", () => {
    // Standard base64 of [0xFB,0xFF] is "+/8="; URL-safe unpadded is "-_8".
    expect(base64UrlEncodeBytes(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect([...base64UrlDecode("-_8")]).toEqual([0xfb, 0xff]);
  });

  it("decodes regardless of how many padding chars the input is missing", () => {
    // Lengths 1..4 bytes exercise all 0/1/2 trailing '=' cases.
    for (const len of [1, 2, 3, 4, 5, 6]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const enc = base64UrlEncodeBytes(bytes);
      expect(enc).not.toContain("=");
      expect([...base64UrlDecode(enc)]).toEqual([...bytes]);
    }
  });

  it("round-trips a unicode JSON payload (emoji + CJK + diacritics) byte-stably", () => {
    const payload = { name: "Ada 💻 北京 Ångström", n: 42 };
    const enc = base64UrlEncodeBytes(
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const back = JSON.parse(new TextDecoder().decode(base64UrlDecode(enc)));
    expect(back).toEqual(payload);
  });
});

describe("signJws determinism", () => {
  it("is deterministic — re-signing the same doc yields identical bytes (Ed25519)", async () => {
    const doc = { hello: "world", n: 7, nested: { a: [1, 2, 3] } };
    const a = await signJws(doc, DJDL_TEST_PEM, DJDL_TEST_KID);
    const b = await signJws(doc, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(a).toBe(b);
  });

  it("produces a 3-segment compact JWS whose header decodes to {alg:EdDSA,kid}", async () => {
    const jws = await signJws({ x: 1 }, DJDL_TEST_PEM, DJDL_TEST_KID);
    const parts = jws.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(parts[0]!)),
    );
    expect(header).toEqual({ alg: "EdDSA", kid: DJDL_TEST_KID });
  });

  it("a signature over a unicode payload verifies under its own key", async () => {
    const doc = { msg: "héllo 世界 🌍" };
    const jws = await signJws(doc, ROTATE_PEM, ROTATE_KID);
    const r = await verifyJws(jws, TRUST);
    expect(r?.kid).toBe(ROTATE_KID);
    expect(r?.payload).toEqual(doc);
  });
});

describe("sha256Base64Url known vectors", () => {
  it("hashes the empty input to the canonical SHA-256 base64url", async () => {
    const out = await sha256Base64Url(new Uint8Array(0));
    expect(out).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it('hashes "abc" to the canonical SHA-256 base64url', async () => {
    const out = await sha256Base64Url(new TextEncoder().encode("abc"));
    expect(out).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });

  it("output is unpadded base64url of a 32-byte digest", async () => {
    const out = await sha256Base64Url(new TextEncoder().encode("anything"));
    expect(out).not.toContain("=");
    expect(base64UrlDecode(out).length).toBe(32);
  });
});

describe("verifyJws structural failures", () => {
  it("rejects a wrong number of segments (0, 1, 2, 4)", async () => {
    const valid = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    const [h, p, s] = valid.split(".");
    expect(await verifyJws("", TRUST)).toBeNull();
    expect(await verifyJws(h!, TRUST)).toBeNull();
    expect(await verifyJws(`${h}.${p}`, TRUST)).toBeNull();
    expect(await verifyJws(`${h}.${p}.${s}.extra`, TRUST)).toBeNull();
  });

  it("rejects a header that is not valid base64url JSON", async () => {
    const valid = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    const [, p, s] = valid.split(".");
    // "!!!" is not decodable JSON once base64url-decoded.
    expect(
      await verifyJws(`${b64u("not-an-object")}.${p}.${s}`, TRUST),
    ).toBeNull();
    expect(await verifyJws(`@@@.${p}.${s}`, TRUST)).toBeNull();
  });

  it("rejects a header missing a string kid", async () => {
    const header = b64u({ alg: "EdDSA", kid: 123 });
    const payload = b64u(DJDL_DOC);
    expect(await verifyJws(`${header}.${payload}.`, TRUST)).toBeNull();
  });

  it("rejects when the signature segment is not valid base64url", async () => {
    const valid = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    const [h, p] = valid.split(".");
    // A space is outside the base64url alphabet → decode/verify fails, returns null.
    expect(await verifyJws(`${h}.${p}. bad sig `, TRUST)).toBeNull();
  });

  it("rejects an empty trust set even for an otherwise-valid JWS", async () => {
    const valid = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(await verifyJws(valid, {})).toBeNull();
  });

  it("rejects when the trust set maps the kid to a malformed (non-32-byte) key", async () => {
    const valid = await signJws(DJDL_DOC, DJDL_TEST_PEM, DJDL_TEST_KID);
    // Right kid, but a 4-byte key — import throws internally and verify returns null.
    expect(await verifyJws(valid, { [DJDL_TEST_KID]: "AAAA" })).toBeNull();
  });

  it("rejects an otherwise-valid JWS whose payload exceeds the 64 KiB cap (parse-DoS guard)", async () => {
    // A genuinely signed JWS (correct Ed25519 over a real key) but with a giant payload:
    // it must fail CLOSED on size BEFORE JSON.parse, never on the signature.
    const huge = { schemaVersion: 1, blob: "A".repeat(70 * 1024) };
    const jws = await signJws(huge, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(await verifyJws(jws, TRUST)).toBeNull();

    // Control: a small, signature-valid doc under the cap still verifies, proving the
    // rejection above is the size guard and not a broken-signature artifact.
    const small = { schemaVersion: 1, blob: "A".repeat(1024) };
    const okJws = await signJws(small, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect((await verifyJws(okJws, TRUST))?.payload).toEqual(small);
  });
});

// WIRE-CONTRACT-V3 §1: the payload cap is 65 536 bytes for every artifact EXCEPT
// `plrs-bundle+jws`, which wraps up to three inner compact JWSs and is capped at 262 144.
// The bundle verifier passes that cap explicitly, per call — it is not a global relaxation,
// and it can only ever raise.
describe("verifyJws — maxPayloadBytes (the plrs-bundle+jws cap, §1)", () => {
  // 100 KiB: over the 64 KiB default, under the 256 KiB bundle cap. Sizes stay just past the
  // boundary being proved — the multi-MiB versions of these tests are what timed out CI once.
  const oversizeDoc = { schemaVersion: 1, blob: "A".repeat(100 * 1024) };

  it("a raised cap accepts a payload the default refuses", async () => {
    const jws = await signJws(oversizeDoc, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(
      (await verifyJws(jws, TRUST, { maxPayloadBytes: 262_144 }))?.payload,
    ).toEqual(oversizeDoc);
  });

  it("the SAME jws is still rejected on the default path", async () => {
    // The option is per call. Nothing about a bundle-sized document leaks into the ordinary
    // license/config/trust verifiers, which never pass it.
    const jws = await signJws(oversizeDoc, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(await verifyJws(jws, TRUST)).toBeNull();
  });

  it("the raised cap is still a cap — past 262 144 decoded bytes is rejected", async () => {
    const huge = { schemaVersion: 1, blob: "A".repeat(300 * 1024) };
    const jws = await signJws(huge, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(
      await verifyJws(jws, TRUST, { maxPayloadBytes: 262_144 }),
    ).toBeNull();
  });

  it("a value BELOW the default is inert — the option raises, never lowers", async () => {
    // Otherwise one call site could quietly enforce a stricter bound than the wire contract
    // and start refusing documents every other implementation accepts.
    const doc = { schemaVersion: 1, blob: "A".repeat(4096) };
    const jws = await signJws(doc, DJDL_TEST_PEM, DJDL_TEST_KID);
    expect(
      (await verifyJws(jws, TRUST, { maxPayloadBytes: 16 }))?.payload,
    ).toEqual(doc);
  });
});
