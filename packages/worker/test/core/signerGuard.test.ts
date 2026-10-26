/**
 * plans/P3-01.md §2.2, "Keeping the signer total" — the Worker half (P3-12).
 *
 * Two guards make the Worker unable to sign what a wire-v4 verifier refuses: `signJws` refuses
 * a header or payload that breaks V4 §1.2 (shared-jws's own suite proves each rule), and
 * `signDoc` refuses an integer claim of a v3 `typ` that is not a safe integer of at least its
 * minimum. Every route that signs answers a refusal as `500 document_not_representable` in its
 * own body shape instead of throwing; this suite drives each one with a stored value that trips
 * a guard.
 */

import { describe, expect, it } from "vitest";
import { signJws, StrictJsonError, verifyJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import { assertIntegerClaims, signDoc } from "../../src/core/signing.js";
import { buildConfigDoc, buildLicenseDoc } from "../../src/core/documents.js";
import { NOW, TEST_KID, TEST_PEM, TEST_PUB } from "../seed.js";

const TRUST = { [TEST_KID]: TEST_PUB };

function licence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: "djdl",
    deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    graceUntil: NOW + 30 * 86_400,
    licenseId: "lic_1",
    entitlements: {},
    ...over,
  };
}

describe("signDoc's integer guard (V4 §3 minimums)", () => {
  for (const graceUntil of [
    1_700_000_000.5,
    -1,
    Number.NaN,
    2 ** 53,
    "1700000000",
  ]) {
    it(`refuses a licence whose graceUntil is ${String(graceUntil)}`, async () => {
      await expect(
        signDoc(
          licence({ graceUntil }),
          TEST_PEM,
          TEST_KID,
          "pkey-license+jws",
        ),
      ).rejects.toBeInstanceOf(StrictJsonError);
    });
  }

  it("refuses a licence with no issuedAt", async () => {
    const doc = licence();
    delete doc.issuedAt;
    await expect(
      signDoc(doc, TEST_PEM, TEST_KID, "pkey-license+jws"),
    ).rejects.toBeInstanceOf(StrictJsonError);
  });

  it("refuses a config document whose schemaVersion is 0 (minimum 1)", async () => {
    await expect(
      signDoc(
        { ...licence(), schemaVersion: 0, config: {}, secrets: {} },
        TEST_PEM,
        TEST_KID,
        "pkey-config+jws",
      ),
    ).rejects.toBeInstanceOf(StrictJsonError);
  });

  it("checks the trust manifest's and the bundle's claims", () => {
    expect(() =>
      assertIntegerClaims(
        { schemaVersion: 1, issuedAt: NOW, expiresAt: NOW + 0.5 },
        "pkey-trust+jws",
      ),
    ).toThrow(StrictJsonError);
    expect(() =>
      assertIntegerClaims({ issuedAt: -5, expiresAt: NOW }, "pkey-bundle+jws"),
    ).toThrow(StrictJsonError);
    expect(() =>
      assertIntegerClaims(
        { schemaVersion: 1, issuedAt: 0, expiresAt: 0 },
        "pkey-trust+jws",
      ),
    ).not.toThrow();
  });

  it("leaves the feed's claims to the composer and refuses a non-object v3 document", () => {
    expect(() =>
      assertIntegerClaims({ seq: 0.5 }, "pkey-feed+jws"),
    ).not.toThrow();
    expect(() => assertIntegerClaims(["x"], "pkey-license+jws")).toThrow(
      StrictJsonError,
    );
  });

  it("signs a clean licence to the same bytes signJws writes", async () => {
    const doc = licence();
    const viaDoc = await signDoc(doc, TEST_PEM, TEST_KID, "pkey-license+jws");
    const viaJws = await signJws(doc, TEST_PEM, TEST_KID, "pkey-license+jws");
    expect(viaDoc).toBe(viaJws);
    expect(
      await verifyJws(viaDoc, TRUST, { typ: "pkey-license+jws" }),
    ).not.toBeNull();
  });

  it("runs the strict-JSON guard too: a lone surrogate in an entitlement", async () => {
    await expect(
      signDoc(
        licence({
          entitlements: {
            x: { state: "enforced", value: "\ud800", updatedAt: NOW },
          },
        }),
        TEST_PEM,
        TEST_KID,
        "pkey-license+jws",
      ),
    ).rejects.toBeInstanceOf(StrictJsonError);
  });
});

describe("the builders compute graceUntil with integer arithmetic", () => {
  it("floors a fractional day count instead of signing a fraction", async () => {
    const lic = buildLicenseDoc({
      aud: "djdl",
      deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      licenseId: "lic_1",
      now: NOW,
      maxOfflineDays: 1.0000001,
      profile: undefined,
      entitlements: {},
    });
    expect(lic.graceUntil).toBe(NOW + Math.floor(1.0000001 * 86_400));
    expect(Number.isSafeInteger(lic.graceUntil)).toBe(true);
    const cfg = buildConfigDoc({
      aud: "djdl",
      deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      now: NOW,
      maxOfflineDays: 0.5,
      schemaVersion: 1,
      payload: { config: {}, secrets: {} },
    });
    expect(cfg.graceUntil).toBe(NOW + 43_200);
    await expect(
      signDoc(cfg, TEST_PEM, TEST_KID, "pkey-config+jws"),
    ).resolves.toMatch(/^ey/);
  });
});

