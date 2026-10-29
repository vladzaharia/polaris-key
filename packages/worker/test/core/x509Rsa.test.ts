/**
 * I-14.5 — RSA in `core/trust/x509.ts` (RSASSA-PKCS1-v1_5, SHA-256/384/512, 2048 to 8192 bits)
 * behind `ChainPolicy.algorithms`, the leaf extendedKeyUsage check and the subject reader.
 * The generated chains come from `x509Fixtures.ts`; the real Game Center chain (gc-prod-12, the
 * DigiCert Trusted G4 code-signing CA1 and Digicert Trusted Root G4, all public certificates,
 * provenance in `test/fixtures/gamecenter/README.md`) is verified at a fixed instant.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OID,
  X509Error,
  parseCertificate,
  subjectAttributes,
  verifyChain,
  type ChainPolicy,
} from "../../src/core/trust/x509.js";
import {
  makeCert,
  makeChain,
  makeRsaChain,
  rsaTestKey,
  syntheticRsaSpki,
  type RsaTestChain,
  x509Reason,
} from "../x509Fixtures.js";
import { TEST_ROOT } from "../paths.js";

const AT = 1_700_000_000;
const RSA = (c: { root: Uint8Array }, extra: Partial<ChainPolicy> = {}) => ({
  roots: [c.root],
  at: AT,
  length: 3,
  algorithms: ["rsa"] as const,
  ...extra,
});

const reason = x509Reason;

describe("x509 RSA: generated chains", () => {
  let c: RsaTestChain;
  beforeAll(async () => {
    c = await makeRsaChain({ at: AT });
  });

  it("accepts an RSA chain when the policy lists rsa, and returns a usable leaf key", async () => {
    const v = await verifyChain(c.chain, RSA(c));
    expect(v.leaf.keyType).toBe("rsa");
    expect(v.leaf.rsa).toEqual({ modulusBits: 2048, exponent: 65537 });
    expect(v.leaf.curve).toBeNull();
    const data = new TextEncoder().encode("signed by the leaf");
    const sig = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      c.leafKey.keys.privateKey,
      data,
    );
    expect(
      await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        v.key,
        sig,
        data,
      ),
    ).toBe(true);
  });

  it("accepts SHA-384 and SHA-512 signatures", async () => {
    for (const hash of ["SHA-384", "SHA-512"] as const) {
      const h = await makeRsaChain({ at: AT, hash });
      expect(await reason(verifyChain(h.chain, RSA(h)))).toBe("accepted");
    }
  });

  it("refuses an RSA chain under the default and the explicit ECDSA-only policy", async () => {
    const { algorithms: _a, ...noAlgs } = RSA(c);
    expect(await reason(verifyChain(c.chain, noAlgs))).toBe(
      "signature algorithm not allowed",
    );
    expect(
      await reason(verifyChain(c.chain, { ...noAlgs, algorithms: ["ecdsa"] })),
    ).toBe("signature algorithm not allowed");
    expect(() => parseCertificate(c.leaf)).toThrow(X509Error);
  });

  it("refuses an ECDSA chain under an RSA-only policy and accepts both under ecdsa+rsa", async () => {
    const e = await makeChain({ at: AT });
    expect(
      await reason(verifyChain(e.chain, { ...RSA(e), algorithms: ["rsa"] })),
    ).toBe("signature algorithm not allowed");
    const both = ["ecdsa", "rsa"] as const;
    expect(
      await reason(verifyChain(e.chain, { ...RSA(e), algorithms: both })),
    ).toBe("accepted");
    expect(
      await reason(verifyChain(c.chain, { ...RSA(c), algorithms: both })),
    ).toBe("accepted");
  });

  it("refuses an RSA signature whose issuer holds an EC key", async () => {
    const ec = await makeChain({ at: AT });
    const leaf = await makeCert({
      subject: "x",
      issuer: "Test WWDR CA - G6",
      key: c.leafKey,
      signer: c.leafKey,
      notBefore: AT - 1000,
      notAfter: AT + 1000,
      ca: false,
    });
    expect(
      await reason(
        verifyChain([leaf, ec.intermediate, ec.root], {
          ...RSA(ec),
          algorithms: ["ecdsa", "rsa"],
        }),
      ),
    ).toBe("issuer key type");
  });

  it("refuses a broken link, a wrong root, an expired and a not-yet-valid leaf", async () => {
    const b = await makeRsaChain({ at: AT, brokenLink: true });
    expect(await reason(verifyChain(b.chain, RSA(b)))).toBe(
      "bad certificate signature",
    );
    const other = await makeRsaChain({ at: AT });
    expect(
      await reason(verifyChain(c.chain, { ...RSA(c), roots: [other.root] })),
    ).toBe("untrusted root");
    const old = await makeRsaChain({ at: AT, expiredLeaf: true });
    expect(await reason(verifyChain(old.chain, RSA(old)))).toBe(
      "certificate not valid now",
    );
    const fut = await makeRsaChain({ at: AT, futureLeaf: true });
    expect(await reason(verifyChain(fut.chain, RSA(fut)))).toBe(
      "certificate not valid now",
    );
    // The intermediate or root expiring is as fatal: move the instant past the CAs.
    expect(
      await reason(
        verifyChain(c.chain, { ...RSA(c), at: AT + 6 * 365 * 86400 }),
      ),
    ).toBe("certificate not valid now");
  });

  it("refuses a tampered certificate byte", async () => {
    const leaf = c.leaf.slice();
    leaf[100]! ^= 0x01;
    expect(
      await reason(verifyChain([leaf, c.intermediate, c.root], RSA(c))),
    ).not.toBe("accepted");
    const sigTampered = c.leaf.slice();
    sigTampered[sigTampered.length - 5]! ^= 0x01;
    expect(
      await reason(verifyChain([sigTampered, c.intermediate, c.root], RSA(c))),
    ).toBe("bad certificate signature");
  });

  it("refuses a swapped order and a missing intermediate", async () => {
    expect(
      await reason(verifyChain([c.intermediate, c.leaf, c.root], RSA(c))),
    ).not.toBe("accepted");
    expect(
      await reason(
        verifyChain([c.leaf, c.root], { ...RSA(c), length: undefined }),
      ),
    ).toBe("issuer mismatch");
  });

  it("checks the leaf's extendedKeyUsage when the policy asks", async () => {
    const want = { leafExtendedKeyUsage: OID.codeSigning };
    expect(await reason(verifyChain(c.chain, RSA(c, want)))).toBe("accepted");
    const none = await makeRsaChain({ at: AT, eku: null });
    expect(await reason(verifyChain(none.chain, RSA(none, want)))).toBe(
      "leaf extended key usage",
    );
    const server = await makeRsaChain({
      at: AT,
      eku: ["1.3.6.1.5.5.7.3.1"],
    });
    expect(await reason(verifyChain(server.chain, RSA(server, want)))).toBe(
      "leaf extended key usage",
    );
    // anyExtendedKeyUsage does not satisfy a named purpose.
    const any = await makeRsaChain({ at: AT, eku: ["2.5.29.37.0"] });
    expect(await reason(verifyChain(any.chain, RSA(any, want)))).toBe(
      "leaf extended key usage",
    );
    // Not asked: any EKU (or none) passes.
    expect(await reason(verifyChain(none.chain, RSA(none)))).toBe("accepted");
    // Several purposes: the wanted one among them suffices.
    const multi = await makeRsaChain({
      at: AT,
      eku: ["1.3.6.1.5.5.7.3.1", OID.codeSigning],
    });
    expect(await reason(verifyChain(multi.chain, RSA(multi, want)))).toBe(
      "accepted",
    );
  });

  it("treats a critical EKU as understood only when the policy requires one", async () => {
    const root = c.rootKey;
    const key = await rsaTestKey();
    const leaf = await makeCert({
      subject: "Apple Inc.",
      issuer: "Test RSA Code Signing CA",
      key,
      signer: root, // wrong signer: the EKU check runs before the link check
      notBefore: AT - 1000,
      notAfter: AT + 1000,
      ca: false,
      eku: [OID.codeSigning],
      ekuCritical: true,
    });
    const chain = [leaf, c.intermediate, c.root];
    expect(await reason(verifyChain(chain, RSA(c)))).toBe(
      "unknown critical extension",
    );
    expect(
      await reason(
        verifyChain(chain, RSA(c, { leafExtendedKeyUsage: OID.codeSigning })),
      ),
    ).toBe("bad certificate signature");
  });

  it("refuses SHA-1 and MD5 signature algorithms", async () => {
    for (const sigOid of [
      "1.2.840.113549.1.1.5", // sha1WithRSAEncryption
      "1.2.840.113549.1.1.4", // md5WithRSAEncryption
      "1.2.840.113549.1.1.14", // sha224WithRSAEncryption
      "1.2.840.113549.1.1.10", // RSASSA-PSS (not supported here)
    ]) {
      const leaf = await makeCert({
        subject: "Apple Inc.",
        issuer: "Test RSA Code Signing CA",
        key: c.leafKey,
        signer: c.leafKey,
        notBefore: AT - 1000,
        notAfter: AT + 1000,
        ca: false,
        tamper: { sigOid },
      });
      expect(() => parseCertificate(leaf, ["rsa"])).toThrow(
        /unsupported signature algorithm/,
      );
      expect(
        await reason(verifyChain([leaf, c.intermediate, c.root], RSA(c))),
      ).toBe("unsupported signature algorithm");
    }
  });

  it("refuses an RSA signature algorithm without its NULL parameters", async () => {
    const leaf = await makeCert({
      subject: "x",
      issuer: "y",
      key: c.leafKey,
      signer: c.leafKey,
      notBefore: AT - 1000,
      notAfter: AT + 1000,
      ca: false,
      tamper: { rsaNoNull: true },
    });
    expect(() => parseCertificate(leaf, ["rsa"])).toThrow(
      /rsa signature algorithm parameters/,
    );
  });

  describe("modulus range and exponent", () => {
    const withSpki = async (spki: Uint8Array) =>
      makeCert({
        subject: "x",
        issuer: "x",
        key: { rsa: true, bits: 0, keys: c.leafKey.keys, spki },
        signer: c.leafKey,
        notBefore: AT - 1000,
        notAfter: AT + 1000,
        ca: false,
      });

    it("accepts exactly 2048 to 8192 bits", async () => {
      for (const bits of [2048, 3072, 4096, 8192]) {
        const cert = parseCertificate(await withSpki(syntheticRsaSpki(bits)), [
          "rsa",
        ]);
        expect(cert.rsa?.modulusBits).toBe(bits);
      }
    });

    it("refuses 1024, 2047, 8193 and 16384 bits", async () => {
      for (const bits of [512, 1024, 2047, 8193, 16384]) {
        const der = await withSpki(syntheticRsaSpki(bits));
        expect(() => parseCertificate(der, ["rsa"])).toThrow(
          /rsa modulus size/,
        );
      }
    });

    it("refuses a small, an even and an oversized public exponent", async () => {
      for (const e of [
        [3],
        [1, 0, 0],
        [1, 0, 0, 0, 1],
        [0xff, 0xff, 0xff, 0xff, 0xff],
      ]) {
        const der = await withSpki(syntheticRsaSpki(2048, e));
        expect(() => parseCertificate(der, ["rsa"])).toThrow(/rsa exponent/);
      }
    });

    it("refuses a real 1024-bit key", async () => {
      const k = await rsaTestKey(1024);
      const cert = await makeCert({
        subject: "x",
        issuer: "x",
        key: k,
        signer: k,
        notBefore: AT - 1000,
        notAfter: AT + 1000,
        ca: false,
      });
      expect(() => parseCertificate(cert, ["rsa"])).toThrow(/rsa modulus size/);
    });
  });
});

describe("x509 subject attributes", () => {
  it("reads O, CN and OU, in order, across RDNs", async () => {
    const k = await rsaTestKey();
    const der = await makeCert({
      subject: "Apple Inc.",
      subjectExtra: [
        [OID.organization, "Apple Inc."],
        [OID.organizationalUnit, "one", 0x13],
        [OID.organizationalUnit, "two"],
      ],
      issuer: "i",
      key: k,
      signer: k,
      notBefore: AT - 1000,
      notAfter: AT + 1000,
      ca: false,
    });
    const cert = parseCertificate(der, ["rsa"]);
    expect(subjectAttributes(cert, OID.commonName)).toEqual(["Apple Inc."]);
    expect(subjectAttributes(cert, OID.organization)).toEqual(["Apple Inc."]);
    expect(subjectAttributes(cert, OID.organizationalUnit)).toEqual([
      "one",
      "two",
    ]);
    expect(subjectAttributes(cert, "2.5.4.6")).toEqual([]);
  });

  it("refuses an unsupported string type and a control character, rather than skipping", async () => {
    const k = await rsaTestKey();
    const mk = (extra: [string, string, number?][]) =>
      makeCert({
        subject: "Apple Inc.",
        subjectExtra: extra,
        issuer: "i",
        key: k,
        signer: k,
        notBefore: AT - 1000,
        notAfter: AT + 1000,
        ca: false,
      });
    const bmp = parseCertificate(await mk([[OID.organization, "ab", 0x1e]]), [
      "rsa",
    ]);
    expect(() => subjectAttributes(bmp, OID.organization)).toThrow(X509Error);
    // The same cert still reads the attributes it can.
    expect(subjectAttributes(bmp, OID.commonName)).toEqual(["Apple Inc."]);
    const nul = parseCertificate(
      await mk([[OID.organization, "Apple Inc.\u0000.evil"]]),
      ["rsa"],
    );
    expect(() => subjectAttributes(nul, OID.organization)).toThrow(
      /control character/,
    );
  });
});

describe("x509 RSA: the real Game Center chain", () => {
  const dir = join(TEST_ROOT, "fixtures", "gamecenter");
  const read = (f: string) => new Uint8Array(readFileSync(join(dir, f)));
  const leaf = read("gc-prod-12.der");
  const ca1 = read("digicert-g4-codesigning-ca1.der");
  const root = read("digicert-trusted-root-g4.der");
  // Inside gc-prod-12's validity (2026-03-17 to 2027-05-27) and every CA's.
  const NOW = Date.UTC(2026, 9, 28) / 1000;
  const policy = (extra: Partial<ChainPolicy> = {}): ChainPolicy => ({
    roots: [root],
    at: NOW,
    length: 3,
    algorithms: ["rsa"],
    leafDigitalSignature: "require",
    leafExtendedKeyUsage: OID.codeSigning,
    ...extra,
  });

  it("verifies leaf <- CA1 <- Root G4 at a fixed instant", async () => {
    const v = await verifyChain([leaf, ca1, root], policy());
    expect(v.leaf.keyType).toBe("rsa");
    expect(v.leaf.rsa).toEqual({ modulusBits: 4096, exponent: 65537 });
    expect(v.chain.map((c) => c.signatureAlgorithm)).toEqual([
      OID.rsaSha256,
      OID.rsaSha384,
      OID.rsaSha384,
    ]);
    expect(v.leaf.extendedKeyUsage).toEqual([OID.codeSigning]);
    expect(subjectAttributes(v.leaf, OID.commonName)).toEqual(["Apple Inc."]);
    expect(subjectAttributes(v.leaf, OID.organization)).toEqual(["Apple Inc."]);
    expect(subjectAttributes(v.leaf, OID.organizationalUnit)).toHaveLength(1);
    expect(v.chain[1]!.pathLen).toBe(0);
  });

  it("the existing ECDSA-only default refuses it", async () => {
    const { algorithms: _a, ...def } = policy();
    expect(await reason(verifyChain([leaf, ca1, root], def))).toBe(
      "signature algorithm not allowed",
    );
  });

  it("refuses the leaf before it is valid and after it expires", async () => {
    const before = Date.UTC(2026, 2, 16) / 1000;
    const after = Date.UTC(2027, 5, 1) / 1000;
    for (const at of [before, after])
      expect(await reason(verifyChain([leaf, ca1, root], policy({ at })))).toBe(
        "certificate not valid now",
      );
  });

  it("refuses a different pinned root, a skipped CA1 and a wrong purpose", async () => {
    const e = await makeRsaChain({ at: NOW });
    expect(
      await reason(verifyChain([leaf, ca1, root], policy({ roots: [e.root] }))),
    ).toBe("untrusted root");
    expect(
      await reason(verifyChain([leaf, root], policy({ length: undefined }))),
    ).toBe("issuer mismatch");
    expect(
      await reason(
        verifyChain(
          [leaf, ca1, root],
          policy({ leafExtendedKeyUsage: "1.3.6.1.5.5.7.3.1" }),
        ),
      ),
    ).toBe("leaf extended key usage");
  });

  it("refuses a tampered leaf and a leaf signed under another CA", async () => {
    const bad = leaf.slice();
    bad[bad.length - 20]! ^= 0x01;
    expect(await reason(verifyChain([bad, ca1, root], policy()))).toBe(
      "bad certificate signature",
    );
    // Root G4 stands in for CA1: the names do not link.
    expect(await reason(verifyChain([leaf, root, root], policy()))).toBe(
      "issuer mismatch",
    );
  });
});
