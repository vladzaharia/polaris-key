/// <reference types="@cloudflare/workers-types" />

/**
 * A small X.509 chain verifier for workerd (P6-01; P6-02 reuses it for App Attest).
 *
 * There is no Workers-native App Store Server Library (notes/E1 §F1), and workerd forbids runtime
 * code generation, so this is a plain interpreter over DER with WebCrypto doing every signature
 * check. It verifies exactly what a pinned-root chain needs and nothing more:
 *
 *   - **DER only, strictly.** Definite lengths, minimal length encodings, no trailing bytes at any
 *     level we read; the optional TBS fields at most once and in order, exactly one SEQUENCE in
 *     `[3]`, no element after an Extension's extnValue; BOOLEANs one byte (0x00/0xff) and DEFAULT
 *     FALSE never encoded (an Extension's `critical`, basicConstraints' `cA`); every time field in
 *     range. A malformed certificate is a refusal, never a best effort.
 *   - **The root is pinned by bytes.** The last certificate of the chain must be byte-identical to
 *     one of the caller's roots; a self-signed look-alike with the same name is just another
 *     certificate. Roots are passed in by the caller (Apple Root CA - G3 for the App Store), never
 *     read from the chain.
 *   - **Each link** — certificate `i`'s issuer name equals certificate `i+1`'s subject name (raw
 *     DER), `i+1` is a CA (basicConstraints `cA`, its `pathLenConstraint` respected, `keyCertSign`
 *     when keyUsage is present), and `i`'s signature verifies under `i+1`'s key with the algorithm
 *     `i` names (inner and outer algorithm identifiers must agree).
 *   - **Validity** — every certificate is within `notBefore`…`notAfter` at the instant given.
 *   - **Critical extensions** — any critical extension other than basicConstraints and keyUsage
 *     refuses the chain (RFC 5280 §4.2), unless the caller lists it as understood.
 *   - **Required OIDs** — the caller may require extension OIDs on the leaf and on the
 *     intermediates (Apple's App Store receipt-signing marker `1.2.840.113635.100.6.11.1` on the
 *     leaf and the WWDR marker `1.2.840.113635.100.6.2.1` on the intermediate).
 *
 * API (P6-02 reuses it): `parseCertificate` (every field above, keyUsage's `keyCertSign` and
 * `digitalSignature`, all extensions by OID), `getExtension(cert, oid)`, and `verifyChain(chain,
 * policy)` answering the leaf, its key and the whole parsed chain — `policy.understood` lists the
 * caller's known critical extension OIDs, `policy.leafDigitalSignature` the leaf's signing use.
 *
 * Algorithms: a caller names the families it accepts in `policy.algorithms` (default
 * `["ecdsa"]`: ECDSA on P-256 and P-384 with SHA-256 or SHA-384, what Apple's App Store and App
 * Attest chains use). `"rsa"` adds RSASSA-PKCS1-v1_5 with SHA-256, SHA-384 or SHA-512 and a
 * 2048 to 8192 bit modulus (Game Center's DigiCert chain). A certificate whose key or signature
 * is outside the policy refuses; SHA-1 and MD5 signatures never verify. The RSA signature check
 * is WebCrypto's, which compares the whole encoded digest (no lenient padding parse here).
 * No revocation check is made (Apple's library makes OCSP optional too); a revoked Apple
 * intermediate is an Apple-side emergency handled by re-pinning (THREAT-MODEL.md, the commerce
 * section).
 */

import { toArrayBuffer } from "../../platform/bytes.js";

// ── DER ──────────────────────────────────────────────────────────────────────────────────────

/** One DER TLV. `der` is the whole element (tag, length and value); `value` the contents. */
export interface DerNode {
  tag: number;
  der: Uint8Array;
  value: Uint8Array;
}

export class X509Error extends Error {
  constructor(readonly reason: string) {
    super(`x509: ${reason}`);
    this.name = "X509Error";
  }
}

const fail = (reason: string): never => {
  throw new X509Error(reason);
};

