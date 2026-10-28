// `pkey-sync-wrap/1` (WIRE-CONTRACT-V5 §13.11.1): RFC 9180 HPKE `mode_base`, single shot, with
// KEM 0x0020 (DHKEM X25519, HKDF-SHA256), KDF 0x0001 (HKDF-SHA256) and AEAD 0x0002 (AES-256-GCM).
// A wrap carries one root `R` to a device's agreement key. Sequence 0 is the only message, so the
// AEAD nonce is the key schedule's `base_nonce`.
//
// The key schedule is written out here (D-10) so that opening runs over `DeviceKeyPort.dh`: the
// private agreement key never leaves its port. Sealing uses an ephemeral `Curve25519` key.

import CryptoKit
import Foundation

public enum SyncHPKE {
    /// The `kem` member of a wrap: the HPKE KEM id as a JSON integer.
    public static let kemX25519 = 0x0020
    public static let encBytes = 32
    /// A wrapped root: 32 bytes of `R` and the 16-byte tag.
    public static let wrapCtBytes = SyncCrypto.rootBytes + 16

    private static let kemSuite = Data("KEM".utf8) + i2osp2(0x0020)
    private static let hpkeSuite = Data("HPKE".utf8) + i2osp2(0x0020) + i2osp2(0x0001) + i2osp2(0x0002)
    private static let v1 = Data("HPKE-v1".utf8)

