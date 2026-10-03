/**
 * A small X.509 reader and chain verifier over WebCrypto (P6-02; shared with P6-01's App Store
 * receipts, which `wp/P6-01-*.md` says reuse this module).
 *
 * The Worker verifies exactly one kind of chain today — an Apple-issued `x5c` chain ending at a
 * PINNED Apple root — and this module is sized for that job, not for the web PKI:
 *
 *   - DER only (an indefinite length, a high tag number or a long length over 4 bytes is refused);
 *   - ECDSA only: `id-ecPublicKey` keys on P-256 or P-384, signatures `ecdsa-with-SHA256` or
 *     `ecdsa-with-SHA384` (Apple's App Attestation Root CA and Apple Root CA - G3 are both P-384;
 *     their leaves are P-256). An RSA chain is refused, not mis-verified;
 *   - trust comes ONLY from the anchors the caller passes. There is no system store, no AIA
 *     fetching, no revocation (Apple's App Attest and App Store chains carry no CRL distribution
 *     point the Worker could act on — THREAT-MODEL.md records that), and no name constraints;
 *   - every certificate's validity window is checked against the caller's `now`; every issuer
 *     (intermediate or anchor) must assert `cA` in its basic constraints; an unrecognised
 *     CRITICAL extension fails the chain (RFC 5280 §4.2), so a certificate is never accepted for
 *     a purpose it restricts in a way this reader cannot see.
 *
 * Pure apart from `crypto.subtle`, so the same code runs in the Node lane and in workerd
 * (`test-workerd/attest.test.ts`), which forbids runtime code generation — no dependency here
 * evaluates code.
 */

// ── DER ───────────────────────────────────────────────────────────────────────────────────────

export class X509Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X509Error";
  }
}

/** One DER TLV: its tag byte, where its content sits, and its full encoding. */
export interface DerNode {
  /** The identifier octet (class, constructed bit and low tag number). */
  tag: number;
  /** The content octets. */
  value: Uint8Array;
  /** The whole TLV, header included — what a signature covers. */
  raw: Uint8Array;
}

const MAX_DER = 64 * 1024;

/** Read one TLV at `offset`; returns the node and the offset after it. */
export function readDer(
  buf: Uint8Array,
  offset = 0,
): { node: DerNode; next: number } {
  if (buf.length > MAX_DER) throw new X509Error("DER input too large");
  if (offset + 2 > buf.length) throw new X509Error("truncated DER");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f)
    throw new X509Error("high tag numbers unsupported");
  let pos = offset + 1;
  const first = buf[pos++]!;
  let len: number;
  if (first < 0x80) len = first;
  else {
    const n = first & 0x7f;
    if (n === 0) throw new X509Error("indefinite length");
    if (n > 4) throw new X509Error("length too long");
    if (pos + n > buf.length) throw new X509Error("truncated DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]!;
    // DER: the shortest form. A long form for a length under 128, or a leading zero, is BER.
    if (len < 0x80 || buf[pos - n] === 0)
      throw new X509Error("non-minimal DER length");
  }
  if (pos + len > buf.length) throw new X509Error("truncated DER value");
  return {
    node: {
      tag,
      value: buf.subarray(pos, pos + len),
      raw: buf.subarray(offset, pos + len),
    },
    next: pos + len,
  };
}

/** Parse exactly one TLV spanning all of `buf`. */
export function parseDer(buf: Uint8Array): DerNode {
  const { node, next } = readDer(buf, 0);
  if (next !== buf.length) throw new X509Error("trailing bytes after DER");
  return node;
}

/** The children of a constructed node. */
export function derChildren(node: DerNode): DerNode[] {
  if ((node.tag & 0x20) === 0) throw new X509Error("not a constructed node");
  const out: DerNode[] = [];
  let pos = 0;
  while (pos < node.value.length) {
    const { node: child, next } = readDer(node.value, pos);
    out.push(child);
    pos = next;
  }
  return out;
}

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
} as const;

function expectTag(
  node: DerNode | undefined,
  tag: number,
  what: string,
): DerNode {
  if (!node || node.tag !== tag) throw new X509Error(`expected ${what}`);
  return node;
}

