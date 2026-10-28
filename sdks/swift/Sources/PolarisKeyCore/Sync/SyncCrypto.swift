// The crypto of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10) and its key hierarchy
// (§13.10.2), on CryptoKit.
//
// Every derivation is HKDF-SHA256 (RFC 5869). Labels are ASCII; a label that scopes by name is
// followed by a NUL and then the UTF-8 name. Every symmetric key seals one plaintext, so the
// AES-GCM nonce is a constant of 12 zero bytes.

import CryptoKit
import Foundation

public enum SyncCrypto {
    /// The HKDF `info` labels, ASCII, without the NUL that scopes some of them.
    public enum Label {
        public static let kid = "pkey-sync/1 kid"
        public static let coll = "pkey-sync/1 coll"
        public static let names = "pkey-sync/1 names"
        public static let chunkId = "pkey-sync/1 chunk-id"
        public static let value = "pkey-sync/1 value"
        public static let file = "pkey-sync/1 file"
        public static let chunk = "pkey-sync/1 chunk"
        public static let recovery = "pkey-sync/1 recovery"
        public static let adopt = "pkey-sync/1 adopt"
    }

    public static let rootBytes = 32
    public static let kidBytes = 16
    /// The salt of a value key (`K_msg`).
    public static let valueSaltBytes = 16
    /// The salt of a file key (`K_file`).
    public static let fileSaltBytes = 32
    public static let tagBytes = 16

    // ── Primitives ───────────────────────────────────────────────────────────────────────────

    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    /// HKDF-SHA256 (RFC 5869). An empty salt is the hash length of zeros.
    public static func hkdf(ikm: Data, salt: Data, info: Data, length: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info,
            outputByteCount: length)
        return key.withUnsafeBytes { Data($0) }
    }

    /// HMAC-SHA256.
    public static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    private static let nonce12 = Data(count: 12)

    /// AES-256-GCM with a 128-bit tag and the all-zero nonce; the result is ciphertext followed by
    /// the tag. A key that is not 32 bytes is refused.
    public static func aesGcmSeal(key: Data, aad: Data, plaintext: Data) throws -> Data {
        guard key.count == 32 else { throw SyncCryptoError.badLength("key") }
        let box = try AES.GCM.seal(
            plaintext, using: SymmetricKey(data: key),
            nonce: AES.GCM.Nonce(data: nonce12), authenticating: aad)
        return box.ciphertext + box.tag
    }

    /// The plaintext, or nil when authentication fails.
    public static func aesGcmOpen(key: Data, aad: Data, ciphertext: Data) -> Data? {
        guard key.count == 32, ciphertext.count >= tagBytes else { return nil }
        let split = ciphertext.count - tagBytes
        let body = ciphertext.prefix(split)
        let tag = ciphertext.suffix(tagBytes)
        guard
            let n = try? AES.GCM.Nonce(data: nonce12),
            let box = try? AES.GCM.SealedBox(nonce: n, ciphertext: body, tag: tag),
            let out = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        else { return nil }
        return out
    }

    /// Random bytes from the system generator.
    public static func random(_ count: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &g) })
    }

    // ── Derivations (§13.10.2) ───────────────────────────────────────────────────────────────

    /// `label`, then (when `name` is given) a NUL and the UTF-8 name.
    private static func info(_ label: String, _ name: String? = nil) -> Data {
        Data((name.map { "\(label)\u{0}\($0)" } ?? label).utf8)
    }

    /// The `kid` of a root: in every envelope header, in the clear.
    public static func deriveKid(root: Data) -> Data {
        hkdf(ikm: root, salt: Data(), info: info(Label.kid), length: kidBytes)
    }

    /// `K_coll(c)`: `c` is `"$settings"` or the concrete collection name.
    public static func deriveCollKey(root: Data, collection: String) -> Data {
        hkdf(ikm: root, salt: Data(), info: info(Label.coll, collection), length: 32)
    }

    /// `K_names`: keys every blinded name.
    public static func deriveNamesKey(root: Data) -> Data {
        hkdf(ikm: root, salt: Data(), info: info(Label.names), length: 32)
    }

    /// `K_cid(c)`: keys the chunk ids of one collection.
    public static func deriveChunkIdKey(root: Data, collection: String) -> Data {
        hkdf(ikm: root, salt: Data(), info: info(Label.chunkId, collection), length: 32)
    }

    /// `K_msg`: one key per value, from `K_coll` and a 16-byte salt.
    public static func deriveValueKey(collKey: Data, salt: Data) -> Data {
        hkdf(ikm: collKey, salt: salt, info: info(Label.value), length: 32)
    }

    /// `K_file`: one key per file version, from `K_coll` and a 32-byte salt.
    public static func deriveFileKey(collKey: Data, salt: Data) -> Data {
        hkdf(ikm: collKey, salt: salt, info: info(Label.file), length: 32)
    }

    /// `K_chunk`: one key per chunk id (its 32 raw bytes are the salt).
    public static func deriveChunkKey(collKey: Data, chunkId: Data) -> Data {
        hkdf(ikm: collKey, salt: chunkId, info: info(Label.chunk), length: 32)
    }

    /// `K_rec`: the 16-byte recovery code is the key material and the `ringId` text is the salt.
    public static func deriveRecoveryKey(code: Data, ringId: String) -> Data {
        hkdf(ikm: code, salt: Data(ringId.utf8), info: info(Label.recovery), length: 32)
    }

    /// `K_adopt`: wraps a foreign root after an account merge.
    public static func deriveAdoptKey(root: Data) -> Data {
        hkdf(ikm: root, salt: Data(), info: info(Label.adopt), length: 32)
    }
}

public enum SyncCryptoError: Error, Equatable {
    case badLength(String)
    /// A value canonical JSON cannot spell identically in every SDK.
    case unspellable(String)
}
