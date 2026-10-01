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
import { assertIntegerClaims, signDoc } from "../src/core/signing.js";
import { buildConfigDoc, buildLicenseDoc } from "../src/core/documents.js";
import { NOW, TEST_KID, TEST_PEM, TEST_PUB } from "./seed.js";

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