/** Read the TLV starting at `offset`. Multi-byte tags and indefinite lengths are refused. */
export function readDer(buf: Uint8Array, offset = 0): DerNode {
  if (offset + 2 > buf.length) fail("truncated");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) fail("multi-byte tag");
  let len = buf[offset + 1]!;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) fail("bad length");
    if (offset + 2 + n > buf.length) fail("truncated");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    // Minimal encoding: the long form only for >= 128, and no leading zero byte.
    if (len < 0x80 || buf[offset + 2] === 0) fail("non-minimal length");
    header = 2 + n;
  }
  const end = offset + header + len;
  if (end > buf.length) fail("truncated");
  return {
    tag,
    der: buf.subarray(offset, end),
    value: buf.subarray(offset + header, end),
  };
}

/** The whole buffer as exactly one TLV. */
export function readDerExact(buf: Uint8Array): DerNode {
  const node = readDer(buf, 0);
  if (node.der.length !== buf.length) fail("trailing bytes");
  return node;
}

/** The elements of a constructed node, which must consume its value exactly. */
export function derChildren(node: DerNode): DerNode[] {
  if (!(node.tag & 0x20)) fail("not constructed");
  const out: DerNode[] = [];
  let at = 0;
  while (at < node.value.length) {
    const child = readDer(node.value, at);
    out.push(child);
    at += child.der.length;
  }
  return out;
}

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_NULL = 0x05;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

/** A DER BOOLEAN: exactly one byte, 0x00 or 0xff. */
function derBoolean(node: DerNode): boolean {
  if (node.tag !== TAG_BOOLEAN || node.value.length !== 1) fail("bad boolean");
  const v = node.value[0];
  if (v !== 0x00 && v !== 0xff) fail("bad boolean");
  return v === 0xff;
}

function expect(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (!node || node.tag !== tag) fail(`expected ${what}`);
  return node!;
}

/** Dotted-decimal OID from its DER contents. */
export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) fail("empty oid");
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < value.length; i++) {
    const b = value[i]!;
    if (acc === 0 && b === 0x80) fail("non-minimal oid");
    acc = acc * 128 + (b & 0x7f);
    if (acc > Number.MAX_SAFE_INTEGER / 128) fail("oid arc too large");
    if (!(b & 0x80)) {
      parts.push(acc);
      acc = 0;
    }
  }
  if (value[value.length - 1]! & 0x80) fail("truncated oid");
  const first = parts.shift()!;
  const head =
    first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...parts].join(".");
}

/** A BIT STRING's bytes; only whole-byte strings (no unused bits) are accepted where a key or a
 *  signature is expected. */
function bitStringBytes(
  node: DerNode,
  allowUnused = false,
): { bytes: Uint8Array; unused: number } {
  if (node.tag !== TAG_BIT_STRING || node.value.length === 0)
    fail("expected bit string");
  const unused = node.value[0]!;
  if (unused > 7 || (!allowUnused && unused !== 0))
    fail("bit string with unused bits");
  return { bytes: node.value.subarray(1), unused };
}

function parseTime(node: DerNode): number {
  const s = new TextDecoder().decode(node.value);
  let m: RegExpMatchArray | null;
  let year: number;
  if (node.tag === TAG_UTC_TIME) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return fail("bad UTCTime");
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (node.tag === TAG_GENERALIZED_TIME) {
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) return fail("bad GeneralizedTime");
    year = Number(m[1]);
  } else return fail("expected time");
  const [month, day, hour, minute, second] = [2, 3, 4, 5, 6].map((k) =>
    Number(m![k]),
  ) as [number, number, number, number, number];
  // Every field in range: Date.UTC would silently roll month 13 or second 60 into the next unit.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    fail("time out of range");
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) fail("bad time");
  return Math.floor(ms / 1000);
}

// ── Certificates ─────────────────────────────────────────────────────────────────────────────

export const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsaSha256: "1.2.840.113549.1.1.11",
  rsaSha384: "1.2.840.113549.1.1.12",
  rsaSha512: "1.2.840.113549.1.1.13",
  extKeyUsage: "2.5.29.37",
  codeSigning: "1.3.6.1.5.5.7.3.3",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  organizationalUnit: "2.5.4.11",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
} as const;

export interface X509Extension {
  critical: boolean;
  /** The extnValue OCTET STRING's contents. */
  value: Uint8Array;
}

