// @pkey-feature core.store
// KeychainStore against an injected fake keychain (P1b-09 plan §5.6, security finding R4-11):
// the data-protection keychain first, the legacy file-based keychain on
// errSecMissingEntitlement (−34018) with a `legacy-keychain` status, migration on read, and
// deletion from both. A real unsigned test bundle cannot reach the data-protection keychain at
// all, so every branch here runs through the seam; H4 (a signed app) is a hand-off.

import Foundation
import Security
import XCTest

@testable import PolarisKeyCore

/// Two item slots — data-protection and legacy — keyed by whether the query carried
/// `kSecUseDataProtectionKeychain`. Status overrides simulate the failures.
private final class FakeKeychain: KeychainAPI, @unchecked Sendable {
    private let lock = NSLock()
    var dp: Data?
    var legacy: Data?
    /// The data-protection keychain answers −34018 to everything (no entitlement).
    var missingEntitlement = false
    /// Force a status on the data-protection side's copy / write.
    var dpCopyStatus: OSStatus?
    var dpWriteStatus: OSStatus?
    /// Every query, for asserting attributes.
    private(set) var queries: [[String: Any]] = []
    private(set) var writes: [(dataProtection: Bool, attributes: [String: Any])] = []

    private func isDP(_ q: [String: Any]) -> Bool {
        (q[kSecUseDataProtectionKeychain as String] as? Bool) == true
    }

    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.lock()
        defer { lock.unlock() }
        queries.append(query)
        if isDP(query) {
            if missingEntitlement { return (errSecMissingEntitlement, nil) }
            if let forced = dpCopyStatus { return (forced, nil) }
            guard let dp else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, (query[kSecReturnData as String] as? Bool) == true ? dp : nil)
        }
        guard let legacy else { return (errSecItemNotFound, nil) }
        return (errSecSuccess, (query[kSecReturnData as String] as? Bool) == true ? legacy : nil)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let dataProtection = isDP(attributes)
        writes.append((dataProtection, attributes))
        let data = attributes[kSecValueData as String] as? Data
        if dataProtection {
            if missingEntitlement { return errSecMissingEntitlement }
            if let forced = dpWriteStatus { return forced }
            dp = data
        } else {
            legacy = data
        }
        return errSecSuccess
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        let dataProtection = isDP(query)
        writes.append((dataProtection, attributes))
        let data = attributes[kSecValueData as String] as? Data
        if dataProtection {
            if missingEntitlement { return errSecMissingEntitlement }
            if let forced = dpWriteStatus { return forced }
            guard dp != nil else { return errSecItemNotFound }
            dp = data
        } else {
            guard legacy != nil else { return errSecItemNotFound }
            legacy = data
        }
        return errSecSuccess
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.lock()
        defer { lock.unlock() }
        if isDP(query) {
            if missingEntitlement { return errSecMissingEntitlement }
            guard dp != nil else { return errSecItemNotFound }
            dp = nil
        } else {
            guard legacy != nil else { return errSecItemNotFound }
            legacy = nil
        }
        return errSecSuccess
    }
}

