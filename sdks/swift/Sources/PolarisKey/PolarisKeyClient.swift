// The Polaris Key client: a small, product-agnostic facade over enroll/fetch/verify/cache/
// gate. Offline-first — init() applies the cached doc with no network; refresh() re-pulls
// (with a single /token re-acquire on 401) and re-applies. An `actor` so its mutable token/
// device/cache state is concurrency-safe under Swift 6 strict concurrency. Mirrors
// sdk-node's client.ts.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Pinned trust set (kid -> raw Ed25519 pubkey base64url). JWKS discovery is layered later.
public struct PolarisTrust: Sendable {
    public let pinnedKeys: TrustSet
    public init(pinnedKeys: TrustSet) { self.pinnedKeys = pinnedKeys }
}

public struct PolarisKeyOptions: Sendable {
    public let productSlug: String
    public let baseUrl: String
    public let version: String
    public let channel: String
    public let trust: PolarisTrust
    public let store: Store
    public let session: URLSession
    /// Caller-supplied per-key overrides — the highest-priority source for `default`-state
    /// keys (never able to beat `enforced`/`hidden`).
    public let localOverrides: [String: JSONValue]?
    /// Env var prefix for config overrides. A key `a.b` reads `PKEY_CONFIG_a__b` (dots → `__`).
    public let envPrefix: String

    public init(
        productSlug: String,
        baseUrl: String = "https://key.plrs.im",
        version: String,
        channel: String? = nil,
        trust: PolarisTrust,
        store: Store? = nil,
        session: URLSession = .shared,
        localOverrides: [String: JSONValue]? = nil,
        envPrefix: String = "PKEY_CONFIG_"
    ) {
        self.productSlug = productSlug
        self.baseUrl = baseUrl.replacingOccurrences(
            of: #"/+$"#, with: "", options: .regularExpression)
        self.version = version
        self.channel = channel ?? Semver.channelForVersion(version).rawValue
        self.trust = trust
        self.store = store ?? KeychainStore(productSlug: productSlug)
        self.session = session
        self.localOverrides = localOverrides
        self.envPrefix = envPrefix
    }
}

public struct RefreshResult: Sendable, Equatable {
    public var applied: Bool
    public var unauthorized: Bool
    public var blocked: Bool
    public var deviceCap: Bool

