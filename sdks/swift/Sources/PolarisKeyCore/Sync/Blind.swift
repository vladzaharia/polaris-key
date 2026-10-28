// Blinded names (WIRE-CONTRACT-V5 §13.10.3):
// `blind(kind, ctx, n) = "x:" + base64url(HMAC-SHA256(K_names, kind 0x00 ctx 0x00 n))`.
// The server compares blinded names by bytes and never learns the plaintext.

import Foundation

public enum SyncBlind {
    public enum Kind: String, Sendable {
        case setting, member, record, field, element
    }

    /// The prefix no declared key or collection name may carry.
    public static let prefix = "x:"

    /// `ctx` is the declared setting key or collection name that scopes the name, `n` the
    /// person's own name (an element is its canonical JSON, see `CanonicalJSON`).
    public static func blind(root: Data, kind: Kind, ctx: String, n: String) -> String {
        let key = SyncCrypto.deriveNamesKey(root: root)
        let mac = SyncCrypto.hmac(key: key, data: Data("\(kind.rawValue)\u{0}\(ctx)\u{0}\(n)".utf8))
        return prefix + Base64URL.encode(mac)
    }

    /// True for the shape of a blinded name (`^x:[A-Za-z0-9_-]{43}$`).
    public static func isBlindedName(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 45, u[0] == 0x78, u[1] == 0x3A else { return false }
        return u[2...].allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
                || $0 == 0x2D || $0 == 0x5F
        }
    }
}