/** A DER OBJECT IDENTIFIER's content as dotted decimal. */
export function decodeOid(value: Uint8Array): string {
  if (value.length === 0) throw new X509Error("empty OID");
  const parts: number[] = [];
  let acc = 0;
  for (let i = 0; i < value.length; i++) {
    const b = value[i]!;
    if (acc === 0 && b === 0x80) throw new X509Error("non-minimal OID");
    acc = acc * 128 + (b & 0x7f);
    if (acc > Number.MAX_SAFE_INTEGER) throw new X509Error("OID arc too large");
    if ((b & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    } else if (i === value.length - 1) throw new X509Error("truncated OID");
  }
  const first = parts[0]!;
  const head =
    first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...parts.slice(1)].join(".");
}

/** The content of a BIT STRING with no unused bits (keys and signatures always are). */
function bitStringBytes(node: DerNode): Uint8Array {
  expectTag(node, TAG.BIT_STRING, "BIT STRING");
  if (node.value.length < 1 || node.value[0] !== 0)
    throw new X509Error("BIT STRING with unused bits");
  return node.value.subarray(1);
}

function parseTime(node: DerNode): number {
  const s = new TextDecoder().decode(node.value);
  let m: RegExpMatchArray | null;
  let year: number;
  if (node.tag === TAG.UTC_TIME) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new X509Error("bad UTCTime");
    const yy = Number(m[1]);
    // RFC 5280 §4.1.2.5.1: YY >= 50 is 19YY, else 20YY.
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (node.tag === TAG.GENERALIZED_TIME) {
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new X509Error("bad GeneralizedTime");
    year = Number(m[1]);
  } else throw new X509Error("expected a time");
  const ms = Date.UTC(
    year,
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Math.floor(ms / 1000);
}

// ── certificates ──────────────────────────────────────────────────────────────────────────────

export const OID = {
  EC_PUBLIC_KEY: "1.2.840.10045.2.1",
  P256: "1.2.840.10045.3.1.7",
  P384: "1.3.132.0.34",
  ECDSA_SHA256: "1.2.840.10045.4.3.2",
  ECDSA_SHA384: "1.2.840.10045.4.3.3",
  BASIC_CONSTRAINTS: "2.5.29.19",
  KEY_USAGE: "2.5.29.15",
  EXT_KEY_USAGE: "2.5.29.37",
} as const;

export interface X509Extension {
  critical: boolean;
  /** The extension's `extnValue` content (itself DER). */
  value: Uint8Array;
}

export interface X509Certificate {
  /** The whole certificate, DER. */
  raw: Uint8Array;
  /** The `tbsCertificate`, DER — what the issuer signed. */
  tbs: Uint8Array;
  /** The issuer and subject Names, DER, compared byte for byte when chaining. */
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** The signature algorithm OID (outer, equal to the inner one by construction). */
  signatureAlgorithm: string;
  /** The ECDSA-Sig-Value, DER. */
  signature: Uint8Array;
  /** The SubjectPublicKeyInfo, DER — WebCrypto imports it as `spki`. */
  spki: Uint8Array;
  /** `P-256` or `P-384`. */
  curve: "P-256" | "P-384";
  /** The public key as an uncompressed SEC1 point (`04 ‖ X ‖ Y`). */
  publicKey: Uint8Array;
  /** Extensions by OID. */
  extensions: Map<string, X509Extension>;
  /** `cA` from basic constraints (false when absent). */
  isCa: boolean;
}

const MAX_CERT = 16 * 1024;

/** Parse one DER certificate. Throws `X509Error` on anything outside the supported subset. */
export function parseCertificate(der: Uint8Array): X509Certificate {
  if (der.length > MAX_CERT) throw new X509Error("certificate too large");
  const cert = expectTag(parseDer(der), TAG.SEQUENCE, "Certificate");
  const [tbsNode, sigAlgNode, sigNode, ...rest] = derChildren(cert);
  if (rest.length) throw new X509Error("extra Certificate fields");
  const tbs = expectTag(tbsNode, TAG.SEQUENCE, "TBSCertificate");
  const outerAlg = algorithmOid(
    expectTag(sigAlgNode, TAG.SEQUENCE, "AlgorithmIdentifier"),
  );
  const signature = bitStringBytes(
    expectTag(sigNode, TAG.BIT_STRING, "signature"),
  );

  const f = derChildren(tbs);
  let i = 0;
  // version [0] EXPLICIT — v3 is required: everything below relies on extensions.
  const versionNode = f[i];
  if (!versionNode || versionNode.tag !== 0xa0)
    throw new X509Error("not a v3 certificate");
  const version = expectTag(
    derChildren(versionNode)[0],
    TAG.INTEGER,
    "version",
  );
  if (version.value.length !== 1 || version.value[0] !== 2)
    throw new X509Error("not a v3 certificate");
  i++;
  expectTag(f[i++], TAG.INTEGER, "serialNumber");
  const innerAlg = algorithmOid(expectTag(f[i++], TAG.SEQUENCE, "signature"));
  if (innerAlg !== outerAlg)
    throw new X509Error("signature algorithm mismatch");
  const issuer = expectTag(f[i++], TAG.SEQUENCE, "issuer");
  const validity = derChildren(expectTag(f[i++], TAG.SEQUENCE, "validity"));
  if (validity.length !== 2) throw new X509Error("bad validity");
  const subject = expectTag(f[i++], TAG.SEQUENCE, "subject");
  const spkiNode = expectTag(f[i++], TAG.SEQUENCE, "subjectPublicKeyInfo");
  const [spkiAlg, spkiKey, ...spkiRest] = derChildren(spkiNode);
  if (spkiRest.length) throw new X509Error("bad subjectPublicKeyInfo");
  const algParts = derChildren(
    expectTag(spkiAlg, TAG.SEQUENCE, "key algorithm"),
  );
  if (
    decodeOid(expectTag(algParts[0], TAG.OID, "key OID").value) !==
    OID.EC_PUBLIC_KEY
  )
    throw new X509Error("not an EC public key");
  const curveOid = decodeOid(
    expectTag(algParts[1], TAG.OID, "curve OID").value,
  );
  const curve =
    curveOid === OID.P256 ? "P-256" : curveOid === OID.P384 ? "P-384" : null;
  if (!curve) throw new X509Error("unsupported curve");
  const publicKey = bitStringBytes(
    expectTag(spkiKey, TAG.BIT_STRING, "public key"),
  );
  const coord = curve === "P-256" ? 32 : 48;
  if (publicKey.length !== 1 + 2 * coord || publicKey[0] !== 0x04)
    throw new X509Error("public key is not an uncompressed point");

  const extensions = new Map<string, X509Extension>();
  for (; i < f.length; i++) {
    const n = f[i]!;
    if (n.tag === 0x81 || n.tag === 0x82) continue; // issuer/subject unique ids
    if (n.tag !== 0xa3) throw new X509Error("unexpected TBSCertificate field");
    const list = expectTag(derChildren(n)[0], TAG.SEQUENCE, "Extensions");
    for (const ext of derChildren(list)) {
      const parts = derChildren(expectTag(ext, TAG.SEQUENCE, "Extension"));
      const oid = decodeOid(expectTag(parts[0], TAG.OID, "extnID").value);
      let critical = false;
      let valueNode = parts[1];
      if (valueNode?.tag === TAG.BOOLEAN) {
        critical = valueNode.value.length === 1 && valueNode.value[0] !== 0;
        valueNode = parts[2];
      }
      const value = expectTag(valueNode, TAG.OCTET_STRING, "extnValue").value;
      if (extensions.has(oid)) throw new X509Error("duplicate extension");
      extensions.set(oid, { critical, value });
    }
  }

  let isCa = false;
  const bc = extensions.get(OID.BASIC_CONSTRAINTS);
  if (bc) {
    const seq = derChildren(
      expectTag(parseDer(bc.value), TAG.SEQUENCE, "BasicConstraints"),
    );
    const first = seq[0];
    isCa =
      first?.tag === TAG.BOOLEAN &&
      first.value.length === 1 &&
      first.value[0] !== 0;
  }

  if (outerAlg !== OID.ECDSA_SHA256 && outerAlg !== OID.ECDSA_SHA384)
    throw new X509Error("unsupported signature algorithm");

  return {
    raw: der,
    tbs: tbs.raw,
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: parseTime(validity[0]!),
    notAfter: parseTime(validity[1]!),
    signatureAlgorithm: outerAlg,
    signature,
    spki: spkiNode.raw,
    curve,
    publicKey,
    extensions,
    isCa,
  };
}

function algorithmOid(node: DerNode): string {
  return decodeOid(
    expectTag(derChildren(node)[0], TAG.OID, "algorithm OID").value,
  );
}

/** Decode a PEM `CERTIFICATE` block to DER. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── signatures ────────────────────────────────────────────────────────────────────────────────

/** An ECDSA-Sig-Value (DER SEQUENCE of r, s) as the fixed-width `r ‖ s` WebCrypto verifies. */
export function ecdsaDerToRaw(sig: Uint8Array, coord: number): Uint8Array {
  const parts = derChildren(
    expectTag(parseDer(sig), TAG.SEQUENCE, "ECDSA-Sig-Value"),
  );
  if (parts.length !== 2) throw new X509Error("bad ECDSA signature");
  const out = new Uint8Array(coord * 2);
  parts.forEach((p, k) => {
    let v = expectTag(p, TAG.INTEGER, "ECDSA integer").value;
    // A positive INTEGER may carry one leading zero; anything longer than the field is invalid.
    while (v.length > coord && v[0] === 0) v = v.subarray(1);
    if (v.length > coord || v.length === 0)
      throw new X509Error("bad ECDSA integer");
    out.set(v, k * coord + (coord - v.length));
  });
  return out;
}

/** Verify `signature` (DER ECDSA) over `data` with `signer`'s key and `algorithm`'s hash. */
export async function verifyEcdsaSignature(
  signer: X509Certificate,
  algorithm: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const hash =
    algorithm === OID.ECDSA_SHA256
      ? "SHA-256"
      : algorithm === OID.ECDSA_SHA384
        ? "SHA-384"
        : null;
  if (!hash) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      signer.spki,
      { name: "ECDSA", namedCurve: signer.curve },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash },
      key,
      ecdsaDerToRaw(signature, signer.curve === "P-256" ? 32 : 48),
      data,
    );
  } catch {
    return false;
  }
}

