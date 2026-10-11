// @pkey-feature core.store config.local devices.attest
//
// SP-41: every durable name the SDK owns follows the base URL's origin. The production host keeps
// the historical names (`<product>`); any other origin appends `@<host>`, so a local control plane
// (`pkey dev`) never shares a directory, a Keychain item or a UserDefaults key with production on
// the same machine.
//
// These tests build the real pieces (no injected store, no injected key store, no injected
// `LocalConfigStore`) against a scratch directory and read back what they derived and wrote: the
// product directories, the presentation cache, `KeychainStore`'s service and files, the packs
// directory, `ConfigClient`'s UserDefaults key and `DevicesClient`'s App Attest Keychain service.
// Nothing here touches the Keychain (a device id and a cache record are files) or the network.

import Foundation
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyPacks
import PolarisKeyPlatform
import Security
import XCTest

@testable import PolarisKey

final class StoreNamespaceTests: XCTestCase {
    /// One control plane the SDK can be pointed at, and the namespace its state must live under.
    private struct Origin {
        let label: String
        /// nil: `CoreOptions`' own default, the production host.
        let baseUrl: String?
        let namespace: String
    }

    private static let production = Origin(
        label: "production (the default base URL)", baseUrl: nil, namespace: "djdl")
    private static let productionSpelledOut = Origin(
        label: "production (upper case, port spelled out)", baseUrl: "https://KEY.PLRS.IM:443/",
        namespace: "djdl")
    private static let local = Origin(
        label: "a local control plane", baseUrl: "http://localhost:8787",
        namespace: "djdl@localhost_8787")

    // ── Helpers ─────────────────────────────────────────────────────────────────────────

