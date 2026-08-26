// The Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verification, natively on
// CryptoKit. This is a byte-for-byte re-implementation of @plrs/jws's `verifyJws` —
// the cross-language conformance corpus pins them identical. See
// docs/security/WIRE-CONTRACT-V2.md §2 for the normative ordering this file implements.
//
//   protected header = {"alg":"EdDSA","typ":<typ>,"kid":<kid>}   (key order fixed; typ v2+)
//   signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
//   signature        = Ed25519 over the ASCII bytes of signingInput
//   compact JWS      = signingInput "." base64url(signature)
//
// SECURITY: the verifying key is selected by the header `kid` from a caller-supplied trust
// set, NEVER from the document; `alg` is asserted `EdDSA` and `kid` asserted a string
// BEFORE any signature math, so a `none`/HMAC downgrade is rejected outright. The signature
// is checked over the ASCII bytes of the ORIGINAL `encHeader.encPayload` substrings — the
// payload is never re-serialised, keeping cross-language verification byte-stable. The
// payload is parsed ONLY after the signature verifies.

import CryptoKit
import Foundation

/// A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded.
public typealias TrustSet = [String: String]

/// Document-type domain separator (wire contract v2 §2.4). One signing key signs BOTH config
/// docs and trust manifests, so without this a manifest can be replayed where a config doc is
/// expected — today that only fails by accident, via a swallowed decode error (R2-10).
public enum JwsTyp: String, Sendable, Equatable {
    case config = "pkey-config+jws"
    case trust = "pkey-trust+jws"
}

/// The successful result of a JWS verification: the selected `kid` + the decoded payload.
public struct VerifiedJws: Sendable, Equatable {
    public let kid: String
    public let payload: ManagedConfigDoc
}

public enum JWSVerifier {
    /// Hard cap on the decoded payload before JSON decoding, bounding parser work on
    /// adversarial input (wire contract v2 §2.1).
    public static let maxPayloadBytes = 65_536

    /// Hard cap on the decoded PROTECTED HEADER. A legitimate header is ~60 bytes. Without
    /// this the payload cap is trivially bypassed by moving the blob into the header instead
    /// — an 8 MiB header was decoded and parsed pre-verification (audit finding R2-04).
    public static let maxHeaderBytes = 1_024

    /// Encoded-form caps, checked BEFORE decoding so an oversized blob is never allocated.
    private static func b64Cap(_ bytes: Int) -> Int { (bytes * 4 + 2) / 3 + 4 }
    public static let maxHeaderB64 = b64Cap(maxHeaderBytes)
    public static let maxPayloadB64 = b64Cap(maxPayloadBytes)

    /// The protected header, decoded with `JSONDecoder` only — never `JSONSerialization`,
    /// whose FIRST-wins duplicate-key resolution is what made Swift disagree with TS/Python
    /// on `{"alg":"none",…,"alg":"EdDSA"}` (audit finding R2-06). Duplicates are rejected by
    /// a raw pre-scan before this ever runs.
    private struct ProtectedHeader: Decodable {
        let alg: String?
        let typ: String?
        let kid: String?
    }

    /// Verify a compact JWS against a trust set and return the signed payload BYTES.
    ///
    /// `typ` is the document type the CALL SITE expects. A header carrying no `typ` is
    /// accepted (v1 compatibility, wire contract v2 §7.2); a header carrying a DIFFERENT one
    /// is rejected outright, which closes cross-protocol replay immediately.
    public static func verifyPayloadData(
        _ jws: String, trust: TrustSet, typ: JwsTyp? = nil
    ) -> (kid: String, payload: Data)? {
        // 1. Structure: exactly three "."-separated segments.
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let encHeader = String(parts[0])
        let encPayload = String(parts[1])
        let encSig = String(parts[2])

        // 2-3. Bound the ENCODED segments before decoding anything, so an oversized blob is
        //      rejected before it is ever allocated.
        guard encHeader.utf8.count <= maxHeaderB64, encPayload.utf8.count <= maxPayloadB64
        else { return nil }

        // 4-5. Strict base64url-decode the header, then bound the DECODED bytes.
        guard let headerData = Base64URL.decodeStrict(encHeader),
            headerData.count <= maxHeaderBytes
        else { return nil }

        // 6. Parse the header, REJECTING duplicate object keys (never first- or last-wins).
        guard let header = StrictJSON.decode(ProtectedHeader.self, from: headerData)
        else { return nil }

        // 7. Assert alg == EdDSA — BEFORE any signature math. This is the algorithm-downgrade
        //    guard: `none`/HS are rejected here.
        guard header.alg == "EdDSA" else { return nil }

        // 8. Domain separation: a header asserting a type other than the one this call site
        //    expects is a cross-protocol replay attempt.
        if let headerTyp = header.typ, let expected = typ, headerTyp != expected.rawValue {
            return nil
        }

        // 9-10. `kid` must be a string, and the verifying key comes FROM THE TRUST SET
        //       (never from the doc). A revoked kid is absent from the set by construction.
        guard let kid = header.kid,
            let rawKeyB64 = trust[kid],
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

        // 11-12. Verify over the ASCII bytes of the ORIGINAL encoded substrings — never
        //        re-encode. Everything below this line is authenticated bytes.
        guard let sig = Base64URL.decodeStrict(encSig) else { return nil }
        let signingInput = Data((encHeader + "." + encPayload).utf8)
        guard publicKey.isValidSignature(sig, for: signingInput) else { return nil }

        // 13. ONLY NOW decode the payload, bound it, and reject duplicate keys in it too.
        guard let payloadData = Base64URL.decodeStrict(encPayload),
            payloadData.count <= maxPayloadBytes,
            !StrictJSON.hasDuplicateKeys(payloadData)
        else { return nil }

        return (kid: kid, payload: payloadData)
    }

