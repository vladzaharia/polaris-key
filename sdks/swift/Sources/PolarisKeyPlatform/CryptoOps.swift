// The Apple crypto lane of the Cloud Connect peer port (CC-14b.3, D-3, D-12): AES-256-GCM and
// X25519 on CryptoKit, served on the binary entry so a key is bytes in process and never JSON or a
// String. Every reply is a status byte then the result:
//
//   1 ok · 0 refused (a tag that does not verify, an all-zero or rejected DH) · 3 bad input
//
// An empty reply means an unknown op, so a status byte is always present for these four.
//
//   cx_seal        key(32) ‖ nonce(12) ‖ aadLen(u32 be) ‖ aad ‖ plaintext   →  1 ‖ ciphertext ‖ tag(16)
//   cx_open        key(32) ‖ nonce(12) ‖ aadLen(u32 be) ‖ aad ‖ ciphertext ‖ tag  →  1 ‖ plaintext | 0
//   cx_x25519      private(32) ‖ peer public(32)   →  1 ‖ shared(32) | 0 (all zero, or CryptoKit refuses)
//   cx_x25519_pub  private(32)                     →  1 ‖ public(32)
//
// No 64 KiB cap here (U-40.2 seals 1 MiB chunks); the entry's 16 MiB bound applies. Nothing logs or
// formats a key. CryptoKit's `SymmetricKey` and private-key objects own copies of the key bytes for
// the call; Swift cannot zero them (a recorded residual). The input is never retained, and the
// reply buffer is zeroed by the C surface once copied out.

import Foundation
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

enum CryptoOps {
    static let ok: UInt8 = 1
    static let refused: UInt8 = 0
    static let badInput: UInt8 = 3
    static let tagBytes = 16

    static func register(into ops: inout [String: PlatformBinaryOp]) {
        ops["cx_seal"] = { seal($0) }
        ops["cx_open"] = { open($0) }
        ops["cx_x25519"] = { x25519($0) }
        ops["cx_x25519_pub"] = { x25519Public($0) }
    }

    /// key, nonce, aad and the rest of the message, or nil when the header does not fit.
    private static func parse(_ i: UnsafeBufferPointer<UInt8>) -> (
        key: SymmetricKey, nonce: Data, aad: Data, body: Data
    )? {
        guard i.count >= 48 else { return nil }
        let aadLen = (Int(i[44]) << 24) | (Int(i[45]) << 16) | (Int(i[46]) << 8) | Int(i[47])
        guard aadLen <= i.count - 48 else { return nil }
        let key = SymmetricKey(data: UnsafeRawBufferPointer(rebasing: UnsafeRawBufferPointer(i)[0..<32]))
        let nonce = Data(i[32..<44])
        let aad = Data(i[48..<(48 + aadLen)])
        let body = Data(i[(48 + aadLen)...])
        return (key, nonce, aad, body)
    }

    static func seal(_ i: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard let p = parse(i), let nonce = try? AES.GCM.Nonce(data: p.nonce) else { return [badInput] }
        guard let box = try? AES.GCM.seal(p.body, using: p.key, nonce: nonce, authenticating: p.aad) else {
            return [refused]
        }
        return [ok] + Array(box.ciphertext) + Array(box.tag)
    }

    static func open(_ i: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard let p = parse(i), let nonce = try? AES.GCM.Nonce(data: p.nonce) else { return [badInput] }
        guard p.body.count >= tagBytes else { return [badInput] }
        let split = p.body.count - tagBytes
        guard
            let box = try? AES.GCM.SealedBox(
                nonce: nonce, ciphertext: p.body.prefix(split), tag: p.body.suffix(tagBytes)),
            let plain = try? AES.GCM.open(box, using: p.key, authenticating: p.aad)
        else { return [refused] }
        return [ok] + Array(plain)
    }

    static func x25519(_ i: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard i.count == 64 else { return [badInput] }
        guard let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(i[0..<32])),
            let peer = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(i[32..<64]))
        else { return [badInput] }
        guard let secret = try? priv.sharedSecretFromKeyAgreement(with: peer) else { return [refused] }
        let bytes = secret.withUnsafeBytes { Array($0) }
        return bytes.contains(where: { $0 != 0 }) ? [ok] + bytes : [refused]
    }

    static func x25519Public(_ i: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard i.count == 32, let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(i)) else {
            return [badInput]
        }
        return [ok] + Array(priv.publicKey.rawRepresentation)
    }
}
