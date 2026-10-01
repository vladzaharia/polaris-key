// The Polaris Key wire crypto: compact JWS (EdDSA / Ed25519) verification, natively on CryptoKit.
// This is a byte-for-byte re-implementation of `@polaris-key/jws`'s `verifyJws` — the cross-language
// conformance corpus (`conformance/corpus/v2`, `jwsCases`) pins them identical. See
// docs/security/WIRE-CONTRACT-V4.md §1 for the normative ordering this file implements.
//
// ── WIRE CONTRACT v4 (§1.1, §1.2), for every `typ` ──────────────────────────────────────────
//
// 1. Ed25519 pre-checks before CryptoKit's verify: `S < L`, canonical `A` and `R`, and neither
//    of the eight small-order encodings. CryptoKit refuses non-canonical points itself; every
//    backend measured accepted a small-order `R` and key.
// 2. `StrictJSON.validate`, a byte-level RFC 8259 scanner over the header and the payload:
//    well-formed UTF-8 with no BOM, exactly one object, no trailing comma, no `NaN`, no raw
//    control character, no lone surrogate, member names unique by Unicode scalars (never
//    `String` equality, which is canonical equivalence) and free of U+0000, every number inside
//    binary64's range judged from its digits, and at most `MAX_JSON_DEPTH` levels. It reports
//    `nonWireIntegers`, from which every integer claim is decided (V4 §3), keyed by scalars.
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
// 2. `maxPayloadBytes` is a RAISE-ONLY override, and only `pkey-bundle+jws` uses it (§1). It
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
    case license = "pkey-license+jws"
    case config = "pkey-config+jws"
    case trust = "pkey-trust+jws"
    case bundle = "pkey-bundle+jws"
    /// Wire contract v4 §2.3: the channel feed, signed by the product key.
    case feed = "pkey-feed+jws"
    /// Wire contract v4 §2.4: the release record, signed by a CI-held release key.
    case release = "pkey-release+jws"
}

/// The RFC 6901 pointers of a payload's number tokens that cannot be wire integers (a fraction
/// or exponent part, or digits above 2^53 − 1), keyed by Unicode scalars like member names.
public typealias NonWireIntegers = Set<[Unicode.Scalar]>

/// WIRE-CONTRACT-V4 §3: an integer claim is a plain integer token from the claim's minimum to
/// 2^53 − 1, decided from the token (`pointer` must not be in `nonWire`) and never from the
/// number `JSONDecoder` made of it — it decodes `1700000000.00000001` as an `Int`. The minimum
/// is the claim's own: 0 for every timestamp, 1 for `schemaVersion` and every `seq`.
public func wireInteger(
    _ value: Int?, pointer: String, min: Int, in nonWire: NonWireIntegers
) -> Bool {
    guard let v = value else { return false }
    if nonWire.contains(Array(pointer.unicodeScalars)) { return false }
    return v >= min && v <= MAX_WIRE_INTEGER
}

/// The successful result of a JWS verification: the selected `kid` + the signed payload bytes.
public struct VerifiedJws: Sendable, Equatable {
    public let kid: String
    /// The RAW signed payload. Typed decoding is the caller's, after this returns — see
    /// `verifyDoc`.
    public let payload: Data
    /// WIRE-CONTRACT-V4 §3: the payload's non-wire-integer pointers.
    public let nonWireIntegers: NonWireIntegers

    public init(kid: String, payload: Data, nonWireIntegers: NonWireIntegers = []) {
        self.kid = kid
        self.payload = payload
        self.nonWireIntegers = nonWireIntegers
    }
}

public enum JWSVerifier {
    /// Hard cap on the decoded payload before JSON decoding, bounding parser work on
    /// adversarial input (§1). `pkey-bundle+jws` raises it to `MAX_BUNDLE_BYTES`; nothing else
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
    ///   - maxPayloadBytes: raise the payload cap for this call. Only `pkey-bundle+jws` does,
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