final class KeychainStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-keychain-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func store(_ fake: FakeKeychain) -> KeychainStore {
        KeychainStore(productSlug: "djdl", configDir: root, keychain: fake)
    }

    private func string(_ data: Data?) -> String? { data.flatMap { String(data: $0, encoding: .utf8) } }

    func testEntitledWritesGoToTheDataProtectionKeychainWithAfterFirstUnlock() async throws {
        let fake = FakeKeychain()
        fake.legacy = Data("pkeyt_old".utf8)
        let s = store(fake)
        try await s.setToken("pkeyt_dp")
        XCTAssertEqual(string(fake.dp), "pkeyt_dp")
        XCTAssertNil(fake.legacy, "a successful data-protection write deletes the legacy item")
        let dpWrite = try XCTUnwrap(fake.writes.first { $0.dataProtection })
        XCTAssertEqual(
            dpWrite.attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlock as String)
        let token = try await s.getToken()
        XCTAssertEqual(token, "pkeyt_dp")
        let status = await s.status()
        XCTAssertEqual(status, StoreStatus(backend: .keychain))
    }

    #if os(macOS)
    func testMissingEntitlementFallsBackToTheLegacyKeychainAndSaysSo() async throws {
        let fake = FakeKeychain()
        fake.missingEntitlement = true
        let s = store(fake)
        try await s.setToken("pkeyt_legacy")
        XCTAssertEqual(string(fake.legacy), "pkeyt_legacy")
        XCTAssertNil(fake.dp)
        let token = try await s.getToken()
        XCTAssertEqual(token, "pkeyt_legacy")
        let status = await s.status()
        XCTAssertEqual(status?.backend, .keychain)
        XCTAssertEqual(status?.degraded?.reason, .legacyKeychain)
        XCTAssertFalse((status?.degraded?.detail ?? "").contains("pkeyt_legacy"))
    }

    func testALegacyItemIsMigratedOnReadWhenTheDataProtectionKeychainIsAvailable() async throws {
        let fake = FakeKeychain()
        fake.legacy = Data("pkeyt_migrate".utf8)
        let s = store(fake)
        let token = try await s.getToken()
        XCTAssertEqual(token, "pkeyt_migrate")
        XCTAssertEqual(string(fake.dp), "pkeyt_migrate")
        XCTAssertNil(fake.legacy)
    }

    func testAFailedMigrationStillReturnsTheToken() async throws {
        let fake = FakeKeychain()
        fake.legacy = Data("pkeyt_keep".utf8)
        fake.dpWriteStatus = errSecInteractionNotAllowed
        let s = store(fake)
        let token = try await s.getToken()
        XCTAssertEqual(token, "pkeyt_keep")
        XCTAssertEqual(string(fake.legacy), "pkeyt_keep", "the legacy item stays until a migration succeeds")
    }

    func testClearDeletesFromBoth() async throws {
        let fake = FakeKeychain()
        fake.dp = Data("a".utf8)
        fake.legacy = Data("b".utf8)
        try await store(fake).clearToken()
        XCTAssertNil(fake.dp)
        XCTAssertNil(fake.legacy)
    }

    func testClearWithoutTheEntitlementStillDeletesTheLegacyItem() async throws {
        let fake = FakeKeychain()
        fake.missingEntitlement = true
        fake.legacy = Data("b".utf8)
        try await store(fake).clearToken()
        XCTAssertNil(fake.legacy)
    }
    #endif

    func testAnotherKeychainFailureIsKeyringErrorAndWritesThrow() async throws {
        let fake = FakeKeychain()
        fake.dpCopyStatus = errSecInteractionNotAllowed
        fake.dpWriteStatus = errSecInteractionNotAllowed
        let s = store(fake)
        let status = await s.status()
        XCTAssertEqual(status?.backend, .keychain)
        XCTAssertEqual(status?.degraded?.reason, .keyringError)
        XCTAssertTrue((status?.degraded?.detail ?? "").contains("\(errSecInteractionNotAllowed)"))
        do {
            try await s.setToken("x")
            XCTFail("a keychain failure other than −34018 must throw")
        } catch StoreError.keychain(let code) {
            XCTAssertEqual(code, errSecInteractionNotAllowed)
        }
    }

    func testStatusIsAnAttributeOnlyProbe() async {
        let fake = FakeKeychain()
        _ = await store(fake).status()
        let probe = try? XCTUnwrap(fake.queries.last)
        XCTAssertEqual(probe?[kSecReturnAttributes as String] as? Bool, true)
        XCTAssertNil(probe?[kSecReturnData as String], "status() never reads the secret")
    }

    func testTheRealKeychainStoreReportsTheKeychainBackend() async {
        // Whatever this host's entitlement situation, the backend is the keychain; an unsigned
        // macOS test bundle is expected to report `legacy-keychain`.
        let status = await KeychainStore(productSlug: "djdl", configDir: root).status()
        XCTAssertEqual(status?.backend, .keychain)
    }

    func testInMemoryStoreReportsMemoryAndAHostStoreReportsNil() async {
        let memory = await InMemoryStore(productSlug: "djdl").status()
        XCTAssertEqual(memory, StoreStatus(backend: .memory))
        let host = await BareStore().status()
        XCTAssertNil(host, "a host store without status() reports nothing, by the protocol default")
    }

    func testTheVocabularyMatchesClientCore() {
        XCTAssertEqual(
            StoreBackend.allCases.map(\.rawValue),
            ["keyring", "keychain", "keystore", "file", "memory", "indexeddb", "custom"])
        XCTAssertEqual(
            StoreDegradedReason.allCases.map(\.rawValue),
            ["keyring-unavailable", "keyring-error", "legacy-keychain", "not-persistent"])
    }
}

/// A host store that predates `status()`.
private actor BareStore: Store {
    func getToken() async throws -> String? { nil }
    func setToken(_ token: String) async throws {}
    func clearToken() async throws {}
    func getDeviceId() async throws -> String { "d" }
    func readCache() async -> CacheRecord? { nil }
    func writeCache(_ record: CacheRecord) async throws {}
    func clearCache() async throws {}
}