    /// Verify a compact JWS against a trust set. Returns the decoded `kid` + payload, or
    /// `nil` on ANY failure (malformed, unknown `kid`, wrong `alg`/`typ`, non-32-byte key,
    /// bad signature, oversized/undecodable payload, duplicate keys). Never throws.
    public static func verify(_ jws: String, trust: TrustSet, typ: JwsTyp? = nil) -> VerifiedJws? {
        guard let verified = verifyPayloadData(jws, trust: trust, typ: typ) else { return nil }
        // Only after a valid signature, decode the payload into the typed doc.
        guard let doc = try? JSONDecoder().decode(ManagedConfigDoc.self, from: verified.payload)
        else { return nil }

        return VerifiedJws(kid: verified.kid, payload: doc)
    }
}

// ── Strict JSON: duplicate keys are a hard failure ─────────────────────────────────

/// JSON parsing that REJECTS duplicate object keys anywhere in the document.
///
/// Silent resolution is a differential across five implementations: `JSON.parse` and
/// `json.loads` keep the LAST member, `JSONSerialization` keeps the FIRST, so
/// `{"alg":"none","kid":"x","alg":"EdDSA"}` read as `EdDSA` in TS/Python and `none` in Swift
/// — the algorithm-downgrade guard giving opposite answers for identical signed bytes
/// (audit finding R2-06). Wire contract v2 §2.2 resolves it by rejecting outright, so no
/// implementation has to be "right" about which member wins.
enum StrictJSON {
    /// Decode `T`, first pre-scanning the RAW bytes for duplicate keys. `JSONDecoder` alone
    /// cannot help: duplicates are collapsed before any `Decodable` sees them.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        guard !hasDuplicateKeys(data) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// True if any JSON object in `data` declares the same key twice.
    ///
    /// Scans the raw bytes tracking one key-set per open object (`nil` marks an array, whose
    /// commas do not introduce keys). Mirrors `hasDuplicateKeys` in
    /// `packages/shared-jws/src/index.ts` statement for statement.
    static func hasDuplicateKeys(_ data: Data) -> Bool {
        let bytes = [UInt8](data)
        var stack: [Set<String>?] = []
        var expectKey = false
        var i = 0
        while i < bytes.count {
            let c = bytes[i]
            if c == UInt8(ascii: "\"") {
                i += 1
                let start = i
                while i < bytes.count {
                    if bytes[i] == UInt8(ascii: "\\") {
                        i += 2
                        continue
                    }
                    if bytes[i] == UInt8(ascii: "\"") { break }
                    i += 1
                }
                let literal = bytes[start..<min(i, bytes.count)]
                i += 1
                if expectKey {
                    if let top = stack.last, top != nil {
                        guard let key = unescape(literal) else {
                            return true  // unparseable key — refuse rather than guess
                        }
                        if stack[stack.count - 1]!.contains(key) { return true }
                        stack[stack.count - 1]!.insert(key)
                    }
                    expectKey = false
                }
                continue
            }
            if c == UInt8(ascii: "{") {
                stack.append(Set<String>())
                expectKey = true
            } else if c == UInt8(ascii: "[") {
                stack.append(nil)
                expectKey = false
            } else if c == UInt8(ascii: "}") || c == UInt8(ascii: "]") {
                if !stack.isEmpty { stack.removeLast() }
                expectKey = false
            } else if c == UInt8(ascii: ",") {
                expectKey = (stack.last ?? nil) != nil
            }
            i += 1
        }
        return false
    }

