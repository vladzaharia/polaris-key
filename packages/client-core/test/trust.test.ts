// The trust anchor / document-key split — wire contract v3 §1.1 (B3-01).
//
// The conformance corpus pins these rules across all five implementations; this suite asserts
// them directly against `client-core`, the one implementation the JS SDKs share, with real
// Ed25519 keys rather than golden vectors. What it exists to protect is a property that is easy
// to "improve" away:
//
//   A trust manifest is verified against PINNED keys ONLY.
//
// The anchor split does NOT relax that. It makes the pinned key a longer-lived one that document
// rotation never touches, so an installed client keeps verifying manifests — and therefore keeps
// receiving revocations — across any number of rotations. A verifier that instead started
// trusting the manifest's own `role` field to decide what may sign a manifest would be letting
// the manifest introduce the key that verifies it, which is R2-01, the most serious client-side
// finding the prior audit closed.

import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncodeBytes, signJws, verifyJws } from "@polaris-key/jws";
import type { TrustManifestDoc } from "@polaris-key/protocol/trust";
import { mergeTrust, verifyTrustManifest } from "../src/trust.js";

const AUD = "djdl";
const NOW = 1_700_000_000;

interface Key {
  kid: string;
  pem: string;
  pub: string;
}

function pkcs8ToPem(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function makeKey(kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    kid,
    pem: pkcs8ToPem(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
    pub: base64UrlEncodeBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  };
}

/** The ANCHOR — the key the host application pins, and the only key that signs a manifest. */
let anchor: Key;
/** The OUTGOING document key, retired by the rotation below. */
let outgoing: Key;
/** The INCOMING document key, published by the post-rotation manifest. */
let incoming: Key;

beforeAll(async () => {
  [anchor, outgoing, incoming] = await Promise.all([
    makeKey("acme-anchor-2026"),
    makeKey("acme-2026"),
    makeKey("acme-2027"),
  ]);
});

function keyEntry(
  key: Key,
  status: string,
  role?: string,
): Record<string, unknown> {
  return {
    kid: key.kid,
    alg: "EdDSA",
    kty: "OKP",
    crv: "Ed25519",
    publicKey: key.pub,
    status,
    ...(role === undefined ? {} : { role }),
  };
}

function manifestDoc(
  keys: Record<string, unknown>[],
  issuedAt = NOW,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: AUD,
    iss: "key.plrs.im",
    issuedAt,
    expiresAt: issuedAt + 300,
    jwksUrl: `https://key.plrs.im/${AUD}/.well-known/jwks.json`,
    cacheSeconds: 300,
    keys,
  };
}

const signManifest = (
  keys: Record<string, unknown>[],
  signer: Key,
): Promise<string> =>
  signJws(manifestDoc(keys), signer.pem, signer.kid, "pkey-trust+jws");

const verify = (
  jws: string,
  over: { pinned?: Record<string, string> } = {},
): Promise<{
  doc: TrustManifestDoc | null;
  discovered: Record<string, string>;
}> =>
  verifyTrustManifest(jws, {
    pinned: over.pinned ?? { [anchor.kid]: anchor.pub },
    expectedAud: AUD,
    now: NOW,
  });

