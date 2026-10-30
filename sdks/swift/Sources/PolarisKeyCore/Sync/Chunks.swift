// Chunk ids and chunk objects (WIRE-CONTRACT-V5 §13.8.3, §13.10.2).
//
//   id      E2E: HMAC-SHA256(K_cid(c), plainChunk); server mode: SHA-256(plainChunk). Hex on the
//           wire (`SYNC_CHUNK_ID_PATTERN`), 32 raw bytes as a key salt and in the aad.
//   object  `pkey-sync-chunk/1`: 0x01 | codec | nonce(12) | AES-256-GCM(K_chunk(id), nonce,
//           aad = 0x01 | codec | id, body). codec 0 is the chunk as is, codec 1 is one zstd frame
//           that declares its content size. A writer may compress (D-4: writers here emit codec
//           0); a reader decodes both. K_chunk is per chunk id, but one id can be sealed with
//           different bodies, so the nonce is synthetic: HMAC-SHA256(K_chunk, 0x01 | codec |
//           body)[0:12]. The reader takes the nonce from the object and recomputes it after the
//           tag opens.
//
// Core links no zstd: a codec 1 object needs the caller's `ZstdDecode` (the umbrella wires
// `LibZstd`). Without one, a codec 1 object is `decode`.

import Foundation

public enum SyncChunks {
    public static let objectVersion: UInt8 = 0x01
    public static let codecRaw: UInt8 = 0
    public static let codecZstd: UInt8 = 1
    /// Version, codec, nonce and the tag: the smallest object (an empty body).
    public static let objectMinBytes = 2 + 12 + 16
    private static let nonceBytes = 12

    /// Why a reader refuses a chunk object, in the order it checks.
    public enum Invalid: String, Sendable, Equatable {
        case shape, version, codec, auth, nonce, decode, size, id
    }

    public enum Opened: Sendable, Equatable {
        case ok(plain: Data, codec: UInt8)
        case invalid(Invalid)

        public var reason: Invalid? { if case .invalid(let r) = self { return r } else { return nil } }
    }

    /// A zstd decoder for one frame with its content size. It may throw; any failure is `decode`.
    public typealias ZstdDecode = @Sendable (Data, Int) throws -> Data

