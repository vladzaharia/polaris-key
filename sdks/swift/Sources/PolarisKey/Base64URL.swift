// base64url <-> bytes — mirrors @polaris-key/jws's `base64UrlDecode`/`base64UrlEncode`
// exactly so the Swift verifier is byte-stable against the cross-language corpus.
//
// Decode maps the URL-safe alphabet (`-_`) back to (`+/`), right-pads with "=" to a
// multiple of 4, then defers to `Data(base64Encoded:)`. Encode strips the padding and
// swaps to the URL-safe alphabet — the wire form is always unpadded.

import Foundation

public enum Base64URL {
    /// Decode a base64url string (URL-safe alphabet, padding optional). Returns nil on
    /// any character / structure error — verification treats that as a hard failure.
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
