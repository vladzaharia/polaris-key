/**
 * P6-01 — `core/trust/x509.ts`: the pinned-root chain verifier the App Store verification (and P6-02's
 * App Attest) runs on. Every chain is generated here (`x509Fixtures.ts`); the workerd lane runs
 * the same verifier in the runtime it ships to (`test-workerd/runtime.test.ts`).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  X509Error,
  decodeOid,
  ecdsaDerToRaw,
  getExtension,
  parseCertificate,
  readDer,
  verifyChain,
} from "../src/core/trust/x509.js";
import { APPLE_ROOT_CA_G3_DER } from "../src/services/distribution/commerce/appleRoot.js";
import {
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  makeCert,
  makeChain,
  makeRoot,
  testKey,
} from "./x509Fixtures.js";

const AT = 1_700_000_000;
const POLICY = (roots: Uint8Array[]) => ({
  roots,
  at: AT,
  length: 3,
  leafOids: [APPLE_LEAF_OID],
  intermediateOids: [APPLE_INTERMEDIATE_OID],
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof X509Error) return e.reason;
    throw e;
  }
  return "accepted";
}

describe("core/x509 — chain verification", () => {
  it("accepts a well-formed Apple-shaped chain to a pinned root and returns the leaf key", async () => {
    const c = await makeChain({ at: AT });
    const { leaf, key } = await verifyChain(c.chain, POLICY([c.root]));
    expect(leaf.curve).toBe("P-256");
    expect(leaf.extensions.has(APPLE_LEAF_OID)).toBe(true);
    expect(key.type).toBe("public");
  });

  it("refuses a chain whose root is not pinned, even with the same name", async () => {
    const c = await makeChain({ at: AT });
    const other = await makeRoot(AT);
    expect(await reason(verifyChain(c.chain, POLICY([other.der])))).toBe(
      "untrusted root",
    );
  });

  it("refuses a broken link (leaf not signed by the intermediate)", async () => {
    const c = await makeChain({ at: AT, brokenLink: true });
    expect(await reason(verifyChain(c.chain, POLICY([c.root])))).toBe(
      "bad certificate signature",
    );
  });

  it("refuses a missing leaf OID and a missing intermediate OID", async () => {
    const a = await makeChain({ at: AT, noLeafOid: true });
    expect(await reason(verifyChain(a.chain, POLICY([a.root])))).toBe(
      "leaf oid missing",
    );
    const b = await makeChain({ at: AT, noIntermediateOid: true });
    expect(await reason(verifyChain(b.chain, POLICY([b.root])))).toBe(
      "intermediate oid missing",
    );
  });

  it("refuses an intermediate that is not a CA and an expired leaf", async () => {
    const a = await makeChain({ at: AT, intermediateNotCa: true });
    expect(await reason(verifyChain(a.chain, POLICY([a.root])))).toBe(
      "issuer is not a CA",
    );
    const b = await makeChain({ at: AT, expiredLeaf: true });
    expect(await reason(verifyChain(b.chain, POLICY([b.root])))).toBe(
      "certificate not valid now",
    );
  });

  it("refuses a chain of the wrong length and a swapped order", async () => {
    const c = await makeChain({ at: AT });
    expect(await reason(verifyChain([c.leaf, c.root], POLICY([c.root])))).toBe(
      "chain length",
    );
    expect(
      await reason(
        verifyChain([c.intermediate, c.leaf, c.root], POLICY([c.root])),
      ),
    ).not.toBe("accepted");
  });

  it("refuses a tampered certificate byte", async () => {
    const c = await makeChain({ at: AT });
    const leaf = c.leaf.slice();
    leaf[leaf.length - 80]! ^= 0x01;
    expect(
      await reason(
        verifyChain([leaf, c.intermediate, c.root], POLICY([c.root])),
      ),
    ).not.toBe("accepted");
  });
});

describe("core/x509 — DER strictness", () => {
  it("refuses indefinite and non-minimal lengths and trailing bytes", () => {
    expect(() => readDer(Uint8Array.of(0x30, 0x80, 0, 0))).toThrow(X509Error);
    expect(() => readDer(Uint8Array.of(0x04, 0x81, 0x01, 0x00))).toThrow(
      X509Error,
    );
    expect(() => parseCertificate(Uint8Array.of(0x30, 0x00, 0x00))).toThrow(
      X509Error,
    );
  });

  it("decodes OIDs and converts ECDSA signatures", () => {
    expect(
      decodeOid(Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03)),
    ).toBe("1.2.840.10045.4.3.3");
    const der = Uint8Array.of(
      0x30,
      0x07,
      0x02,
      0x02,
      0x00,
      0x80,
      0x02,
      0x01,
      0x01,
    );
    const raw = ecdsaDerToRaw(der, 32);
    expect(raw[31]).toBe(0x80);
    expect(raw[63]).toBe(0x01);
  });
});

describe("the pinned Apple Root CA - G3", () => {
  it("is Apple's published certificate (SHA-256 fingerprint 63343ABF…3E9179)", () => {
    const fp = createHash("sha256").update(APPLE_ROOT_CA_G3_DER).digest("hex");
    expect(fp).toBe(
      "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179",
    );
    const cert = parseCertificate(APPLE_ROOT_CA_G3_DER);
    expect(cert.curve).toBe("P-384");
    expect(cert.ca).toBe(true);
  });

  it("is the same bytes as Apple's published AppleRootCA-G3.cer, kept as a fixture", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const der = readFileSync(
      join(here, "fixtures", "commerce", "AppleRootCA-G3.cer"),
    );
    expect(der.equals(Buffer.from(APPLE_ROOT_CA_G3_DER))).toBe(true);
  });
});

describe("core/x509 — hardening (the parser P6-02 builds on)", () => {
  async function leafWith(tamper: Record<string, unknown>, ca = false) {
    const key = await testKey("P-256");
    return makeCert({
      subject: "Leaf",
      issuer: "Leaf",
      key,
      signer: key,
      notBefore: AT - 86400,
      notAfter: AT + 86400,
      ca,
      tamper,
    });
  }
  const refuse = (der: Uint8Array) => {
    try {
      parseCertificate(der);
    } catch (e) {
      if (e instanceof X509Error) return e.reason;
      throw e;
    }
    return "accepted";
  };

  it("range-checks every time field (no rolling of month 13, day 31 in April or second 60)", async () => {
    for (const raw of [
      "20231301000000Z",
      "20230431000000Z",
      "20230101240000Z",
      "20230101006000Z",
      "20230101000060Z",
      "20230229000000Z",
    ])
      expect(refuse(await leafWith({ notBeforeRaw: raw })), raw).toBe(
        "time out of range",
      );
    expect(refuse(await leafWith({ notBeforeRaw: "20240229000000Z" }))).toBe(
      "accepted",
    );
  });

  it("refuses a repeated [3], a second element inside it, and a trailing element in an Extension", async () => {
    expect(refuse(await leafWith({ repeatExtensions: true }))).toBe(
      "repeated or misordered tbs field",
    );
    expect(refuse(await leafWith({ extensionsWrapperExtra: true }))).toBe(
      "extensions wrapper shape",
    );
    expect(refuse(await leafWith({ extensionTrailer: true }))).toBe(
      "trailing extension element",
    );
  });

  it("refuses an explicitly encoded cA FALSE and a BOOLEAN of the wrong length", async () => {
    expect(refuse(await leafWith({ explicitCaFalse: true }))).toBe(
      "encoded default",
    );
    expect(refuse(await leafWith({ longBoolean: true }))).toBe("bad boolean");
  });

  it("exposes keyUsage, extensions and the parsed chain; checks digitalSignature on the leaf when asked", async () => {
    const c = await makeChain({ at: AT });
    const { chain, leaf } = await verifyChain(c.chain, {
      ...POLICY([c.root]),
      leafDigitalSignature: "require",
    });
    expect(chain).toHaveLength(3);
    expect(leaf.digitalSignature).toBe(true);
    expect(getExtension(leaf, APPLE_LEAF_OID)?.critical).toBe(false);
    expect(getExtension(leaf, "1.2.3.4")).toBeNull();

    // A leaf whose keyUsage is keyEncipherment only (bit 2), and one with no keyUsage at all.
    const kuNoSign = await leafWith({ keyUsage: [5, 0x20] });
    expect(parseCertificate(kuNoSign).digitalSignature).toBe(false);
    const noKu = await leafWith({ keyUsage: null });
    expect(parseCertificate(noKu).digitalSignature).toBeNull();
    const root = await makeRoot(AT);
    const signWith = async (tamper: Record<string, unknown>) => {
      const key = await testKey("P-256");
      return makeCert({
        subject: "Leaf",
        issuer: "Test Root CA - G3",
        key,
        signer: root.key,
        notBefore: AT - 86400,
        notAfter: AT + 86400,
        ca: false,
        tamper,
      });
    };
    const base = { roots: [root.der], at: AT };
    expect(
      await reason(
        verifyChain([await signWith({ keyUsage: [5, 0x20] }), root.der], {
          ...base,
          leafDigitalSignature: "ifPresent",
        }),
      ),
    ).toBe("leaf may not sign");
    expect(
      await reason(
        verifyChain([await signWith({ keyUsage: null }), root.der], {
          ...base,
          leafDigitalSignature: "ifPresent",
        }),
      ),
    ).toBe("accepted");
    expect(
      await reason(
        verifyChain([await signWith({ keyUsage: null }), root.der], {
          ...base,
          leafDigitalSignature: "require",
        }),
      ),
    ).toBe("leaf may not sign");
  });

  it("refuses an unknown critical extension unless the caller lists it as understood", async () => {
    const root = await makeRoot(AT);
    const key = await testKey("P-256");
    const leaf = await makeCert({
      subject: "Leaf",
      issuer: "Test Root CA - G3",
      key,
      signer: root.key,
      notBefore: AT - 86400,
      notAfter: AT + 86400,
      ca: false,
      criticalUnknown: true,
    });
    const base = { roots: [root.der], at: AT };
    expect(await reason(verifyChain([leaf, root.der], base))).toBe(
      "unknown critical extension",
    );
    expect(
      await reason(
        verifyChain([leaf, root.der], {
          ...base,
          understood: ["1.3.6.1.4.1.99999.1"],
        }),
      ),
    ).toBe("accepted");
  });
});
