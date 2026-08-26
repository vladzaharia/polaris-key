// Per-document verification — wire contract v3 §2–§3.
//
// Signs real `plrs-license+jws` / `plrs-config+jws` documents with a freshly generated
// Ed25519 key (WebCrypto only — the package is isomorphic, and so is its test) and drives
// them through `verifyLicenseDoc` / `verifyConfigDoc`. The interesting half is what must be
// REFUSED: the other document type, v2's `key.plrs.im` issuer, a foreign audience or device,
// a grace window past the one-year ceiling, and a stale document on the network path.

import { beforeAll, describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  signJws,
  type TrustSet,
} from "@plrs/jws";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { ConfigDoc } from "@plrs/protocol/config";
import {
  verifyConfigDoc,
  verifyLicenseDoc,
  type VerifyOptions,
} from "../src/verify.js";
import { CLOCK_SKEW_SECONDS, MAX_GRACE_SECONDS } from "../src/claims.js";

const KID = "plrs-test-2026";
let PEM = "";
let trust: TrustSet = {};

const enc = new TextEncoder();
const dec = new TextDecoder();

function pkcs8ToPem(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  PEM = pkcs8ToPem(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  trust = {
    [KID]: base64UrlEncodeBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
});

// The fixture docs live on their own little timeline, so the clock is pinned rather than read
// from the wall — the network profile asserts the freshness window and would otherwise reject
// every 1970-epoch fixture.
const ISSUED = 1000;
const EXPIRES = 4600;
const GRACE = 2_592_000;
const NOW = 2000;

function baseOpts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    trust,
    expectedAud: "djdl",
    deviceId: "dev-1",
    now: NOW,
    ...over,
  };
}

function licenseDoc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  return {
    aud: "djdl",
    iss: "plrs.im",
    deviceId: "dev-1",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    graceUntil: GRACE,
    licenseId: "lic-1",
    profile: {
      name: "Ada Lovelace",
      firstName: "Ada",
      email: "ada@example.com",
      activatedAt: 1,
    },
    entitlements: {
      "license.tier": { state: "enforced", value: "pro", updatedAt: 999 },
    },
    ...over,
  };
}

function configDoc(over: Partial<ConfigDoc> = {}): ConfigDoc {
  return {
    aud: "djdl",
    iss: "plrs.im",
    deviceId: "dev-1",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    graceUntil: GRACE,
    schemaVersion: 4,
    config: {
      "run.concurrency": { state: "enforced", value: 4, updatedAt: 999 },
    },
    secrets: {},
    ...over,
  };
}

const signLicense = (over: Partial<LicenseDoc> = {}): Promise<string> =>
  signJws(licenseDoc(over), PEM, KID, "plrs-license+jws");
const signConfig = (over: Partial<ConfigDoc> = {}): Promise<string> =>
  signJws(configDoc(over), PEM, KID, "plrs-config+jws");

describe("verifyLicenseDoc / verifyConfigDoc — happy path", () => {
  it("accepts a well-formed license document and reproduces it byte-for-byte", async () => {
    const doc = licenseDoc();
    const result = await verifyLicenseDoc(await signLicense(), baseOpts());
    expect(result).toEqual(doc);
  });

  it("accepts a well-formed config document and reproduces it byte-for-byte", async () => {
    const doc = configDoc();
    const result = await verifyConfigDoc(await signConfig(), baseOpts());
    expect(result).toEqual(doc);
  });

  it("issues a config document to a device with no license at all (D-08 on the wire)", async () => {
    // Nothing about the config document references a license: the config-only product's
    // document verifies exactly like any other.
    const result = await verifyConfigDoc(await signConfig(), baseOpts());
    expect(result?.schemaVersion).toBe(4);
    expect(result).not.toHaveProperty("licenseId");
    expect(result).not.toHaveProperty("entitlements");
  });
});

describe("verifyDoc — typ domain separation (§2)", () => {
  it("refuses a CONFIG document presented to verifyLicenseDoc", async () => {
    expect(await verifyLicenseDoc(await signConfig(), baseOpts())).toBeNull();
  });

  it("refuses a LICENSE document presented to verifyConfigDoc", async () => {
    expect(await verifyConfigDoc(await signLicense(), baseOpts())).toBeNull();
  });

  it("refuses a trust manifest replayed into either document call site", async () => {
    const manifest = await signJws(
      {
        schemaVersion: 1,
        aud: "djdl",
        iss: "plrs.im",
        issuedAt: ISSUED,
        expiresAt: EXPIRES,
        jwksUrl: "https://k.test/djdl/.well-known/jwks.json",
        cacheSeconds: 300,
        keys: [],
      },
      PEM,
      KID,
      "plrs-trust+jws",
    );
    expect(await verifyLicenseDoc(manifest, baseOpts())).toBeNull();
    expect(await verifyConfigDoc(manifest, baseOpts())).toBeNull();
  });

  it("refuses a document whose header carries NO typ at all (§2: the v2 tolerance window is over)", async () => {
    // signJws with no typ argument emits the v1-era typ-less header. A v3 verifier must
    // reject it even though the claims are perfect — otherwise any signed artifact from
    // the tolerance era can masquerade as whichever document type an attacker prefers.
    const typless = await signJws(licenseDoc(), PEM, KID);
    expect(await verifyLicenseDoc(typless, baseOpts())).toBeNull();
  });

  it("refuses a v2 `pkey-config+jws` document outright (no dual-accept window)", async () => {
    const legacy = await signJws(licenseDoc(), PEM, KID, "pkey-config+jws");
    expect(await verifyLicenseDoc(legacy, baseOpts())).toBeNull();
    expect(await verifyConfigDoc(legacy, baseOpts())).toBeNull();
  });
});

