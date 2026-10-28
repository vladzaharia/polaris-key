// A test-only RFC 8032 Ed25519 signer. CryptoKit's `Curve25519.Signing` signs with fresh randomness,
// so the same message signs to a different value each time; the HTTP transcripts pin the `keys`
// proof's `sig` byte for byte, and the Node, Python and Kotlin signers are deterministic. This is a
// slow, plain implementation (16-limb integers) used only to reproduce those recorded bytes; the
// SDK itself signs through CryptoKit. Not for production use.

import CryptoKit
import Foundation

enum DeterministicEd25519 {
    private typealias N = [UInt32]  // 16 little-endian 32-bit limbs

    private static func zero() -> N { [UInt32](repeating: 0, count: 16) }
    private static func num(_ v: UInt32) -> N {
        var r = zero()
        r[0] = v
        return r
    }
    private static func fromLE(_ d: [UInt8]) -> N {
        var r = zero()
        for (i, b) in d.enumerated() { r[i / 4] |= UInt32(b) << UInt32(8 * (i % 4)) }
        return r
    }
    private static func hex(_ s: String) -> N {
        var bytes: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            bytes.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return fromLE(bytes.reversed())
    }
    private static func le32(_ n: N) -> [UInt8] { (0..<32).map { UInt8((n[$0 / 4] >> UInt32(8 * ($0 % 4))) & 0xff) } }

    private static let P = hex("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed")
    private static let L = hex("1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed")
    private static let D = hex("52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3")
    private static let BX = hex("216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a")
    private static let BY = hex("6666666666666666666666666666666666666666666666666666666666666658")

    private static func cmp(_ a: N, _ b: N) -> Int {
        for i in stride(from: 15, through: 0, by: -1) where a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
        return 0
    }
    private static func add(_ a: N, _ b: N) -> N {
        var r = zero()
        var carry: UInt64 = 0
        for i in 0..<16 {
            let t = UInt64(a[i]) + UInt64(b[i]) + carry
            r[i] = UInt32(truncatingIfNeeded: t)
            carry = t >> 32
        }
        return r
    }
    private static func sub(_ a: N, _ b: N) -> N {
        var r = zero()
        var borrow: Int64 = 0
        for i in 0..<16 {
            var t = Int64(a[i]) - Int64(b[i]) - borrow
            borrow = t < 0 ? 1 : 0
            if t < 0 { t += 1 << 32 }
            r[i] = UInt32(t)
        }
        return r
    }
    private static func mul(_ a: N, _ b: N) -> N {
        var r = zero()
        for i in 0..<16 {
            var carry: UInt64 = 0
            for j in 0..<(16 - i) {
                let t = UInt64(a[i]) * UInt64(b[j]) + UInt64(r[i + j]) + carry
                r[i + j] = UInt32(truncatingIfNeeded: t)
                carry = t >> 32
            }
        }
        return r
    }
    private static func bit(_ a: N, _ i: Int) -> Bool { (a[i / 32] >> UInt32(i % 32)) & 1 == 1 }
    private static func shr255(_ a: N) -> N {
        var r = zero()
        for i in 0..<8 { r[i] = (a[i + 7] >> 31) | (i + 8 < 16 ? a[i + 8] << 1 : 0) }
        return r
    }
    private static func low255(_ a: N) -> N {
        var r = a
        for i in 8..<16 { r[i] = 0 }
        r[7] &= 0x7fff_ffff
        return r
    }

    // GF(2^255 - 19)
    private static func red(_ x: N) -> N {
        var x = x
        while true {
            let hi = shr255(x)
            if hi.allSatisfy({ $0 == 0 }) { break }
            x = add(low255(x), mul(hi, num(19)))
        }
        return cmp(x, P) >= 0 ? sub(x, P) : x
    }
    private static func addP(_ a: N, _ b: N) -> N { red(add(a, b)) }
    private static func subP(_ a: N, _ b: N) -> N { red(sub(add(a, P), b)) }
    private static func mulP(_ a: N, _ b: N) -> N { red(mul(a, b)) }
    private static func invP(_ a: N) -> N {
        let e = sub(P, num(2))
        var r = num(1)
        for i in stride(from: 254, through: 0, by: -1) {
            r = mulP(r, r)
            if bit(e, i) { r = mulP(r, a) }
        }
        return r
    }

    private struct Pt { var x: N, y: N, z: N, t: N }

    private static func padd(_ p: Pt, _ q: Pt) -> Pt {
        let a = mulP(subP(p.y, p.x), subP(q.y, q.x))
        let b = mulP(addP(p.y, p.x), addP(q.y, q.x))
        let c = mulP(mulP(p.t, addP(D, D)), q.t)
        let d = mulP(addP(p.z, p.z), q.z)
        let e = subP(b, a)
        let f = subP(d, c)
        let g = addP(d, c)
        let h = addP(b, a)
        return Pt(x: mulP(e, f), y: mulP(g, h), z: mulP(f, g), t: mulP(e, h))
    }

    private static func baseMultiple(_ k: N) -> [UInt8] {
        let base = Pt(x: BX, y: BY, z: num(1), t: mulP(BX, BY))
        var q = Pt(x: zero(), y: num(1), z: num(1), t: zero())
        for i in stride(from: 255, through: 0, by: -1) {
            q = padd(q, q)
            if bit(k, i) { q = padd(q, base) }
        }
        let zi = invP(q.z)
        let x = mulP(q.x, zi)
        let y = mulP(q.y, zi)
        var out = le32(y)
        out[31] |= UInt8(x[0] & 1) << 7
        return out
    }

    // Scalars mod L
    private static func modL(_ x: N) -> N {
        var rem = zero()
        for i in stride(from: 511, through: 0, by: -1) {
            var carry: UInt32 = bit(x, i % 512) ? 1 : 0
            for j in 0..<16 {
                let next = rem[j] >> 31
                rem[j] = (rem[j] << 1) | carry
                carry = next
            }
            if cmp(rem, L) >= 0 { rem = sub(rem, L) }
        }
        return rem
    }

    /// The RFC 8032 signature of `message` by the key with this 32-byte `seed`.
    static func sign(_ message: Data, seed: Data, publicKey: Data) -> Data {
        let h = Array(SHA512.hash(data: seed))
        var a = Array(h[0..<32])
        a[0] &= 248
        a[31] &= 127
        a[31] |= 64
        let r = modL(fromLE64(Array(SHA512.hash(data: Data(h[32..<64]) + message))))
        let rEnc = baseMultiple(r)
        let k = modL(fromLE64(Array(SHA512.hash(data: Data(rEnc) + publicKey + message))))
        let s = modL(add(r, mul(k, fromLE(a))))
        return Data(rEnc + le32(s))
    }

    private static func fromLE64(_ d: [UInt8]) -> N { fromLE(d) }
}
