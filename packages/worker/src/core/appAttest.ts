/**
 * Apple App Attest attestation verification (P6-02), following Apple's "Validating apps that
 * connect to your server" steps 1–9, in the order Apple lists them:
 *
 *   1. the `x5c` chain (credential certificate, then Apple's intermediate) verifies up to the
 *      PINNED Apple App Attestation Root CA;
 *   2–4. `nonce = SHA-256(authData ‖ clientDataHash)` equals the credential certificate's
 *      extension 1.2.840.113635.100.8.2;
 *   5. `SHA-256(credential public key)` equals the key id the app presents;
 *   6. `authData.rpIdHash` equals `SHA-256("<TeamID>.<bundleId>")` for one of the product's apps;
 *   7. the sign counter is 0 (a fresh key);
 *   8. the aaguid is `appattest` + seven NULs (production) or `appattestdevelop` (development),
 *      whichever the product's trust policy names — never either;
 *   9. the credential id equals the key id.
 *
 * Fail closed: any parse error, any mismatch, any unsupported shape is a refusal with a reason
 * (for the audit trail and the console, never for the device: the route answers one
 * `attestation_rejected`). The receipt is not verified or stored — it serves Apple's fraud-metric
 * service, which is not used here. The credential public key is returned so the caller can keep
 * it for later assertions (the brief's "stored for later").
 *
 * The chain is verified by P6-01's `core/x509.ts` (one X.509 parser for the Worker): the `x5c`
 * certificates plus the pinned root, which `verifyChain` requires byte for byte at the end. The
 * nonce extension is the one critical OID App Attest adds to that verifier's understood set, and
 * the credential certificate's keyUsage is checked `ifPresent`: its key is the credential key that
 * later signs assertions, so a keyUsage that is present must allow digitalSignature, while a
 * certificate without keyUsage is not refused (Apple documents no keyUsage requirement for the
 * credential certificate, and no real attestation is available offline to prove one is always
 * present; `require` could refuse genuine devices for no security gain, since the key's use is
 * bound by the nonce and the RP ID anyway).
 *
 * `roots` is injectable for tests only: the route handler's production caller passes nothing and
 * gets the pinned Apple root. Pure apart from `crypto.subtle`; runs in Node and workerd.
 */

import { CborError, decodeCbor, type CborValue } from "./cbor.js";
import {
  base64ToBytes,
  derChildren,
  getExtension,
  parseCertificate,
  readDerExact,
  verifyChain,
  X509Error,
  type X509Certificate,
} from "./x509.js";

/**
 * Apple App Attestation Root CA (P-384, valid 2020-03-18 to 2045-03-15), from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem.
 * SHA-256 fingerprint 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
 * (`test/appAttest.test.ts` pins the fingerprint and checks the self-signature).
 */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

/** The credential certificate's nonce extension. */
export const APP_ATTEST_NONCE_OID = "1.2.840.113635.100.8.2";

export type AppAttestEnvironment = "production" | "development";

const AAGUID: Record<AppAttestEnvironment, Uint8Array> = {
  production: new Uint8Array([
    ...new TextEncoder().encode("appattest"),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]),
  development: new TextEncoder().encode("appattestdevelop"),
};

export type AppAttestFailure =
  | "malformed"
  | "format"
  | "chain"
  | "nonce"
  | "key_id"
  | "rp_id"
  | "counter"
  | "aaguid"
  | "credential_id";

export interface AppAttestVerified {
  ok: true;
  /** The `<TeamID>.<bundleId>` the RP ID hash matched. */
  appId: string;
  environment: AppAttestEnvironment;
  /** The key id as presented (standard base64 of the public key's SHA-256). */
  keyId: string;
  /** The credential public key, an uncompressed P-256 point, base64url — kept for assertions. */
  publicKey: string;
}

export type AppAttestResult =
  | AppAttestVerified
  | { ok: false; reason: AppAttestFailure; detail?: string };

export interface AppAttestInput {
  /** The attestation object (CBOR) as `DCAppAttestService.attestKey` returned it. */
  attestation: Uint8Array;
  /** The key id the app presents (base64, standard or url alphabet). */
  keyId: string;
  /** The 32-byte client data hash the app passed to `attestKey`. */
  clientDataHash: Uint8Array;
  /** Every `<TeamID>.<bundleId>` the product ships under. */
  appIds: readonly string[];
  environment: AppAttestEnvironment;
  now: number;
  /** Trust anchors, DER. TESTS ONLY: production passes nothing and gets the pinned Apple root. */
  roots?: readonly Uint8Array[];
}

/** A PEM `CERTIFICATE` block as DER. */
export function pemToDer(pem: string): Uint8Array {
  return base64ToBytes(
    pem
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\s+/g, ""),
  );
}

let pinnedRootDer: Uint8Array | null = null;

/** The pinned Apple App Attestation Root CA, DER, decoded once per isolate. */
export function appleAppAttestRootDer(): Uint8Array {
  return (pinnedRootDer ??= pemToDer(APPLE_APP_ATTEST_ROOT_PEM));
}

/** The pinned root, parsed. */
export function appleAppAttestRoot(): X509Certificate {
  return parseCertificate(appleAppAttestRootDer());
}

