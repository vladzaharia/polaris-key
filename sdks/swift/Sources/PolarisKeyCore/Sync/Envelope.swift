// `pkey-sync-value/1` (WIRE-CONTRACT-V5 §13.10.4): one sealed setting, record, member, field or
// element value.
//
//   0x01 | kid(16) | salt(16) | AES-256-GCM(K_msg, nonce 0x00*12, aad = the first 33 bytes, P)
//
// `P` is the UTF-8 canonical JSON `{"k": name, "v": value}` padded with 0x80 then zeros to a
// multiple of 64 bytes (at least one byte of padding).

import Foundation

public enum SyncEnvelope {
    public static let version: UInt8 = 0x01
    /// Version, kid and salt: the associated data.
    public static let headerBytes = 33
    /// Header and tag.
    public static let fixedBytes = 49
    public static let padBlock = 64
    /// Fixed bytes and at most one block of padding.
    public static let overheadBytes = 113

    /// Why a reader refuses an envelope, in the order it checks.
    public enum Invalid: String, Sendable, Equatable {
        case shape, version, kid, auth, padding, json, name
    }

    public enum Opened: Sendable {
        case ok(name: String, value: JSONValue)
        case invalid(Invalid)

        public var isOK: Bool { if case .ok = self { return true } else { return false } }
        public var reason: Invalid? { if case .invalid(let r) = self { return r } else { return nil } }
    }

    private static func pad(_ p: Data) -> Data {
        let total = (p.count / padBlock) * padBlock + padBlock
        var out = p
        out.append(0x80)
        out.append(Data(count: total - out.count))
        return out
    }

    /// The bytes before the padding, or nil when the padding is not `0x80` and zeros.
    private static func unpad(_ p: Data) -> Data? {
        var end = p.count
        while end > 0, p[p.startIndex + end - 1] == 0 { end -= 1 }
        if end == 0 || p[p.startIndex + end - 1] != 0x80 { return nil }
        return p.prefix(end - 1)
    }

    /// Seals `value` under `name` in `collection`. `salt` (16 bytes) is fresh randomness unless a
    /// test fixes it. Throws for a value canonical JSON refuses.
    public static func seal(
        root: Data, collection: String, name: String, value: JSONValue,
        salt: Data = SyncCrypto.random(SyncCrypto.valueSaltBytes)
    ) throws -> Data {
        guard salt.count == SyncCrypto.valueSaltBytes else { throw SyncCryptoError.badLength("salt") }
        let kid = SyncCrypto.deriveKid(root: root)
        let collKey = SyncCrypto.deriveCollKey(root: root, collection: collection)
        let key = SyncCrypto.deriveValueKey(collKey: collKey, salt: salt)
        let header = Data([version]) + kid + salt
        let p = pad(try CanonicalJSON.encodeBytes(.object(["k": .string(name), "v": value])))
        return header + (try SyncCrypto.aesGcmSeal(key: key, aad: header, plaintext: p))
    }

    /// Opens an envelope for `name` (or one of its `aliases`) in `collection`. The checks run in
    /// the order of `Invalid`; `kid` is checked before any decryption so a caller can look for
    /// another root. A match on an alias answers that alias as `name`.
    public static func open(
        root: Data, collection: String, name: String, envelope: Data, aliases: [String] = []
    ) -> Opened {
        openEnvelope(root: root, collection: collection, envelope: envelope) {
            $0 == name || aliases.contains($0)
        }
    }

    /// Opens an envelope whose name the caller does not know yet (a blinded open key or merge
    /// member: the name is inside). It answers the envelope's own `k`. The caller MUST check that
    /// `k` is the name it expected before it trusts the value.
    public static func openAnyName(root: Data, collection: String, envelope: Data) -> Opened {
        openEnvelope(root: root, collection: collection, envelope: envelope) { _ in true }
    }

    private static func openEnvelope(
        root: Data, collection: String, envelope env: Data, accepts: (String) -> Bool
    ) -> Opened {
        let envelope = Data(env)  // zero-based
        let n = envelope.count
        guard n >= fixedBytes + padBlock, (n - fixedBytes) % padBlock == 0 else {
            return .invalid(.shape)
        }
        guard envelope[0] == version else { return .invalid(.version) }
        let kid = SyncCrypto.deriveKid(root: root)
        var diff: UInt8 = 0
        for i in 0..<SyncCrypto.kidBytes { diff |= kid[i] ^ envelope[1 + i] }
        guard diff == 0 else { return .invalid(.kid) }

        let header = envelope.prefix(headerBytes)
        let salt = envelope[(1 + SyncCrypto.kidBytes)..<headerBytes]
        let collKey = SyncCrypto.deriveCollKey(root: root, collection: collection)
        let key = SyncCrypto.deriveValueKey(collKey: collKey, salt: Data(salt))
        guard
            let padded = SyncCrypto.aesGcmOpen(
                key: key, aad: Data(header), ciphertext: envelope.suffix(from: headerBytes))
        else { return .invalid(.auth) }
        guard let body = unpad(padded) else { return .invalid(.padding) }

        guard
            let parsed = try? CanonicalJSON.parse(utf8: body),
            case .object(let o) = parsed, o.count == 2, let k = o["k"], let v = o["v"],
            case .string(let name) = k
        else { return .invalid(.json) }
        guard accepts(name) else { return .invalid(.name) }
        return .ok(name: name, value: v)
    }
}

// An opened value is the person's data: nothing prints it.
extension SyncEnvelope.Opened: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        switch self {
        case .ok(let name, _): return "SyncEnvelope.Opened.ok(name: \(name), value: <redacted>)"
        case .invalid(let r): return "SyncEnvelope.Opened.invalid(\(r.rawValue))"
        }
    }
    public var debugDescription: String { description }
}
