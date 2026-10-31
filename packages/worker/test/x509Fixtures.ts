/**
 * Test certificate chains for `core/trust/x509.ts` and the App Store verification (P6-01).
 *
 * Pure TypeScript over WebCrypto — no Node import — so the workerd lane builds the same chains
 * at runtime. A chain is shaped like Apple's: a self-signed P-384 root, a P-384 intermediate
 * carrying the WWDR marker OID and a P-256 leaf carrying the App Store receipt-signing OID, each
 * signed with ecdsa-with-SHA384. Options break one property at a time for the refusal tests.
 * No real Apple key or certificate is involved; the tests pin the root they generate through the
 * test-only override (`setAppleRootsForTesting`).
 */

import { X509Error } from "../src/core/trust/x509.js";

export const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1";
export const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

const OIDS = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  cn: "2.5.4.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsaSha256: "1.2.840.113549.1.1.11",
  rsaSha384: "1.2.840.113549.1.1.12",
  rsaSha512: "1.2.840.113549.1.1.13",
  extKeyUsage: "2.5.29.37",
};

// ── DER encoding ─────────────────────────────────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const n = value.length;
  let len: Uint8Array;
  if (n < 0x80) len = Uint8Array.of(n);
  else if (n < 0x100) len = Uint8Array.of(0x81, n);
  else if (n < 0x10000) len = Uint8Array.of(0x82, n >> 8, n & 0xff);
  else len = Uint8Array.of(0x83, n >> 16, (n >> 8) & 0xff, n & 0xff);
  return concat(Uint8Array.of(tag), len, value);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));
const octets = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array) => tlv(0x03, concat(Uint8Array.of(0), b));
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

function integer(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1);
  if (b[0]! & 0x80) b = concat(Uint8Array.of(0), b);
  return tlv(0x02, b);
}

function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const out: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
}

