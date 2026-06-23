// The FROZEN Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verification,
// natively on CryptoKit. This is a byte-for-byte re-implementation of @polaris-key/jws's
// `verifyJws` — the cross-language conformance corpus pins them identical.
//
//   protected header = {"alg":"EdDSA","kid":<kid>}            (key order fixed)
//   signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
//   signature        = Ed25519 over the ASCII bytes of signingInput
//   compact JWS      = signingInput "." base64url(signature)
//
// SECURITY: the verifying key is selected by the header `kid` from a caller-supplied trust
// set, NEVER from the document; `alg` is asserted `EdDSA` and `kid` asserted a string
// BEFORE any signature math, so a `none`/HMAC downgrade is rejected outright. The signature
// is checked over the ASCII bytes of the ORIGINAL `encHeader.encPayload` substrings — the
// payload is never re-serialised, keeping cross-language verification byte-stable.

import CryptoKit
import Foundation

/// A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded.
public typealias TrustSet = [String: String]

/// The successful result of a JWS verification: the selected `kid` + the decoded payload.
public struct VerifiedJws: Sendable, Equatable {
    public let kid: String
    public let payload: ManagedConfigDoc
}

public enum JWSVerifier {
    /// Verify a compact JWS against a trust set. Returns the decoded `kid` + payload, or
    /// `nil` on ANY failure (malformed, unknown `kid`, wrong `alg`, non-32-byte key, bad
    /// signature, undecodable payload). Never throws.
    public static func verify(_ jws: String, trust: TrustSet) -> VerifiedJws? {
        // 1. Structure: exactly three "."-separated segments.
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let encHeader = String(parts[0])
        let encPayload = String(parts[1])
        let encSig = String(parts[2])

        // 2. base64url-decode header + payload (mirrors JSON.parse(atob(...))).
        guard
            let headerData = Base64URL.decode(encHeader),
            let payloadData = Base64URL.decode(encPayload),
            let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any]
        else { return nil }

        // 3. Assert alg == EdDSA and kid is a String — BEFORE any signature math. This is
        //    the algorithm-downgrade guard: `none`/HS are rejected here.
        guard
            let alg = header["alg"] as? String, alg == "EdDSA",
            let kid = header["kid"] as? String
        else { return nil }

        // 4. Select the verifying key by kid FROM THE TRUST SET (never from the doc).
        guard let rawKeyB64 = trust[kid],
              let rawKey = Base64URL.decode(rawKeyB64),
              rawKey.count == 32
        else { return nil }

        let publicKey: Curve25519.Signing.PublicKey
        do {
            // RAW 32 bytes — do NOT prepend any SPKI prefix (a Node/WebCrypto-only quirk).
            publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: rawKey)
        } catch {
            return nil
        }

        // 5. Verify over the ASCII bytes of the ORIGINAL encoded substrings — never re-encode.
        guard let sig = Base64URL.decode(encSig) else { return nil }
        let signingInput = Data((encHeader + "." + encPayload).utf8)
        guard publicKey.isValidSignature(sig, for: signingInput) else { return nil }

        // 6. Only after a valid signature, decode the payload into the typed doc.
        guard let doc = try? JSONDecoder().decode(ManagedConfigDoc.self, from: payloadData)
        else { return nil }

        return VerifiedJws(kid: kid, payload: doc)
    }
}

/// Options for the product-scoped, anti-replay document check layered over raw JWS verify.
public struct VerifyDocOptions: Sendable {
    public let trust: TrustSet
    public let expectedAud: String
    public let deviceId: String
    public let lastAcceptedIssuedAt: Int?

    public init(
        trust: TrustSet,
        expectedAud: String,
        deviceId: String,
        lastAcceptedIssuedAt: Int? = nil
    ) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.deviceId = deviceId
        self.lastAcceptedIssuedAt = lastAcceptedIssuedAt
    }
}

/// Cryptographic verification + anti-replay. On top of the frozen JWS path we assert the
/// product audience, the device binding, and monotonic `issuedAt` so a doc can't be spliced
/// across products/devices or replayed. Mirrors sdk-node's `verifyDoc`.
public func verifyDoc(_ jws: String, options: VerifyDocOptions) -> ManagedConfigDoc? {
    guard let v = JWSVerifier.verify(jws, trust: options.trust) else { return nil }
    let doc = v.payload
    if doc.aud != options.expectedAud { return nil }
    if doc.deviceId != options.deviceId { return nil }
    if let last = options.lastAcceptedIssuedAt, doc.issuedAt <= last { return nil }
    return doc
}
