// Persistence: the per-device token, a stable device id, and the offline-first config
// cache. `Store` is the protocol the client talks to; `InMemoryStore` backs tests, and
// `KeychainStore` keeps the token in the OS keychain (secret) with the device id + cache
// in a 0600 file under the config dir. Mirrors sdk-node's store.ts split (secret in the
// keyring, bookkeeping on disk).
//
// Wire contract v2 §4: the cache persists ONLY SIGNED ARTIFACTS. Every security-relevant
// counter (`lastAcceptedIssuedAt`, `lastTrustIssuedAt`, `lastVerifiedAt`, the trust set, the
// decoded doc) used to live here unsigned and was read back as fact; all of them are now
// DERIVED by re-verifying the stored JWS on load. `blocked`/`lastSyncUnauthorized` remain
// unsigned because they only ever make the gate STRICTER.

import Foundation
import Security

/// The offline-first cache record — the signed artifacts plus fail-closed sync hints.
///
/// A doc-less record (`configJws == nil`) is valid: it carries only `blocked`/
/// `lastSyncUnauthorized` so the gate can render a revoked/blocked state before any doc has
/// ever been accepted.
public struct CacheRecord: Sendable, Codable, Equatable {
    /// Format version. A `v1` record decodes to nothing and is discarded, never migrated —
    /// carrying its unsigned state forward is exactly the defect v2 removes.
    public var v: Int
    /// The compact JWS of the managed-config doc, VERBATIM as served.
    public var configJws: String?
    /// The compact JWS of the trust manifest, VERBATIM as served.
    public var trustJws: String?
    /// Cache validator — a non-security hint.
    public var etag: String?
    /// Fail-CLOSED hint: the last `/config` ended in a hard 401.
    public var lastSyncUnauthorized: Bool?
    /// Fail-CLOSED hint: the last `/config` returned a 403 version/channel block.
    public var blocked: BlockInfoRecord?

    public init(
        configJws: String? = nil,
        trustJws: String? = nil,
        etag: String? = nil,
        lastSyncUnauthorized: Bool? = nil,
        blocked: BlockInfoRecord? = nil,
        v: Int = CACHE_RECORD_VERSION
    ) {
        self.v = v
        self.configJws = configJws
        self.trustJws = trustJws
        self.etag = etag
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
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

/// A persistence failure the host application can act on.
///
/// These used to be swallowed: a failed keychain write left `setToken` returning normally
/// having stored nothing (re-activation on every launch), and a failed device-id write
/// produced a NEW random device id per launch — burning a seat each time (R4-12).
public enum StoreError: Error, Sendable, Equatable {
    /// A `SecItem*` call failed with this `OSStatus` (e.g. `errSecInteractionNotAllowed`).
    case keychain(OSStatus)
    /// A file operation failed with this `errno`.
    case io(path: String, code: Int32)
    /// The path is a symlink; refused rather than followed.
    case symlink(path: String)
    /// The record could not be encoded.
    case encoding
}

/// The persistence surface the client depends on. All methods are async so a keychain or
/// network-backed implementation can be slotted in without changing the client; the mutating
/// ones throw so a failure is never silent.
public protocol Store: Sendable {
    func getToken() async throws -> String?
    func setToken(_ token: String) async throws
    func clearToken() async throws
    func getDeviceId() async throws -> String
    /// A missing, unreadable, or unparseable cache is not an error — it is "no cache", which
    /// the client treats as `needs-activation`. Fail closed.
    func readCache() async -> CacheRecord?
    func writeCache(_ record: CacheRecord) async throws
    func clearCache() async throws
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
    /// Largest cache file we will read. The record is a JWS pair plus two hints.
    private static let maxCacheBytes = 512 * 1024

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
    public func getToken() async throws -> String? {
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
        // "No token" and "the keychain would not answer" are different facts: the first is
        // needs-activation, the second is a condition the user can fix.
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String) async throws {
        let data = Data(token.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // `kSecAttrAccessible` must ride on the UPDATE too — it was only ever set on the
        // initial add, so a re-issued token silently inherited whatever protection class the
        // original item happened to carry (R4-11).
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw StoreError.keychain(status) }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw StoreError.keychain(addStatus) }
    }

    public func clearToken() async throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.keychain(status)
        }
    }

    // ── Device id (0600 file) ──
    public func getDeviceId() async throws -> String {
        if let data = (try? readSecure(deviceURL)) ?? nil,
            let existing = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty {
            return existing
        }
        let id = DeviceID.derive(productSlug: productSlug)
        // A swallowed failure here mints a FRESH random device id on every launch on any
        // platform without a hardware id — consuming a seat each time (R4-12).
        try writeSecure(Data(id.utf8), to: deviceURL)
        return id
    }

    // ── Offline cache (0600 file) ──
    public func readCache() async -> CacheRecord? {
        guard let data = (try? readSecure(cacheURL)) ?? nil else { return nil }
        return try? JSONDecoder().decode(CacheRecord.self, from: data)
    }

    public func writeCache(_ record: CacheRecord) async throws {
        guard let data = try? JSONEncoder().encode(record) else { throw StoreError.encoding }
        try writeSecure(data, to: cacheURL)
    }

    public func clearCache() async throws {
        // Already gone ⇒ the postcondition holds; anything else is a real failure.
        guard FileManager.default.fileExists(atPath: cacheURL.path) else { return }
        do {
            try FileManager.default.removeItem(at: cacheURL)
        } catch {
            throw StoreError.io(path: cacheURL.path, code: errno)
        }
    }

    /// Create/overwrite `url` at mode 0600, refusing to follow a symlink.
    ///
    /// `Data.write(options: .atomic)` created the file at the ambient umask — measured 0644 —
    /// and only THEN chmod'd it, so the first-ever write of `managed.json` (the one that
    /// first contains `payload.secrets`) was briefly world-readable, and permanently so if
    /// the process died in between (R4-09). `open(2)` applies the mode AT CREATION, and
    /// `O_NOFOLLOW` gives Swift the symlink refusal Node's `writeSecure` already had.
    private func writeSecure(_ data: Data, to url: URL) throws {
        let path = url.path
        let fd = path.withCString {
            open($0, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        }
        guard fd >= 0 else { throw Self.openError(path: path, code: errno) }
        defer { close(fd) }
        // The creation mode applies only to a NEW file; repair a pre-existing loose one.
        guard fchmod(fd, 0o600) == 0 else { throw StoreError.io(path: path, code: errno) }
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let base = buf.baseAddress else { return }
            var offset = 0
            while offset < buf.count {
                let n = write(fd, base.advanced(by: offset), buf.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw StoreError.io(path: path, code: errno)
                }
                offset += n
            }
        }
    }

    /// Read `url`, refusing to follow a symlink and bounding the read. Returns nil when the
    /// file simply does not exist.
    private func readSecure(_ url: URL) throws -> Data? {
        let path = url.path
        let fd = path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard fd >= 0 else {
            if errno == ENOENT { return nil }
            throw Self.openError(path: path, code: errno)
        }
        defer { close(fd) }
        var out = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                throw StoreError.io(path: path, code: errno)
            }
            if n == 0 { break }
            out.append(contentsOf: buffer[0..<n])
            guard out.count <= Self.maxCacheBytes else {
                throw StoreError.io(path: path, code: EFBIG)
            }
        }
        return out
    }

    private static func openError(path: String, code: Int32) -> StoreError {
        // ELOOP is the O_NOFOLLOW refusal; ENXIO/EMLINK are the same refusal on some hosts.
        code == ELOOP || code == EMLINK
            ? .symlink(path: path) : .io(path: path, code: code)
    }
}