        // 6. Parse the header under V4 §1.2 (duplicate keys refused, never first- or last-wins).
        guard StrictJSON.validate(headerData) != nil,
            let header = try? JSONDecoder().decode(ProtectedHeader.self, from: headerData)
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
        // V4 §1.1: S < L, canonical A and R, no small-order A or R — before CryptoKit.
        guard Ed25519Strict.prechecks(key: [UInt8](rawKey), sig: [UInt8](sig)) else { return nil }
        let signingInput = Data((encHeader + "." + encPayload).utf8)
        guard publicKey.isValidSignature(sig, for: signingInput) else { return nil }

        // 13. ONLY NOW decode the payload, bound it, and validate it under V4 §1.2.
        guard let payloadData = Base64URL.decodeStrict(encPayload),
            payloadData.count <= payloadCap,
            let nonWire = StrictJSON.validate(payloadData)
        else { return nil }

        return VerifiedJws(kid: kid, payload: payloadData, nonWireIntegers: nonWire)
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
///
/// `decode` and `hasDuplicateKeys` are the JWS path and are unchanged by P1b-04. The four
/// `package` scanners below serve the config environment rule (WIRE-CONTRACT-V3 §2.2.1 rule 2),
/// and are the building blocks P3-02 reuses for documents.
package enum StrictJSON {
    /// Decode `T`, first pre-scanning the RAW bytes for duplicate keys. `JSONDecoder` alone
    /// cannot help: duplicates are collapsed before any `Decodable` sees them.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
        guard !hasDuplicateKeys(data) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// True if any JSON object in `data` declares the same key twice. Names are keyed by
    /// `String`, whose equality is canonical equivalence (the JWS path; P3-01 and P3-02 move it
    /// to scalar keys). Mirrors `hasDuplicateKeys` in `packages/shared-jws/src/index.ts`.
    static func hasDuplicateKeys(_ data: Data) -> Bool {
        scanMemberNames(data) { name in name }
    }

    /// §2.2.1 rule 2's member-name checks: true when an object declares two members whose names
    /// are the same sequence of Unicode scalar values after unescaping (never normalized, so
    /// `"\u00e9"` and `"e\u0301"` are two names), when a name holds U+0000, or when a name
    /// cannot be decoded (a lone surrogate).
    package static func hasRefusedMemberName(_ data: Data) -> Bool {
        scanMemberNames(data) { name -> [Unicode.Scalar]? in
            let scalars = Array(name.unicodeScalars)
            return scalars.contains(Unicode.Scalar(0)) ? nil : scalars
        }
    }

    /// The raw-text scanner behind both: it tracks one key set per open object (`nil` marks an
    /// array, whose commas do not introduce keys) and stores `key(name)` for each member name.
    /// A name for which `key` returns nil, or that cannot be unescaped, is refused.
    private static func scanMemberNames<K: Hashable>(
        _ data: Data, key makeKey: (String) -> K?
    ) -> Bool {
        let bytes = [UInt8](data)
        var stack: [Set<K>?] = []
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
                        guard let name = unescape(literal), let key = makeKey(name) else {
                            return true  // unparseable or refused key — refuse rather than guess
                        }
                        if stack[stack.count - 1]!.contains(key) { return true }
                        stack[stack.count - 1]!.insert(key)
                    }
                    expectKey = false
                }
                continue
            }
            if c == UInt8(ascii: "{") {
                stack.append(Set<K>())
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

    /// True when more than `max` arrays and objects are open at some point (§2.2.1 rule 2).
    /// String contents are skipped (a backslash skips the next byte). Exact for every text
    /// `JSONDecoder` accepts, which also enforces no bound below 512 itself.
    package static func nestingExceeds(_ data: Data, _ max: Int) -> Bool {
        var depth = 0
        var inString = false
        var i = 0
        let bytes = [UInt8](data)
        while i < bytes.count {
            let c = bytes[i]
            if inString {
                if c == UInt8(ascii: "\\") {
                    i += 1
                } else if c == UInt8(ascii: "\"") {
                    inString = false
                }
            } else if c == UInt8(ascii: "\"") {
                inString = true
            } else if c == UInt8(ascii: "[") || c == UInt8(ascii: "{") {
                depth += 1
                if depth > max { return true }
            } else if c == UInt8(ascii: "]") || c == UInt8(ascii: "}") {
                depth -= 1
            }
            i += 1
        }
        return false
    }

    /// True when an object or array closes right after a comma (§2.2.1 rule 2). `JSONDecoder`
    /// accepts `[1,2,]` and `{"a":1,}`; RFC 8259 does not.
    package static func hasTrailingComma(_ data: Data) -> Bool {
        let bytes = [UInt8](data)
        var inString = false
        var afterComma = false
        var i = 0
        while i < bytes.count {
            let c = bytes[i]
            if inString {
                if c == UInt8(ascii: "\\") {
                    i += 1
                } else if c == UInt8(ascii: "\"") {
                    inString = false
                }
                i += 1
                continue
            }
            switch c {
            case UInt8(ascii: " "), UInt8(ascii: "\t"), UInt8(ascii: "\n"), UInt8(ascii: "\r"):
                break
            case UInt8(ascii: ","):
                afterComma = true
            case UInt8(ascii: "]"), UInt8(ascii: "}"):
                if afterComma { return true }
            default:
                afterComma = false
                if c == UInt8(ascii: "\"") { inString = true }
            }
            i += 1
        }
        return false
    }

    /// True when every number token outside a string is in §2.2.1 rule 2's range. A token is the
    /// run of digits, `.`, `e`, `E`, `+` and `-` at each `-` or digit.
    package static func numbersInRange(_ data: Data) -> Bool {
        let bytes = [UInt8](data)
        var inString = false
        var i = 0
        while i < bytes.count {
            let c = bytes[i]
            if inString {
                if c == UInt8(ascii: "\\") {
                    i += 2
                } else {
                    if c == UInt8(ascii: "\"") { inString = false }
                    i += 1
                }
                continue
            }
            if c == UInt8(ascii: "\"") {
                inString = true
                i += 1
                continue
            }
            if c == UInt8(ascii: "-") || isDigit(c) {
                let start = i
                while i < bytes.count && isNumberRunByte(bytes[i]) { i += 1 }
                if !numberTokenInRange(bytes[start..<i]) { return false }
                continue
            }
            i += 1
        }
        return true
    }

    private static func isDigit(_ c: UInt8) -> Bool {
        c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
    }

    private static func isNumberRunByte(_ c: UInt8) -> Bool {
        isDigit(c) || c == UInt8(ascii: ".") || c == UInt8(ascii: "e")
            || c == UInt8(ascii: "E") || c == UInt8(ascii: "+") || c == UInt8(ascii: "-")
    }

    /// Judge one number token from its decimal digits, with no floating point. In range when its
    /// exponent part has at most six significant digits and the number is zero or its first
    /// non-zero digit's power of ten is from -307 to 307. Every byte is checked to be a digit
    /// before `0x30` is subtracted, and every count stays far below `Int.max`, so a malformed
    /// run such as `1e5-5` (which `JSONDecoder` refuses anyway) cannot trap.
    package static func numberTokenInRange<C: Collection>(_ token: C) -> Bool
    where C.Element == UInt8 {
        let t = Array(token)
        var i = 0
        if i < t.count && t[i] == UInt8(ascii: "-") { i += 1 }
        var intDigits = 0
        var leadingZeros = 0
        var sawNonZero = false
        while i < t.count && isDigit(t[i]) {
            if !sawNonZero {
                if t[i] == UInt8(ascii: "0") { leadingZeros += 1 } else { sawNonZero = true }
            }
            intDigits += 1
            i += 1
        }
        if i < t.count && t[i] == UInt8(ascii: ".") {
            i += 1
            while i < t.count && isDigit(t[i]) {
                if !sawNonZero {
                    if t[i] == UInt8(ascii: "0") { leadingZeros += 1 } else { sawNonZero = true }
                }
                i += 1
            }
        }
        var exponent = 0
        if i < t.count && (t[i] == UInt8(ascii: "e") || t[i] == UInt8(ascii: "E")) {
            i += 1
            var negative = false
            if i < t.count && (t[i] == UInt8(ascii: "+") || t[i] == UInt8(ascii: "-")) {
                negative = t[i] == UInt8(ascii: "-")
                i += 1
            }
            var significant = 0
            while i < t.count && isDigit(t[i]) {
                let d = Int(t[i] - UInt8(ascii: "0"))
                if significant > 0 || d != 0 {
                    significant += 1
                    if significant > maxExponentDigits { return false }
                    exponent = exponent * 10 + d
                }
                i += 1
            }
            if negative { exponent = -exponent }
        }
        if !sawNonZero { return true }  // every digit is zero
        let power = intDigits - 1 - leadingZeros + exponent
        return power >= -maxDecimalExponent && power <= maxDecimalExponent
    }

    /// §2.2.1 rule 2's limits, restated as literals in every SDK.
    package static let maxDepth = 64
    private static let maxDecimalExponent = 307
    private static let maxExponentDigits = 6

    /// Resolve a raw JSON string literal (escapes and all) to the key it denotes, so `"a"` and
    /// `"\u0061"` collide the way every JSON parser makes them collide. Wrapped in an array
    /// because a bare string is a JSON fragment. `JSONDecoder` refuses a lone surrogate.
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

// ── Ed25519 strictness (WIRE-CONTRACT-V4 §1.1) ─────────────────────────────────────

/// Byte comparisons on the trusted key `A` and the signature `R ‖ S`, run before the backend.
public enum Ed25519Strict {
    /// The group order L, little-endian.
    static let l: [UInt8] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x10,
    ]
    /// The field prime p = 2^255 − 19, little-endian.
    static let p: [UInt8] = [0xed] + [UInt8](repeating: 0xff, count: 30) + [0x7f]

    /// The eight small-order encodings, lowercase hex (V4 §1.1 check 3).
    public static let smallOrderEncodings: Set<String> = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]
    static let negativeZero: Set<String> = [
        "0100000000000000000000000000000000000000000000000000000000000080",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ]

    /// `a < b` for two 32-byte little-endian integers.
    static func lessThan(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        for k in stride(from: 31, through: 0, by: -1) where a[k] != b[k] { return a[k] < b[k] }
        return false
    }

    static func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// Checks 2–3 for one 32-byte encoding.
    static func acceptablePoint(_ enc: [UInt8]) -> Bool {
        guard enc.count == 32 else { return false }
        var y = enc
        y[31] &= 0x7f
        guard lessThan(y, p) else { return false }
        let h = hex(enc)
        return !negativeZero.contains(h) && !smallOrderEncodings.contains(h)
    }

    /// V4 §1.1 checks 1–3.
    public static func prechecks(key: [UInt8], sig: [UInt8]) -> Bool {
        guard key.count == 32, sig.count == 64 else { return false }
        guard lessThan(Array(sig[32..<64]), l) else { return false }
        return acceptablePoint(key) && acceptablePoint(Array(sig[0..<32]))
    }
}

