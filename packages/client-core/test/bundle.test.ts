// Offline activation bundles — wire contract v3 §7.
//
// `conformance/corpus/v2`'s `bundleCases` are the normative pins for this module and run in
// the Node conformance runner; this suite covers what a signed fixture cannot express and
// what the corpus deliberately leaves out:
//
//   * the VACUOUS bundle (§7's last paragraph) — no license, no config. The generator has no
//     reason to mint one because a server would never emit it, but a hostile or buggy mint
//     could, and importing it would leave an install marked provisioned with nothing behind
//     the marker.
//   * the SHAPE of what a passing bundle hands back — a host writes the cache from it, so a
//     missing `trustJws` or a decoded-instead-of-signed document would be an §4.1 violation
//     that the corpus's pass/fail vectors cannot see.
//   * the two entry points agreeing, and `verifyBundle` collapsing every step to `null`.
//
// Isomorphic like the rest of the package: WebCrypto only, key generated in `beforeAll`.

import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@plrs/jws";
import type { BundleDoc } from "@plrs/protocol/core";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { ConfigDoc } from "@plrs/protocol/config";
import type { TrustManifestDoc } from "@plrs/protocol/trust";
import {
  MAX_BUNDLE_BYTES,
  inspectBundle,
  verifyBundle,
  type BundleOptions,
} from "../src/bundle.js";

const KID = "plrs-test-2026";
const PRODUCT = "djdl";
const DEVICE = "dev-1";

let PEM = "";
let PUB = "";
let pinned: TrustSet = {};

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
  PUB = base64UrlEncodeBytes(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  pinned = { [KID]: PUB };
});

// The bundle is minted at MINTED and imported at NOW, a week later — the inner documents are
// long past their one-hour `expiresAt` by then, which is exactly the split §7 encodes: the
// bundle gets network freshness, its contents get the reload profile.
const MINTED = 1_700_000_000;
const NOW = MINTED + 7 * 86_400;
const IMPORT_WINDOW = 30 * 86_400;
const GRACE = 90 * 86_400;

function opts(over: Partial<BundleOptions> = {}): BundleOptions {
  return { pinned, product: PRODUCT, deviceId: DEVICE, now: NOW, ...over };
}