/** The certificate's public key as an uncompressed SEC1 point (the SPKI's BIT STRING). */
function publicKeyPoint(cert: X509Certificate): Uint8Array {
  const parts = derChildren(readDerExact(cert.spki));
  const bits = parts[1];
  if (!bits || bits.tag !== 0x03 || bits.value[0] !== 0)
    throw new X509Error("bad public key");
  const point = bits.value.subarray(1);
  if (point.length !== 65 || point[0] !== 0x04)
    throw new X509Error("public key is not an uncompressed P-256 point");
  return point;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Decode base64 in either alphabet, with or without padding; `null` when it is not base64. */
export function decodeBase64Any(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (std.length % 4 === 1) return null;
  try {
    const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function field(m: Map<CborValue, CborValue>, k: string): CborValue {
  return m.get(k);
}

/** The nonce inside extension 1.2.840.113635.100.8.2: SEQUENCE { [1] EXPLICIT OCTET STRING }. */
function nonceOf(cert: X509Certificate): Uint8Array | null {
  const ext = getExtension(cert, APP_ATTEST_NONCE_OID);
  if (!ext) return null;
  try {
    const seq = readDerExact(ext.value);
    if (seq.tag !== 0x30) return null;
    const tagged = derChildren(seq).find((n) => n.tag === 0xa1);
    if (!tagged) return null;
    const inner = derChildren(tagged)[0];
    return inner && inner.tag === 0x04 ? inner.value : null;
  } catch {
    return null;
  }
}

export async function verifyAppAttestation(
  input: AppAttestInput,
): Promise<AppAttestResult> {
  const keyIdBytes = decodeBase64Any(input.keyId);
  if (!keyIdBytes || keyIdBytes.length !== 32)
    return { ok: false, reason: "malformed", detail: "keyId" };
  if (input.clientDataHash.length !== 32)
    return { ok: false, reason: "malformed", detail: "clientDataHash" };

  let obj: CborValue;
  try {
    obj = decodeCbor(input.attestation);
  } catch (e) {
    if (e instanceof CborError)
      return { ok: false, reason: "malformed", detail: "cbor" };
    throw e;
  }
  if (!(obj instanceof Map)) return { ok: false, reason: "malformed" };
  if (field(obj, "fmt") !== "apple-appattest")
    return { ok: false, reason: "format" };
  const attStmt = field(obj, "attStmt");
  const authData = field(obj, "authData");
  if (!(attStmt instanceof Map) || !(authData instanceof Uint8Array))
    return { ok: false, reason: "malformed", detail: "attStmt/authData" };
  const x5c = field(attStmt, "x5c");
  if (
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    !x5c.every((c) => c instanceof Uint8Array)
  )
    return { ok: false, reason: "malformed", detail: "x5c" };

  // 1. The chain: the x5c certificates, then the trusted root that issued the last of them
  // (P6-01's verifier requires the root itself, byte for byte, at the end of the chain).
  const roots = input.roots ?? [appleAppAttestRootDer()];
  let credCert: X509Certificate;
  let credentialKey: Uint8Array;
  try {
    const top = parseCertificate(x5c[x5c.length - 1] as Uint8Array);
    const root = roots.find((r) => {
      try {
        const sub = parseCertificate(r).subject;
        return (
          sub.length === top.issuer.length &&
          sub.every((b, i) => b === top.issuer[i])
        );
      } catch {
        return false;
      }
    });
    if (!root) return { ok: false, reason: "chain", detail: "untrusted root" };
    const verified = await verifyChain([...(x5c as Uint8Array[]), root], {
      roots,
      at: input.now,
      understood: [APP_ATTEST_NONCE_OID],
      leafDigitalSignature: "ifPresent",
    });
    credCert = verified.leaf;
    if (credCert.curve !== "P-256")
      return { ok: false, reason: "chain", detail: "credential key curve" };
    credentialKey = publicKeyPoint(credCert);
  } catch (e) {
    if (e instanceof X509Error)
      return { ok: false, reason: "chain", detail: e.message };
    throw e;
  }

  // 2–4. The nonce.
  const expected = await sha256(authData, input.clientDataHash);
  const nonce = nonceOf(credCert);
  if (!nonce || !eq(nonce, expected)) return { ok: false, reason: "nonce" };

  // 5. The key id.
  if (!eq(await sha256(credentialKey), keyIdBytes))
    return { ok: false, reason: "key_id" };

  // authenticatorData: rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId …
  if (authData.length < 55)
    return { ok: false, reason: "malformed", detail: "authData" };
  const flags = authData[32]!;
  if ((flags & 0x40) === 0)
    return {
      ok: false,
      reason: "malformed",
      detail: "no attested credential data",
    };

  // 6. The RP ID.
  const rpIdHash = authData.subarray(0, 32);
  let appId: string | null = null;
  for (const candidate of input.appIds) {
    if (eq(await sha256(new TextEncoder().encode(candidate)), rpIdHash)) {
      appId = candidate;
      break;
    }
  }
  if (!appId) return { ok: false, reason: "rp_id" };

  // 7. The counter.
  const counter =
    ((authData[33]! << 24) >>> 0) +
    (authData[34]! << 16) +
    (authData[35]! << 8) +
    authData[36]!;
  if (counter !== 0) return { ok: false, reason: "counter" };

  // 8. The environment.
  if (!eq(authData.subarray(37, 53), AAGUID[input.environment]))
    return { ok: false, reason: "aaguid" };

  // 9. The credential id.
  const credIdLen = (authData[53]! << 8) | authData[54]!;
  if (authData.length < 55 + credIdLen)
    return { ok: false, reason: "malformed", detail: "credentialId" };
  if (!eq(authData.subarray(55, 55 + credIdLen), keyIdBytes))
    return { ok: false, reason: "credential_id" };

  return {
    ok: true,
    appId,
    environment: input.environment,
    keyId: input.keyId,
    publicKey: base64url(credentialKey),
  };
}