    private func makeRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("pkey-namespace-\(UUID().uuidString)", isDirectory: true)
    }

    /// Core options with every directory base under `root` and no injected store: the real
    /// `KeychainStore`, the real product directories. The transport never dials.
    private func options(_ origin: Origin, in root: URL) -> CoreOptions {
        func base(_ name: String) -> URL { root.appendingPathComponent(name, isDirectory: true) }
        if let baseUrl = origin.baseUrl {
            return CoreOptions(
                productSlug: "djdl", baseUrl: baseUrl, version: "1.0.0", pinnedKeys: [:],
                configDir: base("config"), transport: ExplodingTransport(), dataDir: base("data"),
                cacheDir: base("cache"), stateDir: base("state"))
        }
        return CoreOptions(
            productSlug: "djdl", version: "1.0.0", pinnedKeys: [:], configDir: base("config"),
            transport: ExplodingTransport(), dataDir: base("data"), cacheDir: base("cache"),
            stateDir: base("state"))
    }

    private func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
            && directory.boolValue
    }

    private func names(in directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }

    /// What `core` derived for `origin`, as it reports it: the namespace, the four product
    /// directories, the presentation cache and the default store's Keychain service and directory.
    private func assertLocations(
        of core: CoreContext, _ origin: Origin, root: URL,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let ns = origin.namespace
        func under(_ base: String) -> URL {
            root.appendingPathComponent("\(base)/\(ns)", isDirectory: true)
        }
        XCTAssertEqual(core.storageNamespace, ns, origin.label, file: file, line: line)
        XCTAssertEqual(core.dirs.config.path, under("config").path, origin.label, file: file, line: line)
        XCTAssertEqual(core.dirs.data.path, under("data").path, origin.label, file: file, line: line)
        XCTAssertEqual(core.dirs.cache.path, under("cache").path, origin.label, file: file, line: line)
        XCTAssertEqual(core.dirs.state.path, under("state").path, origin.label, file: file, line: line)
        XCTAssertEqual(
            core.presentationSource.directory.path,
            under("data").appendingPathComponent("presentation", isDirectory: true).path,
            origin.label, file: file, line: line)
        let store = try XCTUnwrap(core.store as? KeychainStore, origin.label, file: file, line: line)
        let service = await store.keychainService
        XCTAssertEqual(service, "pkey:\(ns)", origin.label, file: file, line: line)
        XCTAssertTrue(
            isDirectory(under("config")), "\(origin.label): the default store made its directory",
            file: file, line: line)
    }

    // ── The locations a client derives ──────────────────────────────────────────────────

    /// With every directory left at its default, one client creates exactly one directory under
    /// each base, named for its origin: production keeps `djdl`, a local control plane gets
    /// `djdl@localhost_8787`. The packs directory (the one consumer of the data directory) lands
    /// in the same place.
    func testEveryDefaultLocationFollowsTheOrigin() async throws {
        for origin in [Self.production, Self.productionSpelledOut, Self.local] {
            let root = makeRoot()
            defer { try? FileManager.default.removeItem(at: root) }
            let core = try CoreContext(options: options(origin, in: root))
            try await assertLocations(of: core, origin, root: root)
            XCTAssertEqual(
                try names(in: root.appendingPathComponent("config")), [origin.namespace],
                "\(origin.label): no other origin's directory exists beside it")

            let packs = PacksClient(core: core, releaseKeys: [:])
            _ = try await packs.zstd()
            XCTAssertEqual(
                try names(in: root.appendingPathComponent("data")), [origin.namespace],
                "\(origin.label): packs start under this origin's data directory only")
            XCTAssertTrue(
                isDirectory(
                    root.appendingPathComponent("data/\(origin.namespace)/packs", isDirectory: true)),
                origin.label)
        }
    }

    // ── State written through the default store ─────────────────────────────────────────

    private func contents(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
    }

    /// One machine, one set of directory bases, a client per origin in turn: local, production,
    /// local again, production spelled differently. Each writes its own device id and cache record
    /// through its default store; none reads or replaces another origin's, and a new client for an
    /// origin finds what that origin kept.
    func testReconfiguringBetweenOriginsKeepsEachOriginsStateApart() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = root.appendingPathComponent("config", isDirectory: true)
        let localDevice = config.appendingPathComponent("djdl@localhost_8787/device")
        let localCacheFile = config.appendingPathComponent("djdl@localhost_8787/managed.json")
        let productionDevice = config.appendingPathComponent("djdl/device")

        // A local client writes under its own directory and creates none for production.
        let local = try CoreContext(options: options(Self.local, in: root))
        try await assertLocations(of: local, Self.local, root: root)
        let localStore = try XCTUnwrap(local.store as? KeychainStore)
        try await localStore.setDeviceId("local-device")
        try await localStore.writeCache(CacheRecord(docs: [.license: "local.jws"]))
        XCTAssertEqual(try contents(localDevice), "local-device")
        XCTAssertTrue(FileManager.default.fileExists(atPath: localCacheFile.path))
        XCTAssertEqual(try names(in: config), ["djdl@localhost_8787"], "no production directory")

        // Production sees none of that, and what it writes leaves the local files alone.
        let production = try CoreContext(options: options(Self.production, in: root))
        try await assertLocations(of: production, Self.production, root: root)
        let productionStore = try XCTUnwrap(production.store as? KeychainStore)
        let productionCacheBefore = await productionStore.readCache()
        XCTAssertNil(productionCacheBefore, "production does not see the local cache")
        try await productionStore.setDeviceId("production-device")
        try await productionStore.writeCache(CacheRecord(docs: [.license: "production.jws"]))
        XCTAssertEqual(try contents(productionDevice), "production-device")
        XCTAssertEqual(try contents(localDevice), "local-device", "the local device id is untouched")
        let localCache = await localStore.readCache()
        XCTAssertEqual(localCache?.docs[.license], "local.jws", "the local cache is untouched")

        // Local again: a new client finds what the local origin kept, not production's.
        let localAgain = try CoreContext(options: options(Self.local, in: root))
        let localAgainStore = try XCTUnwrap(localAgain.store as? KeychainStore)
        let keptLocalDevice = try await localAgainStore.getDeviceId()
        let keptLocalCache = await localAgainStore.readCache()
        XCTAssertEqual(keptLocalDevice, "local-device")
        XCTAssertEqual(keptLocalCache?.docs[.license], "local.jws")

        // The same production origin spelled another way is the same state.
        let spelledOut = try CoreContext(options: options(Self.productionSpelledOut, in: root))
        try await assertLocations(of: spelledOut, Self.productionSpelledOut, root: root)
        let spelledOutStore = try XCTUnwrap(spelledOut.store as? KeychainStore)
        let keptProductionDevice = try await spelledOutStore.getDeviceId()
        let keptProductionCache = await spelledOutStore.readCache()
        XCTAssertEqual(keptProductionDevice, "production-device")
        XCTAssertEqual(keptProductionCache?.docs[.license], "production.jws")
        XCTAssertEqual(try names(in: config), ["djdl", "djdl@localhost_8787"])
    }

    // ── What the clients on top of Core consume ─────────────────────────────────────────

    /// The facade hands Core's namespace to the clients that keep their own state: `ConfigClient`
    /// persists `config.set` values under one UserDefaults key per namespace and `DevicesClient`
    /// keeps the App Attest key id under a Keychain service named for it. Production's key and
    /// service are the historical `pkey.config.local.<product>` and `pkey:<product>`.
    func testClientsKeepTheirOwnStateUnderTheNamespace() async throws {
        let root = makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let suite = "im.plrs.key.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        func client(_ origin: Origin) throws -> PolarisKeyClient {
            try PolarisKeyClient(
                options: PolarisKeyClientOptions(
                    core: options(origin, in: root),
                    config: ConfigClientOptions(local: LocalConfigOptions(suiteName: suite))))
        }
        func stored(_ namespace: String) throws -> [String: JSONValue]? {
            guard let data = defaults.data(forKey: "pkey.config.local.\(namespace)") else { return nil }
            guard case .object(let values) = try JSONDecoder().decode(JSONValue.self, from: data) else {
                return nil
            }
            return values
        }

        let local = try client(Self.local)
        XCTAssertEqual(local.core.storageNamespace, "djdl@localhost_8787")
        let localKeys = try XCTUnwrap(local.devices.keyStore as? KeychainAttestKeyStore)
        XCTAssertEqual(localKeys.service, "pkey:djdl@localhost_8787")
        try await local.config.set("ui.theme", .string("light"))
        XCTAssertEqual(try stored("djdl@localhost_8787"), ["ui.theme": .string("light")])
        XCTAssertNil(try stored("djdl"), "a local override is never written to production's key")

        // Production reads none of it, and what it keeps goes to its own key.
        let production = try client(Self.production)
        let productionKeys = try XCTUnwrap(production.devices.keyStore as? KeychainAttestKeyStore)
        XCTAssertEqual(productionKeys.service, "pkey:djdl")
        let productionBefore = await production.config.localValues()
        XCTAssertEqual(productionBefore, [:], "production starts without the local override")
        try await production.config.set("ui.theme", .string("dark"))
        XCTAssertEqual(try stored("djdl"), ["ui.theme": .string("dark")])
        XCTAssertEqual(
            try stored("djdl@localhost_8787"), ["ui.theme": .string("light")],
            "production's write leaves the local override alone")

        // A new local client finds the local override; the same production origin spelled
        // differently finds production's.
        let localAgain = try client(Self.local)
        let localValues = await localAgain.config.localValues()
        XCTAssertEqual(localValues, ["ui.theme": .string("light")])
        let spelledOut = try client(Self.productionSpelledOut)
        let spelledOutValues = await spelledOut.config.localValues()
        XCTAssertEqual(spelledOutValues, ["ui.theme": .string("dark")])
        let spelledOutKeys = try XCTUnwrap(spelledOut.devices.keyStore as? KeychainAttestKeyStore)
        XCTAssertEqual(spelledOutKeys.service, "pkey:djdl")
    }

    /// A namespaced product is a valid `SecureStore` product, so `DevicesClient`'s App Attest key id
    /// persists under `pkey:<product>@<host>` rather than being refused (the key store drops a
    /// refused write silently, and the device would attest a fresh key every time).
    func testTheAttestKeyIdPersistsUnderTheNamespacedService() {
        for origin in [Self.production, Self.local] {
            let keychain = MemoryKeychain()
            let keys = KeychainAttestKeyStore(product: origin.namespace, backend: keychain)
            XCTAssertNil(keys.get(), origin.label)
            keys.set("key-for-\(origin.namespace)")
            XCTAssertEqual(keys.get(), "key-for-\(origin.namespace)", origin.label)
            XCTAssertEqual(
                keychain.names, ["pkey:\(origin.namespace)/\(KeychainAttestKeyStore.account)"], origin.label)
            keys.delete()
            XCTAssertNil(keys.get(), origin.label)
            XCTAssertEqual(keychain.names, [], origin.label)
        }
    }
}

/// A Keychain in memory: items by `service/account`, so a test reads which name a store used.
private final class MemoryKeychain: KeychainBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    /// The `service/account` of every item held, sorted.
    var names: [String] { lock.withLock { items.keys.sorted() } }

    private func name(_ attributes: [String: Any]) -> String {
        let service = attributes[kSecAttrService as String] as? String ?? ""
        let account = attributes[kSecAttrAccount as String] as? String ?? ""
        return "\(service)/\(account)"
    }

    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        lock.withLock {
            guard let data = items[name(query)] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, data)
        }
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            items[name(attributes)] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        lock.withLock {
            guard items[name(query)] != nil else { return errSecItemNotFound }
            items[name(query)] = attributes[kSecValueData as String] as? Data
            return errSecSuccess
        }
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        lock.withLock { items.removeValue(forKey: name(query)) == nil ? errSecItemNotFound : errSecSuccess }
    }
}