    /// Resolve a raw JSON string literal (escapes and all) to the key it denotes, so
    /// `"a"` and `"a"` collide the way every JSON parser makes them collide. Wrapped in
    /// an array because a bare string is a JSON fragment.
    private static func unescape(_ literal: ArraySlice<UInt8>) -> String? {
        var wrapped = Data([UInt8(ascii: "["), UInt8(ascii: "\"")])
        wrapped.append(contentsOf: literal)
        wrapped.append(contentsOf: [UInt8(ascii: "\""), UInt8(ascii: "]")])
        return (try? JSONDecoder().decode([String].self, from: wrapped))?.first
    }
}

// ── Document-level verification (claims + anti-replay) ─────────────────────────────

/// Options for the product-scoped, anti-replay document check layered over raw JWS verify.
public struct VerifyDocOptions: Sendable {
    public let trust: TrustSet
    public let expectedAud: String
    /// Required `iss`. Documented as always `key.plrs.im`, never enforced until v2 (R2-08).
    public let expectedIss: String
    public let deviceId: String
    public let lastAcceptedIssuedAt: Int?
    /// Epoch seconds to evaluate the time claims against. Pass the client's monotonic-floored
    /// `effectiveNow` so a rolled-back clock cannot widen the window (§4.3).
    public let now: Int?
    public let clockSkewSeconds: Int
    /// Enforce `expiresAt` (default). Every other claim is checked either way.
    ///
    /// `true` — the NETWORK path: a freshly served document that has already expired is
    /// never installed or cached (§3). `false` — the CACHE-RELOAD path only: a cached
    /// document is *expected* to be past its short `expiresAt` — that is what offline
    /// operation is — so freshness is the gate's job there (`grace` / `expired`), not the
    /// verifier's. Pinned by the corpus's `doc-expired` / `doc-expired-reload-path` pair.
    public let checkFreshness: Bool

    public init(
        trust: TrustSet,
        expectedAud: String,
        deviceId: String,
        lastAcceptedIssuedAt: Int? = nil,
        expectedIss: String = POLARIS_ISSUER,
        now: Int? = nil,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS,
        checkFreshness: Bool = true
    ) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.deviceId = deviceId
        self.lastAcceptedIssuedAt = lastAcceptedIssuedAt
        self.expectedIss = expectedIss
        self.now = now
        self.clockSkewSeconds = clockSkewSeconds
        self.checkFreshness = checkFreshness
    }
}

/// Saturating add. Timestamps in a signed payload are attacker-influenced `Int`s and Swift
/// TRAPS on overflow, so `issuedAt + MAX_GRACE_SECONDS` written as a plain `+` is a remote
/// crash on a doc carrying `Int.max`. Every claim comparison goes through this.
func saturatingAdd(_ a: Int, _ b: Int) -> Int {
    let (sum, overflowed) = a.addingReportingOverflow(b)
    guard overflowed else { return sum }
    return b > 0 ? Int.max : Int.min
}

/// Cryptographic verification + claim validation + anti-replay (wire contract v2 §3). On top
/// of the JWS path we assert the document type, schema version, audience, issuer, device
/// binding, monotonic `issuedAt`, and the whole signed validity window — so a doc cannot be
/// spliced across products/devices, replayed, back-dated, or handed to us already expired.
/// Any failure returns nil; this never throws.
public func verifyDoc(_ jws: String, options: VerifyDocOptions) -> ManagedConfigDoc? {
    guard let v = JWSVerifier.verify(jws, trust: options.trust, typ: .config) else { return nil }
    let doc = v.payload
    let now = options.now ?? Int(Date().timeIntervalSince1970)
    let skew = options.clockSkewSeconds

    // `schemaVersion` is the per-product CATALOG version, not a wire version, so it gets a
    // SHAPE check only — `Codable` requiring an `Int` is that check (§3.1 correction 1).
    // Allow-listing it would reject every product that ever republished its catalog.
    guard doc.aud == options.expectedAud else { return nil }
    guard doc.iss == options.expectedIss else { return nil }
    guard doc.deviceId == options.deviceId else { return nil }
    // Anti-replay: strictly newer than the last document we accepted.
    if let last = options.lastAcceptedIssuedAt, doc.issuedAt <= last { return nil }
    // A far-future stamp is prima facie tampering (or a badly wrong server clock).
    guard doc.issuedAt <= saturatingAdd(now, skew) else { return nil }
    // Bound the grace window against a hostile server AND a tampered file.
    guard doc.graceUntil >= doc.expiresAt,
        doc.graceUntil <= saturatingAdd(doc.issuedAt, MAX_GRACE_SECONDS)
    else { return nil }
    if options.checkFreshness {
        guard doc.expiresAt > saturatingAdd(now, -skew) else { return nil }
    }
    return doc
}
