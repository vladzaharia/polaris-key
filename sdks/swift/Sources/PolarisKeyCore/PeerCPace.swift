// WIRE-CONTRACT-V5 §15.12, "The mode-q handshake": CPace for account-free local pairing. Suite
// CPACE-X25519-SHA512 of draft-irtf-cfrg-cpace-21 in its initiator-responder setting: the string
// functions (`prepend_len`, `lv_cat`, `generator_string`, `transcript_ir`), `decodeUCoordinate`, the
// Elligator 2 map, the share check, the ISK, the PSK that feeds Noise and the two frames (C1, C2) that
// run before it. Swift mirror of client-core's `peer/cpace.ts`. Nothing here does I/O.
//
// Timing. Every scalar multiplication runs through CryptoKit's X25519. Swift has no BigInt, so the
// Elligator 2 map runs over `Fe25519`, a small field type for 2^255 - 19 (sixteen 16-bit limbs in
// `Int64`, the representation of TweetNaCl). Its operations have no branch and no table index that
// depends on a field element: the only loops and branches are on public values (the limb count, the
// bits of the two fixed exponents p - 2 and (p - 1) / 2), and the choice between the two Elligator 2
// results is a masked select. The TypeScript reference runs this map over BigInt, which is variable
// time; this one is constant time in its operands. Callers still make a generator ahead of the
// connection that needs it, never inside the reply to a peer's frame (the contract's rule).
//
// A share or a K that breaks a rule is a refusal, not an error: the caller closes the connection
// silently and counts no failure (§15.12 step 3).
//
// `Data` is copy-on-write and CryptoKit copies what it is given, so a scalar or an ISK cannot be zeroed
// in place once it is in a call: the copies this module owns (`Fe25519` limbs) are overwritten, the rest
// are released.

import Foundation

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

public enum PeerCPaceError: Error, Sendable, Equatable {
    /// The password is not six ASCII digits, the QR secret is not 16 bytes, or a length is wrong.
    case input
}

// ── The field 2^255 - 19 ─────────────────────────────────────────────────────────────

/// An element of GF(2^255 - 19) as sixteen signed 16-bit limbs (`Int64`), little-endian. Not
/// necessarily reduced between operations; `packed()` reduces fully. Constant time in the limbs.
struct Fe25519 {
    var l: [Int64]

    static let zero = Fe25519(l: [Int64](repeating: 0, count: 16))
    static let one: Fe25519 = {
        var z = [Int64](repeating: 0, count: 16)
        z[0] = 1
        return Fe25519(l: z)
    }()
    /// The Montgomery coefficient A = 486662 of Curve25519.
    static let montA: Fe25519 = {
        var z = [Int64](repeating: 0, count: 16)
        z[0] = 0x6D06
        z[1] = 0x0007
        return Fe25519(l: z)
    }()

    /// Little-endian 32 bytes, bit 255 cleared (`decodeUCoordinate(u, 255)`); not reduced.
    init(unpacking b: [UInt8]) {
        var o = [Int64](repeating: 0, count: 16)
        for i in 0..<16 { o[i] = Int64(b[2 * i]) + (Int64(b[2 * i + 1]) << 8) }
        o[15] &= 0x7fff
        l = o
    }

    init(l: [Int64]) { self.l = l }

    /// One carry pass over the limbs (TweetNaCl `car25519`). No data-dependent branch.
    @inline(__always)
    private mutating func carry() {
        for i in 0..<16 {
            l[i] += (1 << 16)
            let c = l[i] >> 16
            // Limb 15 carries into limb 0 times 38 (2^256 = 38 mod p).
            let target = i < 15 ? i + 1 : 0
            l[target] += c - 1 + (i == 15 ? 37 * (c - 1) : 0)
            l[i] -= c << 16
        }
    }

    @inline(__always)
    static func + (a: Fe25519, b: Fe25519) -> Fe25519 {
        var o = a.l
        for i in 0..<16 { o[i] += b.l[i] }
        return Fe25519(l: o)
    }

    @inline(__always)
    static func - (a: Fe25519, b: Fe25519) -> Fe25519 {
        var o = a.l
        for i in 0..<16 { o[i] -= b.l[i] }
        return Fe25519(l: o)
    }

    @inline(__always)
    static func * (a: Fe25519, b: Fe25519) -> Fe25519 {
        var t = [Int64](repeating: 0, count: 31)
        for i in 0..<16 {
            for j in 0..<16 { t[i + j] += a.l[i] * b.l[j] }
        }
        for i in 0..<15 { t[i] += 38 * t[i + 16] }
        var r = Fe25519(l: Array(t[0..<16]))
        r.carry()
        r.carry()
        return r
    }

