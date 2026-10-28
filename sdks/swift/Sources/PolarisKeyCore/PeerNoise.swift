// WIRE-CONTRACT-V5 §15.5 and §15.6: the Noise engine of `pkey-peer/1` (CC-11.2).
//
// The Noise Protocol Framework (revision 34), patterns XX and XXpsk0 over 25519, AESGCM and
// SHA256, on CryptoKit. Swift mirror of client-core's `peer/noise.ts`. The engine does no I/O
// and reads no clock. A failure throws a `PeerNoiseError` whose `code` is all a caller may show
// or log: it carries no key, payload or ciphertext. After any failure a handshake is dead and
// refuses further use.
//
// The static key is a port (`PeerNoiseStaticKey`), so a device key that stays in the Keychain
// takes part without its private half ever reaching the engine (G1); `PeerNoiseDeviceKey` adapts
// a `DeviceKeyPort`. Swift gives no control over copies of key bytes: the engine keeps its
// secrets in `SymmetricKey` and in byte arrays it zeroes when they are replaced or the
// handshake ends or fails.
//
// Nothing here prints a secret: every type's `description` is fixed text and its mirror is empty.

import CryptoKit
import Foundation

/// Why a Noise call refused. `code` is the string the other SDKs use.
public enum PeerNoiseError: Error, Sendable, Equatable, CustomStringConvertible {
    /// A tag failed (wrong key, PSK, prologue or tampering).
    case decrypt
    /// A DH output was all zeros, the point was low order, or the backend refused.
    case dhZero
    /// A message was too short or too long.
    case malformed
    /// A call out of order, or after a failure.
    case state
    /// The 2^64 - 1 nonce was reached.
    case nonceExhausted
    /// A key or PSK of the wrong length.
    case badKey

    public var code: String {
        switch self {
        case .decrypt: return "decrypt"
        case .dhZero: return "dh_zero"
        case .malformed: return "malformed"
        case .state: return "state"
        case .nonceExhausted: return "nonce_exhausted"
        case .badKey: return "bad_key"
        }
    }

    public var description: String { "noise: " + code }
}

/// A Noise message is at most 65,535 bytes (Noise §3), and a TCP frame carries one (§15.6).
public let peerNoiseMaxMessage = 65535

// ── Hash and KDF ─────────────────────────────────────────────────────────────────────

public enum PeerNoiseHash {
    public static func sha256(_ parts: Data...) -> Data {
        var h = SHA256()
        for p in parts { h.update(data: p) }
        return Data(h.finalize())
    }

    public static func hmacSHA256(key: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// HKDF-SHA256 (RFC 5869). An empty salt is HashLen zero bytes, as the RFC defines.
    public static func hkdfSHA256(salt: Data, ikm: Data, info: Data, length: Int) -> Data {
        let prk = hmacSHA256(key: salt.isEmpty ? Data(count: 32) : salt, ikm)
        var t = Data()
        var out = Data()
        var i: UInt8 = 1
        while out.count < length {
            t = hmacSHA256(key: prk, t + info + Data([i]))
            out += t
            i &+= 1
        }
        return Data(out.prefix(length))
    }
}

// ── Protocol names, prologue, PSK (§15.5) ────────────────────────────────────────────

public enum PeerNoiseMode: String, Sendable, CaseIterable {
    case a, v, p
}

/// The Noise protocol name of a mode: XXpsk0 for `a` (R-1), plain XX for `v` and `p`.
public func peerNoiseProtocol(_ mode: PeerNoiseMode) -> String {
    mode == .a ? "Noise_XXpsk0_25519_AESGCM_SHA256" : "Noise_XX_25519_AESGCM_SHA256"
}

/// `"pkey-peer/1" || 0x00 || slug || 0x00 || mode || 0x00`.
public func peerPrologue(slug: String, mode: PeerNoiseMode) -> Data {
    Data("pkey-peer/1".utf8) + [0] + Data(slug.utf8) + [0] + Data(mode.rawValue.utf8) + [0]
}

/// The mode-a PSK: HKDF-SHA256, empty salt, the 32-byte discovery key as input keying material
/// and `"pkey-peer/1 psk" || 0x00 || slug` as info, 32 bytes out (V5 §15.5 pins this order).
public func peerPsk(discoveryKey: Data, slug: String) throws -> Data {
    guard discoveryKey.count == 32 else { throw PeerNoiseError.badKey }
    return PeerNoiseHash.hkdfSHA256(
        salt: Data(), ikm: discoveryKey, info: Data("pkey-peer/1 psk".utf8) + [0] + Data(slug.utf8),
        length: 32)
}

// ── X25519 ───────────────────────────────────────────────────────────────────────────

enum PeerNoiseX25519 {
    /// The shared secret, or nil when the point is low order, the backend refuses it (a CryptoKit
    /// throw) or the output is all zero.
    static func agree(_ priv: Curve25519.KeyAgreement.PrivateKey, _ remote: Data) -> Data? {
        guard remote.count == 32, !DeviceProofs.isX25519LowOrder([UInt8](remote)),
            let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: remote),
            let shared = try? priv.sharedSecretFromKeyAgreement(with: pub)
        else { return nil }
        let out = shared.withUnsafeBytes { Data($0) }
        return out.contains(where: { $0 != 0 }) ? out : nil
    }
}