describe("verifyDoc — shared envelope (§3)", () => {
  it("refuses v2's `key.plrs.im` issuer; v3 is the host-neutral `plrs.im`", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ iss: "key.plrs.im" }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signConfig({ iss: "key.plrs.im" }),
        baseOpts(),
      ),
    ).toBeNull();
    // …and the plain `plrs.im` default is what actually passes.
    expect(
      await verifyLicenseDoc(await signLicense(), baseOpts()),
    ).not.toBeNull();
  });

  it("refuses any other foreign issuer, but honours an explicitly configured one", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ iss: "https://evil.example" }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyLicenseDoc(await signLicense({ iss: "other.test" }), {
        ...baseOpts(),
        expectedIss: "other.test",
      }),
    ).not.toBeNull();
  });

  it("refuses a foreign audience (anti-cross-product splice), both types", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ aud: "other-product" }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signConfig({ aud: "other-product" }),
        baseOpts(),
      ),
    ).toBeNull();
  });

  it("refuses a foreign deviceId (anti-cross-device splice), both types", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ deviceId: "someone-else" }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signConfig({ deviceId: "someone-else" }),
        baseOpts(),
      ),
    ).toBeNull();
  });

  it("bounds graceUntil: never below expiresAt, never beyond a year from issuedAt", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ graceUntil: 4599 }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyLicenseDoc(
        await signLicense({ graceUntil: ISSUED + MAX_GRACE_SECONDS + 1 }),
        baseOpts(),
      ),
    ).toBeNull();
    // Exactly at the ceiling is the longest offline window a signer can grant.
    expect(
      await verifyLicenseDoc(
        await signLicense({ graceUntil: ISSUED + MAX_GRACE_SECONDS }),
        baseOpts(),
      ),
    ).not.toBeNull();
  });

  it("applies the same grace ceiling to config documents", async () => {
    expect(
      await verifyConfigDoc(
        await signConfig({ graceUntil: ISSUED + MAX_GRACE_SECONDS + 1 }),
        baseOpts(),
      ),
    ).toBeNull();
  });

  it("enforces the per-type anti-replay floor (equal is not strictly newer)", async () => {
    const opts = baseOpts({ lastAcceptedIssuedAt: ISSUED });
    expect(
      await verifyLicenseDoc(await signLicense({ issuedAt: ISSUED }), opts),
    ).toBeNull();
    expect(
      await verifyLicenseDoc(await signLicense({ issuedAt: ISSUED - 1 }), opts),
    ).toBeNull();
    const newer = await verifyLicenseDoc(
      await signLicense({ issuedAt: ISSUED + 1 }),
      opts,
    );
    expect(newer?.issuedAt).toBe(ISSUED + 1);
  });

  it("refuses a far-future issuedAt, with CLOCK_SKEW of leeway", async () => {
    const future = 10 * 365 * 86400;
    expect(
      await verifyLicenseDoc(
        await signLicense({
          issuedAt: future,
          expiresAt: future + 3600,
          graceUntil: future + 3600,
        }),
        baseOpts(),
      ),
    ).toBeNull();
    // A clock CLOCK_SKEW seconds slow on a freshly-signed doc is still tolerated.
    const t = 1_700_000_000;
    expect(
      await verifyLicenseDoc(
        await signLicense({
          issuedAt: t,
          expiresAt: t + 3600,
          graceUntil: t + 30 * 86400,
        }),
        baseOpts({ now: t - CLOCK_SKEW_SECONDS }),
      ),
    ).not.toBeNull();
  });
});