    @inline(__always)
    func squared() -> Fe25519 { self * self }

    /// `cond` is 1 to take `b`, 0 to take `a`; a masked select, no branch.
    @inline(__always)
    static func select(_ a: Fe25519, _ b: Fe25519, _ cond: Int64) -> Fe25519 {
        let mask = ~(cond - 1)
        var o = a.l
        for i in 0..<16 { o[i] ^= mask & (a.l[i] ^ b.l[i]) }
        return Fe25519(l: o)
    }

    /// `self ^ e` for a public exponent (32 little-endian bytes): left-to-right square and multiply. The
    /// branch is on the exponent's bit, which is a fixed public constant, never on the base.
    @inline(__always)
    func power(_ e: [UInt8]) -> Fe25519 {
        var r = Fe25519.one
        for bit in stride(from: 255, through: 0, by: -1) {
            r = r.squared()
            if (e[bit >> 3] >> UInt8(bit & 7)) & 1 == 1 { r = r * self }
        }
        return r
    }

    /// The canonical 32 little-endian bytes of the value, fully reduced into [0, p). No branch.
    @inline(__always)
    func packed() -> [UInt8] {
        var t = self
        t.carry()
        t.carry()
        t.carry()
        var m = [Int64](repeating: 0, count: 16)
        for _ in 0..<2 {
            m[0] = t.l[0] - 0xffed
            for i in 1..<15 {
                m[i] = t.l[i] - 0xffff - ((m[i - 1] >> 16) & 1)
                m[i - 1] &= 0xffff
            }
            m[15] = t.l[15] - 0x7fff - ((m[14] >> 16) & 1)
            let b = (m[15] >> 16) & 1
            m[14] &= 0xffff
            t = Fe25519.select(Fe25519(l: m), t, b)
        }
        var out = [UInt8](repeating: 0, count: 32)
        for i in 0..<16 {
            out[2 * i] = UInt8(truncatingIfNeeded: t.l[i] & 0xff)
            out[2 * i + 1] = UInt8(truncatingIfNeeded: t.l[i] >> 8)
        }
        return out
    }

    /// Overwrite the limbs.
    @inline(__always)
    mutating func wipe() { for i in 0..<16 { l[i] = 0 } }
}

/// `p - 2` and `(p - 1) / 2`, little-endian: the two public exponents.
private let expInverse: [UInt8] = [0xEB] + [UInt8](repeating: 0xFF, count: 30) + [0x7F]
private let expLegendre: [UInt8] = [0xF6] + [UInt8](repeating: 0xFF, count: 30) + [0x3F]

// ── CPace ────────────────────────────────────────────────────────────────────────────

public enum PeerCPace {
    public enum Kind: Sendable, Equatable { case code, qr }

    /// The first byte of both frames.
    public static let frameVersion: UInt8 = 0x01
    public static let c1Length = 34
    public static let c2Length = 33
    public static let shareLength = 32
    /// The QR secret, in bytes (`LOCAL_QR_SECRET_BYTES`).
    public static let qrSecretBytes = 16

    static let dsi = "CPace255"
    static let dsiIsk = "CPace255_ISK"
    /// SHA-512's input block size, the draft's `s_in_bytes`.
    public static let sInBytes = 128

    static func kindByte(_ k: Kind) -> UInt8 { k == .code ? 0x01 : 0x02 }

    private static func sha512(_ parts: Data...) -> Data {
        var h = SHA512()
        for p in parts { h.update(data: p) }
        return Data(h.finalize())
    }

    // The draft's string functions (appendix A).

    /// `prepend_len`: the LEB128 length, then the data.
    public static func prependLen(_ data: Data) -> Data {
        var len: [UInt8] = []
        var rest = data.count
        while rest >= 128 {
            len.append(UInt8(rest % 128 + 128))
            rest /= 128
        }
        len.append(UInt8(rest))
        return Data(len) + data
    }

    /// `lv_cat`: every argument length-prefixed, then concatenated.
    public static func lvCat(_ args: [Data]) -> Data {
        var out = Data()
        for a in args { out += prependLen(a) }
        return out
    }

    /// `generator_string(DSI, PRS, CI, sid, s_in_bytes)`.
    public static func generatorString(dsi: Data, prs: Data, ci: Data, sid: Data, sInBytes: Int) -> Data {
        let zpad = max(0, sInBytes - 1 - prependLen(prs).count - prependLen(dsi).count)
        return lvCat([dsi, prs, Data(count: zpad), ci, sid])
    }