function generalizedTime(epoch: number): Uint8Array {
  const d = new Date(epoch * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const s = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

const nul = () => tlv(0x05, new Uint8Array());

/** A Name: the CN, then any `extra` [oid, value, string tag] RDNs (default UTF8String). */
const name = (
  cn: string,
  extra: ReadonlyArray<[string, string, number?]> = [],
) =>
  seq(
    ...extra.map(([o, v, tag]) =>
      set(seq(oid(o), tlv(tag ?? 0x0c, new TextEncoder().encode(v)))),
    ),
    set(seq(oid(OIDS.cn), utf8(cn))),
  );

/** raw r||s → DER ECDSA-Sig-Value. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(integer(raw.subarray(0, half)), integer(raw.subarray(half)));
}

// ── Keys and certificates ────────────────────────────────────────────────────────────────────

export interface TestKey {
  curve: "P-256" | "P-384";
  keys: CryptoKeyPair;
  spki: Uint8Array;
}

export async function testKey(curve: "P-256" | "P-384"): Promise<TestKey> {
  const keys = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: curve },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer,
  );
  return { curve, keys, spki };
}

/** A generated RSA key pair (RSASSA-PKCS1-v1_5). */
export interface RsaTestKey {
  rsa: true;
  bits: number;
  keys: CryptoKeyPair;
  spki: Uint8Array;
}

export async function rsaTestKey(
  bits = 2048,
  hash: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-256",
): Promise<RsaTestKey> {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: bits,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash,
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer,
  );
  return { rsa: true, bits, keys, spki };
}

/**
 * An RSA SubjectPublicKeyInfo around a synthetic modulus of exactly `bits` bits (top and bottom
 * bit set, so odd): no private key exists. For parser range tests, where the certificate is
 * refused (or read) before any signature is checked. `exponent` is the big-endian public exponent.
 */
export function syntheticRsaSpki(
  bits: number,
  exponent: number[] = [1, 0, 1],
): Uint8Array {
  const n = new Uint8Array(Math.ceil(bits / 8)).fill(0xa5);
  n[0] = 1 << ((bits - 1) % 8);
  n[n.length - 1] = n[n.length - 1]! | 1;
  return seq(
    seq(oid(OIDS.rsaEncryption), nul()),
    bits_(seq(integer(n), integer(Uint8Array.from(exponent)))),
  );
}
const bits_ = bits;

export interface CertSpec {
  subject: string;
  issuer: string;
  key: TestKey | RsaTestKey;
  /** The signer (the issuer's key; the subject's own for a self-signed root). */
  signer: TestKey | RsaTestKey;
  /** Extra subject RDNs ahead of the CN: [oid, value, string tag (default UTF8String 0x0c)]. */
  subjectExtra?: Array<[string, string, number?]>;
  /** extendedKeyUsage purposes (dotted OIDs); critical when `ekuCritical`. */
  eku?: string[];
  ekuCritical?: boolean;
  notBefore: number;
  notAfter: number;
  ca: boolean;
  pathLen?: number;
  /** Extra (non-critical, empty-valued) extensions by OID. */
  oids?: string[];
  /** Mark an unknown extension critical. */
  criticalUnknown?: boolean;
  hash?: "SHA-256" | "SHA-384" | "SHA-512";
  serial?: number;
  /** Refusal-test knobs, each breaking one DER/profile rule. */
  tamper?: {
    /** Name this signature algorithm OID (inner and outer) instead of the real one. */
    sigOid?: string;
    /** Write the RSA signature algorithm without its NULL parameters. */
    rsaNoNull?: boolean;
    /** A raw GeneralizedTime string for notBefore (e.g. "20231301000000Z"). */
    notBeforeRaw?: string;
    /** The keyUsage BIT STRING contents ([unusedBits, ...bytes]); `null` omits keyUsage. */
    keyUsage?: number[] | null;
    /** Encode the leaf's basicConstraints cA FALSE explicitly (forbidden in DER). */
    explicitCaFalse?: boolean;
    /** A trailing element after extnValue in the first extension. */
    extensionTrailer?: boolean;
    /** Repeat the [3] extensions field. */
    repeatExtensions?: boolean;
    /** A second SEQUENCE inside the [3] wrapper. */
    extensionsWrapperExtra?: boolean;
    /** A critical BOOLEAN two bytes long. */
    longBoolean?: boolean;
  };
}

export async function makeCert(spec: CertSpec): Promise<Uint8Array> {
  const hash = spec.hash ?? "SHA-384";
  const rsaSigner = "rsa" in spec.signer;
  const t = spec.tamper ?? {};
  const sigOid =
    t.sigOid ??
    (rsaSigner
      ? hash === "SHA-256"
        ? OIDS.rsaSha256
        : hash === "SHA-384"
          ? OIDS.rsaSha384
          : OIDS.rsaSha512
      : hash === "SHA-256"
        ? OIDS.ecdsaSha256
        : OIDS.ecdsaSha384);
  const alg =
    rsaSigner && !t.rsaNoNull ? seq(oid(sigOid), nul()) : seq(oid(sigOid));
  const critical = t.longBoolean
    ? tlv(0x01, Uint8Array.of(0xff, 0xff))
    : bool(true);
  const bcInner = [
    ...(spec.ca ? [bool(true)] : t.explicitCaFalse ? [bool(false)] : []),
    ...(spec.ca && spec.pathLen !== undefined
      ? [integer(Uint8Array.of(spec.pathLen))]
      : []),
  ];
  const exts: Uint8Array[] = [
    seq(
      oid(OIDS.basicConstraints),
      critical,
      octets(seq(...bcInner)),
      ...(t.extensionTrailer ? [tlv(0x05, new Uint8Array())] : []),
    ),
    ...(t.keyUsage === null
      ? []
      : [
          seq(
            oid(OIDS.keyUsage),
            bool(true),
            // digitalSignature (bit 0), plus keyCertSign + cRLSign (bits 5, 6) for a CA.
            octets(
              tlv(
                0x03,
                Uint8Array.from(
                  t.keyUsage ?? [spec.ca ? 1 : 7, spec.ca ? 0x86 : 0x80],
                ),
              ),
            ),
          ),
        ]),
    ...(spec.eku
      ? [
          seq(
            oid(OIDS.extKeyUsage),
            ...(spec.ekuCritical ? [bool(true)] : []),
            octets(seq(...spec.eku.map(oid))),
          ),
        ]
      : []),
    ...(spec.oids ?? []).map((o) =>
      seq(oid(o), octets(tlv(0x05, new Uint8Array()))),
    ),
    ...(spec.criticalUnknown
      ? [
          seq(
            oid("1.3.6.1.4.1.99999.1"),
            bool(true),
            octets(tlv(0x05, new Uint8Array())),
          ),
        ]
      : []),
  ];
  const extField = tlv(
    0xa3,
    concat(seq(...exts), ...(t.extensionsWrapperExtra ? [seq()] : [])),
  );
  const notBefore = t.notBeforeRaw
    ? tlv(0x18, new TextEncoder().encode(t.notBeforeRaw))
    : generalizedTime(spec.notBefore);
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(Uint8Array.of(spec.serial ?? 1)),
    alg,
    name(spec.issuer),
    seq(notBefore, generalizedTime(spec.notAfter)),
    name(spec.subject, spec.subjectExtra),
    spec.key.spki,
    extField,
    ...(t.repeatExtensions ? [extField] : []),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      rsaSigner ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash },
      spec.signer.keys.privateKey,
      tbs as BufferSource,
    ),
  );
  return seq(tbs, alg, bits(rsaSigner ? sig : rawToDer(sig)));
}