describe("verifyDoc — the checkFreshness split (§3)", () => {
  it("network path refuses an expired document; reload path keeps offline grace alive", async () => {
    const jws = await signLicense();
    const wayPastExpiry = EXPIRES + 10 * 86400;
    // Default (network) — a stale document must never enter the cache.
    expect(
      await verifyLicenseDoc(jws, baseOpts({ now: wayPastExpiry })),
    ).toBeNull();
    // Reload — the cached document is EXPECTED to be past its short expiresAt; the gate
    // enforces graceUntil against the clock floor instead.
    expect(
      await verifyLicenseDoc(
        jws,
        baseOpts({ now: wayPastExpiry, checkFreshness: false }),
      ),
    ).not.toBeNull();
  });

  it("the split is exactly one CLOCK_SKEW window wide on the network path", async () => {
    const jws = await signLicense();
    expect(
      await verifyLicenseDoc(
        jws,
        baseOpts({ now: EXPIRES + CLOCK_SKEW_SECONDS - 1 }),
      ),
    ).not.toBeNull();
    expect(
      await verifyLicenseDoc(
        jws,
        baseOpts({ now: EXPIRES + CLOCK_SKEW_SECONDS + 1 }),
      ),
    ).toBeNull();
  });

  it("applies to config documents identically", async () => {
    const jws = await signConfig();
    const wayPastExpiry = EXPIRES + 10 * 86400;
    expect(
      await verifyConfigDoc(jws, baseOpts({ now: wayPastExpiry })),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        jws,
        baseOpts({ now: wayPastExpiry, checkFreshness: false }),
      ),
    ).not.toBeNull();
  });

  it("the reload path still refuses a foreign device (it relaxes freshness, nothing else)", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense({ deviceId: "someone-else" }),
        baseOpts({ checkFreshness: false }),
      ),
    ).toBeNull();
  });
});

describe("verifyDoc — per-document claims", () => {
  it("license: refuses a missing/scalar entitlements map or a blank licenseId", async () => {
    const bad = [
      { entitlements: undefined as unknown as LicenseDoc["entitlements"] },
      { entitlements: [] as unknown as LicenseDoc["entitlements"] },
      { licenseId: "" },
      { licenseId: 7 as unknown as string },
      { profile: "Ada" as unknown as LicenseDoc["profile"] },
    ];
    for (const over of bad) {
      expect(
        await verifyLicenseDoc(await signLicense(over), baseOpts()),
      ).toBeNull();
    }
    // An absent optional profile is fine.
    expect(
      await verifyLicenseDoc(
        await signLicense({ profile: undefined }),
        baseOpts(),
      ),
    ).not.toBeNull();
  });

  it("config: accepts any product catalog version but refuses a malformed one", async () => {
    // The field carries the PRODUCT CATALOG version, so 999 is a perfectly ordinary value —
    // the shape is what is enforceable.
    expect(
      await verifyConfigDoc(
        await signConfig({ schemaVersion: 999 }),
        baseOpts(),
      ),
    ).not.toBeNull();
    expect(
      await verifyConfigDoc(
        await signConfig({ schemaVersion: "1" as unknown as number }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(await signConfig({ schemaVersion: 0 }), baseOpts()),
    ).toBeNull();
  });

  it("config: refuses a missing config or secrets map", async () => {
    expect(
      await verifyConfigDoc(
        await signConfig({
          config: undefined as unknown as ConfigDoc["config"],
        }),
        baseOpts(),
      ),
    ).toBeNull();
    expect(
      await verifyConfigDoc(
        await signConfig({
          secrets: undefined as unknown as ConfigDoc["secrets"],
        }),
        baseOpts(),
      ),
    ).toBeNull();
  });
});

describe("verifyDoc — crypto path (delegated to @plrs/jws, asserted here)", () => {
  it("refuses a tampered payload", async () => {
    const jws = await signLicense();
    const [h, p, s] = jws.split(".") as [string, string, string];
    const decoded = JSON.parse(dec.decode(base64UrlDecode(p))) as LicenseDoc;
    decoded.licenseId = "TAMPERED";
    const tampered = base64UrlEncodeBytes(enc.encode(JSON.stringify(decoded)));
    expect(
      await verifyLicenseDoc(`${h}.${tampered}.${s}`, baseOpts()),
    ).toBeNull();
  });

  it("refuses an unknown kid", async () => {
    expect(
      await verifyLicenseDoc(
        await signLicense(),
        baseOpts({ trust: { "some-other-kid": trust[KID]! } }),
      ),
    ).toBeNull();
  });

  it("refuses a non-EdDSA alg header (no none/HS downgrade)", async () => {
    const jws = await signLicense();
    const [, p, s] = jws.split(".") as [string, string, string];
    const noneHeader = base64UrlEncodeBytes(
      enc.encode(
        JSON.stringify({ alg: "none", typ: "plrs-license+jws", kid: KID }),
      ),
    );
    expect(
      await verifyLicenseDoc(`${noneHeader}.${p}.${s}`, baseOpts()),
    ).toBeNull();
  });

  it("refuses structurally malformed input", async () => {
    for (const junk of ["not-a-jws", "a.b", "@@@.@@@.@@@", ""]) {
      expect(await verifyLicenseDoc(junk, baseOpts())).toBeNull();
      expect(await verifyConfigDoc(junk, baseOpts())).toBeNull();
    }
  });
});
