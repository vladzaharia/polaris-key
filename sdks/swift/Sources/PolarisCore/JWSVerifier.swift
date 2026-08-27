// The Polaris wire crypto: compact JWS (EdDSA / Ed25519) verification, natively on CryptoKit.
// This is a byte-for-byte re-implementation of `@plrs/jws`'s `verifyJws` — the cross-language
// conformance corpus (`conformance/corpus/v2`, `jwsCases`) pins them identical. See
// docs/security/WIRE-CONTRACT-V3.md §1 for the normative ordering this file implements.
//
//   protected header = {"alg":"EdDSA","kid":<kid>,"typ":<typ>}   (key order fixed)
//   signingInput     = base64url(utf8(JSON(header))) "." base64url(utf8(JSON(payload)))
//   signature        = Ed25519 over the ASCII bytes of signingInput
//   compact JWS      = signingInput "." base64url(signature)
//
// SECURITY: the verifying key is selected by the header `kid` from a caller-supplied trust set,
// NEVER from the document; `alg` is asserted `EdDSA` and `kid` asserted a string BEFORE any
// signature math, so a `none`/HMAC downgrade is rejected outright. The signature is checked
// over the ASCII bytes of the ORIGINAL `encHeader.encPayload` substrings — the payload is never
// re-serialised, keeping cross-language verification byte-stable. The payload is parsed ONLY
// after the signature verifies.
//
// ── TWO v3 CHANGES ──────────────────────────────────────────────────────────────────────────
//
// 1. `requireTyp` defaults to TRUE. v2 accepted a header carrying no `typ` at all, as a
//    one-release compatibility window for v1 artifacts. That window is over (§2): an untyped
//    document is a document whose call site cannot be proved, so it is refused. Pinned by
//    `typ-missing-rejected`.
// 2. `maxPayloadBytes` is a RAISE-ONLY override, and only `plrs-bundle+jws` uses it (§1). It
//    is raise-only because lowering the frozen cap is not a decision a call site gets to make,
//    and it is coupled to a REQUIRED `typ` because otherwise a 256 KiB untyped blob accepted
//    here could be re-presented at an ordinary document call site.

import CryptoKit
import Foundation

/// A trust set: `kid` → raw 32-byte Ed25519 public key, base64url-encoded.
public typealias TrustSet = [String: String]

/// Document-type domain separator (§2). One signing key signs every artifact a product emits,
/// so without this a trust manifest can be replayed where a license document is expected —
/// which in v2 only failed by accident, via a swallowed decode error (R2-10).
public enum JwsTyp: String, Sendable, Equatable, CaseIterable {
    case license = "plrs-license+jws"
    case config = "plrs-config+jws"
    case trust = "plrs-trust+jws"
    case bundle = "plrs-bundle+jws"
}

/// The successful result of a JWS verification: the selected `kid` + the signed payload bytes.
public struct VerifiedJws: Sendable, Equatable {
    public let kid: String
    /// The RAW signed payload. Typed decoding is the caller's, after this returns — see
    /// `verifyDoc`.
    public let payload: Data
}

public enum JWSVerifier {
    /// Hard cap on the decoded payload before JSON decoding, bounding parser work on
    /// adversarial input (§1). `plrs-bundle+jws` raises it to `MAX_BUNDLE_BYTES`; nothing else
    /// may.
    public static let maxPayloadBytes = 65_536

    /// Hard cap on the decoded PROTECTED HEADER. A legitimate header is ~60 bytes. Without this
    /// the payload cap is trivially bypassed by moving the blob into the header instead — an
    /// 8 MiB header was decoded and parsed pre-verification (audit finding R2-04).
    public static let maxHeaderBytes = 1_024

    /// Encoded-form caps, checked BEFORE decoding so an oversized blob is never allocated.
    static func b64Cap(_ bytes: Int) -> Int { (bytes * 4 + 2) / 3 + 4 }
    public static let maxHeaderB64 = b64Cap(maxHeaderBytes)
    public static let maxPayloadB64 = b64Cap(maxPayloadBytes)

    /// The protected header, decoded with `JSONDecoder` only — never `JSONSerialization`, whose
    /// FIRST-wins duplicate-key resolution is what made Swift disagree with TS/Python on
    /// `{"alg":"none",…,"alg":"EdDSA"}` (audit finding R2-06). Duplicates are rejected by a raw
    /// pre-scan before this ever runs.
    private struct ProtectedHeader: Decodable {
        let alg: String?
        let typ: String?
        let kid: String?
    }