export interface TestChain {
  root: Uint8Array;
  intermediate: Uint8Array;
  leaf: Uint8Array;
  leafKey: TestKey;
  /** `[leaf, intermediate, root]`. */
  chain: Uint8Array[];
  /** The chain as `x5c` (standard base64). */
  x5c: string[];
}

export interface ChainOptions {
  /** Epoch seconds the chain is valid around (± 10 years for CAs, ± 1 year for the leaf). */
  at: number;
  /** Omit the leaf's App Store OID. */
  noLeafOid?: boolean;
  /** Omit the intermediate's WWDR OID. */
  noIntermediateOid?: boolean;
  /** Sign the leaf with a key other than the intermediate's (a broken link). */
  brokenLink?: boolean;
  /** The intermediate is not a CA. */
  intermediateNotCa?: boolean;
  /** The leaf expired before `at`. */
  expiredLeaf?: boolean;
  /** Reuse this root (and its key) instead of generating one. */
  root?: { der: Uint8Array; key: TestKey };
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return btoa(s);
}

/** A fresh root key and certificate (self-signed P-384 CA). */
export async function makeRoot(
  at: number,
  cn = "Test Root CA - G3",
): Promise<{ der: Uint8Array; key: TestKey }> {
  const key = await testKey("P-384");
  const der = await makeCert({
    subject: cn,
    issuer: cn,
    key,
    signer: key,
    notBefore: at - 10 * 365 * 86400,
    notAfter: at + 10 * 365 * 86400,
    ca: true,
  });
  return { der, key };
}

export async function makeChain(o: ChainOptions): Promise<TestChain> {
  const year = 365 * 86400;
  const root = o.root ?? (await makeRoot(o.at));
  const interKey = await testKey("P-384");
  const intermediate = await makeCert({
    subject: "Test WWDR CA - G6",
    issuer: "Test Root CA - G3",
    key: interKey,
    signer: root.key,
    notBefore: o.at - 5 * year,
    notAfter: o.at + 5 * year,
    ca: !o.intermediateNotCa,
    pathLen: 0,
    oids: o.noIntermediateOid ? [] : [APPLE_INTERMEDIATE_OID],
    serial: 2,
  });
  const leafKey = await testKey("P-256");
  const stranger = await testKey("P-384");
  const leaf = await makeCert({
    subject: "Test StoreKit Signing",
    issuer: "Test WWDR CA - G6",
    key: leafKey,
    signer: o.brokenLink ? stranger : interKey,
    notBefore: o.expiredLeaf ? o.at - 2 * year : o.at - year,
    notAfter: o.expiredLeaf ? o.at - 86400 : o.at + year,
    ca: false,
    oids: o.noLeafOid ? [] : [APPLE_LEAF_OID],
    serial: 3,
  });
  const chain = [leaf, intermediate, root.der];
  return {
    root: root.der,
    intermediate,
    leaf,
    leafKey,
    chain,
    x5c: chain.map(toBase64),
  };
}