export interface X509Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  /** The outer signature algorithm OID. */
  signatureAlgorithm: string;
  /** The signature BIT STRING's bytes: a DER ECDSA-Sig-Value, or the RSA signature. */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The whole SubjectPublicKeyInfo, as WebCrypto imports it. */
  spki: Uint8Array;
  /** The key family: ECDSA (with `curve`) or RSA (with `rsa`). */
  keyType: "ecdsa" | "rsa";
  /** The EC curve; `null` for an RSA key (never null under the default ECDSA-only policy). */
  curve: "P-256" | "P-384" | null;
  /** The RSA modulus size in bits and the public exponent; `null` for an EC key. */
  rsa: { modulusBits: number; exponent: number } | null;
  extensions: Map<string, X509Extension>;
  /** basicConstraints: `ca` and `pathLen` (null = unlimited / absent). */
  ca: boolean;
  pathLen: number | null;
  /** keyUsage bit 5 (keyCertSign); `null` when the extension is absent. */
  keyCertSign: boolean | null;
  /** keyUsage bit 0 (digitalSignature); `null` when the extension is absent. */
  digitalSignature: boolean | null;
  /** The extendedKeyUsage purposes (dotted OIDs); `null` when the extension is absent. */
  extendedKeyUsage: string[] | null;
}

export type KeyAlgorithm = "ecdsa" | "rsa";

/** The RSA key sizes accepted, in bits (the modulus's exact bit length). */
export const RSA_MIN_BITS = 2048;
export const RSA_MAX_BITS = 8192;

const RSA_HASH: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  [OID.rsaSha256]: "SHA-256",
  [OID.rsaSha384]: "SHA-384",
  [OID.rsaSha512]: "SHA-512",
};

function algorithmOid(node: DerNode): string {
  const parts = derChildren(expect(node, TAG_SEQUENCE, "algorithm"));
  const oid = decodeOid(expect(parts[0], TAG_OID, "algorithm oid").value);
  // ECDSA identifiers carry no parameters (RFC 5758 §3.2).
  if (
    (oid === OID.ecdsaSha256 || oid === OID.ecdsaSha384) &&
    parts.length !== 1
  )
    fail("ecdsa algorithm with parameters");
  // RSASSA-PKCS1-v1_5 identifiers carry an explicit NULL (RFC 4055 §5).
  if (oid in RSA_HASH && (parts.length !== 2 || !isNull(parts[1]!)))
    fail("rsa signature algorithm parameters");
  return oid;
}

const isNull = (n: DerNode): boolean =>
  n.tag === TAG_NULL && n.value.length === 0;

/** An RSAPublicKey (RFC 8017 A.1.1): a minimal positive odd modulus of 2048 to 8192 bits and a
 *  minimal odd exponent of at least 65537 that fits 32 bits. */
function parseRsaPublicKey(bytes: Uint8Array): {
  modulusBits: number;
  exponent: number;
} {
  const parts = derChildren(
    expect(readDerExact(bytes), TAG_SEQUENCE, "rsa public key"),
  );
  if (parts.length !== 2) fail("rsa public key shape");
  const posInt = (n: DerNode | undefined, what: string): Uint8Array => {
    const v = expect(n, TAG_INTEGER, what).value;
    if (v.length === 0 || v[0]! & 0x80) fail(`negative ${what}`);
    if (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80))
      fail(`non-minimal ${what}`);
    return v[0] === 0 ? v.subarray(1) : v;
  };
  const n = posInt(parts[0], "rsa modulus");
  const e = posInt(parts[1], "rsa exponent");
  if (n.length === 0 || n[0] === 0) fail("rsa modulus");
  const modulusBits = (n.length - 1) * 8 + (32 - Math.clz32(n[0]!));
  if (modulusBits < RSA_MIN_BITS || modulusBits > RSA_MAX_BITS)
    fail("rsa modulus size");
  if (!(n[n.length - 1]! & 1)) fail("rsa modulus is even");
  if (e.length === 0 || e.length > 4 || !(e[e.length - 1]! & 1))
    fail("rsa exponent");
  const exponent = e.reduce((a, b) => a * 256 + b, 0);
  if (exponent < 65537) fail("rsa exponent too small");
  return { modulusBits, exponent };
}

/** Parse one DER certificate. Throws `X509Error` on anything it does not accept. `algorithms`
 *  (default ECDSA only) names the key and signature families allowed. */
