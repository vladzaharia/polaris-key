// The recovery code and the adopt blob (WIRE-CONTRACT-V5 §13.11.4).
//
//   code    = 16 random bytes ‖ the first 4 bytes of SHA-256(those 16): 160 bits, 32 Crockford
//             base32 characters, shown as 8 groups of 4 joined by hyphens.
//   blob    = 0x01 ‖ n12 ‖ AES-256-GCM(K, n, aad, R)       (recovery and adopt share the layout)
//   recovery: K = K_rec, aad = "pkey-sync/1 recovery" ‖ ringId ‖ u32be(epoch) ‖ kid
//   adopt:    K = K_adopt (of the new root), aad = "pkey-sync/1 adopt" ‖ fromRingId ‖ u32be(epoch)
//             ‖ kid, sealing the foreign or previous root; `epoch` and `kid` are that root's.

import Foundation

public enum SyncRecovery {
    public static let codeBytes = 16
    public static let checksumBytes = 4
    public static let codeChars = 32
    public static let blobVersion: UInt8 = 0x01
    /// The client error code for a bad checksum or a failed unwrap.
    public static let codeInvalid = "recovery-code-invalid"

    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A fresh 16-byte code.
    public static func newCode() -> Data { SyncCrypto.random(codeBytes) }

    private static func withChecksum(_ code: Data) -> Data {
        code + SyncCrypto.sha256(code).prefix(checksumBytes)
    }

    /// The text shown to the person: 8 groups of 4, upper case, joined by hyphens.
    public static func encode(code: Data) throws -> String {
        guard code.count == codeBytes else { throw SyncCryptoError.badLength("recovery code") }
        var chars: [Character] = []
        var acc: UInt32 = 0
        var bits = 0
        for b in withChecksum(code) {
            acc = (acc << 8) | UInt32(b)
            bits += 8
            while bits >= 5 {
                chars.append(alphabet[Int((acc >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
            acc &= (1 << UInt32(bits)) - 1
        }
        return stride(from: 0, to: chars.count, by: 4)
            .map { String(chars[$0..<min($0 + 4, chars.count)]) }.joined(separator: "-")
    }

    /// The 16-byte code in a typed or pasted string, or nil. It ignores case, spaces and hyphens,
    /// maps `I` and `L` to `1` and `O` to `0`, and checks the length and the checksum.
    public static func parse(_ text: String) -> Data? {
        let clean = text.uppercased().filter { $0 != "-" && !$0.isWhitespace }
            .map { c -> Character in (c == "I" || c == "L") ? "1" : (c == "O" ? "0" : c) }
        guard clean.count == codeChars else { return nil }
        var bytes: [UInt8] = []
        var acc: UInt32 = 0
        var bits = 0
        for ch in clean {
            guard let v = alphabet.firstIndex(of: ch) else { return nil }
            acc = (acc << 5) | UInt32(v)
            bits += 5
            if bits >= 8 {
                bytes.append(UInt8((acc >> UInt32(bits - 8)) & 0xFF))
                bits -= 8
                acc &= (1 << UInt32(bits)) - 1
            }
        }
        let code = Data(bytes.prefix(codeBytes))
        let want = withChecksum(code)
        var diff: UInt8 = 0
        for i in codeBytes..<(codeBytes + checksumBytes) { diff |= bytes[i] ^ want[i] }
        return diff == 0 ? code : nil
    }

    // ── The blobs ────────────────────────────────────────────────────────────────────────────

    private static func aad(_ label: String, _ ringId: String, _ epoch: Int, _ kid: Data) -> Data {
        Data(label.utf8) + Data(ringId.utf8) + SyncHPKE.u32be(epoch) + kid
    }

    private static func sealBlob(key: Data, aad: Data, root: Data, nonce: Data?) throws -> Data {
        let n = nonce ?? SyncCrypto.random(12)
        guard n.count == 12 else { throw SyncCryptoError.badLength("nonce") }
        return Data([blobVersion]) + n
            + (try SyncCrypto.aesGcmSeal(key: key, aad: aad, plaintext: root, nonce: n))
    }

    private static func openBlob(key: Data, aad: Data, blob: Data) -> Data? {
        let b = Data(blob)
        guard b.count == 1 + 12 + SyncCrypto.rootBytes + SyncCrypto.tagBytes, b[0] == blobVersion
        else { return nil }
        let root = SyncCrypto.aesGcmOpen(
            key: key, aad: aad, ciphertext: b.suffix(from: 13), nonce: b[1..<13])
        return root?.count == SyncCrypto.rootBytes ? root : nil
    }

    /// `recovery.ct`: the root sealed under the code. `nonce` is for a test vector only.
    public static func wrap(
        code: Data, ringId: String, epoch: Int, kid: Data, root: Data, nonce: Data? = nil
    ) throws -> Data {
        try sealBlob(
            key: SyncCrypto.deriveRecoveryKey(code: code, ringId: ringId),
            aad: aad(SyncCrypto.Label.recovery, ringId, epoch, kid), root: root, nonce: nonce)
    }

    /// The root, or nil (a wrong code, ring, epoch or `kid`, or tampering).
    public static func unwrap(code: Data, ringId: String, epoch: Int, kid: Data, blob: Data) -> Data? {
        openBlob(
            key: SyncCrypto.deriveRecoveryKey(code: code, ringId: ringId),
            aad: aad(SyncCrypto.Label.recovery, ringId, epoch, kid), blob: blob)
    }

    /// The ring (`fromRingId`, `epoch`) and root `kid` that an adopt blob names.
    public struct AdoptFrom: Sendable, Equatable {
        public var fromRingId: String
        public var epoch: Int
        public var kid: Data
        public init(fromRingId: String, epoch: Int, kid: Data) {
            self.fromRingId = fromRingId
            self.epoch = epoch
            self.kid = kid
        }
    }

    /// Seals a foreign or previous root under `K_adopt` of the current root.
    public static func sealAdopt(
        currentRoot: Data, from: AdoptFrom, oldRoot: Data, nonce: Data? = nil
    ) throws -> Data {
        try sealBlob(
            key: SyncCrypto.deriveAdoptKey(root: currentRoot),
            aad: aad(SyncCrypto.Label.adopt, from.fromRingId, from.epoch, from.kid), root: oldRoot,
            nonce: nonce)
    }

    /// The adopted root, or nil.
    public static func openAdopt(currentRoot: Data, from: AdoptFrom, blob: Data) -> Data? {
        openBlob(
            key: SyncCrypto.deriveAdoptKey(root: currentRoot),
            aad: aad(SyncCrypto.Label.adopt, from.fromRingId, from.epoch, from.kid), blob: blob)
    }
}