    /// 32 raw bytes of a chunk id, or nil when the text is not 64 lowercase hex characters.
    public static func idBytes(hex: String) -> Data? {
        let u = Array(hex.utf8)
        guard u.count == 64 else { return nil }
        var out = Data(capacity: 32)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 0x30...0x39: return c - 0x30
            case 0x61...0x66: return c - 0x61 + 10
            default: return nil
            }
        }
        for i in stride(from: 0, to: 64, by: 2) {
            guard let hi = nibble(u[i]), let lo = nibble(u[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
        }
        return out
    }

    /// The id of a plaintext chunk. `root` is the ring root in E2E mode; nil is server mode, where
    /// the id is the plain SHA-256.
    public static func chunkId(root: Data?, collection: String, plain: Data) -> Data {
        guard let root else { return SyncCrypto.sha256(plain) }
        return SyncCrypto.hmac(
            key: SyncCrypto.deriveChunkIdKey(root: root, collection: collection), data: plain)
    }

    /// `chunkId` as the 64-character hex of the wire.
    public static func chunkIdHex(root: Data?, collection: String, plain: Data) -> String {
        chunkId(root: root, collection: collection, plain: plain).map { String(format: "%02x", $0) }
            .joined()
    }

    private static func syntheticNonce(key: Data, codec: UInt8, body: Data) -> Data {
        SyncCrypto.hmac(key: key, data: Data([objectVersion, codec]) + body).prefix(nonceBytes)
    }

    private static func chunkKey(root: Data, collection: String, id: Data) -> Data {
        SyncCrypto.deriveChunkKey(
            collKey: SyncCrypto.deriveCollKey(root: root, collection: collection), chunkId: id)
    }

    /// Seals `body` (the chunk for codec 0, one zstd frame for codec 1) as the object for `id`.
    /// The caller computed `id` from the plaintext; `open` checks it again.
    public static func seal(
        root: Data, collection: String, id: Data, codec: UInt8, body: Data
    ) throws -> Data {
        guard root.count == SyncCrypto.rootBytes else { throw SyncCryptoError.badLength("root") }
        guard id.count == 32 else { throw SyncCryptoError.badLength("chunk id") }
        guard codec == codecRaw || codec == codecZstd else { throw SyncCryptoError.badLength("chunk codec") }
        let aad = Data([objectVersion, codec]) + id
        let key = chunkKey(root: root, collection: collection, id: id)
        let nonce = syntheticNonce(key: key, codec: codec, body: body)
        let ct = try SyncCrypto.aesGcmSeal(key: key, aad: aad, plaintext: body, nonce: nonce)
        return Data([objectVersion, codec]) + nonce + ct
    }

    /// The content size a zstd frame header declares (RFC 8878 §3.1.1.1), or nil when the frame
    /// does not start with the magic, is cut short or declares none.
    public static func zstdContentSize(_ frame: Data) -> Int? {
        let f = [UInt8](frame)
        guard f.count >= 6, f[0] == 0x28, f[1] == 0xB5, f[2] == 0x2F, f[3] == 0xFD else { return nil }
        let d = f[4]
        let flag = Int(d >> 6)
        let single = Int((d >> 5) & 1)
        let at = 5 + (single == 1 ? 0 : 1) + [0, 1, 2, 4][Int(d & 3)]
        let width = flag == 0 ? (single == 1 ? 1 : 0) : [0, 2, 4, 8][flag]
        guard width != 0, f.count >= at + width else { return nil }
        var v: UInt64 = 0
        for i in stride(from: width - 1, through: 0, by: -1) {
            v = v << 8 | UInt64(f[at + i])
        }
        // A declared size past 2^62 is refused as `size` by every caller; keep it in `Int`.
        if v > (1 << 62) { return 1 << 62 }
        return Int(v) + (flag == 1 ? 256 : 0)
    }

    private static func equal(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }

    /// Opens the object for `id` in `collection`. The checks run in the order of `Invalid`: shape,
    /// version, codec, the tag (which covers the codec and the id), the nonce, the zstd frame (it
    /// must declare a content size of at most `SYNC_CDC_MAX_BYTES`, checked before any decode),
    /// and last that the keyed hash of the plaintext is `id`.
    public static func open(
        root: Data, collection: String, id: Data, object: Data, decode: ZstdDecode? = nil
    ) -> Opened {
        let o = [UInt8](object)
        if o.count < objectMinBytes { return .invalid(.shape) }
        if o[0] != objectVersion { return .invalid(.version) }
        let codec = o[1]
        if codec != codecRaw && codec != codecZstd { return .invalid(.codec) }
        if id.count != 32 || root.count != SyncCrypto.rootBytes { return .invalid(.auth) }
        let aad = Data([objectVersion, codec]) + id
        let key = chunkKey(root: root, collection: collection, id: id)
        let nonce = Data(o[2..<(2 + nonceBytes)])
        guard
            let body = SyncCrypto.aesGcmOpen(
                key: key, aad: aad, ciphertext: Data(o[(2 + nonceBytes)...]), nonce: nonce)
        else { return .invalid(.auth) }
        if !equal(syntheticNonce(key: key, codec: codec, body: body), nonce) { return .invalid(.nonce) }

        let plain: Data
        if codec == codecRaw {
            plain = body
        } else {
            guard let size = zstdContentSize(body), let decode else { return .invalid(.decode) }
            if size > SYNC_CDC_MAX_BYTES { return .invalid(.size) }
            guard let out = try? decode(body, size), out.count == size else { return .invalid(.decode) }
            plain = out
        }
        if plain.count > SYNC_CDC_MAX_BYTES { return .invalid(.size) }
        if !equal(chunkId(root: root, collection: collection, plain: plain), id) { return .invalid(.id) }
        return .ok(plain: plain, codec: codec)
    }
}
