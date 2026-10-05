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
//   * the keychain service tag is `pkey:<product>` (§8).

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
    /// Wire contract v4 (plans/P3-01.md §2.6): the committed channel feeds (`pkey-feed+jws`,
    /// verbatim), keyed by the CANONICAL channel — each feed's own `channel` claim, never the
    /// requested name. Each channel's `seq` floor is DERIVED from the entry that re-verifies on
    /// load, never stored. Additive, so `v` stays 3: an older loader ignores the member.
    public var feeds: [String: String]
    /// The release records (`pkey-release+jws`, verbatim), keyed by lowercase hex SHA-256; kept
    /// only while a committed feed pins one.
    public var releaseRecords: [String: String]

    public init(
        trustJws: String? = nil,
        docs: [DocumentSlice: String] = [:],
        etags: [DocumentSlice: String] = [:],
        importedBundle: ImportedBundle? = nil,
        lastSyncUnauthorized: Bool? = nil,
        blocked: BlockInfoRecord? = nil,
        feeds: [String: String] = [:],
        releaseRecords: [String: String] = [:],
        v: Int = CACHE_RECORD_VERSION
    ) {
        self.v = v
        self.trustJws = trustJws
        self.docs = docs
        self.etags = etags
        self.importedBundle = importedBundle
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
        self.feeds = feeds
        self.releaseRecords = releaseRecords
    }

    /// `docs`/`etags` are keyed by a `DocumentSlice` enum, and Swift's `Codable` would otherwise
    /// encode an enum-keyed dictionary as a flat `[key, value, …]` ARRAY — which would make the
    /// on-disk shape disagree with `{"docs":{"license":"…"}}` in every other SDK. These coding
    /// keys keep the JSON an object, per §4.1.
    private enum CodingKeys: String, CodingKey {
        case v, trustJws, docs, etags, importedBundle, lastSyncUnauthorized, blocked, feeds,
            releaseRecords
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
        // A slice that does not decode is no slice: nothing in it could be re-verified anyway.
        feeds = (try? c.decodeIfPresent([String: String].self, forKey: .feeds)) ?? [:]
        releaseRecords =
            (try? c.decodeIfPresent([String: String].self, forKey: .releaseRecords)) ?? [:]
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
        // No empty slices in the record, as in every other SDK.
        if !feeds.isEmpty { try c.encode(feeds, forKey: .feeds) }
        if !releaseRecords.isEmpty { try c.encode(releaseRecords, forKey: .releaseRecords) }
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

// ── Store status (P1b-09 plan §2.3) ──────────────────────────────────────────────────

/// Where a token store keeps the token. Stable identifiers, shared with every SDK
/// (`client-core`'s `STORE_BACKENDS`).
public enum StoreBackend: String, Sendable, CaseIterable, Codable {
    /// An OS credential store through a keyring library.
    case keyring
    /// The Apple Keychain through Security.framework.
    case keychain
    /// An Android Keystore key wrapping the token.
    case keystore
    /// A 0600 file.
    case file
    /// Nothing persists (tests).
    case memory
    /// Browser storage (Godot web).
    case indexeddb
    /// A host store that fits none of these.
    case custom
}

/// Why a store is weaker than this platform's best option (`STORE_DEGRADED_REASONS`).
public enum StoreDegradedReason: String, Sendable, CaseIterable, Codable {
    case keyringUnavailable = "keyring-unavailable"
    case keyringError = "keyring-error"
    /// macOS: no data-protection keychain entitlement; the file-based keychain is used.
    case legacyKeychain = "legacy-keychain"
    case notPersistent = "not-persistent"
}

/// What a store's `status()` reports: where the token lives now, and why if that is weaker than
/// this platform's best option. `detail` is human text and never contains the token.
public struct StoreStatus: Sendable, Equatable, Codable {
    public struct Degraded: Sendable, Equatable, Codable {
        public let reason: StoreDegradedReason
        public let detail: String?

        public init(reason: StoreDegradedReason, detail: String? = nil) {
            self.reason = reason
            self.detail = detail
        }
    }

    public let backend: StoreBackend
    public let degraded: Degraded?

    public init(backend: StoreBackend, degraded: Degraded? = nil) {
        self.backend = backend
        self.degraded = degraded
    }
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
    /// Where the token lives now, and why if that is weaker than this platform's best option.
    /// Optional: the default is `nil` ("this store does not report"). Never throws.
    func status() async -> StoreStatus?
    /// The persisted update-health journal (P6-03 events not yet reported), or nil. Optional:
    /// the default keeps no journal across launches (events still ride this process's reports).
    func readJournal() async -> Data?
    /// Replace the journal; nil deletes it. Best-effort, never throws.
    func writeJournal(_ data: Data?) async
}

extension Store {
    public func status() async -> StoreStatus? { nil }
    public func readJournal() async -> Data? { nil }
    public func writeJournal(_ data: Data?) async {}
}

// ── In-memory (tests) ────────────────────────────────────────────────────────────

/// In-memory store for tests. An actor so it stays `Sendable` under strict concurrency.
public actor InMemoryStore: Store {
    private var token: String?
    private var cache: CacheRecord?
    private var journal: Data?
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
    public func status() async -> StoreStatus? { StoreStatus(backend: .memory) }
    public func readJournal() async -> Data? { journal }
    public func writeJournal(_ data: Data?) async { journal = data }
}

// ── Keychain + 0600 file (production) ──────────────────────────────────────────────

/// The four `SecItem*` calls `KeychainStore` makes, behind a seam so tests can inject a fake
/// keychain (an unsigned test bundle cannot reach the data-protection keychain at all).
protocol KeychainAPI: Sendable {
    /// `SecItemCopyMatching`: the status, and the returned data when the query asked for it.
    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?)
    func add(_ attributes: [String: Any]) -> OSStatus
    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

/// The real Security.framework calls.
struct SystemKeychain: KeychainAPI {
    func copyMatching(_ query: [String: Any]) -> (OSStatus, Data?) {
        var item: CFTypeRef?
        let status = withUnsafeMutablePointer(to: &item) {
            SecItemCopyMatching(query as CFDictionary, $0)
        }
        return (status, item as? Data)
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func update(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

/// Production store: the secret token lives in the OS keychain (generic password, service
/// `pkey:<product>` per §8), while the device id + offline cache are 0600 JSON files under
/// `<configDir>/<product>/`. An actor for `Sendable` safety; keychain/file I/O is serialized
/// through it.
///
/// THE KEYCHAIN (P1b-09 plan §5.6). The token goes to the DATA-PROTECTION keychain
/// (`kSecUseDataProtectionKeychain`) with `kSecAttrAccessibleAfterFirstUnlock`. Without that
/// flag macOS writes the legacy file-based keychain, which ignores the accessibility attribute
/// (R4-11). A macOS process without the entitlement the data-protection keychain needs (an
/// unsigned CLI, a test bundle) has its writes refused with `errSecMissingEntitlement` (its
/// reads answer "not found"); it then keeps using the legacy keychain, as before, and `status()`
/// says so (`legacy-keychain`). Reads try data protection
/// first and fall back to the legacy item, migrating it when the data-protection keychain is
/// available; clears delete from both. iOS always uses the data-protection keychain, so the
/// legacy branch is `#if os(macOS)`.
public actor KeychainStore: Store {
    /// Largest cache file we will read. The record is the trust manifest and two documents, plus
    /// the v4 update slices (a feed per channel the host asked for, a record per pin), and hints.
    private static let maxCacheBytes = 4 * 1024 * 1024

    private let productSlug: String
    private let service: String
    private let account = "token"
    private let dir: URL
    private let cacheURL: URL
    private let journalURL: URL
    private let deviceURL: URL
    private let keychain: any KeychainAPI

    public init(productSlug: String, configDir: URL? = nil) {
        self.init(productSlug: productSlug, configDir: configDir, keychain: SystemKeychain())
    }

    init(productSlug: String, configDir: URL?, keychain: any KeychainAPI) {
        self.productSlug = productSlug
        // §8 — the keychain service tag is `pkey:<product>`, stable across wire-contract
        // revisions. The `plrs:` spelling Amendment A1 withdrew is never written or read.
        self.service = "pkey:\(productSlug)"
        self.keychain = keychain
        let base = configDir ?? ProductDirs.defaultConfigBase()
        self.dir = base.appendingPathComponent(productSlug, isDirectory: true)
        self.cacheURL = dir.appendingPathComponent("managed.json")
        self.journalURL = dir.appendingPathComponent("update-events.json")
        self.deviceURL = dir.appendingPathComponent("device")
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    /// The keychain service tag this store reads and writes. Exposed so a test can assert the
    /// §8 rebrand rather than trust a comment.
    public var keychainService: String { service }

    // ── Token (keychain) ──

    /// The item's identity, in the data-protection keychain or the legacy one.
    private func itemQuery(dataProtection: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if dataProtection { query[kSecUseDataProtectionKeychain as String] = true }
        return query
    }

    private func readItem(dataProtection: Bool) -> (OSStatus, String?) {
        var query = itemQuery(dataProtection: dataProtection)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let (status, data) = keychain.copyMatching(query)
        return (status, data.flatMap { String(data: $0, encoding: .utf8) })
    }

    /// Update, else add. `kSecAttrAccessible` rides on the UPDATE too — it was only ever set on
    /// the initial add, so a re-issued token silently inherited whatever protection class the
    /// original item happened to carry (R4-11).
    private func writeItem(_ token: String, dataProtection: Bool) -> OSStatus {
        let data = Data(token.utf8)
        let base = itemQuery(dataProtection: dataProtection)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = keychain.update(base, update)
        guard status == errSecItemNotFound else { return status }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return keychain.add(add)
    }

    public func getToken() async throws -> String? {
        let (status, token) = readItem(dataProtection: true)
        if status == errSecSuccess { return token }
        #if os(macOS)
        if status == errSecItemNotFound || status == errSecMissingEntitlement {
            let (legacyStatus, legacy) = readItem(dataProtection: false)
            if legacyStatus == errSecItemNotFound { return nil }
            guard legacyStatus == errSecSuccess else { throw StoreError.keychain(legacyStatus) }
            // Migrate the legacy item into the data-protection keychain. An unentitled process
            // also answers "not found" to the read above, so its migration write fails with
            // −34018; a failed migration still returns the token and keeps the legacy item.
            if status == errSecItemNotFound, let legacy,
                writeItem(legacy, dataProtection: true) == errSecSuccess {
                _ = keychain.delete(itemQuery(dataProtection: false))
            }
            return legacy
        }
        #endif
        // "No token" and "the keychain would not answer" are different facts: the first is
        // needs-activation, the second is a condition the user can fix.
        if status == errSecItemNotFound { return nil }
        throw StoreError.keychain(status)
    }

    public func setToken(_ token: String) async throws {
        let status = writeItem(token, dataProtection: true)
        if status == errSecSuccess {
            #if os(macOS)
            // Best effort: no older token may linger in the legacy keychain for a later read.
            _ = keychain.delete(itemQuery(dataProtection: false))
            #endif
            return
        }
        #if os(macOS)
        if status == errSecMissingEntitlement {
            let legacy = writeItem(token, dataProtection: false)
            guard legacy == errSecSuccess else { throw StoreError.keychain(legacy) }
            return
        }
        #endif
        throw StoreError.keychain(status)
    }

    public func clearToken() async throws {
        let status = keychain.delete(itemQuery(dataProtection: true))
        guard
            status == errSecSuccess || status == errSecItemNotFound
                || status == errSecMissingEntitlement
        else { throw StoreError.keychain(status) }
        #if os(macOS)
        let legacy = keychain.delete(itemQuery(dataProtection: false))
        guard legacy == errSecSuccess || legacy == errSecItemNotFound else {
            throw StoreError.keychain(legacy)
        }
        #endif
    }

    /// The account of an item that never exists: the target of the side-effect-free entitlement
    /// probe in `status()`.
    static let entitlementProbeAccount = "pkey-status-probe"

    /// An attribute-only probe: it never reads the secret.
    ///
    /// An unentitled macOS process cannot tell from a READ that the data-protection keychain is
    /// closed to it — measured on macOS 27: `SecItemCopyMatching` answers errSecItemNotFound
    /// (−25300) while add, update and delete answer errSecMissingEntitlement (−34018). So a
    /// "not found" is followed by a DELETE of a sentinel item that never exists: −34018 means the
    /// token goes to the legacy keychain (`legacy-keychain`); "not found" means the process is
    /// entitled. An entitled process whose token still sits in the legacy keychain (not yet
    /// migrated by a read) also reports `legacy-keychain`.
    public func status() async -> StoreStatus? {
        let status = probeAttributes(dataProtection: true)
        if status == errSecSuccess { return StoreStatus(backend: .keychain) }
        #if os(macOS)
        if status == errSecMissingEntitlement { return Self.legacyKeychainStatus }
        if status == errSecItemNotFound {
            var sentinel = itemQuery(dataProtection: true)
            sentinel[kSecAttrAccount as String] = Self.entitlementProbeAccount
            let probe = keychain.delete(sentinel)
            if probe == errSecMissingEntitlement { return Self.legacyKeychainStatus }
            if probe == errSecSuccess || probe == errSecItemNotFound {
                if probeAttributes(dataProtection: false) == errSecSuccess {
                    return StoreStatus(
                        backend: .keychain,
                        degraded: .init(
                            reason: .legacyKeychain,
                            detail:
                                "the token is still in the file-based login keychain; "
                                + "the next read migrates it to the data-protection keychain"))
                }
                return StoreStatus(backend: .keychain)
            }
            return StoreStatus(
                backend: .keychain,
                degraded: .init(reason: .keyringError, detail: Self.describe(probe)))
        }
        #else
        if status == errSecItemNotFound { return StoreStatus(backend: .keychain) }
        #endif
        return StoreStatus(
            backend: .keychain,
            degraded: .init(reason: .keyringError, detail: Self.describe(status)))
    }

    private func probeAttributes(dataProtection: Bool) -> OSStatus {
        var query = itemQuery(dataProtection: dataProtection)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return keychain.copyMatching(query).0
    }

    #if os(macOS)
    private static let legacyKeychainStatus = StoreStatus(
        backend: .keychain,
        degraded: .init(
            reason: .legacyKeychain,
            detail:
                "no data-protection keychain entitlement (errSecMissingEntitlement); "
                + "the file-based login keychain is used"))
    #endif

    private static func describe(_ status: OSStatus) -> String {
        if let message = SecCopyErrorMessageString(status, nil) as String? {
            return "\(message) (OSStatus \(status))"
        }
        return "OSStatus \(status)"
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
    public func readJournal() async -> Data? {
        (try? readSecure(journalURL)) ?? nil
    }

    public func writeJournal(_ data: Data?) async {
        if let data {
            try? writeSecure(data, to: journalURL)
        } else {
            try? FileManager.default.removeItem(at: journalURL)
        }
    }

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