// ── The static key port ──────────────────────────────────────────────────────────────

/// This side's static X25519 key. The engine asks for the public half and for DH outputs; the
/// private half stays behind the port (G1).
public protocol PeerNoiseStaticKey: Sendable {
    /// The raw 32-byte public key.
    func publicKey() async throws -> Data
    /// X25519 with the static key against a raw public key. nil or a throw refuses (`dh_zero`).
    func dh(_ remote: Data) async throws -> Data?
}

/// A static key held as raw bytes: known-answer tests, or a key a host keeps itself.
public struct PeerNoiseRawStaticKey: PeerNoiseStaticKey, CustomStringConvertible, CustomReflectable {
    private let key: Curve25519.KeyAgreement.PrivateKey

    public init(privateKey: Data) throws {
        guard privateKey.count == 32,
            let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        else { throw PeerNoiseError.badKey }
        key = k
    }

    public func publicKey() async throws -> Data { key.publicKey.rawRepresentation }
    public func dh(_ remote: Data) async throws -> Data? { PeerNoiseX25519.agree(key, remote) }

    public var description: String { "PeerNoiseRawStaticKey()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// A device key port as the static key: the agreement key stays in its store.
public struct PeerNoiseDeviceKey: PeerNoiseStaticKey, CustomStringConvertible, CustomReflectable {
    private let port: any DeviceKeyPort

    public init(_ port: any DeviceKeyPort) { self.port = port }

    public func publicKey() async throws -> Data {
        let keys = try await port.ensure()
        guard let raw = Base64URL.decodeStrict(keys.agreeKey), raw.count == 32 else {
            throw PeerNoiseError.badKey
        }
        return raw
    }

    public func dh(_ remote: Data) async throws -> Data? { try await port.dh(remote) }

    public var description: String { "PeerNoiseDeviceKey()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

// ── CipherState ──────────────────────────────────────────────────────────────────────

private func nonceBytes(_ n: UInt64) -> Data {
    var d = Data(count: 4)
    for shift in stride(from: 56, through: 0, by: -8) { d.append(UInt8(truncatingIfNeeded: n >> UInt64(shift))) }
    return d
}

func gcmSeal(_ key: SymmetricKey, nonce: UInt64, ad: Data, _ plaintext: Data) throws -> Data {
    do {
        let box = try AES.GCM.seal(
            plaintext, using: key, nonce: AES.GCM.Nonce(data: nonceBytes(nonce)), authenticating: ad)
        var out = Data()
        out.append(box.ciphertext)
        out.append(box.tag)
        return out
    } catch { throw PeerNoiseError.state }
}

func gcmOpen(_ key: SymmetricKey, nonce: UInt64, ad: Data, _ sealed: Data) -> Data? {
    guard sealed.count >= 16, let n = try? AES.GCM.Nonce(data: nonceBytes(nonce)) else { return nil }
    let body = Data(sealed.prefix(sealed.count - 16))
    let tag = Data(sealed.suffix(16))
    guard let box = try? AES.GCM.SealedBox(nonce: n, ciphertext: body, tag: tag) else { return nil }
    return (try? AES.GCM.open(box, using: key, authenticating: ad)).map { Data($0) }
}

/// One direction of the transport, or the handshake's cipher. The nonce is 4 zero bytes then a
/// big-endian u64 counter. Calls run one at a time (a lock), so two tasks never share a nonce.
/// A failed read does not advance the counter (Noise §5.1).
public final class PeerCipherState: @unchecked Sendable, CustomStringConvertible, CustomReflectable {
    private let lock = NSLock()
    private var k: SymmetricKey?
    private var n: UInt64 = 0
    private var wiped = false

    init(key: Data?) { k = key.map { SymmetricKey(data: $0) } }

    var hasKey: Bool { lock.withLock { k != nil } }

    func setKey(_ key: Data) {
        lock.withLock {
            k = SymmetricKey(data: key)
            n = 0
        }
    }

    public func encrypt(ad: Data, _ plaintext: Data) throws -> Data {
        try lock.withLock {
            if wiped { throw PeerNoiseError.state }
            guard let k else { return plaintext }
            if n == UInt64.max { throw PeerNoiseError.nonceExhausted }
            if plaintext.count + 16 > peerNoiseMaxMessage { throw PeerNoiseError.malformed }
            let out = try gcmSeal(k, nonce: n, ad: ad, plaintext)
            n += 1
            return out
        }
    }

    public func decrypt(ad: Data, _ ciphertext: Data) throws -> Data {
        try lock.withLock {
            if wiped { throw PeerNoiseError.state }
            guard let k else { return ciphertext }
            if n == UInt64.max { throw PeerNoiseError.nonceExhausted }
            if ciphertext.count < 16 || ciphertext.count > peerNoiseMaxMessage {
                throw PeerNoiseError.malformed
            }
            guard let pt = gcmOpen(k, nonce: n, ad: ad, ciphertext) else { throw PeerNoiseError.decrypt }
            n += 1
            return pt
        }
    }

    /// REKEY (Noise §4.2): `k = ENCRYPT(k, 2^64 - 1, "", zeros(32))[0..32]`. The counter stays.
    public func rekey() throws {
        try lock.withLock {
            guard let k else { throw PeerNoiseError.state }
            let out = try gcmSeal(k, nonce: UInt64.max, ad: Data(), Data(count: 32))
            self.k = SymmetricKey(data: Data(out.prefix(32)))
        }
    }

    /// After this, `encrypt` and `decrypt` throw: a wiped cipher never passes bytes through as plaintext.
    func wipe() {
        lock.withLock {
            k = nil
            wiped = true
        }
    }

    public var description: String { "PeerCipherState()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

/// The two directions of a finished handshake.
public struct PeerNoiseTransport: Sendable, CustomStringConvertible, CustomReflectable {
    public let send: PeerCipherState
    public let receive: PeerCipherState

    public var description: String { "PeerNoiseTransport()" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }
}

// ── HandshakeState ───────────────────────────────────────────────────────────────────

public enum PeerNoiseRole: Sendable { case initiator, responder }

private enum Token { case psk, e, s, ee, es, se }

/// One handshake. Alternate `writeMessage` and `readMessage` as the role dictates (the initiator
/// writes first); after the third message `transport()` yields the two ciphers. Any
/// `PeerNoiseError` kills the handshake.
public actor PeerNoiseHandshake: CustomStringConvertible, CustomReflectable {
    private static let xx: [[Token]] = [[.e], [.e, .ee, .s, .es], [.s, .se]]

    private let initiator: Bool
    private let usesPsk: Bool
    private let staticKey: any PeerNoiseStaticKey
    private var psk: [UInt8]?
    private var e: Curve25519.KeyAgreement.PrivateKey?
    private let ephemeralPublicOverride: Data?
    private var re: Data?
    private var rs: Data?
    private var sPub: Data?
    private var index = 0
    private var dead = false
    private let cs = PeerCipherState(key: nil)
    private var h: [UInt8]
    private var ck: [UInt8]

    /// - `staticKey`: this side's static key port (G1).
    /// - `ephemeralKey`: fixes the ephemeral private key (known-answer tests only); the default
    ///   is random.
    /// - `ephemeralPublicOverride`: replaces the public key the initiator writes and mixes in
    ///   message 1 (the corpus's low-order rows); tests only.
    public init(
        role: PeerNoiseRole, protocol name: String, prologue: Data, staticKey: any PeerNoiseStaticKey,
        psk: Data? = nil, ephemeralKey: Data? = nil
    ) throws {
        try self.init(
            role: role, protocol: name, prologue: prologue, staticKey: staticKey, psk: psk,
            ephemeralKey: ephemeralKey, ephemeralPublicOverride: nil)
    }

    init(
        role: PeerNoiseRole, protocol name: String, prologue: Data, staticKey: any PeerNoiseStaticKey,
        psk: Data?, ephemeralKey: Data?, ephemeralPublicOverride: Data?
    ) throws {
        let uses: Bool
        switch name {
        case "Noise_XX_25519_AESGCM_SHA256": uses = false
        case "Noise_XXpsk0_25519_AESGCM_SHA256": uses = true
        default: throw PeerNoiseError.state
        }
        if uses != (psk != nil) { throw PeerNoiseError.badKey }
        if let psk, psk.count != 32 { throw PeerNoiseError.badKey }
        var eph: Curve25519.KeyAgreement.PrivateKey?
        if let ephemeralKey {
            guard ephemeralKey.count == 32,
                let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ephemeralKey)
            else { throw PeerNoiseError.badKey }
            eph = k
        }
        self.initiator = role == .initiator
        self.usesPsk = uses
        self.staticKey = staticKey
        self.psk = psk.map { [UInt8]($0) }
        self.e = eph
        self.ephemeralPublicOverride = ephemeralPublicOverride
        let nameBytes = Data(name.utf8)
        let start =
            nameBytes.count <= 32 ? nameBytes + Data(count: 32 - nameBytes.count) : PeerNoiseHash.sha256(nameBytes)
        self.h = [UInt8](start)
        self.ck = [UInt8](start)
        self.h = [UInt8](PeerNoiseHash.sha256(Data(self.h), prologue))
    }

    /// True once all three messages are written and read.
    public var finished: Bool { index == Self.xx.count }

    /// The peer's static public key, once its `s` token has been read.
    public var remoteStatic: Data? { rs }

    /// The handshake hash `h`: the channel binding, once finished. Kept after `transport()`.
    public var handshakeHash: Data {
        get throws {
            guard finished else { throw PeerNoiseError.state }
            return Data(h)
        }
    }

    public nonisolated var description: String { "PeerNoiseHandshake()" }
    public nonisolated var customMirror: Mirror { Mirror(self, children: [:]) }

    // ── symmetric state ──

    private func mixHash(_ data: Data) { h = [UInt8](PeerNoiseHash.sha256(Data(h), data)) }

    private func kdf(_ ikm: Data, outputs: Int) -> [Data] {
        let temp = PeerNoiseHash.hmacSHA256(key: Data(ck), ikm)
        let o1 = PeerNoiseHash.hmacSHA256(key: temp, Data([1]))
        let o2 = PeerNoiseHash.hmacSHA256(key: temp, o1 + Data([2]))
        if outputs == 2 { return [o1, o2] }
        return [o1, o2, PeerNoiseHash.hmacSHA256(key: temp, o2 + Data([3]))]
    }

    private func mixKey(_ ikm: Data) {
        let o = kdf(ikm, outputs: 2)
        wipe(&ck)
        ck = [UInt8](o[0])
        cs.setKey(o[1])
    }

    private func mixKeyAndHash(_ ikm: Data) {
        let o = kdf(ikm, outputs: 3)
        wipe(&ck)
        ck = [UInt8](o[0])
        mixHash(o[1])
        cs.setKey(o[2])
    }

    private func encryptAndHash(_ pt: Data) throws -> Data {
        let ct = try cs.encrypt(ad: Data(h), pt)
        mixHash(ct)
        return ct
    }

    private func decryptAndHash(_ ct: Data) throws -> Data {
        let pt = try cs.decrypt(ad: Data(h), ct)
        mixHash(ct)
        return pt
    }

    private func staticPublic() async throws -> Data {
        if let sPub { return sPub }
        let pub: Data
        do { pub = try await staticKey.publicKey() } catch { throw PeerNoiseError.badKey }
        guard pub.count == 32 else { throw PeerNoiseError.badKey }
        sPub = pub
        return pub
    }

    /// One DH token: this side's private key of the kind against the peer's public key. A low-order
    /// point, a backend refusal (a CryptoKit throw, a port that throws) and an all-zero output all
    /// abort with `dh_zero` (§15.5).
    private func dh(_ token: Token) async throws {
        let (a, b): (Character, Character)
        switch token {
        case .ee: (a, b) = ("e", "e")
        case .es: (a, b) = ("e", "s")
        case .se: (a, b) = ("s", "e")
        default: throw PeerNoiseError.state
        }
        let mine = initiator ? a : b
        let theirs = initiator ? b : a
        guard let remote = theirs == "e" ? re : rs else { throw PeerNoiseError.state }
        if DeviceProofs.isX25519LowOrder([UInt8](remote)) { throw PeerNoiseError.dhZero }
        var out: Data?
        if mine == "e" {
            guard let e else { throw PeerNoiseError.state }
            out = PeerNoiseX25519.agree(e, remote)
        } else {
            out = try? await staticKey.dh(remote)
        }
        guard let out, out.count == 32, out.contains(where: { $0 != 0 }) else {
            throw PeerNoiseError.dhZero
        }
        mixKey(out)
    }

    // ── messages ──

    private func tokens() -> [Token] {
        var t = Self.xx[index]
        if index == 0 && usesPsk { t.insert(.psk, at: 0) }
        return t
    }

    private func guarded<T: Sendable>(_ turn: Bool, _ body: () async throws -> T) async throws -> T {
        if dead || finished || initiator != turn { throw PeerNoiseError.state }
        do { return try await body() } catch let err as PeerNoiseError {
            kill()
            throw err
        } catch {
            kill()
            throw PeerNoiseError.state
        }
    }

    private func kill() {
        dead = true
        cs.wipe()
        e = nil
        wipe(&ck)
        wipe(&h)
        if psk != nil { wipe(&psk!) }
        psk = nil
    }

    /// Write the next handshake message carrying `payload`.
    public func writeMessage(_ payload: Data) async throws -> Data {
        try await guarded(index % 2 == 0) {
            var wire = Data()
            for t in tokens() {
                switch t {
                case .psk: mixKeyAndHash(Data(psk ?? []))
                case .e:
                    if e == nil { e = Curve25519.KeyAgreement.PrivateKey() }
                    var pub = e!.publicKey.rawRepresentation
                    if index == 0, initiator, let o = ephemeralPublicOverride { pub = o }
                    wire += pub
                    mixHash(pub)
                    if usesPsk { mixKey(pub) }
                case .s: wire += try encryptAndHash(try await staticPublic())
                default: try await dh(t)
                }
            }
            wire += try encryptAndHash(payload)
            if wire.count > peerNoiseMaxMessage { throw PeerNoiseError.malformed }
            index += 1
            return wire
        }
    }

    /// Read the next handshake message; returns its payload.
    public func readMessage(_ message: Data) async throws -> Data {
        try await guarded(index % 2 == 1) {
            let msg = Data(message)  // re-based at index 0
            if msg.count > peerNoiseMaxMessage { throw PeerNoiseError.malformed }
            var off = 0
            for t in tokens() {
                switch t {
                case .psk: mixKeyAndHash(Data(psk ?? []))
                case .e:
                    guard msg.count >= off + 32 else { throw PeerNoiseError.malformed }
                    let r = msg.subdata(in: off..<off + 32)
                    re = r
                    off += 32
                    mixHash(r)
                    if usesPsk { mixKey(r) }
                case .s:
                    let n = cs.hasKey ? 32 + 16 : 32
                    guard msg.count >= off + n else { throw PeerNoiseError.malformed }
                    rs = try decryptAndHash(msg.subdata(in: off..<off + n))
                    off += n
                default: try await dh(t)
                }
            }
            let payload = try decryptAndHash(msg.subdata(in: off..<msg.count))
            index += 1
            return payload
        }
    }

    /// The transport ciphers of a finished handshake: `send` for this side's writes, `receive`
    /// for its reads. The handshake is spent afterwards.
    public func transport() throws -> PeerNoiseTransport {
        guard !dead, finished else { throw PeerNoiseError.state }
        let o = kdf(Data(), outputs: 2)
        let a = PeerCipherState(key: o[0])
        let b = PeerCipherState(key: o[1])
        let hash = h
        kill()
        h = hash  // the binding stays readable
        return initiator ? PeerNoiseTransport(send: a, receive: b) : PeerNoiseTransport(send: b, receive: a)
    }
}

private func wipe(_ b: inout [UInt8]) {
    for i in b.indices { b[i] = 0 }
}