    /// Verify a compact JWS against a trust set and return the signed payload BYTES.
    ///
    /// - Parameters:
    ///   - typ: the document type the CALL SITE expects. A header carrying a different one is a
    ///     cross-protocol replay attempt and is refused.
    ///   - requireTyp: reject a header carrying NO `typ`. True on every v3 path (§2).
    ///   - maxPayloadBytes: raise the payload cap for this call. Only `plrs-bundle+jws` does,
    ///     and only to `MAX_BUNDLE_BYTES`; a value below the frozen cap is ignored, and a raise
    ///     without a required `typ` is refused outright.
    ///
    /// Returns `nil` on ANY failure. Never throws — every call site fails closed identically.
    public static func verify(
        _ jws: String,
        trust: TrustSet,
        typ: JwsTyp?,
        requireTyp: Bool = true,
        maxPayloadBytes overrideCap: Int? = nil
    ) -> VerifiedJws? {
        // RAISE-ONLY, and only with a proven type. The cap and the `typ` travel together: a
        // raised cap granted to an untyped artifact is exactly the confusion §1's exception
        // exists to avoid.
        let payloadCap = Swift.max(overrideCap ?? maxPayloadBytes, maxPayloadBytes)
        if payloadCap > maxPayloadBytes, typ == nil || !requireTyp { return nil }
        let payloadCapB64 = b64Cap(payloadCap)

        // 1. Structure: exactly three "."-separated segments.
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let encHeader = String(parts[0])
        let encPayload = String(parts[1])
        let encSig = String(parts[2])

        // 2-3. Bound the ENCODED segments before decoding anything, so an oversized blob is
        //      rejected before it is ever allocated.
        guard encHeader.utf8.count <= maxHeaderB64, encPayload.utf8.count <= payloadCapB64
        else { return nil }

        // 4-5. Strict base64url-decode the header, then bound the DECODED bytes.
        guard let headerData = Base64URL.decodeStrict(encHeader),
            headerData.count <= maxHeaderBytes
        else { return nil }

        // 6. Parse the header, REJECTING duplicate object keys (never first- or last-wins).
        guard let header = StrictJSON.decode(ProtectedHeader.self, from: headerData)
        else { return nil }

        // 7. Assert alg == EdDSA — BEFORE any signature math. This is the algorithm-downgrade
        //    guard: `none`/HS/ES are rejected here.
        guard header.alg == "EdDSA" else { return nil }

        // 8. Domain separation (§2). An absent `typ` is refused on every v3 path; a header
        //    asserting a type other than the one this call site expects is a replay attempt.
        if requireTyp && header.typ == nil { return nil }
        if let headerTyp = header.typ, let expected = typ, headerTyp != expected.rawValue {
            return nil
        }

        // 9-10. `kid` must be a string, and the verifying key comes FROM THE TRUST SET (never
        //       from the doc). A revoked kid is absent from the set by construction.
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
            payloadData.count <= payloadCap,
            !StrictJSON.hasDuplicateKeys(payloadData)
        else { return nil }

        return VerifiedJws(kid: kid, payload: payloadData)
    }

    /// Verify and decode in one step, for callers that want the typed payload and nothing else.
    /// Claim validation is NOT here — see `verifyDoc` (§3).
    public static func verifyDecoding<T: Decodable>(
        _ type: T.Type,
        _ jws: String,
        trust: TrustSet,
        typ: JwsTyp?,
        requireTyp: Bool = true,
        maxPayloadBytes overrideCap: Int? = nil
    ) -> T? {
        guard
            let verified = verify(
                jws, trust: trust, typ: typ, requireTyp: requireTyp,
                maxPayloadBytes: overrideCap)
        else { return nil }
        return try? JSONDecoder().decode(type, from: verified.payload)
    }
}

// ── Strict JSON: duplicate keys are a hard failure ─────────────────────────────────

/// JSON parsing that REJECTS duplicate object keys anywhere in the document.
///
/// Silent resolution is a differential across implementations: `JSON.parse` and `json.loads`
/// keep the LAST member, `JSONSerialization` keeps the FIRST, so
/// `{"alg":"none","kid":"x","alg":"EdDSA"}` read as `EdDSA` in TS/Python and `none` in Swift —
/// the algorithm-downgrade guard giving opposite answers for identical signed bytes (audit
/// finding R2-06). §1 resolves it by rejecting outright, so no implementation has to be "right"
/// about which member wins.
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

    /// Resolve a raw JSON string literal (escapes and all) to the key it denotes, so `"a"` and
    /// `"a"` collide the way every JSON parser makes them collide. Wrapped in an array because
    /// a bare string is a JSON fragment.
    private static func unescape(_ literal: ArraySlice<UInt8>) -> String? {
        var wrapped = Data([UInt8(ascii: "["), UInt8(ascii: "\"")])
        wrapped.append(contentsOf: literal)
        wrapped.append(contentsOf: [UInt8(ascii: "\""), UInt8(ascii: "]")])
        return (try? JSONDecoder().decode([String].self, from: wrapped))?.first
    }
}

/// Saturating add. Timestamps in a signed payload are attacker-influenced `Int`s and Swift TRAPS
/// on overflow, so `issuedAt + MAX_GRACE_SECONDS` written as a plain `+` is a remote crash on a
/// doc carrying `Int.max`. Every claim comparison goes through this.
public func saturatingAdd(_ a: Int, _ b: Int) -> Int {
    let (sum, overflowed) = a.addingReportingOverflow(b)
    guard overflowed else { return sum }
    return b > 0 ? Int.max : Int.min
}