export function parseCertificate(
  der: Uint8Array,
  algorithms: readonly KeyAlgorithm[] = ["ecdsa"],
): X509Certificate {
  const allowEc = algorithms.includes("ecdsa");
  const allowRsa = algorithms.includes("rsa");
  const cert = derChildren(
    expect(readDerExact(der), TAG_SEQUENCE, "certificate"),
  );
  if (cert.length !== 3) fail("certificate shape");
  const tbsNode = expect(cert[0], TAG_SEQUENCE, "tbsCertificate");
  const signatureAlgorithm = algorithmOid(cert[1]!);
  const sigFamily: KeyAlgorithm | null =
    signatureAlgorithm === OID.ecdsaSha256 ||
    signatureAlgorithm === OID.ecdsaSha384
      ? "ecdsa"
      : signatureAlgorithm in RSA_HASH
        ? "rsa"
        : null;
  if (sigFamily === null) fail("unsupported signature algorithm");
  if (sigFamily === "ecdsa" ? !allowEc : !allowRsa)
    fail("signature algorithm not allowed");
  const signature = bitStringBytes(cert[2]!).bytes;

  const tbs = derChildren(tbsNode);
  let i = 0;
  // [0] EXPLICIT Version — v3 is required (extensions carry everything we check).
  const versionNode = tbs[i];
  if (!versionNode || versionNode.tag !== 0xa0) fail("not a v3 certificate");
  const versionParts = derChildren(versionNode!);
  if (versionParts.length !== 1) fail("version wrapper shape");
  const version = expect(versionParts[0], TAG_INTEGER, "version");
  if (version.value.length !== 1 || version.value[0] !== 2)
    fail("not a v3 certificate");
  i++;
  expect(tbs[i++], TAG_INTEGER, "serial");
  const innerAlg = algorithmOid(tbs[i++]!);
  if (innerAlg !== signatureAlgorithm) fail("signature algorithm mismatch");
  const issuer = expect(tbs[i++], TAG_SEQUENCE, "issuer").der;
  const validity = derChildren(expect(tbs[i++], TAG_SEQUENCE, "validity"));
  if (validity.length !== 2) fail("validity shape");
  const notBefore = parseTime(validity[0]!);
  const notAfter = parseTime(validity[1]!);
  const subject = expect(tbs[i++], TAG_SEQUENCE, "subject").der;
  const spkiNode = expect(tbs[i++], TAG_SEQUENCE, "subjectPublicKeyInfo");
  const spkiParts = derChildren(spkiNode);
  if (spkiParts.length !== 2) fail("spki shape");
  const keyAlg = derChildren(
    expect(spkiParts[0], TAG_SEQUENCE, "key algorithm"),
  );
  const keyOid = decodeOid(expect(keyAlg[0], TAG_OID, "key oid").value);
  let keyType: "ecdsa" | "rsa";
  let curve: "P-256" | "P-384" | null = null;
  let rsa: { modulusBits: number; exponent: number } | null = null;
  if (keyOid === OID.ecPublicKey && allowEc) {
    keyType = "ecdsa";
    if (keyAlg.length !== 2) fail("ec key algorithm shape");
    const curveOid = decodeOid(expect(keyAlg[1], TAG_OID, "curve").value);
    curve =
      curveOid === OID.p256
        ? "P-256"
        : curveOid === OID.p384
          ? "P-384"
          : fail("unsupported curve");
    bitStringBytes(spkiParts[1]!);
  } else if (keyOid === OID.rsaEncryption && allowRsa) {
    keyType = "rsa";
    if (keyAlg.length !== 2 || !isNull(keyAlg[1]!))
      fail("rsa key algorithm parameters");
    rsa = parseRsaPublicKey(bitStringBytes(spkiParts[1]!).bytes);
  } else return fail("unsupported key type");

  const extensions = new Map<string, X509Extension>();
  // The optional trailing fields, each at most once and in order: [1] issuerUniqueID, [2]
  // subjectUniqueID, [3] extensions (EXPLICIT, exactly one SEQUENCE inside). Anything else, a
  // repeat or a field out of order refuses the certificate.
  const order = [0x81, 0x82, 0xa3];
  let last = -1;
  for (; i < tbs.length; i++) {
    const node = tbs[i]!;
    const at = order.indexOf(node.tag);
    if (at < 0) fail("unexpected tbs field");
    if (at <= last) fail("repeated or misordered tbs field");
    last = at;
    if (node.tag !== 0xa3) continue; // issuer/subject unique ids
    const wrapped = derChildren(node);
    if (wrapped.length !== 1) fail("extensions wrapper shape");
    const list = derChildren(expect(wrapped[0], TAG_SEQUENCE, "extensions"));
    if (list.length === 0) fail("empty extensions");
    for (const ext of list) {
      const parts = derChildren(expect(ext, TAG_SEQUENCE, "extension"));
      const oid = decodeOid(expect(parts[0], TAG_OID, "extension oid").value);
      let critical = false;
      let k = 1;
      if (parts[k]?.tag === TAG_BOOLEAN) {
        critical = derBoolean(parts[k]!);
        // DER: DEFAULT FALSE is never encoded.
        if (!critical) fail("encoded default");
        k++;
      }
      const value = expect(parts[k], TAG_OCTET_STRING, "extnValue").value;
      if (k + 1 !== parts.length) fail("trailing extension element");
      if (extensions.has(oid)) fail("duplicate extension");
      extensions.set(oid, { critical, value });
    }
  }

  let ca = false;
  let pathLen: number | null = null;
  const bc = extensions.get(OID.basicConstraints);
  if (bc) {
    const parts = derChildren(
      expect(readDerExact(bc.value), TAG_SEQUENCE, "basicConstraints"),
    );
    let j = 0;
    if (parts[j]?.tag === TAG_BOOLEAN) {
      ca = derBoolean(parts[j]!);
      // DER: cA DEFAULT FALSE is never encoded.
      if (!ca) fail("encoded default");
      j++;
    }
    if (parts[j]?.tag === TAG_INTEGER) {
      const v = parts[j]!.value;
      if (v.length !== 1 || v[0]! > 0x7f) fail("bad pathLen");
      pathLen = v[0]!;
      j++;
    }
    if (j !== parts.length) fail("basicConstraints shape");
  }
  let keyCertSign: boolean | null = null;
  let digitalSignature: boolean | null = null;
  const ku = extensions.get(OID.keyUsage);
  if (ku) {
    const { bytes } = bitStringBytes(readDerExact(ku.value), true);
    keyCertSign = bytes.length > 0 && (bytes[0]! & 0x04) !== 0;
    digitalSignature = bytes.length > 0 && (bytes[0]! & 0x80) !== 0;
  }

  let extendedKeyUsage: string[] | null = null;
  const eku = extensions.get(OID.extKeyUsage);
  if (eku) {
    const purposes = derChildren(
      expect(readDerExact(eku.value), TAG_SEQUENCE, "extKeyUsage"),
    );
    if (purposes.length === 0) fail("empty extKeyUsage");
    extendedKeyUsage = purposes.map((p) =>
      decodeOid(expect(p, TAG_OID, "key purpose").value),
    );
  }

  return {
    der,
    tbs: tbsNode.der,
    signatureAlgorithm,
    signature,
    issuer,
    subject,
    notBefore,
    notAfter,
    spki: spkiNode.der,
    keyType,
    curve,
    rsa,
    extensions,
    ca,
    pathLen,
    keyCertSign,
    digitalSignature,
    extendedKeyUsage,
  };
}