// ── JWS (ES256 with x5c) ─────────────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign `payload` as Apple signs a StoreKit or notification JWS: ES256, `x5c` in the header. */
export async function signX5cJws(
  payload: unknown,
  key: TestKey,
  x5c: string[],
  header: Record<string, unknown> = {},
): Promise<string> {
  const enc = new TextEncoder();
  const h = b64url(
    enc.encode(JSON.stringify({ alg: "ES256", x5c, ...header })),
  );
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.keys.privateKey,
      enc.encode(`${h}.${p}`) as BufferSource,
    ),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

// ── An RSA chain (Game Center's shape) ───────────────────────────────────────────────────────

export interface RsaChainOptions {
  /** Epoch seconds the chain is valid around. */
  at: number;
  /** Modulus bits of every key (default 2048). */
  bits?: number;
  /** The hash every certificate is signed with (default SHA-256). */
  hash?: "SHA-256" | "SHA-384" | "SHA-512";
  /** Sign the leaf with a key other than the intermediate's. */
  brokenLink?: boolean;
  /** The leaf's extendedKeyUsage purposes (default code signing); `null` omits the extension. */
  eku?: string[] | null;
  /** The leaf's subject: O and CN (default "Apple Inc." for both). */
  leafO?: string;
  leafCn?: string;
  /** The leaf was not yet valid at `at`. */
  futureLeaf?: boolean;
  /** The leaf expired before `at`. */
  expiredLeaf?: boolean;
  /** Reuse this root instead of generating one. */
  root?: { der: Uint8Array; key: RsaTestKey };
}

export interface RsaTestChain {
  root: Uint8Array;
  rootKey: RsaTestKey;
  intermediate: Uint8Array;
  leaf: Uint8Array;
  leafKey: RsaTestKey;
  /** `[leaf, intermediate, root]`. */
  chain: Uint8Array[];
}

export async function makeRsaChain(o: RsaChainOptions): Promise<RsaTestChain> {
  const year = 365 * 86400;
  const bits = o.bits ?? 2048;
  const hash = o.hash ?? "SHA-256";
  const rootKey = o.root?.key ?? (await rsaTestKey(bits, hash));
  const root =
    o.root?.der ??
    (await makeCert({
      subject: "Test RSA Root",
      issuer: "Test RSA Root",
      key: rootKey,
      signer: rootKey,
      notBefore: o.at - 10 * year,
      notAfter: o.at + 10 * year,
      ca: true,
      hash,
    }));
  const interKey = await rsaTestKey(bits, hash);
  const intermediate = await makeCert({
    subject: "Test RSA Code Signing CA",
    issuer: "Test RSA Root",
    key: interKey,
    signer: rootKey,
    notBefore: o.at - 5 * year,
    notAfter: o.at + 5 * year,
    ca: true,
    pathLen: 0,
    hash,
    serial: 2,
  });
  const leafKey = await rsaTestKey(bits, hash);
  const stranger = await rsaTestKey(bits, hash);
  const leaf = await makeCert({
    subject: o.leafCn ?? "Apple Inc.",
    subjectExtra: [["2.5.4.10", o.leafO ?? "Apple Inc."]],
    issuer: "Test RSA Code Signing CA",
    key: leafKey,
    signer: o.brokenLink ? stranger : interKey,
    notBefore: o.futureLeaf
      ? o.at + 86400
      : o.expiredLeaf
        ? o.at - 2 * year
        : o.at - year,
    notAfter: o.futureLeaf
      ? o.at + year
      : o.expiredLeaf
        ? o.at - 86400
        : o.at + year,
    ca: false,
    eku: o.eku === null ? undefined : (o.eku ?? ["1.3.6.1.5.5.7.3.3"]),
    hash,
    serial: 3,
  });
  return {
    root,
    rootKey,
    intermediate,
    leaf,
    leafKey,
    chain: [leaf, intermediate, root],
  };
}

/** The refusal reason of an `X509Error` a promise rejects with, or "accepted". */
export async function x509Reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof X509Error) return e.reason;
    throw e;
  }
  return "accepted";
}
