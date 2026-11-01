import CryptoKit
import Foundation
import XCTest

@testable import PolarisKeyPlatform

/// The cx_* ops (CC-14b.3) against the Noise corpus rows: RFC 7748 x25519, the low-order points
/// and NIST AES-GCM, through `PlatformHost.callBinary` exactly as the C surface reaches them.
final class CryptoOpsTests: XCTestCase {
    private let host = PlatformHost(
        services: .system(), binaryOps: PlatformBinaryOps.system(sink: PlatformEventSink(), environment: [:]))

    private func hex(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    private func call(_ op: String, _ bytes: [UInt8]) -> [UInt8] {
        bytes.withUnsafeBufferPointer { host.callBinary(op, $0) }
    }

    private func gcmInput(_ key: [UInt8], _ nonce: [UInt8], _ aad: [UInt8], _ body: [UInt8]) -> [UInt8] {
        let n = aad.count
        return key + nonce + [UInt8(n >> 24 & 255), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)] + aad
            + body
    }

    private func vectors() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/corpus/v2/noise-vectors.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    func testX25519Rows() throws {
        let v = try vectors()
        let x = v["x25519"] as! [String: Any]
        for r in x["scalarMult"] as! [[String: String]] {
            let out = call("cx_x25519", hex(r["scalar"]!) + hex(r["u"]!))
            XCTAssertEqual(out, [1] + hex(r["expect"]!), r["id"]!)
        }
        for r in x["agreement"] as! [[String: String]] {
            XCTAssertEqual(call("cx_x25519_pub", hex(r["alicePrivate"]!)), [1] + hex(r["alicePublic"]!))
            XCTAssertEqual(call("cx_x25519_pub", hex(r["bobPrivate"]!)), [1] + hex(r["bobPublic"]!))
            XCTAssertEqual(call("cx_x25519", hex(r["alicePrivate"]!) + hex(r["bobPublic"]!)), [1] + hex(r["shared"]!))
            XCTAssertEqual(call("cx_x25519", hex(r["bobPrivate"]!) + hex(r["alicePublic"]!)), [1] + hex(r["shared"]!))
        }
    }

    func testLowOrderRowsAreRefusedOrMatch() throws {
        let low = try vectors()["lowOrder"] as! [String: Any]
        let scalar = hex(low["scalar"] as! String)
        for r in low["rows"] as! [[String: Any]] {
            let out = call("cx_x25519", scalar + hex(r["u"] as! String))
            if r["allZero"] as! Bool {
                XCTAssertEqual(out, [0], r["id"] as! String)  // dh_zero: refused, never a secret
            } else {
                XCTAssertEqual(out, [1] + hex(r["output"] as! String), r["id"] as! String)
            }
        }
    }

    func testAesGcmRows() throws {
        for r in try vectors()["aesGcm"] as! [[String: String]] {
            let key = hex(r["key"]!)
            let nonce = hex(r["nonce"]!)
            let aad = hex(r["aad"]!)
            let plain = hex(r["plaintext"]!)
            let sealed = hex(r["ciphertext"]!) + hex(r["tag"]!)
            XCTAssertEqual(call("cx_seal", gcmInput(key, nonce, aad, plain)), [1] + sealed, r["id"]!)
            XCTAssertEqual(call("cx_open", gcmInput(key, nonce, aad, sealed)), [1] + plain, r["id"]!)
            var bad = sealed
            bad[bad.count - 1] ^= 1
            XCTAssertEqual(call("cx_open", gcmInput(key, nonce, aad, bad)), [0])
            XCTAssertEqual(call("cx_open", gcmInput(key, nonce, aad + [1], sealed)), [0])
        }
    }

