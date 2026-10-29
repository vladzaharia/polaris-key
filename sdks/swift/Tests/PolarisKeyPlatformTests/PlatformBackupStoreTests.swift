#if canImport(Security)
    import Foundation
    import Security
    import XCTest

    @testable import PolarisKeyPlatform

    final class PlatformBackupStoreTests: XCTestCase {
        private let value = PlatformBackupStore.RestoreValue(restoreId: "rst_1", secret: "s3cr3t-value")

        func testRestoreItemAttributes() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc)
            try store.writeRestore(product: "diceroll", value)
            guard let added = kc.added.first else { return XCTFail("nothing added") }
            XCTAssertEqual(added[kSecClass as String] as? String, kSecClassGenericPassword as String)
            XCTAssertEqual(added[kSecAttrService as String] as? String, "pkey-restore:diceroll")
            XCTAssertEqual(added[kSecAttrAccount as String] as? String, "restore")
            XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, true)
            XCTAssertEqual(added[kSecUseDataProtectionKeychain as String] as? Bool, true)
            XCTAssertEqual(
                added[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlock as String,
                "a synchronizable item cannot be ThisDeviceOnly")
            XCTAssertNil(added[kSecAttrAccessGroup as String], "the default is the app's own group (D-7)")
            let json = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: try XCTUnwrap(added[kSecValueData as String] as? Data))
                    as? [String: Any])
            XCTAssertEqual(json["v"] as? Int, 1)
            XCTAssertEqual(json["restoreId"] as? String, "rst_1")
            XCTAssertEqual(Set(json.keys), ["v", "restoreId", "secret"])
        }

        func testSyncRootItemAttributes() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc)
            let bytes = Data(#"{"v":1,"root":"AAAA"}"#.utf8)
            try store.set(.syncRoot(product: "diceroll", subject: "usr_7", ringId: "ring.1"), value: bytes)
            let added = try XCTUnwrap(kc.added.first)
            XCTAssertEqual(added[kSecAttrService as String] as? String, "pkey-sync:diceroll")
            XCTAssertEqual(added[kSecAttrAccount as String] as? String, "usr_7:ring.1")
            XCTAssertEqual(added[kSecAttrSynchronizable as String] as? Bool, true)
            XCTAssertEqual(try store.get(.syncRoot(product: "diceroll", subject: "usr_7", ringId: "ring.1")), bytes)
        }

        func testRoundTripUpdateAndDelete() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc)
            XCTAssertNil(try store.readRestore(product: "diceroll"))
            try store.writeRestore(product: "diceroll", value)
            let next = PlatformBackupStore.RestoreValue(restoreId: "rst_2", secret: "other")
            try store.writeRestore(product: "diceroll", next)
            XCTAssertEqual(kc.added.count, 1, "the second write updates")
            XCTAssertEqual(
                kc.updates.last?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlock as String)
            XCTAssertEqual(try store.readRestore(product: "diceroll"), next)
            try store.deleteRestore(product: "diceroll")
            try store.deleteRestore(product: "diceroll")  // absent is success
            XCTAssertNil(try store.readRestore(product: "diceroll"))
        }

        func testEveryQueryIsSynchronizableDataProtection() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc)
            try store.writeRestore(product: "diceroll", value)
            _ = try store.get(.restore(product: "diceroll"))
            try store.deleteRestore(product: "diceroll")
            XCTAssertFalse(kc.queries.isEmpty)
            for q in kc.queries {
                XCTAssertEqual(q[kSecAttrSynchronizable as String] as? Bool, true)
                XCTAssertEqual(q[kSecUseDataProtectionKeychain as String] as? Bool, true)
            }
        }

        func testAccessGroupIsSetOnlyWhenPassed() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc, accessGroup: "TEAM123.group.example")
            XCTAssertEqual(store.accessGroup, "TEAM123.group.example")
            try store.writeRestore(product: "diceroll", value)
            _ = try store.get(.restore(product: "diceroll"))
            try store.deleteRestore(product: "diceroll")
            XCTAssertEqual(kc.added.first?[kSecAttrAccessGroup as String] as? String, "TEAM123.group.example")
            XCTAssertFalse(kc.queries.isEmpty)
            for q in kc.queries { XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String, "TEAM123.group.example") }

            let plain = FakeKeychain()
            let empty = PlatformBackupStore(backend: plain, accessGroup: "")
            XCTAssertNil(empty.accessGroup)
            try empty.writeRestore(product: "diceroll", value)
            XCTAssertNil(plain.added.first?[kSecAttrAccessGroup as String])
            for q in plain.queries { XCTAssertNil(q[kSecAttrAccessGroup as String]) }
        }

        func testPrefixGuardRefusesOtherServices() {
            let store = PlatformBackupStore(backend: FakeKeychain())
            for service in ["pkey:diceroll", "pkey-restore", "pkey-syncx:diceroll", "com.apple.x", ""] {
                XCTAssertThrowsError(try store.query(service: service, account: "token")) {
                    XCTAssertEqual($0 as? PlatformBackupStore.Failure, .refusedService, service)
                }
            }
            XCTAssertNoThrow(try store.query(service: "pkey-restore:diceroll", account: "restore"))
            XCTAssertNoThrow(try store.query(service: "pkey-sync:diceroll", account: "u:r"))
        }

        func testNamesAreValidated() {
            let store = PlatformBackupStore(backend: FakeKeychain())
            XCTAssertThrowsError(try store.get(.restore(product: "Dice Roll"))) {
                XCTAssertEqual($0 as? PlatformBackupStore.Failure, .invalidName)
            }
            for (subject, ring) in [("a:b", "r"), ("s", "r:1"), ("", "r"), ("s", ""), ("../x", "r")] {
                XCTAssertThrowsError(try store.get(.syncRoot(product: "diceroll", subject: subject, ringId: ring))) {
                    XCTAssertEqual($0 as? PlatformBackupStore.Failure, .invalidName, "\(subject)|\(ring)")
                }
            }
            // A host-namespaced product (a non-production Worker) is accepted, as in SecureStore.
            XCTAssertNoThrow(try store.get(.restore(product: "diceroll@localhost_8787")))
        }

        func testValueBounds() throws {
            let kc = FakeKeychain()
            let store = PlatformBackupStore(backend: kc)
            let item = PlatformBackupStore.Item.restore(product: "diceroll")
            let big = Data(#"{"v":1,"pad":"\#(String(repeating: "x", count: 4096))"}"#.utf8)
            XCTAssertThrowsError(try store.set(item, value: big)) {
                XCTAssertEqual($0 as? PlatformBackupStore.Failure, .invalidValue)
            }
            XCTAssertThrowsError(try store.set(item, value: Data("not json".utf8)))
            XCTAssertThrowsError(try store.set(item, value: Data("[1]".utf8)), "an object, not an array")
            // Exactly 4096 bytes is accepted.
            let head = #"{"v":1,"pad":""#
            let tail = #""}"#
            let pad = String(repeating: "x", count: 4096 - head.utf8.count - tail.utf8.count)
            let edge = Data((head + pad + tail).utf8)
            XCTAssertEqual(edge.count, 4096)
            XCTAssertNoThrow(try store.set(item, value: edge))
            XCTAssertEqual(kc.added.count, 1, "refused values never reach the Keychain")
        }

        func testRestoreValueDecodeAndRedaction() throws {
            XCTAssertEqual(PlatformBackupStore.RestoreValue.decode(try value.encoded()), value)
            XCTAssertNil(PlatformBackupStore.RestoreValue.decode(Data(#"{"v":2,"restoreId":"a","secret":"b"}"#.utf8)))
            XCTAssertNil(PlatformBackupStore.RestoreValue.decode(Data(#"{"v":1,"restoreId":"a"}"#.utf8)))
            XCTAssertNil(PlatformBackupStore.RestoreValue.decode(Data("nope".utf8)))
            for text in ["\(value)", String(reflecting: value), String(describing: value)] {
                XCTAssertFalse(text.contains("s3cr3t-value"), text)
                XCTAssertTrue(text.contains("redacted"))
            }
        }

        func testMissingEntitlementAndNotAvailableAreUnavailable() throws {
            for status in [OSStatus(-34018), errSecNotAvailable] {
                let kc = FakeKeychain()
                kc.failWith = status
                let store = PlatformBackupStore(backend: kc, accessGroup: "TEAM123.group.example")
                let expected = PlatformBackupStore.Failure.unavailable(status: Int32(status))
                XCTAssertThrowsError(try store.get(.restore(product: "diceroll"))) {
                    XCTAssertEqual($0 as? PlatformBackupStore.Failure, expected)
                }
                XCTAssertThrowsError(try store.writeRestore(product: "diceroll", value)) {
                    XCTAssertEqual($0 as? PlatformBackupStore.Failure, expected)
                }
                XCTAssertThrowsError(try store.deleteRestore(product: "diceroll")) {
                    XCTAssertEqual($0 as? PlatformBackupStore.Failure, expected)
                }
            }
        }

        func testOtherStatusesAreKeychainFailures() {
            let kc = FakeKeychain()
            kc.failWith = errSecInteractionNotAllowed
            let store = PlatformBackupStore(backend: kc)
            XCTAssertThrowsError(try store.get(.restore(product: "diceroll"))) {
                XCTAssertEqual(
                    $0 as? PlatformBackupStore.Failure, .keychain(status: Int32(errSecInteractionNotAllowed)))
            }
        }

        func testThisStoreNeverTouchesSecureStoreItems() throws {
            let kc = FakeKeychain()
            let secure = SecureStore(product: "diceroll", backend: kc)
            XCTAssertEqual(secure.set(account: "token", value: "pkeyt_1")["ok"], true)
            let store = PlatformBackupStore(backend: kc)
            try store.deleteRestore(product: "diceroll")
            XCTAssertEqual(secure.get(account: "token"), ["ok": true, "value": "pkeyt_1"])
        }
    }
#endif
