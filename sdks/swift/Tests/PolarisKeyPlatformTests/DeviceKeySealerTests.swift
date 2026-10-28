#if canImport(Security) && canImport(CryptoKit)
    import Foundation
    import Security
    import XCTest

    @testable import PolarisKeyPlatform

    final class DeviceKeySealerTests: XCTestCase {
        private let ctx = Data("pkey-device-keys/1/diceroll".utf8)
        private let plain = Data((0..<141).map { UInt8($0) })

        private func sealer(_ kc: FakeKeychain, _ product: String = "diceroll") -> DeviceKeySealer {
            DeviceKeySealer(product: product, backend: kc)
        }

        private func blob(_ r: PlatformObject) -> Data {
            Data(base64Encoded: r["blob"]?.stringValue ?? "") ?? Data()
        }

        func testRoundTripAndKeyAttributes() {
            let kc = FakeKeychain()
            let s = sealer(kc)
            let sealed = s.seal(plain: plain, context: ctx)
            XCTAssertEqual(sealed["ok"], true)
            let b = blob(sealed)
            XCTAssertEqual(b.first, 1)
            XCTAssertEqual(b.count, 1 + 12 + plain.count + 16)
            XCTAssertFalse(b.contains(plain.prefix(16)), "the record is not in the blob")
            let opened = s.open(blob: b, context: ctx)
            XCTAssertEqual(Data(base64Encoded: opened["plain"]?.stringValue ?? ""), plain)
            guard let added = kc.added.first else { return XCTFail("no key item") }
            XCTAssertEqual(added[kSecAttrService as String] as? String, "pkey:diceroll")
            XCTAssertEqual(added[kSecAttrAccount as String] as? String, "device-key-seal")
            XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, false)
            XCTAssertEqual(
                added[kSecAttrAccessible as String] as? String,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            XCTAssertNil(added[kSecAttrAccessGroup as String])
        }

        func testOneKeyIsReused() {
            let kc = FakeKeychain()
            let s = sealer(kc)
            _ = s.seal(plain: plain, context: ctx)
            _ = s.seal(plain: plain, context: ctx)
            XCTAssertEqual(kc.added.count, 1, "a second seal reuses the key")
            XCTAssertNotEqual(
                blob(s.seal(plain: plain, context: ctx)), blob(s.seal(plain: plain, context: ctx)), "fresh nonce")
        }

        func testContextAndTamperAreUnopenable() {
            let kc = FakeKeychain()
            let s = sealer(kc)
            var b = blob(s.seal(plain: plain, context: ctx))
            XCTAssertEqual(s.open(blob: b, context: Data("pkey-device-keys/1/other".utf8)), DeviceKeySealer.unopenable)
            b[b.count - 1] ^= 1
            XCTAssertEqual(s.open(blob: b, context: ctx), DeviceKeySealer.unopenable)
            XCTAssertEqual(s.open(blob: Data([1, 2, 3]), context: ctx), DeviceKeySealer.unopenable)
            var wrongVersion = blob(s.seal(plain: plain, context: ctx))
            wrongVersion[0] = 2
            XCTAssertEqual(s.open(blob: wrongVersion, context: ctx), DeviceKeySealer.unopenable)
        }

        func testMissingKeyIsUnopenableAndOpenNeverCreatesOne() {
            let kc = FakeKeychain()
            let b = blob(sealer(kc).seal(plain: plain, context: ctx))
            let other = FakeKeychain()  // the key is gone (a new device, a restore)
            XCTAssertEqual(sealer(other).open(blob: b, context: ctx), DeviceKeySealer.unopenable)
            XCTAssertTrue(other.added.isEmpty, "open never creates a key")
        }

        func testTransientKeychainErrorIsAnErrorNeverMissing() {
            let kc = FakeKeychain()
            let s = sealer(kc)
            let b = blob(s.seal(plain: plain, context: ctx))
            kc.failWith = errSecInteractionNotAllowed
            let open = s.open(blob: b, context: ctx)
            XCTAssertEqual(open["error"], "keychain")
            XCTAssertEqual(open["status"], .int(Int(errSecInteractionNotAllowed)))
            XCTAssertEqual(s.seal(plain: plain, context: ctx)["error"], "keychain", "a fault never makes a new key")
            XCTAssertEqual(s.destroy()["error"], "keychain")
            kc.failWith = nil
            XCTAssertEqual(s.open(blob: b, context: ctx)["ok"], true, "the key survived the fault")
        }

        func testDestroyMakesBlobsUnopenableAndIsIdempotent() {
            let kc = FakeKeychain()
            let s = sealer(kc)
            let b = blob(s.seal(plain: plain, context: ctx))
            XCTAssertEqual(s.destroy(), ["ok": true])
            XCTAssertEqual(s.destroy(), ["ok": true])
            XCTAssertEqual(s.open(blob: b, context: ctx), DeviceKeySealer.unopenable)
        }

        func testProductsHaveTheirOwnKeys() {
            let kc = FakeKeychain()
            let b = blob(sealer(kc, "diceroll").seal(plain: plain, context: ctx))
            _ = sealer(kc, "other").seal(plain: plain, context: ctx)
            XCTAssertEqual(kc.added.count, 2)
            XCTAssertEqual(sealer(kc, "other").open(blob: b, context: ctx), DeviceKeySealer.unopenable)
        }

        func testThroughJSON() {
            let kc = FakeKeychain()
            let h = PlatformHost(services: fakeServices(keychain: kc))
            func call(_ s: String) -> PlatformObject {
                decodePlatformJSON(h.call(s)) ?? [:]
            }
            let c = ctx.base64EncodedString()
            let p = plain.base64EncodedString()
            let sealed = call(#"{"op":"dk_seal","product":"diceroll","context":"\#(c)","plain":"\#(p)"}"#)
            XCTAssertEqual(sealed["ok"], true)
            let b = sealed["blob"]?.stringValue ?? ""
            XCTAssertEqual(
                call(#"{"op":"dk_open","product":"diceroll","context":"\#(c)","blob":"\#(b)"}"#)["plain"], .string(p))
            XCTAssertEqual(call(#"{"op":"dk_open","product":"diceroll","context":"\#(c)"}"#)["error"], "bad_input")
            XCTAssertEqual(
                call(#"{"op":"dk_seal","product":"Bad Name","context":"\#(c)","plain":"\#(p)"}"#)["error"],
                "invalid_name")
            XCTAssertEqual(
                call(#"{"op":"dk_seal","product":"diceroll","keychain":"login","context":"\#(c)","plain":"\#(p)"}"#)[
                    "ok"], true)
            XCTAssertEqual(
                kc.queries.last?[kSecUseDataProtectionKeychain as String] as? Bool, nil,
                "the login keychain was asked for")
            XCTAssertEqual(
                call(#"{"op":"dk_seal","product":"diceroll","keychain":"icloud","context":"\#(c)","plain":"\#(p)"}"#)[
                    "error"], "invalid_keychain")
            XCTAssertEqual(call(#"{"op":"dk_destroy","product":"diceroll"}"#), ["ok": true])
            let (none, _) = (PlatformHost(services: fakeServices(keychain: nil)), 0)
            XCTAssertEqual(
                decodePlatformJSON(none.call(#"{"op":"dk_destroy","product":"diceroll"}"#))?["reason"], "runtime")
        }
    }
#endif