/**
 * Every value of the subject's attribute `oid` (`OID.commonName`, `OID.organization`,
 * `OID.organizationalUnit`), in order. Only UTF8String, PrintableString and IA5String values are
 * read, and a control character in one refuses; any other string type under the OID refuses
 * rather than being skipped. No match answers `[]`: callers compare for exact equality.
 */
export function subjectAttributes(
  cert: X509Certificate,
  oid: string,
): string[] {
  const out: string[] = [];
  for (const rdn of derChildren(
    expect(readDerExact(cert.subject), TAG_SEQUENCE, "name"),
  )) {
    for (const atv of derChildren(expect(rdn, TAG_SET, "rdn"))) {
      const parts = derChildren(expect(atv, TAG_SEQUENCE, "attribute"));
      if (parts.length !== 2) fail("attribute shape");
      if (decodeOid(expect(parts[0], TAG_OID, "attribute oid").value) !== oid)
        continue;
      const v = parts[1]!;
      if (v.tag !== 0x0c && v.tag !== 0x13 && v.tag !== 0x16)
        fail("unsupported attribute string type");
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(v.value);
      } catch {
        return fail("bad attribute string");
      }
      // No C0 control characters or DEL (an embedded NUL must not truncate a comparison).
      for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c < 0x20 || c === 0x7f) fail("control character in attribute");
      }
      out.push(text);
    }
  }
  return out;
}

