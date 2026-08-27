// Persistence: the per-device token, a stable device id, and the offline-first verified cache.
// `Store` is the protocol Core talks to; `InMemoryStore` backs tests, and `KeychainStore` keeps
// the token in the OS keychain (secret) with the device id + cache in 0600 files under the
// config dir. Mirrors sdk-node's store split (secret in the keyring, bookkeeping on disk).
//
// Wire contract v3 §4.1: the cache persists ONLY SIGNED ARTIFACTS. Every security-relevant
// counter — the per-type anti-replay floors, the trust set, `lastVerifiedAt`, the decoded
// documents — is DERIVED by re-verifying the stored JWSs on load. `blocked` and
// `lastSyncUnauthorized` remain unsigned because they can only ever make the gate STRICTER.
//
// ── WHAT v3 CHANGED ─────────────────────────────────────────────────────────────────────────
//
//   * `CACHE_RECORD_VERSION` is 3, and a record carrying anything else is DISCARDED rather than
//     migrated — including a perfectly well-formed v2 record. One network round trip is the
//     right price for not carrying poisoned state forward.
//   * `configJws`/`etag` become per-service SLICES (`docs`/`etags`), because license and config
//     are now two independently-fetched, independently-ETagged documents.
//   * `importedBundle` records an offline activation (§7), which is what lets the gate answer
//     `activation: .bundle` for an install that holds no credential at all.
//   * the keychain service tag is `plrs:<product>` (§8).

import Foundation
import Security

/// The offline cache record — the signed artifacts plus fail-closed sync hints (§4.1).
///
/// A doc-less record is valid: it carries only `blocked`/`lastSyncUnauthorized` so the gate can
/// render a revoked/blocked state before any document has ever been accepted.
public struct CacheRecord: Sendable, Codable, Equatable {
    /// Format version. Any value but `CACHE_RECORD_VERSION` is discarded, never migrated.
    public var v: Int
    /// The compact JWS of the trust manifest, VERBATIM as served.
    public var trustJws: String?
    /// Per-service signed documents. An absent slice means the service is unused by this
    /// product, or has not been fetched yet — never that it failed open.
    public var docs: [DocumentSlice: String]
    /// Non-security hints: the per-document conditional-request validators.
    public var etags: [DocumentSlice: String]
    /// Set by `importBundle` (§7). Present with a verified license doc ⇒ `activation: .bundle`;
    /// a later online activation supersedes it with `activation: .token`.
    public var importedBundle: ImportedBundle?
    /// Fail-CLOSED hint: the last document fetch ended in a hard 401 (§4.3).
    public var lastSyncUnauthorized: Bool?
    /// Fail-CLOSED hint: the last `/license/document` returned a 403 version/channel block.
    public var blocked: BlockInfoRecord?

    public init(
        trustJws: String? = nil,
        docs: [DocumentSlice: String] = [:],
        etags: [DocumentSlice: String] = [:],
        importedBundle: ImportedBundle? = nil,
        lastSyncUnauthorized: Bool? = nil,
        blocked: BlockInfoRecord? = nil,
        v: Int = CACHE_RECORD_VERSION
    ) {
        self.v = v
        self.trustJws = trustJws
        self.docs = docs
        self.etags = etags
        self.importedBundle = importedBundle
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
    }

    /// `docs`/`etags` are keyed by a `DocumentSlice` enum, and Swift's `Codable` would otherwise
    /// encode an enum-keyed dictionary as a flat `[key, value, …]` ARRAY — which would make the
    /// on-disk shape disagree with `{"docs":{"license":"…"}}` in every other SDK. These coding
    /// keys keep the JSON an object, per §4.1.
    private enum CodingKeys: String, CodingKey {
        case v, trustJws, docs, etags, importedBundle, lastSyncUnauthorized, blocked
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        trustJws = try c.decodeIfPresent(String.self, forKey: .trustJws)
        docs = CacheRecord.slices(
            try c.decodeIfPresent([String: String].self, forKey: .docs))
        etags = CacheRecord.slices(
            try c.decodeIfPresent([String: String].self, forKey: .etags))
        importedBundle = try c.decodeIfPresent(ImportedBundle.self, forKey: .importedBundle)
        lastSyncUnauthorized = try c.decodeIfPresent(Bool.self, forKey: .lastSyncUnauthorized)
        blocked = try c.decodeIfPresent(BlockInfoRecord.self, forKey: .blocked)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encodeIfPresent(trustJws, forKey: .trustJws)
        if !docs.isEmpty { try c.encode(CacheRecord.strings(docs), forKey: .docs) }
        if !etags.isEmpty { try c.encode(CacheRecord.strings(etags), forKey: .etags) }
        try c.encodeIfPresent(importedBundle, forKey: .importedBundle)
        try c.encodeIfPresent(lastSyncUnauthorized, forKey: .lastSyncUnauthorized)
        try c.encodeIfPresent(blocked, forKey: .blocked)
    }

