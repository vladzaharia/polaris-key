// @pkey-feature core.verify
// Trust custody — WIRE-CONTRACT-V4 §1 and §2.3: the key-status allow-list, canonical published
// keys, pinned-key tombstones with their signed evidence, and the `?signer=` retry order.
// `conformance/corpus/v2`'s `trustCases` pin the verdicts across SDKs; this suite covers the
// helpers the corpus drives indirectly (`loadPinRevocations`, `trustSignerOrder`).

import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, type TrustSet } from "@polaris-key/jws";
import { MAX_TRUST_SIGNER_ATTEMPTS } from "@polaris-key/protocol/core";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import {
  compareKidBytes,
  jwsHeaderKid,
  loadPinRevocations,
  mergeTrust,
  trustSignerOrder,
  usablePins,
  verifyTrustManifest,
} from "../src/trust.js";

const PRODUCT = "djdl";
const T = 1_700_000_000;

interface Key {
  kid: string;
  pem: string;
  pub: string;
}
const keys: Record<"a" | "b" | "c", Key> = {} as never;

function pkcs8ToPem(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  for (const name of ["a", "b", "c"] as const) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    keys[name] = {
      kid: `kid-${name}`,
      pem: pkcs8ToPem(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      ),
      pub: base64UrlEncodeBytes(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      ),
    };
  }
});

const pins = (...names: ("a" | "b" | "c")[]): TrustSet =>
  Object.fromEntries(names.map((n) => [keys[n].kid, keys[n].pub]));

function entry(name: "a" | "b" | "c", status: unknown) {
  return {
    kid: keys[name].kid,
    alg: "EdDSA",
    kty: "OKP",
    crv: "Ed25519",
    publicKey: keys[name].pub,
    ...(status === undefined ? {} : { status }),
  };
}

function manifest(
  signer: "a" | "b" | "c",
  list: Record<string, unknown>[],
  issuedAt = T,
): Promise<string> {
  const doc = {
    schemaVersion: 1,
    aud: PRODUCT,
    iss: "key.plrs.im",
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
    cacheSeconds: 300,
    keys: list,
  } as unknown as TrustManifestDoc;
  return signJws(doc, keys[signer].pem, keys[signer].kid, "pkey-trust+jws");
}

const reload = { expectedAud: PRODUCT, checkFreshness: false } as const;

describe("the key-status allow-list (§1)", () => {
  it("keeps exactly active, staged and retired", async () => {
    const jws = await manifest("a", [
      entry("a", "active"),
      entry("b", "staged"),
      entry("c", "retired"),
    ]);
    const r = await verifyTrustManifest(jws, { pinned: pins("a"), ...reload });
    expect(Object.keys(r.discovered).sort()).toEqual(
      ["kid-a", "kid-b", "kid-c"].sort(),
    );
  });

  it("skips a missing, unknown, non-string or differently-cased status, never fatal", async () => {
    for (const status of [
      undefined,
      "suspended",
      "Active",
      "REVOKED",
      1,
      null,
    ]) {
      const jws = await manifest("a", [
        entry("a", "active"),
        entry("b", status),
      ]);
      const r = await verifyTrustManifest(jws, {
        pinned: pins("a"),
        ...reload,
      });
      expect(r.doc, String(status)).not.toBeNull();
      expect(r.discovered, String(status)).toEqual(pins("a"));
    }
  });

  it("skips a published key that is not canonical base64url", async () => {
    // 32 bytes are 43 characters: the last one has 2 unused bits. Set the lowest.
    const ALPHABET =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const pub = keys.b.pub;
    const last = ALPHABET.indexOf(pub[pub.length - 1]!);
    const bent = `${pub.slice(0, -1)}${ALPHABET[last | 1]}`;
    const jws = await manifest("a", [
      entry("a", "active"),
      { ...entry("b", "active"), publicKey: bent },
    ]);
    const r = await verifyTrustManifest(jws, { pinned: pins("a"), ...reload });
    expect(r.doc).not.toBeNull();
    expect(r.discovered).toEqual(pins("a"));
  });
});

