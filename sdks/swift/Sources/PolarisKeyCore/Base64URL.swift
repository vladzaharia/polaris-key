// base64url <-> bytes — mirrors @polaris-key/jws's `base64UrlDecode`/`base64UrlEncode`
// exactly so the Swift verifier is byte-stable against the cross-language corpus.
//
// Decode maps the URL-safe alphabet (`-_`) back to (`+/`), right-pads with "=" to a
// multiple of 4, then defers to `Data(base64Encoded:)`. Encode strips the padding and
// swaps to the URL-safe alphabet — the wire form is always unpadded.

import Foundation

public enum Base64URL {
    /// The unpadded base64url alphabet. Nothing else is a valid JWS segment.
    private static let alphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    /// Strict base64url decode for WIRE segments (header / payload / signature): the `-_`
    /// alphabet only — no `+`/`/`, no `=` padding, no whitespace, no other byte.
    ///
    /// `Data(base64Encoded:)` already rejects junk, but it happily accepts the STANDARD
    /// alphabet (`+/`) and explicit padding once we have re-padded, which made the same
    /// mangled token decode differently across SDKs (audit finding R2-05). Wire contract v2
    /// §2.3 requires every language to reject rather than tolerate. Returns nil, never throws.
    public static func decodeStrict(_ s: String) -> Data? {
        guard isCanonical(s) else { return nil }
        return decode(s)
    }

    /// Canonical unpadded base64url (V4 §1): the URL-safe alphabet only, a length that is not
    /// 1 mod 4, and zero unused low bits in the last character (4 bits when the length is 2
    /// mod 4, 2 bits when it is 3 mod 4). Equivalent to "re-encoding the decoded bytes gives
    /// the input".
    public static func isCanonical(_ s: String) -> Bool {
        var count = 0
        var last: Character = "A"
        for ch in s {
            guard alphabet.contains(ch) else { return false }
            count += 1
            last = ch
        }
        let rem = count % 4
        if rem == 1 { return false }
        if rem == 0 { return true }
        guard let value = valueOf(last) else { return false }
        let unused = rem == 2 ? 0b1111 : 0b11
        return value & unused == 0
    }

    private static func valueOf(_ ch: Character) -> Int? {
        guard let a = ch.asciiValue else { return nil }
        switch a {
        case 65...90: return Int(a) - 65
        case 97...122: return Int(a) - 97 + 26
        case 48...57: return Int(a) - 48 + 52
        case 45: return 62
        case 95: return 63
        default: return nil
        }
    }

    /// Decode a base64url string (URL-safe alphabet, padding optional). Returns nil on
    /// any character / structure error — verification treats that as a hard failure.
    ///
    /// Lenient about the standard alphabet, matching `@polaris-key/jws`'s `base64UrlDecode`,
    /// which is still used for trust-set key material. JWS segments MUST use
    /// `decodeStrict(_:)` instead.
    public static func decode(_ s: String) -> Data? {
        var b64 = s.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = b64.count % 4
        if remainder != 0 {
            b64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: b64)
    }

    /// Encode bytes as unpadded base64url.
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Encode a UTF-8 string as unpadded base64url (the header/payload encoder).
    public static func encode(string s: String) -> String {
        encode(Data(s.utf8))
    }
}
