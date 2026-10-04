/**
 * Generated App Attest fixtures (P6-02): a test certificate chain shaped like Apple's — a P-384
 * root CA, a P-384 intermediate CA and a P-256 credential certificate carrying the nonce extension
 * 1.2.840.113635.100.8.2 — and the CBOR attestation object around it, built with WebCrypto and a
 * minimal DER and CBOR encoder. Nothing Apple-issued: the verifier's pinned root is replaced by
 * the generated one through the test-only `roots` / `appAttestRoots` injection.
 *
 * Web APIs only, so the Node lane and the workerd lane (`test-workerd/attest.test.ts`) share it.
 * Every knob produces one specific defect the verifier must catch.
 */

// ── DER ───────────────────────────────────────────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let head: number[];
  if (len < 0x80) head = [tag, len];
  else if (len < 0x100) head = [tag, 0x81, len];
  else head = [tag, 0x82, len >> 8, len & 0xff];
  return concat(new Uint8Array(head), content);
}

const seq = (...p: Uint8Array[]) => tlv(0x30, concat(...p));
const set = (...p: Uint8Array[]) => tlv(0x31, concat(...p));
const octet = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, concat(new Uint8Array([0]), b));
const explicit = (n: number, b: Uint8Array) => tlv(0xa0 + n, b);
const bool = (v: boolean) => tlv(0x01, new Uint8Array([v ? 0xff : 0]));
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));

function int(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if (b[0]! & 0x80) b = concat(new Uint8Array([0]), b);
  return tlv(0x02, b);
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  }
  return tlv(0x06, new Uint8Array(out));
}

function utcTime(epoch: number): Uint8Array {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
}

const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));

const SHA256_ALG = "1.2.840.10045.4.3.2";
const SHA384_ALG = "1.2.840.10045.4.3.3";

interface KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  curve: "P-256" | "P-384";
}

async function keyPair(curve: "P-256" | "P-384"): Promise<KeyPair> {
  const k = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: curve },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { privateKey: k.privateKey, publicKey: k.publicKey, curve };
}

async function sign(
  issuer: KeyPair,
  alg: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: alg === SHA384_ALG ? "SHA-384" : "SHA-256" },
      issuer.privateKey,
      data,
    ),
  );
  const half = raw.length / 2;
  return seq(int(raw.subarray(0, half)), int(raw.subarray(half)));
}

interface CertSpec {
  subject: string;
  issuer: string;
  key: KeyPair;
  issuerKey: KeyPair;
  ca: boolean;
  notBefore: number;
  notAfter: number;
  extra?: Uint8Array[];
  /** Flip a byte of the signature. */
  badSignature?: boolean;
}

async function makeCert(spec: CertSpec): Promise<Uint8Array> {
  const alg = spec.issuerKey.curve === "P-384" ? SHA384_ALG : SHA256_ALG;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", spec.key.publicKey)) as ArrayBuffer,
  );
  const exts = [
    seq(oid("2.5.29.19"), bool(true), octet(spec.ca ? seq(bool(true)) : seq())),
    seq(
      oid("2.5.29.15"),
      bool(true),
      octet(bitString(new Uint8Array([spec.ca ? 0x06 : 0x80]))),
    ),
    ...(spec.extra ?? []),
  ];
  const tbs = seq(
    explicit(0, int(new Uint8Array([2]))),
    int(crypto.getRandomValues(new Uint8Array(8))),
    seq(oid(alg)),
    name(spec.issuer),
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    name(spec.subject),
    spki,
    explicit(3, seq(...exts)),
  );
  const sig = await sign(spec.issuerKey, alg, tbs);
  if (spec.badSignature) sig[sig.length - 1]! ^= 0x01;
  return seq(tbs, seq(oid(alg)), bitString(sig));
}

// ── CBOR ──────────────────────────────────────────────────────────────────────────────────────

function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >> 16) & 0xff,
    (n >> 8) & 0xff,
    n & 0xff,
  ]);
}

export type CborIn =
  | string
  | number
  | Uint8Array
  | CborIn[]
  | [string, CborIn][];

/** Encode text, non-negative integers, bytes, arrays, and maps given as `{map: entries}`. */
export function cbor(v: CborIn | { map: [CborIn, CborIn][] }): Uint8Array {
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return concat(cborHead(3, b.length), b);
  }
  if (typeof v === "number")
    return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v);
  if (Array.isArray(v))
    return concat(cborHead(4, v.length), ...v.map((x) => cbor(x as CborIn)));
  return concat(
    cborHead(5, v.map.length),
    ...v.map.flatMap(([k, x]) => [cbor(k), cbor(x)]),
  );
}