describe("pinned-key tombstones (§1)", () => {
  it("another pin revokes a pin; the effective set loses it", async () => {
    const jws = await manifest("b", [
      entry("a", "revoked"),
      entry("b", "active"),
    ]);
    const r = await verifyTrustManifest(jws, {
      pinned: pins("a", "b"),
      ...reload,
    });
    expect(r.revokedPins).toEqual(["kid-a"]);
    expect(
      mergeTrust(usablePins(pins("a", "b"), r.revokedPins), r.discovered),
    ).toEqual(pins("b"));
  });

  it("a manifest that revokes its own signer is refused in full", async () => {
    const jws = await manifest("a", [
      entry("a", "revoked"),
      entry("b", "active"),
    ]);
    const r = await verifyTrustManifest(jws, {
      pinned: pins("a", "b"),
      ...reload,
    });
    expect(r.doc).toBeNull();
    expect(r.revokedPins).toEqual([]);
  });

  it("a tombstoned pin signs nothing and no manifest restores it", async () => {
    const byA = await manifest("a", [entry("a", "active")]);
    expect(
      (
        await verifyTrustManifest(byA, {
          pinned: pins("a", "b"),
          tombstones: ["kid-a"],
          ...reload,
        })
      ).doc,
    ).toBeNull();
    const restore = await manifest("b", [
      entry("a", "active"),
      entry("b", "active"),
    ]);
    const r = await verifyTrustManifest(restore, {
      pinned: pins("a", "b"),
      tombstones: ["kid-a"],
      ...reload,
    });
    expect(r.doc).not.toBeNull();
    expect(r.discovered).toEqual(pins("b"));
    expect(r.revokedPins).toEqual([]);
  });

  it("listing a pinned kid as revoked with other bytes is a substitution", async () => {
    const jws = await manifest("b", [
      { ...entry("a", "revoked"), publicKey: keys.c.pub },
      entry("b", "active"),
    ]);
    const r = await verifyTrustManifest(jws, {
      pinned: pins("a", "b"),
      ...reload,
    });
    expect(r.doc).toBeNull();
  });
});

describe("loadPinRevocations (§4.1)", () => {
  it("applies the evidence in ascending manifest issuedAt, not map order", async () => {
    // b revoked a first (T), then a revoked b (T + 10): only a is tombstoned, and a's later
    // manifest is dropped because its signer was already tombstoned.
    const bRevokesA = await manifest("b", [entry("a", "revoked")], T);
    const aRevokesB = await manifest("a", [entry("b", "revoked")], T + 10);
    for (const evidence of [
      { "kid-a": bRevokesA, "kid-b": aRevokesB },
      { "kid-b": aRevokesB, "kid-a": bRevokesA },
    ]) {
      const r = await loadPinRevocations(evidence, {
        pinned: pins("a", "b"),
        expectedAud: PRODUCT,
      });
      expect(r.tombstones).toEqual(["kid-a"]);
      expect(r.kept).toEqual({ "kid-a": bRevokesA });
    }
  });

  it("drops an entry filed under the wrong kid, a forged one and a foreign one", async () => {
    const bRevokesA = await manifest("b", [entry("a", "revoked")]);
    const r = await loadPinRevocations(
      {
        "kid-b": bRevokesA,
        "kid-c": await manifest("c", [entry("a", "revoked")]),
        "kid-x": bRevokesA,
        "kid-a": "not-a-jws",
      },
      { pinned: pins("a", "b"), expectedAud: PRODUCT },
    );
    expect(r).toEqual({ tombstones: [], kept: {} });
  });

  it("never leaves an install without a usable pin", async () => {
    const r = await loadPinRevocations(
      {
        "kid-a": await manifest("b", [entry("a", "revoked")], T),
        "kid-b": await manifest("c", [entry("b", "revoked")], T + 1),
        "kid-c": await manifest("a", [entry("c", "revoked")], T + 2),
      },
      { pinned: pins("a", "b", "c"), expectedAud: PRODUCT },
    );
    expect(r.tombstones).toEqual(["kid-a", "kid-b"]);
    expect(Object.keys(usablePins(pins("a", "b", "c"), r.tombstones))).toEqual([
      "kid-c",
    ]);
  });
});

describe("the ?signer= retry order (§2.3)", () => {
  it("is empty when the default manifest's signer is a usable pin", () => {
    expect(trustSignerOrder(pins("a", "b"), "kid-a")).toEqual([]);
  });

  it("is every usable pin in ascending byte order, capped", () => {
    const many: TrustSet = {};
    for (const kid of ["z", "b", "a", "y", "c", "x"]) many[kid] = "k";
    expect(trustSignerOrder(many, "active-kid")).toEqual(
      ["a", "b", "c", "x", "y", "z"].slice(0, MAX_TRUST_SIGNER_ATTEMPTS),
    );
    expect(trustSignerOrder(pins("b", "a"), null)).toEqual(["kid-a", "kid-b"]);
  });

  it("orders by UTF-8 bytes, not UTF-16 units", () => {
    // U+FF21 (EF BC A1) sorts before U+10000 (F0 90 80 80) in bytes, after it in UTF-16.
    expect(compareKidBytes("Ａ", "\u{10000}")).toBeLessThan(0);
    expect("Ａ" < "\u{10000}").toBe(false);
  });

  it("reads the header kid without verifying", async () => {
    expect(jwsHeaderKid(await manifest("c", []))).toBe("kid-c");
    expect(jwsHeaderKid("garbage")).toBeNull();
  });
});