// WIRE-CONTRACT-V5 §15.2, §15.3: the signer refuses a certificate or roster no v5 verifier accepts.
describe("signDoc's Cloud Connect write checks", () => {
  const b64 = (bytes: Uint8Array): string =>
    Buffer.from(bytes).toString("base64url");
  const key = (seed: number): string => b64(new Uint8Array(32).fill(seed));
  const dev = (n: number): Record<string, string> => ({
    deviceId: String(n).padStart(32, "0"),
    signKey: key(0x10 + n),
    agreeKey: b64(Uint8Array.from({ length: 32 }, (_, k) => (k === 0 ? n : 9))),
  });
  const SUB = `ps_${"A".repeat(22)}`;
  const cert = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    iss: ISSUER,
    aud: "djdl",
    sub: SUB,
    ...dev(1),
    ringEpoch: 1,
    issuedAt: NOW,
    expiresAt: NOW + 604_800,
    ...over,
  });
  const ring = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    iss: ISSUER,
    aud: "djdl",
    sub: SUB,
    epoch: 1,
    issuedAt: NOW,
    expiresAt: NOW + 604_800,
    devices: [dev(1), dev(2)],
    ...over,
  });
  const sign = (doc: unknown, typ: "pkey-peer+jws" | "pkey-ring+jws") =>
    signDoc(doc, TEST_PEM, TEST_KID, typ);

  it("signs a well-formed certificate and roster, and each verifies under its typ only", async () => {
    const c = await sign(cert(), "pkey-peer+jws");
    const r = await sign(ring(), "pkey-ring+jws");
    expect(await verifyJws(c, TRUST, { typ: "pkey-peer+jws" })).not.toBeNull();
    expect(await verifyJws(r, TRUST, { typ: "pkey-ring+jws" })).not.toBeNull();
    expect(await verifyJws(c, TRUST, { typ: "pkey-ring+jws" })).toBeNull();
    expect(await verifyJws(r, TRUST, { typ: "pkey-peer+jws" })).toBeNull();
  });

  const lowOrder = b64(new Uint8Array(32)); // u = 0
  const badCerts: [string, Record<string, unknown>][] = [
    ["a foreign issuer", { iss: "evil.example" }],
    ["an account id as sub", { sub: "acct_123" }],
    ["a short deviceId", { deviceId: "short" }],
    ["a padded key", { signKey: `${key(5)}=` }],
    ["a small-order signKey", { signKey: lowOrder }],
    ["a low-order agreeKey", { agreeKey: lowOrder }],
    ["ringEpoch 0", { ringEpoch: 0 }],
    ["a fractional ringEpoch", { ringEpoch: 1.5 }],
    ["a seven-day-plus-one lifetime", { expiresAt: NOW + 604_801 }],
    ["a zero lifetime", { expiresAt: NOW }],
  ];
  for (const [name, over] of badCerts) {
    it(`refuses a certificate with ${name}`, async () => {
      await expect(sign(cert(over), "pkey-peer+jws")).rejects.toBeInstanceOf(
        StrictJsonError,
      );
    });
  }

  const dupId = { ...dev(2), deviceId: dev(1).deviceId };
  const dupKey = { ...dev(2), agreeKey: dev(1).agreeKey };
  const badRings: [string, Record<string, unknown>][] = [
    ["no devices", { devices: [] }],
    ["129 devices", { devices: Array.from({ length: 129 }, (_, i) => dev(i)) }],
    ["devices out of order", { devices: [dev(2), dev(1)] }],
    ["a repeated deviceId", { devices: [dev(1), dupId] }],
    ["a repeated key", { devices: [dev(1), dupKey] }],
    ["a low-order agreeKey", { devices: [{ ...dev(1), agreeKey: lowOrder }] }],
    ["epoch 0", { epoch: 0 }],
    ["devices that is not a list", { devices: {} }],
  ];
  for (const [name, over] of badRings) {
    it(`refuses a roster with ${name}`, async () => {
      await expect(sign(ring(over), "pkey-ring+jws")).rejects.toBeInstanceOf(
        StrictJsonError,
      );
    });
  }

  it("signs a roster of exactly 128 devices", async () => {
    const devices = Array.from({ length: 128 }, (_, i) => dev(i));
    await expect(sign(ring({ devices }), "pkey-ring+jws")).resolves.toMatch(
      /^ey/,
    );
  });

  it("leaves other typs alone", () => {
    expect(() => assertIntegerClaims({}, "pkey-feed+jws")).not.toThrow();
  });
});
