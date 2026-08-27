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
        for ch in s where !alphabet.contains(ch) { return nil }
        return decode(s)
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