    public init(
        applied: Bool, unauthorized: Bool = false, blocked: Bool = false, deviceCap: Bool = false
    ) {
        self.applied = applied
        self.unauthorized = unauthorized
        self.blocked = blocked
        self.deviceCap = deviceCap
    }
}

public actor PolarisKeyClient {
    public let product: String
    private let baseUrl: String
    private let version: String
    private let channel: String
    private let trust: TrustSet
    private let store: Store
    private let session: URLSession
    private let localOverrides: [String: JSONValue]
    private let envPrefix: String

    private var token: String?
    private var deviceId = ""
    private var cache: CacheRecord?

    public init(options: PolarisKeyOptions) {
        self.product = options.productSlug
        self.baseUrl = options.baseUrl
        self.version = options.version
        self.channel = options.channel
        self.trust = options.trust.pinnedKeys
        self.store = options.store
        self.session = options.session
        self.localOverrides = options.localOverrides ?? [:]
        self.envPrefix = options.envPrefix
    }

    /// Construct + `init()` (load token/device/cache with no network) in one step.
    public static func create(options: PolarisKeyOptions) async -> PolarisKeyClient {
        let c = PolarisKeyClient(options: options)
        await c.start()
        return c
    }

    /// Load token + device id + cached doc (no network).
    public func start() async {
        deviceId = await store.getDeviceId()
        token = await store.getToken()
        cache = await store.readCache()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    // ── Gate / reads ────────────────────────────────────────────────────────────
    public func status(now: Int? = nil) -> LicenseState {
        let blockInfo = cache?.blocked.map {
            BlockInfo(reason: $0.reason, allowedRange: $0.allowedRange)
        }
        return licenseState(
            GateInput(
                hasToken: token != nil,
                doc: cache?.doc,
                now: now ?? nowSec(),
                lastSyncUnauthorized: cache?.lastSyncUnauthorized ?? false,
                blocked: blockInfo,
                lastVerifiedAt: cache?.lastVerifiedAt))
    }

    public func isLicensed(now: Int? = nil) -> Bool {
        isUsable(status(now: now).status)
    }

    /// Read the effective config value for `key`, honoring layered overrides + management
    /// state (wire v2):
    ///   - `enforced`/`hidden` ⇒ the remote value always wins (no override can replace it).
    ///   - otherwise           ⇒ localOverrides[key] ?? env ?? remote value ?? `fallback`.
    /// Env reads `environment[envPrefix + key (dots→"__")]`, parsed as JSON if it parses,
    /// else taken as the raw string.
    public func config(_ key: String, default fallback: JSONValue) -> JSONValue {
        let entry = cache?.doc?.payload.config[key]
        if let entry, entry.state == .enforced || entry.state == .hidden {
            return entry.value
        }
        if let local = localOverrides[key] { return local }
        if let env = envValue(for: key) { return env }
        if let entry { return entry.value }
        return fallback
    }

    /// Resolve which layer supplies a key's effective config value.
    public func configSource(_ key: String) -> ConfigSource {
        let entry = cache?.doc?.payload.config[key]
        if entry?.state == .enforced { return .enforced }
        if entry?.state == .hidden { return .hidden }
        if localOverrides[key] != nil { return .local }
        if envValue(for: key) != nil { return .env }
        if entry != nil { return .remoteDefault }
        return .fallback
    }

    /// The user-visible config (every entry except `hidden` ones), each carrying its value
    /// and whether it is `enforced` (i.e. the user cannot override it).
    public func listUserConfig() -> [UserConfigEntry] {
        guard let config = cache?.doc?.payload.config else { return [] }
        return config.compactMap { key, entry in
            guard entry.state != .hidden else { return nil }
            return UserConfigEntry(
                key: key, value: entry.value, enforced: entry.state == .enforced)
        }
    }

    /// Read + decode the env override for `key`, or nil if unset. The raw string is parsed
    /// as JSON (so `"4"`→int, `"true"`→bool, `"[1,2]"`→array); on parse failure it is kept
    /// as a plain string.
    private func envValue(for key: String) -> JSONValue? {
        let name = envPrefix + key.replacingOccurrences(of: ".", with: "__")
        guard let raw = ProcessInfo.processInfo.environment[name] else { return nil }
        if let data = raw.data(using: .utf8),
            let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) {
            return parsed
        }
        return .string(raw)
    }

    /// Read a managed secret value (string only), or nil.
    public func secret(_ key: String) -> String? {
        cache?.doc?.payload.secrets[key]?.value.stringValue
    }

    /// True iff the named entitlement is present and `value == true`.
    public func isEntitled(_ name: String) -> Bool {
        cache?.doc?.payload.entitlements[name]?.value.boolValue == true
    }

    public func entitlements() -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in cache?.doc?.payload.entitlements ?? [:] { out[k] = v.value }
        return out
    }

    public func profile() -> DocProfile? { cache?.doc?.profile }

    // ── Enrollment ────────────────────────────────────────────────────────────────
    /// Exchange a license key for a per-machine token, persist it, then force a refresh.
    @discardableResult
    public func activate(key: String) async -> EnrollResult {
        let r = await Endpoints.enrollWithKey(
            baseUrl: baseUrl, product: product, key: key, deviceId: deviceId, session: session)
        if case .ok(let newToken, _) = r {
            token = newToken
            await store.setToken(newToken)
            _ = await refresh()
        }
        return r
    }

    /// Best-effort server-side deauthorize, then wipe all local state.
    public func deactivate() async {
        if let token {
            await Endpoints.deauthorize(
                baseUrl: baseUrl, product: product, token: token, session: session)
        }
        token = nil
        cache = nil
        await store.clearToken()
        await store.clearCache()
    }

    // ── Refresh ─────────────────────────────────────────────────────────────────
    @discardableResult
    public func refresh() async -> RefreshResult {
        guard let token else { return RefreshResult(applied: false) }
        let result = await fetchAndApply(allowReacquire: true)
        if result.applied || !result.unauthorized {
            let snap = reportSnapshotBody()
            _ = await Endpoints.reportSnapshot(
                baseUrl: baseUrl, product: product, token: token, snapshot: snap,
                session: session)
        }
        return result
    }