describe("trust anchor split (§1.1)", () => {
  it("an anchor-signed manifest verifies against the pinned anchor and publishes the document key", async () => {
    const result = await verify(
      await signManifest(
        [
          keyEntry(anchor, "active", "anchor"),
          keyEntry(incoming, "active", "document"),
        ],
        anchor,
      ),
    );
    expect(result.doc).not.toBeNull();
    expect(result.discovered[incoming.kid]).toBe(incoming.pub);
  });

  it("a manifest signed by a DOCUMENT key is rejected, and the previous trust set survives", async () => {
    // The R2-01 guard in §1.1's vocabulary. The document key is the one that rotates, so it is
    // the one a compromise obtains — letting it sign the manifest would hand an attacker the
    // ability to mint the key set, and would silently un-revoke itself.
    const forged = await signManifest(
      [
        keyEntry(anchor, "active", "anchor"),
        keyEntry(incoming, "active", "document"),
      ],
      outgoing,
    );
    const result = await verify(forged);
    expect(result.doc).toBeNull();
    expect(result.discovered).toEqual({});
    // The caller keeps whatever it had — a refused manifest changes nothing at all.
    const kept = mergeTrust({ [anchor.kid]: anchor.pub }, result.discovered);
    expect(kept).toEqual({ [anchor.kid]: anchor.pub });
  });

  it("declaring `role: anchor` does not make a key an anchor", async () => {
    const forged = await signManifest(
      [
        keyEntry(outgoing, "active", "anchor"),
        keyEntry(anchor, "retired", "document"),
      ],
      outgoing,
    );
    expect((await verify(forged)).doc).toBeNull();
  });

  it("`role` is advisory in the benign direction too — it never filters a key out", async () => {
    // An implementation that trusted `role` to decide what belongs in the discovered set would
    // build a smaller trust set than its siblings from identical signed bytes: exactly the class
    // of cross-language divergence A1-06 and A1-08 were.
    const result = await verify(
      await signManifest(
        [
          keyEntry(anchor, "active", "document"), // wrong
          keyEntry(incoming, "active", "future"), // unknown
          keyEntry(outgoing, "active"), // absent
        ],
        anchor,
      ),
    );
    expect(result.doc).not.toBeNull();
    expect(Object.keys(result.discovered).sort()).toEqual(
      [anchor.kid, incoming.kid, outgoing.kid].sort(),
    );
  });

  it("a document-key rotation leaves a pinned client fully functional", async () => {
    // The regression this whole change exists to prevent. The client pins only the anchor and
    // currently trusts the outgoing key; the post-rotation manifest is signed by the SAME anchor.
    const before = await verify(
      await signManifest(
        [
          keyEntry(anchor, "active", "anchor"),
          keyEntry(outgoing, "active", "document"),
        ],
        anchor,
      ),
    );
    expect(before.doc).not.toBeNull();

    const after = await verify(
      await signManifest(
        [
          keyEntry(anchor, "active", "anchor"),
          keyEntry(incoming, "active", "document"),
        ],
        anchor,
      ),
    );
    expect(after.doc).not.toBeNull();

    const effective = mergeTrust(
      { [anchor.kid]: anchor.pub },
      after.discovered,
    );
    expect(effective[incoming.kid]).toBe(incoming.pub);
    expect(effective[outgoing.kid]).toBeUndefined(); // pruned by absence

    // A document signed by the ROTATED key verifies; one signed by the outgoing key does not.
    const doc = { hello: "world" };
    expect(
      await verifyJws(
        await signJws(doc, incoming.pem, incoming.kid, "pkey-license+jws"),
        effective,
        { typ: "pkey-license+jws" },
      ),
    ).not.toBeNull();
    expect(
      await verifyJws(
        await signJws(doc, outgoing.pem, outgoing.kid, "pkey-license+jws"),
        effective,
        { typ: "pkey-license+jws" },
      ),
    ).toBeNull();
  });

  it("pinning the DOCUMENT key instead of the anchor is the failure the split abolishes", async () => {
    // Stated as a test so the reason the anchor exists cannot be argued away later: a client
    // that pins the rotating key stops verifying manifests the moment it rotates, which is
    // precisely B3-01. Nothing in the verifier changes that — only pinning the anchor does.
    const postRotation = await signManifest(
      [
        keyEntry(anchor, "active", "anchor"),
        keyEntry(incoming, "active", "document"),
      ],
      anchor,
    );
    const pinnedToDocumentKey = await verify(postRotation, {
      pinned: { [outgoing.kid]: outgoing.pub },
    });
    expect(pinnedToDocumentKey.doc).toBeNull();

    // The same manifest, the same moment, a client pinned to the anchor: still working.
    expect((await verify(postRotation)).doc).not.toBeNull();
  });
});