    /// `transcript_ir(Ya, ADa, Yb, ADb)`.
    public static func transcriptIr(ya: Data, ada: Data, yb: Data, adb: Data) -> Data {
        lvCat([ya, ada]) + lvCat([yb, adb])
    }

    // Elligator 2 (Z = 2).

    public struct Elligator2Result: Sendable, Equatable {
        /// `decodeUCoordinate(input) mod p`, 32 bytes.
        public let r: Data
        /// Whether `v = -A / (1 + 2 r^2)` is on the curve; otherwise the result comes from the twist.
        public let onCurve: Bool
        /// The u-coordinate of the result, 32 bytes little-endian.
        public let u: Data
    }

    /// The draft's `map_to_curve_elligator2` for Curve25519 on 32 input bytes. Constant time in the input
    /// (see the file header). Nil for an input that is not 32 bytes.
    public static func elligator2(_ input: Data) -> Elligator2Result? {
        guard input.count == 32 else { return nil }
        let r = Fe25519(unpacking: [UInt8](input))
        // w = 1 + 2 r^2 is never 0: -1/2 is a non-square mod p, since p = 5 (mod 8).
        let r2 = r.squared()
        let w = Fe25519.one + r2 + r2
        // v = -A / w
        let v = Fe25519.zero - (Fe25519.montA * w.power(expInverse))
        let v2 = v.squared()
        let gv = v2 * v + Fe25519.montA * v2 + v
        // g(v) is never 0 (A^2 - 4 is a non-square), so eps is 1 or p - 1.
        let eps = gv.power(expLegendre).packed()
        let one = Fe25519.one.packed()
        var diffOne = 0 as UInt8
        for i in 0..<32 { diffOne |= eps[i] ^ one[i] }
        // eps == 1 exactly when diffOne == 0; eps == p - 1 is the other allowed value. Both are read as 0 or 1
        // by arithmetic on the difference (0 - 1 is negative, 1...255 - 1 is not), never a branch on it.
        let onCurve: Int64 = ((Int64(diffOne) - 1) >> 8) & 1
        let pm1 = (Fe25519.zero - Fe25519.one).packed()
        var diffMinus = 0 as UInt8
        for i in 0..<32 { diffMinus |= eps[i] ^ pm1[i] }
        let isMinus: Int64 = ((Int64(diffMinus) - 1) >> 8) & 1
        guard (onCurve | isMinus) == 1 else { return nil }
        let twist = Fe25519.zero - v - Fe25519.montA
        let u = Fe25519.select(twist, v, onCurve)
        return Elligator2Result(r: Data(r.packed()), onCurve: onCurve == 1, u: Data(u.packed()))
    }

    // The password-related string and the generator.

    /// `"pkey-peer/1 code" || 0x00 || <the 6 ASCII password digits>`.
    public static func prsCode(_ digits: String) throws -> Data {
        let u = Array(digits.utf8)
        guard u.count == 6, u.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { throw PeerCPaceError.input }
        return Data("pkey-peer/1 code".utf8) + [0] + Data(u)
    }

    /// `"pkey-peer/1 qr" || 0x00 || <the 16 secret bytes>`.
    public static func prsQr(_ secret: Data) throws -> Data {
        guard secret.count == qrSecretBytes else { throw PeerCPaceError.input }
        return Data("pkey-peer/1 qr".utf8) + [0] + secret
    }

    /// The generator: `g = elligator2(SHA-512(generator_string(DSI, PRS, CI, sid, 128))[0..32])`, its
    /// u-coordinate as 32 bytes. `ci` is the mode-q prologue and `sid` the window's 10 bytes.
    public static func generator(prs: Data, ci: Data, sid: Data) -> Data {
        let hash = sha512(generatorString(dsi: Data(dsi.utf8), prs: prs, ci: ci, sid: sid, sInBytes: sInBytes))
            .prefix(32)
        // `elligator2` is nil only for a wrong length or g(v) = 0, neither of which a 32-byte hash makes.
        return elligator2(Data(hash))?.u ?? Data(count: 32)
    }

    // Shares and the refusals (§15.12 step 3).

    public enum ShareVerdict: Sendable, Equatable {
        case ok
        case length
        case nonCanonical
        case lowOrder
    }

