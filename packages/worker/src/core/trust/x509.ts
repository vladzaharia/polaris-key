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
 * Algorithms: ECDSA on P-256 and P-384 with SHA-256 or SHA-384 — what Apple's App Store and App
 * Attest chains use. RSA is not supported (no caller needs it); a certificate using it refuses.
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
const TAG_SEQUENCE = 0x30;

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
  /** The DER ECDSA-Sig-Value from the signature BIT STRING. */
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The whole SubjectPublicKeyInfo, as WebCrypto imports it. */
  spki: Uint8Array;
  curve: "P-256" | "P-384";
  extensions: Map<string, X509Extension>;
  /** basicConstraints: `ca` and `pathLen` (null = unlimited / absent). */
  ca: boolean;
  pathLen: number | null;
  /** keyUsage bit 5 (keyCertSign); `null` when the extension is absent. */
  keyCertSign: boolean | null;
  /** keyUsage bit 0 (digitalSignature); `null` when the extension is absent. */
  digitalSignature: boolean | null;
}

function algorithmOid(node: DerNode): string {
  const parts = derChildren(expect(node, TAG_SEQUENCE, "algorithm"));
  const oid = decodeOid(expect(parts[0], TAG_OID, "algorithm oid").value);
  // ECDSA identifiers carry no parameters (RFC 5758 §3.2).
  if (
    (oid === OID.ecdsaSha256 || oid === OID.ecdsaSha384) &&
    parts.length !== 1
  )
    fail("ecdsa algorithm with parameters");
  return oid;
}

/** Parse one DER certificate. Throws `X509Error` on anything it does not accept. */
export function parseCertificate(der: Uint8Array): X509Certificate {
  const cert = derChildren(
    expect(readDerExact(der), TAG_SEQUENCE, "certificate"),
  );
  if (cert.length !== 3) fail("certificate shape");
  const tbsNode = expect(cert[0], TAG_SEQUENCE, "tbsCertificate");
  const signatureAlgorithm = algorithmOid(cert[1]!);
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
  if (
    decodeOid(expect(keyAlg[0], TAG_OID, "key oid").value) !== OID.ecPublicKey
  )
    fail("unsupported key type");
  const curveOid = decodeOid(expect(keyAlg[1], TAG_OID, "curve").value);
  const curve =
    curveOid === OID.p256
      ? "P-256"
      : curveOid === OID.p384
        ? "P-384"
        : fail("unsupported curve");
  bitStringBytes(spkiParts[1]!);

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
    curve,
    extensions,
    ca,
    pathLen,
    keyCertSign,
    digitalSignature,
  };
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
  const hash =
    child.signatureAlgorithm === OID.ecdsaSha256
      ? "SHA-256"
      : child.signatureAlgorithm === OID.ecdsaSha384
        ? "SHA-384"
        : fail("unsupported signature algorithm");
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
  const certs = chain.map(parseCertificate);
  const understood = new Set([
    OID.basicConstraints,
    OID.keyUsage,
    ...(policy.understood ?? []),
  ]);
  for (const [k, c] of certs.entries()) {
    if (policy.at < c.notBefore || policy.at > c.notAfter)
      fail("certificate not valid now");
    for (const [oid, ext] of c.extensions)
      if (ext.critical && !understood.has(oid))
        fail("unknown critical extension");
    if (k > 0 && k < certs.length - 1)
      for (const oid of policy.intermediateOids ?? [])
        if (!c.extensions.has(oid)) fail("intermediate oid missing");
  }
  for (const oid of policy.leafOids ?? [])
    if (!certs[0]!.extensions.has(oid)) fail("leaf oid missing");
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
    key: await certificateKey(certs[0]!),
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