function manifest(): TrustManifestDoc {
  return {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "plrs.im",
    issuedAt: MINTED,
    expiresAt: MINTED + 300,
    jwksUrl: `https://k.test/${PRODUCT}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys: [
      {
        kid: KID,
        alg: "EdDSA",
        kty: "OKP",
        crv: "Ed25519",
        publicKey: PUB,
        status: "active",
      },
    ],
  };
}

function licenseDoc(): LicenseDoc {
  return {
    iss: "plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + 3600,
    graceUntil: MINTED + GRACE,
    licenseId: "lic-air-gapped",
    entitlements: {},
  };
}

function configDoc(): ConfigDoc {
  return {
    iss: "plrs.im",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + 3600,
    graceUntil: MINTED + GRACE,
    schemaVersion: 4,
    config: {
      "run.mode": { state: "enforced", value: "offline", updatedAt: MINTED },
    },
    secrets: {},
  };
}

/** Mint a bundle around whatever inner documents the case wants. */
async function mint(
  docs: BundleDoc["docs"],
  over: Partial<BundleDoc> = {},
): Promise<string> {
  const payload: BundleDoc = {
    bundleId: "01JBUNDLE0000000000000000",
    aud: PRODUCT,
    deviceId: DEVICE,
    issuedAt: MINTED,
    expiresAt: MINTED + IMPORT_WINDOW,
    docs,
    trust: await signJws(manifest(), PEM, KID, "plrs-trust+jws"),
    ...over,
  };
  return signJws(payload, PEM, KID, "plrs-bundle+jws");
}

async function innerDocs(
  which: "both" | "license" | "config",
): Promise<BundleDoc["docs"]> {
  const license = await signJws(licenseDoc(), PEM, KID, "plrs-license+jws");
  const config = await signJws(configDoc(), PEM, KID, "plrs-config+jws");
  if (which === "license") return { license };
  if (which === "config") return { config };
  return { license, config };
}

describe("verifyBundle — the vacuous bundle (§7)", () => {
  it("refuses a bundle carrying NO documents at all, at the claims step", async () => {
    // Perfectly signed, addressed to this device, inside its import window — and it grants
    // nothing and configures nothing. Importing it would write an `importedBundle` marker
    // with no content behind it: an install that reads as provisioned and is not.
    const jws = await mint({});
    expect(await inspectBundle(jws, opts())).toEqual({
      ok: false,
      reason: "bundle-claims-rejected",
    });
    expect(await verifyBundle(jws, opts())).toBeNull();
  });

  it("a config-only bundle is NOT vacuous — D-08 air-gaps without a license", async () => {
    const jws = await mint(await innerDocs("config"));
    const bundle = await verifyBundle(jws, opts());
    expect(bundle).not.toBeNull();
    expect(bundle!.docs.config).toBeDefined();
    // …and it carries no activation: `activation: "bundle"` arises only from a bundle whose
    // LICENSE document verified, so the host must not read one out of this.
    expect(bundle!.docs.license).toBeUndefined();
  });
});

describe("verifyBundle — what a passing bundle hands back", () => {
  it("returns the signed artifacts and the effective trust set, not just a boolean", async () => {
    const jws = await mint(await innerDocs("both"));
    const result = await inspectBundle(jws, opts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bundle } = result;

    expect(bundle.bundleId).toBe("01JBUNDLE0000000000000000");
    // The manifest's compact JWS, verbatim — the cache stores this, never a decoded key map.
    expect(bundle.trustJws.split(".")).toHaveLength(3);
    expect(bundle.effectiveTrust).toEqual(pinned);
    // Each document as BOTH artifact and payload: the artifact is what the host persists, the
    // payload is what it gates on, and re-verifying to get the second would be wasteful.
    expect(bundle.docs.license!.doc.licenseId).toBe("lic-air-gapped");
    expect(bundle.docs.license!.jws.split(".")).toHaveLength(3);
    expect(bundle.docs.config!.doc.schemaVersion).toBe(4);
    expect(bundle.docs.config!.jws.split(".")).toHaveLength(3);
  });

  it("verifies inner documents on the RELOAD profile — a week-old bundle still imports", async () => {
    // Both inner documents expired six days before `NOW`. On the network profile that is a
    // refusal; §7.4 says reload, because a bundle's inner documents carry a long `graceUntil`
    // rather than a long `expiresAt`, and the gate is what enforces the grace bound later.
    const jws = await mint(await innerDocs("both"));
    expect(NOW).toBeGreaterThan(licenseDoc().expiresAt);
    expect(await verifyBundle(jws, opts())).not.toBeNull();
  });

  it("still refuses an inner document whose grace has a different device's name on it", async () => {
    const foreign = await signJws(
      { ...licenseDoc(), deviceId: "someone-elses-laptop" },
      PEM,
      KID,
      "plrs-license+jws",
    );
    const jws = await mint({ license: foreign }, { deviceId: DEVICE });
    expect(await inspectBundle(jws, opts())).toEqual({
      ok: false,
      reason: "inner-doc-rejected",
    });
  });
});

describe("verifyBundle — the cap is the verifier's, not the caller's", () => {
  it("exposes the §1 bundle cap as a constant callers cannot raise", () => {
    // There is no `maxPayloadBytes` on `BundleOptions` at all: the raised cap is a property of
    // `plrs-bundle+jws`, and a host that could pass its own would be able to grant a quarter
    // megabyte to something that is not a bundle.
    expect(MAX_BUNDLE_BYTES).toBe(262_144);
    expect(Object.keys(opts())).toEqual([
      "pinned",
      "product",
      "deviceId",
      "now",
    ]);
  });

  it("refuses a bundle padded past the cap even though its signature is good", async () => {
    const padding = "x".repeat(MAX_BUNDLE_BYTES);
    const jws = await mint(await innerDocs("license"), {
      bundleId: `01JBUNDLE${padding}`,
    });
    expect(await inspectBundle(jws, opts())).toEqual({
      ok: false,
      reason: "bundle-jws-rejected",
    });
  });
});

describe("verifyBundle — step attribution", () => {
  it("distinguishes a foreign BUNDLE from a foreign inner DOCUMENT", async () => {
    // The same words, two different operator remedies: "this bundle was minted for another
    // machine — get one for yours" versus "the mint bound the wrong device into the licence".
    const docs = await innerDocs("license");
    expect(
      await inspectBundle(await mint(docs), opts({ deviceId: "other" })),
    ).toEqual({
      ok: false,
      reason: "bundle-claims-rejected",
    });
  });

  it("refuses a bundle whose import window has closed, past the skew", async () => {
    const jws = await mint(await innerDocs("license"));
    const late = MINTED + IMPORT_WINDOW + 301;
    expect(await inspectBundle(jws, opts({ now: late }))).toEqual({
      ok: false,
      reason: "bundle-claims-rejected",
    });
    // …and accepts it one second inside the skew, so the boundary is the contract's, not an
    // off-by-one.
    expect(
      await verifyBundle(jws, opts({ now: MINTED + IMPORT_WINDOW + 300 })),
    ).not.toBeNull();
  });

  it("attributes a manifest that substitutes a pinned kid to the TRUST step", async () => {
    const swapped: TrustManifestDoc = {
      ...manifest(),
      keys: [
        {
          ...manifest().keys[0]!,
          publicKey: base64UrlEncodeBytes(new Uint8Array(32)),
        },
      ],
    };
    const jws = await mint(await innerDocs("license"), {
      trust: await signJws(swapped, PEM, KID, "plrs-trust+jws"),
    });
    expect(await inspectBundle(jws, opts())).toEqual({
      ok: false,
      reason: "bundle-trust-rejected",
    });
  });

  it("refuses a bundle wearing another document's typ", async () => {
    // The raised cap travels with the `typ`; without the check the same bytes could be
    // replayed where a 64 KiB document is expected.
    const jws = await signJws(
      {
        bundleId: "b",
        aud: PRODUCT,
        deviceId: DEVICE,
        issuedAt: MINTED,
        expiresAt: MINTED + IMPORT_WINDOW,
        docs: await innerDocs("license"),
        trust: await signJws(manifest(), PEM, KID, "plrs-trust+jws"),
      },
      PEM,
      KID,
      "plrs-license+jws",
    );
    expect(await inspectBundle(jws, opts())).toEqual({
      ok: false,
      reason: "bundle-jws-rejected",
    });
  });
});