    private static func i2osp2(_ n: Int) -> Data { Data([UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)]) }

    public static func u32be(_ n: Int) -> Data {
        Data([UInt8(n >> 24 & 0xFF), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)])
    }

    // HKDF-Extract and -Expand (RFC 5869).
    private static func extract(salt: Data, ikm: Data) -> Data {
        SyncCrypto.hmac(key: salt.isEmpty ? Data(count: 32) : salt, data: ikm)
    }

    private static func expand(prk: Data, info: Data, length: Int) -> Data {
        var out = Data()
        var t = Data()
        var i: UInt8 = 1
        while out.count < length {
            t = SyncCrypto.hmac(key: prk, data: t + info + Data([i]))
            out += t
            i += 1
        }
        return out.prefix(length)
    }

    private static func labeledExtract(suite: Data, salt: Data, label: String, ikm: Data) -> Data {
        extract(salt: salt, ikm: v1 + suite + Data(label.utf8) + ikm)
    }

    private static func labeledExpand(
        suite: Data, prk: Data, label: String, info: Data, length: Int
    ) -> Data {
        expand(prk: prk, info: i2osp2(length) + v1 + suite + Data(label.utf8) + info, length: length)
    }

    /// `ExtractAndExpand` of the KEM (RFC 9180 §4.1).
    public static func sharedSecret(dh: Data, kemContext: Data) -> Data {
        let prk = labeledExtract(suite: kemSuite, salt: Data(), label: "eae_prk", ikm: dh)
        return labeledExpand(
            suite: kemSuite, prk: prk, label: "shared_secret", info: kemContext, length: 32)
    }

    /// The AEAD key and nonce of a `mode_base` context (RFC 9180 §5.1).
    public static func keySchedule(secret: Data, info: Data) -> (key: Data, nonce: Data) {
        let pskIdHash = labeledExtract(suite: hpkeSuite, salt: Data(), label: "psk_id_hash", ikm: Data())
        let infoHash = labeledExtract(suite: hpkeSuite, salt: Data(), label: "info_hash", ikm: info)
        let context = Data([0x00]) + pskIdHash + infoHash
        let s = labeledExtract(suite: hpkeSuite, salt: secret, label: "secret", ikm: Data())
        return (
            labeledExpand(suite: hpkeSuite, prk: s, label: "key", info: context, length: 32),
            labeledExpand(suite: hpkeSuite, prk: s, label: "base_nonce", info: context, length: 12)
        )
    }

    private static func isZero(_ d: Data) -> Bool { d.allSatisfy { $0 == 0 } }

    public struct Sealed: Sendable {
        /// The sender's ephemeral public key.
        public let enc: Data
        public let ct: Data
    }

    /// `SealBase` for one message. `ephemeralPrivate` (32 bytes) is for a test vector only; leave
    /// it out to draw a fresh `Curve25519` key. Throws when the recipient key is not usable.
    public static func seal(
        recipientPublicKey: Data, info: Data, aad: Data, plaintext: Data,
        ephemeralPrivate: Data? = nil
    ) throws -> Sealed {
        guard recipientPublicKey.count == 32 else { throw SyncCryptoError.badLength("recipient key") }
        let skE =
            try ephemeralPrivate.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) }
            ?? Curve25519.KeyAgreement.PrivateKey()
        let enc = skE.publicKey.rawRepresentation
        let pkR = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientPublicKey)
        let dh = try skE.sharedSecretFromKeyAgreement(with: pkR).withUnsafeBytes { Data($0) }
        guard !isZero(dh) else { throw SyncCryptoError.unspellable("the recipient key is not usable") }
        let ss = sharedSecret(dh: dh, kemContext: enc + recipientPublicKey)
        let (key, nonce) = keySchedule(secret: ss, info: info)
        return Sealed(enc: enc, ct: try SyncCrypto.aesGcmSeal(key: key, aad: aad, plaintext: plaintext, nonce: nonce))
    }

    /// `OpenBase` for a recipient held by a port: `recipientPublicKey` is its raw public key and
    /// `dh` is `DeviceKeyPort.dh` (nil for a refused peer key). The plaintext, or nil for a bad
    /// `enc`, a wrong key, info or aad, or tampering.
    public static func open(
        recipientPublicKey: Data, dh: (Data) async throws -> Data?, enc: Data, info: Data,
        aad: Data, ciphertext: Data
    ) async rethrows -> Data? {
        guard enc.count == encBytes, let shared = try await dh(enc), !isZero(shared) else { return nil }
        let ss = sharedSecret(dh: shared, kemContext: enc + recipientPublicKey)
        let (key, nonce) = keySchedule(secret: ss, info: info)
        return SyncCrypto.aesGcmOpen(key: key, aad: aad, ciphertext: ciphertext, nonce: nonce)
    }

    /// `OpenBase` over a device key port.
    public static func open(
        port: any DeviceKeyPort, enc: Data, info: Data, aad: Data, ciphertext: Data
    ) async throws -> Data? {
        guard let keys = try await port.publicKeys(), let pub = Base64URL.decode(keys.agreeKey),
            pub.count == 32
        else { return nil }
        return try await open(
            recipientPublicKey: pub, dh: { try await port.dh($0) }, enc: enc,
            info: info, aad: aad, ciphertext: ciphertext)
    }

    // ── The wrap ─────────────────────────────────────────────────────────────────────────────

    public struct WrapContext: Sendable, Equatable {
        public var product: String
        public var deviceId: String
        public var ringId: String
        /// At least 1.
        public var epoch: Int
        public init(product: String, deviceId: String, ringId: String, epoch: Int) {
            self.product = product
            self.deviceId = deviceId
            self.ringId = ringId
            self.epoch = epoch
        }
    }

    /// `"pkey-sync/1 wrap\0" ‖ product ‖ 0x00 ‖ deviceId ‖ 0x00 ‖ ringId ‖ 0x00 ‖ u32be(epoch)`.
    public static func wrapInfo(_ c: WrapContext) -> Data {
        Data("pkey-sync/1 wrap\u{0}".utf8) + Data(c.product.utf8) + Data([0]) + Data(c.deviceId.utf8)
            + Data([0]) + Data(c.ringId.utf8) + Data([0]) + u32be(c.epoch)
    }

    /// A `pkey-sync-wrap/1` as the routes carry it, in bytes.
    public struct Wrap: Sendable, Equatable {
        public var kem: Int
        public var enc: Data
        public var ct: Data
        public init(kem: Int, enc: Data, ct: Data) {
            self.kem = kem
            self.enc = enc
            self.ct = ct
        }
    }

    /// Wraps `root` to a device's agreement key. `kid` (16 bytes, of `root`) is the associated data.
    public static func wrapRoot(
        recipientPublicKey: Data, context: WrapContext, kid: Data, root: Data,
        ephemeralPrivate: Data? = nil
    ) throws -> Wrap {
        let s = try seal(
            recipientPublicKey: recipientPublicKey, info: wrapInfo(context), aad: kid,
            plaintext: root, ephemeralPrivate: ephemeralPrivate)
        return Wrap(kem: kemX25519, enc: s.enc, ct: s.ct)
    }

    /// The root in a wrap, or nil: an unknown `kem`, a wrong key, context or `kid`, tampering, or a
    /// plaintext that is not 32 bytes. The caller still checks that `kid(R)` is the ring's `rootKid`.
    public static func unwrapRoot(
        recipientPublicKey: Data, dh: (Data) async throws -> Data?, context: WrapContext,
        kid: Data, wrap: Wrap
    ) async rethrows -> Data? {
        guard wrap.kem == kemX25519 else { return nil }
        let root = try await open(
            recipientPublicKey: recipientPublicKey, dh: dh, enc: wrap.enc, info: wrapInfo(context),
            aad: kid, ciphertext: wrap.ct)
        return root?.count == SyncCrypto.rootBytes ? root : nil
    }

    /// `unwrapRoot` for a device whose agreement key lives in a `DeviceKeyPort`.
    public static func unwrapRoot(
        port: any DeviceKeyPort, context: WrapContext, kid: Data, wrap: Wrap
    ) async throws -> Data? {
        guard let keys = try await port.publicKeys(), let pub = Base64URL.decode(keys.agreeKey),
            pub.count == 32
        else { return nil }
        return try await unwrapRoot(
            recipientPublicKey: pub, dh: { try await port.dh($0) }, context: context,
            kid: kid, wrap: wrap)
    }
}