// ── Signatures ───────────────────────────────────────────────────────────────────────────────

/** A DER ECDSA-Sig-Value as the raw `r || s` WebCrypto verifies, each half `size` bytes. */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
  const parts = derChildren(
    expect(readDerExact(der), TAG_SEQUENCE, "ecdsa signature"),
  );
  if (parts.length !== 2) fail("ecdsa signature shape");
  const out = new Uint8Array(size * 2);
  parts.forEach((p, k) => {
    let v = expect(p, TAG_INTEGER, "ecdsa integer").value;
    if (v.length === 0 || v[0]! & 0x80) fail("negative ecdsa integer");
    if (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80))
      fail("non-minimal ecdsa integer");
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail("ecdsa integer too large");
    out.set(v, k * size + (size - v.length));
  });
  return out;
}

/** The certificate's public key as a WebCrypto ECDSA verify key. */
export async function certificateKey(
  cert: X509Certificate,
): Promise<CryptoKey> {
  // A key that is not a valid curve point makes WebCrypto throw a DataError; that is a
  // refused certificate, not a crash.
  if (cert.keyType !== "ecdsa" || !cert.curve) return fail("not an ec key");
  try {
    return await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(cert.spki),
      { name: "ECDSA", namedCurve: cert.curve },
      false,
      ["verify"],
    );
  } catch {
    return fail("invalid public key");
  }
}

async function signedBy(
  child: X509Certificate,
  issuer: X509Certificate,
): Promise<boolean> {
  const rsaHash = RSA_HASH[child.signatureAlgorithm];
  if (rsaHash) {
    // An RSA signature needs an RSA issuer key, and is exactly one modulus long.
    if (issuer.keyType !== "rsa" || !issuer.rsa) return fail("issuer key type");
    if (child.signature.length !== Math.ceil(issuer.rsa.modulusBits / 8))
      return fail("rsa signature length");
    const key = await rsaCertificateKey(issuer, rsaHash);
    try {
      return await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        toArrayBuffer(child.signature),
        toArrayBuffer(child.tbs),
      );
    } catch {
      return fail("bad certificate signature");
    }
  }
  const hash =
    child.signatureAlgorithm === OID.ecdsaSha256
      ? "SHA-256"
      : child.signatureAlgorithm === OID.ecdsaSha384
        ? "SHA-384"
        : fail("unsupported signature algorithm");
  if (issuer.keyType !== "ecdsa" || !issuer.curve)
    return fail("issuer key type");
  const raw = ecdsaDerToRaw(
    child.signature,
    issuer.curve === "P-256" ? 32 : 48,
  );
  const key = await certificateKey(issuer);
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      toArrayBuffer(raw),
      toArrayBuffer(child.tbs),
    );
  } catch {
    return fail("bad certificate signature");
  }
}

/** The certificate's RSA public key as a WebCrypto RSASSA-PKCS1-v1_5 verify key for `hash`. */
export async function rsaCertificateKey(
  cert: X509Certificate,
  hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256",
): Promise<CryptoKey> {
  if (cert.keyType !== "rsa") return fail("not an rsa key");
  try {
    return await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(cert.spki),
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
  } catch {
    return fail("invalid public key");
  }
}

// ── Chains ───────────────────────────────────────────────────────────────────────────────────

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, k) => v === b[k]);

export interface ChainPolicy {
  /** DER of every trusted root. The chain's last certificate must equal one byte for byte. */
  roots: readonly Uint8Array[];
  /** Epoch seconds every certificate must be valid at. */
  at: number;
  /** Extension OIDs the leaf must carry. */
  leafOids?: readonly string[];
  /** Extension OIDs every intermediate (between leaf and root) must carry. */
  intermediateOids?: readonly string[];
  /** Exact chain length (Apple: 3). */
  length?: number;
  /** Critical extension OIDs the caller understands beyond basicConstraints and keyUsage (any
   *  other critical extension refuses the chain). */
  understood?: readonly string[];
  /**
   * The leaf signs (a JWS, an attestation): when `"require"`, its keyUsage must be present and
   * include digitalSignature; when `"ifPresent"`, a keyUsage that is present must include it.
   * Absent = not checked.
   */
  leafDigitalSignature?: "require" | "ifPresent";
  /** Key and signature families the chain may use, every certificate included. Default
   *  `["ecdsa"]`, which leaves existing callers as they were; `"rsa"` is opt-in. */
  algorithms?: readonly KeyAlgorithm[];
  /** An extendedKeyUsage purpose OID the leaf must list (exact; anyExtendedKeyUsage does not
   *  satisfy it). Setting it also lets the leaf mark that extension critical. */
  leafExtendedKeyUsage?: string;
  /** The hash the returned leaf key is imported for when the leaf is RSA (default SHA-256). */
  leafRsaHash?: "SHA-256" | "SHA-384" | "SHA-512";
}