    /// An unrecognised slice name is DROPPED rather than decoded — a future service's document
    /// is not something this build can verify, and keeping it would mean persisting an artifact
    /// nothing re-checks.
    private static func slices(_ raw: [String: String]?) -> [DocumentSlice: String] {
        var out: [DocumentSlice: String] = [:]
        for (key, value) in raw ?? [:] {
            if let slice = DocumentSlice(rawValue: key) { out[slice] = value }
        }
        return out
    }

    private static func strings(_ slices: [DocumentSlice: String]) -> [String: String] {
        var out: [String: String] = [:]
        for (slice, value) in slices { out[slice.rawValue] = value }
        return out
    }
}

/// The §7 import marker. `importedAt` is a local timestamp and is NOT security state: the gate
/// reads the imported license document's own signed claims, never this.
public struct ImportedBundle: Sendable, Codable, Equatable {
    public let bundleId: String
    public let importedAt: Int

    public init(bundleId: String, importedAt: Int) {
        self.bundleId = bundleId
        self.importedAt = importedAt
    }
}

/// Codable mirror of the unsigned 403 hint for the on-disk cache.
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
/// These used to be swallowed: a failed keychain write left `setToken` returning normally having
/// stored nothing (re-activation on every launch), and a failed device-id write produced a NEW
/// random device id per launch — burning a seat each time (R4-12).
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

/// The persistence surface Core depends on. All methods are async so a keychain- or
/// network-backed implementation can be slotted in without changing Core; the mutating ones
/// throw so a failure is never silent.
public protocol Store: Sendable {
    func getToken() async throws -> String?
    func setToken(_ token: String) async throws
    func clearToken() async throws
    func getDeviceId() async throws -> String
    /// A missing, unreadable, or unparseable cache is not an error — it is "no cache", which
    /// Core treats as `needs-activation`. Fail closed.
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
/// `plrs:<product>` per §8), while the device id + offline cache are 0600 JSON files under
/// `<configDir>/<product>/`. An actor for `Sendable` safety; keychain/file I/O is serialized
/// through it.
public actor KeychainStore: Store {
    /// Largest cache file we will read. The record is at most three compact JWSs plus hints.
    private static let maxCacheBytes = 1024 * 1024

    private let productSlug: String
    private let service: String
    private let account = "token"
    private let dir: URL
    private let cacheURL: URL
    private let deviceURL: URL

    /// Where the device id and cache live when the host does not say.
    ///
    /// `~/.config/` on macOS, matching the Node SDK's `XDG_CONFIG_HOME ?? ~/.config`, so a
    /// developer running both against the same product finds one directory rather than two.
    /// `homeDirectoryForCurrentUser` is UNAVAILABLE on iOS — a real gap the target split
    /// surfaced, since the package has declared `.iOS(.v17)` support since v1 — so iOS uses
    /// Application Support, the sandboxed equivalent, and falls back to the temporary directory
    /// only on a platform that has neither.
    private static func defaultConfigDir() -> URL {
        #if os(macOS)
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
        #else
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? FileManager.default.temporaryDirectory
        #endif
    }

    public init(productSlug: String, configDir: URL? = nil) {
        self.productSlug = productSlug
        // §8 — the keychain service tag is `plrs:<product>`. Pre-launch, no dual-read: a
        // `pkey:` item is simply not found, and the device re-registers once.
        self.service = "plrs:\(productSlug)"
        let base = configDir ?? KeychainStore.defaultConfigDir()
        self.dir = base.appendingPathComponent(productSlug, isDirectory: true)
        self.cacheURL = dir.appendingPathComponent("managed.json")
        self.deviceURL = dir.appendingPathComponent("device")
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    /// The keychain service tag this store reads and writes. Exposed so a test can assert the
    /// §8 rebrand rather than trust a comment.
    public var keychainService: String { service }

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
        // `kSecAttrAccessible` must ride on the UPDATE too — it was only ever set on the initial
        // add, so a re-issued token silently inherited whatever protection class the original
        // item happened to carry (R4-11).
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
    /// and only THEN chmod'd it, so the first-ever write of `managed.json` (the one that first
    /// contains a config document's secrets) was briefly world-readable, and permanently so if
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

    /// Read `url`, refusing to follow a symlink and bounding the read. Returns nil when the file
    /// simply does not exist.
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