    func testBadInputs() {
        let key = [UInt8](repeating: 1, count: 32)
        let nonce = [UInt8](repeating: 2, count: 12)
        XCTAssertEqual(call("cx_seal", []), [3])
        XCTAssertEqual(call("cx_seal", key + nonce), [3])
        // aadLen larger than what follows.
        XCTAssertEqual(call("cx_seal", key + nonce + [0, 0, 0, 9, 1, 2]), [3])
        XCTAssertEqual(call("cx_seal", key + nonce + [0xFF, 0xFF, 0xFF, 0xFF]), [3])
        // Fewer bytes than a tag.
        XCTAssertEqual(call("cx_open", gcmInput(key, nonce, [], [1, 2, 3])), [3])
        XCTAssertEqual(call("cx_x25519", key), [3])
        XCTAssertEqual(call("cx_x25519", key + key + [0]), [3])
        XCTAssertEqual(call("cx_x25519_pub", key + [0]), [3])
        XCTAssertEqual(call("cx_x25519_pub", []), [3])
    }

    func testLargeChunkAndAllByteValues() {
        let key = (0..<32).map { UInt8($0) }
        let nonce = (0..<12).map { UInt8(100 + $0) }
        let plain = (0..<(1 << 20)).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ 3) }
        let sealed = call("cx_seal", gcmInput(key, nonce, [], plain))
        XCTAssertEqual(sealed.count, 1 + plain.count + 16)
        XCTAssertEqual(call("cx_open", gcmInput(key, nonce, [], Array(sealed.dropFirst()))), [1] + plain)
    }

    /// The sync entry answers (GM.1): an empty message, an empty AAD, a refused tag, and one 1 MiB
    /// message with 64 KiB of AAD, the largest call the sync facade hands a lane, with a pinned digest.
    func testSyncAnswers() {
        let zeroKey = [UInt8](repeating: 0, count: 32)
        let zeroNonce = [UInt8](repeating: 0, count: 12)
        let emptySealed = hex("530f8afbc74536b9a963b4f1c4cb738b")
        XCTAssertEqual(call("cx_seal", gcmInput(zeroKey, zeroNonce, [], [])), [1] + emptySealed)
        XCTAssertEqual(call("cx_open", gcmInput(zeroKey, zeroNonce, [], emptySealed)), [1])
        var tampered = emptySealed
        tampered[0] ^= 1
        XCTAssertEqual(call("cx_open", gcmInput(zeroKey, zeroNonce, [], tampered)), [0])

        let key = (0..<32).map { UInt8($0) }
        let nonce = (0..<12).map { UInt8(0xA0 + $0) }
        let aad = Array("pkey-sync-kat".utf8)
        let plain = (0..<(1 << 20)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }
        let reply = call("cx_seal", gcmInput(key, nonce, aad, plain))
        XCTAssertEqual(reply.count, 1 + plain.count + 16)
        XCTAssertEqual(reply.first, 1)
        let sealed = Array(reply.dropFirst())
        XCTAssertEqual(
            SHA256.hash(data: sealed).map { String(format: "%02x", $0) }.joined(),
            "20985c5839f5d4ccc63675c2e97146b4e8de8c720a4536b93b8f36b9fa50d672")
        XCTAssertEqual(call("cx_open", gcmInput(key, nonce, aad, sealed)), [1] + plain)
        var flipped = sealed
        flipped[flipped.count - 1] ^= 1
        XCTAssertEqual(call("cx_open", gcmInput(key, nonce, aad, flipped)), [0])

        // The entry bound: the largest call the facade hands over (1 MiB, 64 KiB of AAD) is taken.
        let bigAad = [UInt8](repeating: 0x5A, count: 64 * 1024)
        let big = call("cx_seal", gcmInput(key, nonce, bigAad, plain))
        XCTAssertEqual(big.count, 1 + plain.count + 16)
        XCTAssertEqual(call("cx_open", gcmInput(key, nonce, bigAad, Array(big.dropFirst()))), [1] + plain)
    }

    func testOpsAreRegisteredWithoutTheSelftestSwitch() {
        for op in ["cx_seal", "cx_open", "cx_x25519", "cx_x25519_pub"] {
            XCTAssertNotNil(PlatformBinaryOps.system(sink: PlatformEventSink(), environment: [:])[op], op)
        }
    }
}
