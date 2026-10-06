#if canImport(Security)
import Foundation
import Security
import XCTest

@testable import PolarisKeyPlatform

final class SecureStoreTests: XCTestCase {
    func testItemAttributes() {
        let kc = FakeKeychain()
        let store = SecureStore(product: "diceroll", backend: kc)
        XCTAssertEqual(store.set(account: "device", value: "d1"), ["ok": true, "op": "add"])
        guard let added = kc.added.first else { return XCTFail("nothing added") }
        XCTAssertEqual(added[kSecAttrService as String] as? String, "pkey:diceroll")
        XCTAssertEqual(added[kSecAttrAccount as String] as? String, "device")
        XCTAssertEqual(added[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(added[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(
            added[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
            "both values are AfterFirstUnlockThisDeviceOnly (S-09), unlike KeychainStore's AfterFirstUnlock")
        XCTAssertNil(added[kSecAttrAccessGroup as String], "no explicit access group")
        for q in kc.queries { XCTAssertNil(q[kSecAttrAccessGroup as String]) }
    }

    func testRoundTripUpdateAndDelete() {
        let kc = FakeKeychain()
        let store = SecureStore(product: "diceroll", backend: kc)
        XCTAssertEqual(store.get(account: "token"), ["ok": true, "value": .null])
        XCTAssertEqual(store.set(account: "token", value: "pkeyt_1"), ["ok": true, "op": "add"])
        XCTAssertEqual(store.set(account: "token", value: "pkeyt_2"), ["ok": true, "op": "update"])
        XCTAssertEqual(
            kc.updates.last?[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(store.get(account: "token"), ["ok": true, "value": "pkeyt_2"])
        XCTAssertEqual(store.delete(account: "token"), ["ok": true])
        XCTAssertEqual(store.delete(account: "token"), ["ok": true], "deleting an absent item is success")
        XCTAssertEqual(store.get(account: "token"), ["ok": true, "value": .null])
    }

    func testFailuresAreSurfacedWithTheirStatus() {
        let kc = FakeKeychain()
        kc.failWith = -34018  // errSecMissingEntitlement
        let store = SecureStore(product: "diceroll", backend: kc)
        XCTAssertEqual(store.get(account: "token"), ["ok": false, "error": "keychain", "status": -34018])
        XCTAssertEqual(store.set(account: "token", value: "x")["status"], -34018)
        XCTAssertEqual(store.delete(account: "token")["ok"], false)
    }

    func testLoginKeychainAttributes() {
        let kc = FakeKeychain()
        let store = SecureStore(product: "diceroll", backend: kc, keychain: .login)
        XCTAssertEqual(store.set(account: "device-token", value: "pkeyt_1"), ["ok": true, "op": "add"])
        guard let added = kc.added.first else { return XCTFail("nothing added") }
        XCTAssertEqual(added[kSecAttrService as String] as? String, "pkey:diceroll")
        XCTAssertEqual(added[kSecAttrAccount as String] as? String, "device-token")
        XCTAssertNil(added[kSecUseDataProtectionKeychain as String], "the login keychain, not the data-protection one")
        XCTAssertNil(added[kSecAttrAccessible as String], "the login keychain has no accessibility class")
        XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, false)
        for q in kc.queries { XCTAssertNil(q[kSecUseDataProtectionKeychain as String]) }
        XCTAssertEqual(store.get(account: "device-token"), ["ok": true, "value": "pkeyt_1"])
    }

    func testNamesAreValidated() {
        let store = SecureStore(product: "Dice Roll", backend: FakeKeychain())
        XCTAssertEqual(store.get(account: "token")["error"], "invalid_name")
        let ok = SecureStore(product: "diceroll", backend: FakeKeychain())
        XCTAssertEqual(ok.set(account: "../x", value: "v")["error"], "invalid_name")
    }
}
#endif