    private func fetchAndApply(allowReacquire: Bool) async -> RefreshResult {
        guard let token else { return RefreshResult(applied: false) }
        let res = await fetchManagedConfig(
            FetchOptions(
                baseUrl: baseUrl, product: product, token: token, deviceId: deviceId,
                version: version, channel: channel, etag: cache?.etag),
            session: session)

        switch res {
        case .notModified:
            await patchCache { c in
                c.blocked = nil
                c.lastSyncUnauthorized = false
            }
            return RefreshResult(applied: false)

        case .unauthorized:
            if allowReacquire {
                let re = await Endpoints.reacquireToken(
                    baseUrl: baseUrl, product: product, deviceId: deviceId, session: session)
                if case .ok(let newToken, _) = re {
                    self.token = newToken
                    await store.setToken(newToken)
                    return await fetchAndApply(allowReacquire: false)
                }
            }
            await patchCache { $0.lastSyncUnauthorized = true }
            return RefreshResult(applied: false, unauthorized: true)

        case .deviceCap:
            return RefreshResult(applied: false, deviceCap: true)

        case .blocked(let reason, let allowedRange):
            await patchCache {
                $0.blocked = BlockInfoRecord(reason: reason, allowedRange: allowedRange)
            }
            return RefreshResult(applied: false, blocked: true)

        case .ok(let jws, let etag):
            guard
                let doc = verifyDoc(
                    jws,
                    options: VerifyDocOptions(
                        trust: trust, expectedAud: product, deviceId: deviceId,
                        lastAcceptedIssuedAt: cache?.lastAcceptedIssuedAt))
            else { return RefreshResult(applied: false) }
            let rec = CacheRecord(
                doc: doc,
                etag: etag,
                lastAcceptedIssuedAt: doc.issuedAt,
                lastVerifiedAt: Int(Date().timeIntervalSince1970 * 1000),
                lastSyncUnauthorized: false,
                blocked: nil)
            cache = rec
            await store.writeCache(rec)
            return RefreshResult(applied: true)

        case .error:
            return RefreshResult(applied: false)
        }
    }

    private func patchCache(_ mutate: (inout CacheRecord) -> Void) async {
        if var existing = cache {
            mutate(&existing)
            cache = existing
            await store.writeCache(existing)
        } else {
            // No doc yet: remember only bookkeeping if it's a block/unauthorized signal.
            var probe = CacheRecord(doc: nil, lastAcceptedIssuedAt: 0)
            mutate(&probe)
            if probe.blocked != nil || probe.lastSyncUnauthorized == true {
                cache = probe
                await store.writeCache(probe)
            }
        }
    }

    /// The non-secret snapshot (config + entitlement effective values) the admin panel reads.
    private func reportSnapshotBody() -> Data {
        var config: [String: JSONValue] = [:]
        var ents: [String: JSONValue] = [:]
        if let doc = cache?.doc {
            for (k, v) in doc.payload.config { config[k] = v.value }
            for (k, v) in doc.payload.entitlements { ents[k] = v.value }
        }
        let body = SnapshotBody(config: config, entitlements: ents)
        return (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }
}

private struct SnapshotBody: Encodable {
    let config: [String: JSONValue]
    let entitlements: [String: JSONValue]
}

/// Which layer supplied a key's effective config value (see `configSource(_:)`).
public enum ConfigSource: String, Sendable, Equatable {
    /// Remote `enforced` entry — server value wins, no override possible.
    case enforced
    /// Remote `hidden` entry — server value wins and the key is hidden from users.
    case hidden
    /// A caller-supplied `localOverrides` value.
    case local
    /// An environment-variable override.
    case env
    /// A remote `default`-state value (no local/env override present).
    case remoteDefault
    /// No remote entry and no override — the caller's `default:` fallback.
    case fallback
}

/// One user-visible config row from `listUserConfig()`.
public struct UserConfigEntry: Sendable, Equatable {
    public let key: String
    public let value: JSONValue
    /// True iff the entry is `enforced` (the user cannot override it).
    public let enforced: Bool

    public init(key: String, value: JSONValue, enforced: Bool) {
        self.key = key
        self.value = value
        self.enforced = enforced
    }
}