// ── Strict JSON (WIRE-CONTRACT-V4 §1.2) ────────────────────────────────────────────

extension StrictJSON {
    /// Validate one header or payload byte for byte under V4 §1.2 rules 1–9 and RFC 8259's
    /// grammar, returning its non-wire-integer pointers, or nil when it is refused.
    package static func validate(_ data: Data) -> NonWireIntegers? {
        var scanner = StrictScanner(bytes: [UInt8](data))
        return scanner.run()
    }
}

/// The byte-level scanner behind `StrictJSON.validate`. Recursion is bounded by
/// `MAX_JSON_DEPTH`, which it refuses past before descending.
struct StrictScanner {
    let b: [UInt8]
    var i = 0
    var nonWire: NonWireIntegers = []

    init(bytes: [UInt8]) { b = bytes }

    static let maxWireDigits: [UInt8] = Array("9007199254740991".utf8)

    mutating func run() -> NonWireIntegers? {
        ws()
        guard i < b.count, b[i] == UInt8(ascii: "{") else { return nil }
        guard value(depth: 0, pointer: []) else { return nil }
        ws()
        return i == b.count ? nonWire : nil
    }

    mutating func ws() {
        while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 }
    }

    static func token(_ name: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        for s in name {
            if s == "~" {
                out += ["~", "0"]
            } else if s == "/" {
                out += ["~", "1"]
            } else {
                out.append(s)
            }
        }
        return out
    }

    mutating func value(depth: Int, pointer: [Unicode.Scalar]) -> Bool {
        ws()
        guard i < b.count else { return false }
        let c = b[i]
        if c == UInt8(ascii: "{") {
            guard depth + 1 <= MAX_JSON_DEPTH else { return false }
            i += 1
            ws()
            if i < b.count, b[i] == UInt8(ascii: "}") {
                i += 1
                return true
            }
            var names = Set<[Unicode.Scalar]>()
            while true {
                ws()
                guard let name = string() else { return false }
                if name.contains(Unicode.Scalar(UInt8(0))) { return false }
                guard names.insert(name).inserted else { return false }
                ws()
                guard i < b.count, b[i] == UInt8(ascii: ":") else { return false }
                i += 1
                guard value(depth: depth + 1, pointer: pointer + ["/"] + Self.token(name))
                else { return false }
                ws()
                guard i < b.count else { return false }
                if b[i] == UInt8(ascii: ",") {
                    i += 1
                    continue
                }
                if b[i] == UInt8(ascii: "}") {
                    i += 1
                    return true
                }
                return false
            }
        }
        if c == UInt8(ascii: "[") {
            guard depth + 1 <= MAX_JSON_DEPTH else { return false }
            i += 1
            ws()
            if i < b.count, b[i] == UInt8(ascii: "]") {
                i += 1
                return true
            }
            var index = 0
            while true {
                let element = pointer + ["/"] + String(index).unicodeScalars
                guard value(depth: depth + 1, pointer: element) else { return false }
                index += 1
                ws()
                guard i < b.count else { return false }
                if b[i] == UInt8(ascii: ",") {
                    i += 1
                    continue
                }
                if b[i] == UInt8(ascii: "]") {
                    i += 1
                    return true
                }
                return false
            }
        }
        if c == UInt8(ascii: "\"") { return string() != nil }
        if c == UInt8(ascii: "-") || (c >= 0x30 && c <= 0x39) { return number(pointer) }
        for lit in ["true", "false", "null"] {
            let bytes = Array(lit.utf8)
            if i + bytes.count <= b.count, Array(b[i..<i + bytes.count]) == bytes {
                i += bytes.count
                return true
            }
        }
        return false
    }

    mutating func hex4() -> UInt32? {
        guard i + 4 <= b.count else { return nil }
        var v: UInt32 = 0
        for k in 0..<4 {
            let c = b[i + k]
            let d: UInt32
            switch c {
            case 0x30...0x39: d = UInt32(c - 0x30)
            case 0x41...0x46: d = UInt32(c - 0x41 + 10)
            case 0x61...0x66: d = UInt32(c - 0x61 + 10)
            default: return nil
            }
            v = v * 16 + d
        }
        i += 4
        return v
    }

    /// One string, decoded to Unicode scalars: refuses raw control characters, bad escapes,
    /// lone surrogates (rule 5) and ill-formed UTF-8 (rule 1: overlongs, encoded surrogates and
    /// anything above U+10FFFF included).
    mutating func string() -> [Unicode.Scalar]? {
        guard i < b.count, b[i] == UInt8(ascii: "\"") else { return nil }
        i += 1
        var out: [Unicode.Scalar] = []
        while true {
            guard i < b.count else { return nil }
            let c = b[i]
            if c == UInt8(ascii: "\"") {
                i += 1
                return out
            }
            if c < 0x20 { return nil }
            if c == UInt8(ascii: "\\") {
                i += 1
                guard i < b.count else { return nil }
                let e = b[i]
                i += 1
                switch e {
                case UInt8(ascii: "\""): out.append("\"")
                case UInt8(ascii: "\\"): out.append("\\")
                case UInt8(ascii: "/"): out.append("/")
                case UInt8(ascii: "b"): out.append("\u{08}")
                case UInt8(ascii: "f"): out.append("\u{0C}")
                case UInt8(ascii: "n"): out.append("\n")
                case UInt8(ascii: "r"): out.append("\r")
                case UInt8(ascii: "t"): out.append("\t")
                case UInt8(ascii: "u"):
                    guard let u = hex4() else { return nil }
                    if u >= 0xD800 && u <= 0xDBFF {
                        guard i + 2 <= b.count, b[i] == UInt8(ascii: "\\"), b[i + 1] == UInt8(ascii: "u")
                        else { return nil }
                        i += 2
                        guard let low = hex4(), low >= 0xDC00, low <= 0xDFFF else { return nil }
                        let cp = 0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00)
                        guard let s = Unicode.Scalar(cp) else { return nil }
                        out.append(s)
                    } else if u >= 0xDC00 && u <= 0xDFFF {
                        return nil
                    } else {
                        guard let s = Unicode.Scalar(u) else { return nil }
                        out.append(s)
                    }
                default:
                    return nil
                }
                continue
            }
            if c < 0x80 {
                out.append(Unicode.Scalar(c))
                i += 1
                continue
            }
            guard let s = utf8Scalar() else { return nil }
            out.append(s)
        }
    }

    /// One multi-byte UTF-8 sequence, strictly (RFC 3629 Table 3-7).
    mutating func utf8Scalar() -> Unicode.Scalar? {
        let c = b[i]
        var need = 0
        var lo: UInt8 = 0x80
        var hi: UInt8 = 0xBF
        var cp: UInt32 = 0
        switch c {
        case 0xC2...0xDF: need = 1; cp = UInt32(c & 0x1F)
        case 0xE0: need = 2; lo = 0xA0; cp = UInt32(c & 0x0F)
        case 0xE1...0xEC, 0xEE...0xEF: need = 2; cp = UInt32(c & 0x0F)
        case 0xED: need = 2; hi = 0x9F; cp = UInt32(c & 0x0F)
        case 0xF0: need = 3; lo = 0x90; cp = UInt32(c & 0x07)
        case 0xF1...0xF3: need = 3; cp = UInt32(c & 0x07)
        case 0xF4: need = 3; hi = 0x8F; cp = UInt32(c & 0x07)
        default: return nil
        }
        guard i + need < b.count else { return nil }
        for k in 1...need {
            let x = b[i + k]
            let (min, max) = k == 1 ? (lo, hi) : (UInt8(0x80), UInt8(0xBF))
            guard x >= min && x <= max else { return nil }
            cp = (cp << 6) | UInt32(x & 0x3F)
        }
        i += need + 1
        return Unicode.Scalar(cp)
    }

    /// One number token (RFC 8259 grammar), judged under rule 8, recorded when it cannot be a
    /// wire integer.
    mutating func number(_ pointer: [Unicode.Scalar]) -> Bool {
        let start = i
        func digit(_ k: Int) -> Bool { k < b.count && b[k] >= 0x30 && b[k] <= 0x39 }
        if b[i] == UInt8(ascii: "-") { i += 1 }
        guard digit(i) else { return false }
        if b[i] == 0x30 {
            i += 1
        } else {
            while digit(i) { i += 1 }
        }
        var plain = true
        if i < b.count, b[i] == UInt8(ascii: ".") {
            plain = false
            i += 1
            guard digit(i) else { return false }
            while digit(i) { i += 1 }
        }
        if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
            plain = false
            i += 1
            if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
            guard digit(i) else { return false }
            while digit(i) { i += 1 }
        }
        let token = b[start..<i]
        guard StrictJSON.numberTokenInRange(token) else { return false }
        var digits = Array(token)
        if digits.first == UInt8(ascii: "-") { digits.removeFirst() }
        let tooBig =
            digits.count > Self.maxWireDigits.count
            || (digits.count == Self.maxWireDigits.count
                && digits.lexicographicallyPrecedes(Self.maxWireDigits) == false
                && digits != Self.maxWireDigits)
        if !plain || tooBig { nonWire.insert(pointer) }
        return true
    }
}