// ── the attestation ───────────────────────────────────────────────────────────────────────────

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat(...parts)),
  );
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export interface TestChain {
  /** The root, DER (what the verifier's test-only `roots` takes). */
  root: Uint8Array;
  rootKey: KeyPair;
  intermediateDer: Uint8Array;
  intermediateKey: KeyPair;
}

/** A root and an intermediate valid from `now - 1 day` to `now + 10 years`. */
export async function makeTestChain(now: number): Promise<TestChain> {
  const rootKey = await keyPair("P-384");
  const intermediateKey = await keyPair("P-384");
  const rootDer = await makeCert({
    subject: "Test App Attestation Root CA",
    issuer: "Test App Attestation Root CA",
    key: rootKey,
    issuerKey: rootKey,
    ca: true,
    notBefore: now - 86400,
    notAfter: now + 10 * 365 * 86400,
  });
  const intermediateDer = await makeCert({
    subject: "Test App Attestation CA 1",
    issuer: "Test App Attestation Root CA",
    key: intermediateKey,
    issuerKey: rootKey,
    ca: true,
    notBefore: now - 86400,
    notAfter: now + 10 * 365 * 86400,
  });
  return {
    root: rootDer,
    rootKey,
    intermediateDer,
    intermediateKey,
  };
}

export interface AttestKnobs {
  /** The `<TeamID>.<bundleId>` the authenticator data hashes. */
  appId: string;
  clientDataHash: Uint8Array;
  environment?: "production" | "development";
  counter?: number;
  /** Use this nonce instead of the correct one. */
  nonce?: Uint8Array;
  /** Sign the credential certificate with a key the chain does not contain. */
  foreignIssuer?: boolean;
  /** Present a keyId that is not the credential key's hash. */
  wrongKeyId?: boolean;
  /** The credential certificate's validity, relative to `now`. */
  leafNotAfterOffset?: number;
  fmt?: string;
}

export async function makeAppAttestation(
  chain: TestChain,
  now: number,
  k: AttestKnobs,
): Promise<{ attestation: Uint8Array; keyId: string }> {
  const credKey = await keyPair("P-256");
  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", credKey.publicKey)) as ArrayBuffer,
  );
  const keyIdBytes = await sha256(rawPub);
  const aaguid =
    (k.environment ?? "production") === "production"
      ? concat(new TextEncoder().encode("appattest"), new Uint8Array(7))
      : new TextEncoder().encode("appattestdevelop");
  const counter = k.counter ?? 0;
  const authData = concat(
    await sha256(new TextEncoder().encode(k.appId)),
    new Uint8Array([0x40]),
    new Uint8Array([
      (counter >>> 24) & 0xff,
      (counter >> 16) & 0xff,
      (counter >> 8) & 0xff,
      counter & 0xff,
    ]),
    aaguid,
    new Uint8Array([0, keyIdBytes.length]),
    keyIdBytes,
    // A stand-in COSE key: the verifier takes the key from the certificate, as Apple says to.
    cbor({ map: [[1, 2]] }),
  );
  const nonce = k.nonce ?? (await sha256(authData, k.clientDataHash));
  const nonceExt = seq(
    oid("1.2.840.113635.100.8.2"),
    octet(seq(explicit(1, octet(nonce)))),
  );
  const issuerKey = k.foreignIssuer
    ? await keyPair("P-384")
    : chain.intermediateKey;
  const leafDer = await makeCert({
    subject: "credential",
    issuer: "Test App Attestation CA 1",
    key: credKey,
    issuerKey,
    ca: false,
    notBefore: now - 3600,
    notAfter: now + (k.leafNotAfterOffset ?? 3 * 86400),
    extra: [nonceExt],
  });
  const attestation = cbor({
    map: [
      ["fmt", k.fmt ?? "apple-appattest"],
      [
        "attStmt",
        {
          map: [
            ["x5c", [leafDer, chain.intermediateDer]],
            ["receipt", new Uint8Array([1, 2, 3])],
          ],
        } as unknown as CborIn,
      ],
      ["authData", authData],
    ],
  });
  const keyId = k.wrongKeyId
    ? b64(await sha256(new TextEncoder().encode("other")))
    : b64(keyIdBytes);
  return { attestation, keyId };
}