    /// A share is 32 bytes, canonical (bit 255 clear and u < 2^255 - 19) and not one of the low-order
    /// points. The canonical check comes first, so the low-order points at or above p refuse as
    /// non-canonical. A share is public, so this compare may branch.
    public static func checkShare(_ y: Data) -> ShareVerdict {
        guard y.count == shareLength else { return .length }
        let b = [UInt8](y)
        if b[31] & 0x80 != 0 { return .nonCanonical }
        // u >= p, with p = 2^255 - 19: every byte above the lowest is 0xFF (top 0x7F) and the lowest >= 0xED.
        var ge = b[0] >= 0xED && b[31] == 0x7F
        if ge { for i in 1..<31 where b[i] != 0xFF { ge = false } }
        if ge { return .nonCanonical }
        return DeviceProofs.isX25519LowOrder(b) ? .lowOrder : .ok
    }

    /// A fresh 32-byte scalar. X25519 clamps it.
    public static func scalar(random: (Int) -> Data) -> Data { random(32) }

    private static func x25519(_ scalar: Data, _ point: Data) -> Data? {
        guard scalar.count == 32, point.count == 32,
            let priv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: scalar),
            let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: point),
            let shared = try? priv.sharedSecretFromKeyAgreement(with: pub)
        else { return nil }
        let out = shared.withUnsafeBytes { Data($0) }
        // K is secret: the all-zero test reads every byte (no early exit on the first non-zero one).
        return out.reduce(UInt8(0)) { $0 | $1 } != 0 ? out : nil
    }

    /// `Y = X25519(y, g)`. Nil when the backend refuses (a degenerate generator) or the output is zero.
    public static func share(scalar: Data, generator g: Data) -> Data? { x25519(scalar, g) }

    public enum Role: Sendable, Equatable { case initiator, responder }

    /// `ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) || transcript_ir(Ya, "", Yb, ""))`, 64 bytes, or nil
    /// when K is 32 zero bytes (or the backend refuses the peer's share): the attempt aborts silently. The
    /// peer's share must already have passed `checkShare`.
    public static func isk(sid: Data, scalar: Data, ya: Data, yb: Data, role: Role) -> Data? {
        let peer = role == .initiator ? yb : ya
        guard let k = x25519(scalar, peer) else { return nil }
        return sha512(
            lvCat([Data(dsiIsk.utf8), sid, k]) + transcriptIr(ya: ya, ada: Data(), yb: yb, adb: Data()))
    }

    /// The Noise PSK of a pairing attempt:
    /// `HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace" || 0x00 || slug)`.
    public static func psk(isk: Data, slug: String) -> Data {
        PeerNoiseHash.hkdfSHA256(
            salt: Data(), ikm: isk, info: Data("pkey-peer/1 cpace".utf8) + [0] + Data(slug.utf8), length: 32)
    }

    // The frames C1 and C2 (§15.12 step 2).

    /// C1, joiner to shower: `0x01 || kind || Ya`, 34 bytes.
    public static func encodeC1(_ kind: Kind, ya: Data) -> Data { Data([frameVersion, kindByte(kind)]) + ya }

    /// C2, shower to joiner: `0x01 || Yb`, 33 bytes.
    public static func encodeC2(yb: Data) -> Data { Data([frameVersion]) + yb }

    public enum FrameRefusal: String, Sendable, Equatable {
        case length, version, kind
        case nonCanonical = "non-canonical"
        case lowOrder = "low-order"
    }

    public enum FrameVerdict: Sendable, Equatable {
        case ok(kind: Kind?, share: Data)
        case refused(FrameRefusal)
    }

    private static func shareRefusal(_ v: ShareVerdict) -> FrameRefusal {
        switch v {
        case .nonCanonical: return .nonCanonical
        case .lowOrder: return .lowOrder
        default: return .length
        }
    }

    /// The receiver's judgement of C1: length, version, kind, then the share.
    public static func parseC1(_ b: Data) -> FrameVerdict {
        guard b.count == c1Length else { return .refused(.length) }
        let a = [UInt8](b)
        guard a[0] == frameVersion else { return .refused(.version) }
        let kind: Kind
        switch a[1] {
        case kindByte(.code): kind = .code
        case kindByte(.qr): kind = .qr
        default: return .refused(.kind)
        }
        let share = Data(a[2...])
        let v = checkShare(share)
        return v == .ok ? .ok(kind: kind, share: share) : .refused(shareRefusal(v))
    }

    /// The receiver's judgement of C2: length, version, then the share.
    public static func parseC2(_ b: Data) -> FrameVerdict {
        guard b.count == c2Length else { return .refused(.length) }
        let a = [UInt8](b)
        guard a[0] == frameVersion else { return .refused(.version) }
        let share = Data(a[1...])
        let v = checkShare(share)
        return v == .ok ? .ok(kind: nil, share: share) : .refused(shareRefusal(v))
    }
}