// ── chains ────────────────────────────────────────────────────────────────────────────────────

export type ChainFailure =
  | "empty"
  | "too_long"
  | "expired"
  | "not_yet_valid"
  | "unknown_issuer"
  | "issuer_not_ca"
  | "bad_signature"
  | "critical_extension";

export type ChainResult = { ok: true } | { ok: false; reason: ChainFailure };

const MAX_CHAIN = 4;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function timeOk(c: X509Certificate, now: number): ChainResult {
  if (now < c.notBefore) return { ok: false, reason: "not_yet_valid" };
  if (now > c.notAfter) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Verify `chain` (leaf first, each element issued by the next) up to one of `anchors`.
 *
 * The chain may end with a copy of the anchor itself or stop below it. Each certificate must be
 * within its validity window at `now`; each issuer must be a CA; each signature must verify under
 * its issuer's key; and a certificate carrying a critical extension outside `knownCritical` (plus
 * basic constraints, key usage and extended key usage, which every Apple certificate marks
 * critical) fails. Extended key usage values are NOT interpreted — a caller that needs a purpose
 * checks the leaf's own extensions.
 */
export async function verifyChain(
  chain: readonly X509Certificate[],
  anchors: readonly X509Certificate[],
  now: number,
  knownCritical: readonly string[] = [],
): Promise<ChainResult> {
  if (chain.length === 0) return { ok: false, reason: "empty" };
  if (chain.length > MAX_CHAIN) return { ok: false, reason: "too_long" };
  const allowed = new Set<string>([
    OID.BASIC_CONSTRAINTS,
    OID.KEY_USAGE,
    OID.EXT_KEY_USAGE,
    ...knownCritical,
  ]);
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    for (const [oid, ext] of cert.extensions)
      if (ext.critical && !allowed.has(oid))
        return { ok: false, reason: "critical_extension" };
    const t = timeOk(cert, now);
    if (!t.ok) return t;
    // A chain that carries the anchor itself stops there: it is trusted by identity.
    if (anchors.some((a) => bytesEqual(a.raw, cert.raw))) return { ok: true };
    const next = chain[i + 1];
    const issuer =
      next && bytesEqual(next.subject, cert.issuer)
        ? next
        : !next
          ? anchors.find((a) => bytesEqual(a.subject, cert.issuer))
          : undefined;
    if (!issuer) return { ok: false, reason: "unknown_issuer" };
    if (!issuer.isCa) return { ok: false, reason: "issuer_not_ca" };
    if (
      !(await verifyEcdsaSignature(
        issuer,
        cert.signatureAlgorithm,
        cert.signature,
        cert.tbs,
      ))
    )
      return { ok: false, reason: "bad_signature" };
    if (!next) {
      // `issuer` is an anchor: its own window still applies.
      const at = timeOk(issuer, now);
      return at.ok ? { ok: true } : at;
    }
  }
  // Every element verified against the next, but the last one is not an anchor.
  return { ok: false, reason: "unknown_issuer" };
}
