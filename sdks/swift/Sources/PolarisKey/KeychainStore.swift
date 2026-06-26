// Persistence: the per-device token, a stable device id, and the offline-first config
// cache. `Store` is the protocol the client talks to; `InMemoryStore` backs tests, and
// `KeychainStore` keeps the token in the OS keychain (secret) with the device id + cache
// in a 0600 file under the config dir. Mirrors sdk-node's store.ts split (secret in the
// keyring, bookkeeping on disk).

import Foundation
import Security

/// The offline-first cache record: the last verified doc plus sync bookkeeping. A doc-less
/// record (doc == nil) is valid — it carries only `blocked`/`lastSyncUnauthorized` so the
/// gate can render a revoked/blocked state before any doc has ever been accepted.
public struct CacheRecord: Sendable, Codable, Equatable {
    public var doc: ManagedConfigDoc?
    public var etag: String?
    public var lastAcceptedIssuedAt: Int
    public var lastVerifiedAt: Int?
    public var lastSyncUnauthorized: Bool?
    public var blocked: BlockInfoRecord?
    public var trustedKeys: TrustSet?
    public var lastTrustIssuedAt: Int?

    public init(
        doc: ManagedConfigDoc?,
        etag: String? = nil,
        lastAcceptedIssuedAt: Int,
        lastVerifiedAt: Int? = nil,
        lastSyncUnauthorized: Bool? = nil,
        blocked: BlockInfoRecord? = nil,
        trustedKeys: TrustSet? = nil,
        lastTrustIssuedAt: Int? = nil
    ) {
        self.doc = doc
        self.etag = etag
        self.lastAcceptedIssuedAt = lastAcceptedIssuedAt
        self.lastVerifiedAt = lastVerifiedAt
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
        self.trustedKeys = trustedKeys
        self.lastTrustIssuedAt = lastTrustIssuedAt
    }
}

/// Codable mirror of `BlockInfo` for the on-disk cache.
public struct BlockInfoRecord: Sendable, Codable, Equatable {
    public let reason: BlockReason
    public let allowedRange: AllowedRange?

    public init(reason: BlockReason, allowedRange: AllowedRange? = nil) {
        self.reason = reason
        self.allowedRange = allowedRange
    }
}

/// The persistence surface the client depends on. All methods are async so a keychain or
/// network-backed implementation can be slotted in without changing the client.
public protocol Store: Sendable {
    func getToken() async -> String?
    func setToken(_ token: String) async
    func clearToken() async
    func getDeviceId() async -> String
    func readCache() async -> CacheRecord?
    func writeCache(_ record: CacheRecord) async
    func clearCache() async
}

// ── In-memory (tests) ────────────────────────────────────────────────────────────

/// In-memory store for tests. An actor so it stays `Sendable` under strict concurrency.
public actor InMemoryStore: Store {
    private var token: String?
    private var cache: CacheRecord?
    private let deviceId: String

    public init(productSlug: String = "test", deviceId: String? = nil) {
        self.deviceId = deviceId ?? DeviceID.derive(productSlug: productSlug)
    }

    public func getToken() async -> String? { token }
    public func setToken(_ token: String) async { self.token = token }
    public func clearToken() async { token = nil }
    public func getDeviceId() async -> String { deviceId }
    public func readCache() async -> CacheRecord? { cache }
    public func writeCache(_ record: CacheRecord) async { cache = record }
    public func clearCache() async { cache = nil }
}

// ── Keychain + 0600 file (production) ──────────────────────────────────────────────

/// Production store: the secret token lives in the OS keychain (generic password, service
/// `pkey:<product>`), while the device id + offline cache are 0600 JSON files under
/// `<configDir>/<product>/`. An actor for `Sendable` safety; keychain/file I/O is
/// serialized through it.
public actor KeychainStore: Store {
    private let productSlug: String
    private let service: String
    private let account = "token"
    private let dir: URL
    private let cacheURL: URL
    private let deviceURL: URL

    public init(productSlug: String, configDir: URL? = nil) {
        self.productSlug = productSlug
        self.service = "pkey:\(productSlug)"
        let base = configDir ?? FileManager.default
            .homeDirectoryForCurrentUser.appendingPathComponent(".config", isDirectory: true)
        self.dir = base.appendingPathComponent(productSlug, isDirectory: true)
        self.cacheURL = dir.appendingPathComponent("managed.json")
        self.deviceURL = dir.appendingPathComponent("device")
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    // ── Token (keychain) ──
    public func getToken() async -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &item) {
            SecItemCopyMatching(query as CFDictionary, $0)
        }
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String) async {
        let data = Data(token.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clearToken() async {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // ── Device id (0600 file) ──
    public func getDeviceId() async -> String {
        if let existing = (try? String(contentsOf: deviceURL, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines), !existing.isEmpty {
            return existing
        }
        let id = DeviceID.derive(productSlug: productSlug)
        writeSecure(id.data(using: .utf8) ?? Data(), to: deviceURL)
        return id
    }

    // ── Offline cache (0600 file) ──
    public func readCache() async -> CacheRecord? {
        guard let data = try? Data(contentsOf: cacheURL) else { return nil }
        return try? JSONDecoder().decode(CacheRecord.self, from: data)
    }

    public func writeCache(_ record: CacheRecord) async {
        guard let data = try? JSONEncoder().encode(record) else { return }
        writeSecure(data, to: cacheURL)
    }

    public func clearCache() async {
        try? FileManager.default.removeItem(at: cacheURL)
    }

    private func writeSecure(_ data: Data, to url: URL) {
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