/** One extension's DER value (the extnValue contents) and criticality, or `null`. */
export function getExtension(
  cert: X509Certificate,
  oid: string,
): X509Extension | null {
  return cert.extensions.get(oid) ?? null;
}

/**
 * Verify `chain` (leaf first, root last, DER each) under `policy`. Answers the parsed leaf and
 * its public key; throws `X509Error` with the first failing check's reason.
 */
export async function verifyChain(
  chain: readonly Uint8Array[],
  policy: ChainPolicy,
): Promise<{
  leaf: X509Certificate;
  key: CryptoKey;
  /** Every certificate, parsed, leaf first. */
  chain: X509Certificate[];
}> {
  if (chain.length < 2) fail("chain too short");
  if (chain.length > 5) fail("chain too long");
  if (policy.length !== undefined && chain.length !== policy.length)
    fail("chain length");
  const last = chain[chain.length - 1]!;
  if (!policy.roots.some((r) => equalBytes(r, last))) fail("untrusted root");
  const algorithms = policy.algorithms ?? ["ecdsa"];
  const certs = chain.map((c) => parseCertificate(c, algorithms));
  const understood = new Set([
    OID.basicConstraints,
    OID.keyUsage,
    ...(policy.understood ?? []),
  ]);
  for (const [k, c] of certs.entries()) {
    if (policy.at < c.notBefore || policy.at > c.notAfter)
      fail("certificate not valid now");
    for (const [oid, ext] of c.extensions)
      if (
        ext.critical &&
        !understood.has(oid) &&
        !(k === 0 && oid === OID.extKeyUsage && policy.leafExtendedKeyUsage)
      )
        fail("unknown critical extension");
    if (k > 0 && k < certs.length - 1)
      for (const oid of policy.intermediateOids ?? [])
        if (!c.extensions.has(oid)) fail("intermediate oid missing");
  }
  for (const oid of policy.leafOids ?? [])
    if (!certs[0]!.extensions.has(oid)) fail("leaf oid missing");
  if (
    policy.leafExtendedKeyUsage !== undefined &&
    !certs[0]!.extendedKeyUsage?.includes(policy.leafExtendedKeyUsage)
  )
    fail("leaf extended key usage");
  const leafDs = certs[0]!.digitalSignature;
  if (
    (policy.leafDigitalSignature === "require" && leafDs !== true) ||
    (policy.leafDigitalSignature === "ifPresent" && leafDs === false)
  )
    fail("leaf may not sign");
  for (let k = 0; k < certs.length - 1; k++) {
    const child = certs[k]!;
    const issuer = certs[k + 1]!;
    if (!equalBytes(child.issuer, issuer.subject)) fail("issuer mismatch");
    if (!issuer.ca) fail("issuer is not a CA");
    if (issuer.keyCertSign === false) fail("issuer may not sign certificates");
    // pathLen counts the CA certificates BELOW the issuer (not the leaf).
    if (issuer.pathLen !== null && k > issuer.pathLen)
      fail("path length exceeded");
    if (!(await signedBy(child, issuer))) fail("bad certificate signature");
  }
  // The root is trusted by bytes, but it must still be the self-issued anchor it claims to be.
  const root = certs[certs.length - 1]!;
  if (!equalBytes(root.issuer, root.subject)) fail("root is not self-issued");
  if (certs[0]!.ca && certs.length > 1) fail("leaf is a CA");
  return {
    leaf: certs[0]!,
    key:
      certs[0]!.keyType === "rsa"
        ? await rsaCertificateKey(certs[0]!, policy.leafRsaHash)
        : await certificateKey(certs[0]!),
    chain: certs,
  };
}

/** Standard (not URL-safe) base64 — `x5c` entries — to bytes; throws `X509Error` on bad input. */
export function base64ToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0)
    fail("bad base64");
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return fail("bad base64");
  }
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}
