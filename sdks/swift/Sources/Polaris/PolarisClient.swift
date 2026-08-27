// The Polaris Key client: a small, product-agnostic facade over activate/fetch/verify/cache/
// gate. Offline-first — start() re-verifies the cached artifacts with no network; refresh()
// re-pulls (with a single /token re-acquire on 401) and re-applies. An `actor` so its mutable
// token/device/cache state is concurrency-safe under Swift 6 strict concurrency. Mirrors
// sdk-node's client.ts.
//
// Wire contract v2 (docs/security/WIRE-CONTRACT-V2.md) governs three things here:
//   §1  the trust set is PINNED ∪ MANIFEST with pins TERMINAL, pruned on every manifest, and
//       the cache is no longer a key source at all;
//   §3  every claim in a document is checked, not just `aud`/`deviceId`;
//   §4  only SIGNED artifacts are persisted, and every counter is DERIVED by re-verifying
//       them on load — there is no unsigned field left on disk for a gate to read.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Pinned trust set (kid -> raw Ed25519 pubkey base64url). The root of trust: a pinned kid
/// can never be overridden, by a manifest or by anything on disk.
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
    public let trustRefresh: Bool
    /// Collect a hardware fingerprint at activation. Defaults to true; set false to opt out
    /// entirely (the server then records this device as `unverified`).
    public let fingerprint: Bool
    /// Product-declared companion-app probes answered in the report snapshot.
    public let probes: [ProbeDeclaration]
    /// Poll `/config` on this interval (seconds). OFF by default — enabling it would silently
    /// add network traffic and wakeups to every already-shipped integration. Set it to make a
    /// remote tier change land without a restart. Call `stopRefreshLoop()` to end it.
    public let refreshIntervalSeconds: Double?
    /// Deadline for every request this SDK makes. `URLSession` alone has no useful default
    /// here, so a slowloris on `/.well-known/polaris-trust.jws` could stall a refresh
    /// indefinitely (audit finding R4-08).
    public let requestTimeoutSeconds: Double

    public init(
        productSlug: String,
        baseUrl: String = "https://key.plrs.im",
        version: String,
        channel: String? = nil,
        trust: PolarisTrust,
        store: Store? = nil,
        session: URLSession = .shared,
        localOverrides: [String: JSONValue]? = nil,
        envPrefix: String = "PKEY_CONFIG_",
        trustRefresh: Bool = true,
        fingerprint: Bool = true,
        probes: [ProbeDeclaration] = [],
        refreshIntervalSeconds: Double? = nil,
        requestTimeoutSeconds: Double = 15
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
        self.trustRefresh = trustRefresh
        self.fingerprint = fingerprint
        self.probes = probes
        self.refreshIntervalSeconds = refreshIntervalSeconds
        self.requestTimeoutSeconds = requestTimeoutSeconds
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

public struct DeviceInfo: Sendable, Equatable {
    public let id: String
    public let current: Bool
    public let status: LicenseStatus
    public let licenseId: String?
    public let profile: DocProfile?
    public let lastVerifiedAt: Int?

    public init(
        id: String,
        current: Bool,
        status: LicenseStatus,
        licenseId: String? = nil,
        profile: DocProfile? = nil,
        lastVerifiedAt: Int? = nil
    ) {
        self.id = id
        self.current = current
        self.status = status
        self.licenseId = licenseId
        self.profile = profile
        self.lastVerifiedAt = lastVerifiedAt
    }
}

public enum DeviceManagementError: Error, Sendable, Equatable {
    case unsupported
}

public actor PolarisKeyClient {
    public let product: String
    private let baseUrl: String
    private let version: String
    private let channel: String
    /// Tier 1 (§1.1): compiled into the host application. TERMINAL — no manifest and nothing
    /// on disk may override a pinned kid.
    private let pinnedKeys: TrustSet
    /// Tier 2: keys learned from a verified trust manifest. Replaced WHOLESALE on every
    /// accepted manifest, so a kid the server stops publishing is dropped (§1.2.4).
    private var manifestKeys: TrustSet = [:]
    private let trustRefreshEnabled: Bool
    private let fingerprintEnabled: Bool
    private let probes: [ProbeDeclaration]
    private let refreshIntervalSeconds: Double?
    private let requestTimeout: Double
    private var refreshTask: Task<Void, Never>?
    private var onChange: (@Sendable (LicenseState) -> Void)?
    private let store: Store
    private let session: URLSession
    private let localOverrides: [String: JSONValue]
    private let envPrefix: String

    private var token: String?
    private var deviceId = ""
    private var cache: CacheRecord?

    // ── Derived security state (§4.2). NEVER read from disk; recomputed by re-verifying
    //    the stored JWS, so there is no unsigned field left to poison.
    private var doc: ManagedConfigDoc?
    private var lastAcceptedIssuedAt: Int?
    private var lastTrustIssuedAt: Int?
    /// Epoch MILLISECONDS of the last successful verification.
    private var lastVerifiedAt: Int?
    /// §4.3 monotonic floor: `max` over the `issuedAt` of every signed artifact re-verified
    /// here — the config document AND the trust manifest. `effectiveNow` is
    /// `max(systemClock, highWaterMark)`, which makes a clock rollback inert without
    /// requiring a trusted local clock. Internal so the derivation itself is testable.
    ///
    /// Both sources are load-bearing. Derived from the document alone the floor is inert
    /// (R4-04): with one cached document the mark equals `doc.issuedAt`, which is below that
    /// same document's `graceUntil` by construction, so it can never push `effectiveNow` past
    /// the end of grace. The manifest is the second, independently-advancing signed clock —
    /// `trustRefresh` is on by default, so it moves even while a content-stable config
    /// document sits behind an unchanged ETag.
    private(set) var highWaterMark = 0
    private var lastStoreError: StoreError?

    /// The effective trust set: manifest keys UNION pinned keys, PINS LAST so a pinned kid
    /// always resolves to the pinned bytes (§1.1.2 — the reverse order was R2-01).
    private var trust: TrustSet { mergeTrust(pinnedKeys, manifestKeys) }

    public init(options: PolarisKeyOptions) {
        self.product = options.productSlug
        self.baseUrl = options.baseUrl
        self.version = options.version
        self.channel = options.channel
        self.pinnedKeys = options.trust.pinnedKeys
        self.trustRefreshEnabled = options.trustRefresh
        self.fingerprintEnabled = options.fingerprint
        self.probes = options.probes
        self.refreshIntervalSeconds = options.refreshIntervalSeconds
        self.requestTimeout = options.requestTimeoutSeconds
        self.store = options.store
        self.session = options.session
        self.localOverrides = options.localOverrides ?? [:]
        self.envPrefix = options.envPrefix
    }

    /// Construct + `start()` (load token/device/cache with no network) in one step.
    ///
    /// Throws when the credential store itself is unavailable — a locked keychain or an
    /// unwritable config dir used to be swallowed, silently re-activating on every launch
    /// and minting a new device id (and burning a seat) each time (R4-12).
    public static func create(options: PolarisKeyOptions) async throws -> PolarisKeyClient {
        let c = PolarisKeyClient(options: options)
        try await c.start()
        return c
    }

    /// Load token + device id + cached artifacts, re-verifying everything (no network).
    public func start() async throws {
        deviceId = try await store.getDeviceId()
        token = try await store.getToken()
        loadCache(await store.readCache())
    }

    /// The last persistence failure, for a host application that wants to surface it.
    public func storeFailure() -> StoreError? { lastStoreError }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    /// `max(systemClock, highWaterMark)` (§4.3). Every gate read and every claim check on the
    /// network path uses this, so winding the clock back cannot widen a window.
    private func effectiveNow(_ override: Int? = nil) -> Int {
        max(override ?? nowSec(), highWaterMark)
    }

    // ── Cache load (§4.2) ───────────────────────────────────────────────────────
    /// Re-verify the persisted artifacts and DERIVE all security state from them.
    ///
    /// 1. the trust manifest is re-verified against the PINNED keys only — never against
    ///    whatever the file claimed, which is what made cache poisoning self-perpetuating;
    /// 2. the trust set is rebuilt per §1;
    /// 3. the config doc is re-verified against that set — every claim but freshness, which
    ///    on the reload path is the gate's job (§3.1 correction 2);
    /// 4. `lastAcceptedIssuedAt` / `lastTrustIssuedAt` / `lastVerifiedAt` / `highWaterMark`
    ///    are computed from the verified content;
    /// 5. any failure ⇒ that artifact is treated as absent. Fail closed; only the
    ///    fail-CLOSED hints (`blocked`, `lastSyncUnauthorized`) survive unverified, because
    ///    they can only ever make the gate stricter.
    private func loadCache(_ record: CacheRecord?) {
        manifestKeys = [:]
        doc = nil
        lastAcceptedIssuedAt = nil
        lastTrustIssuedAt = nil
        lastVerifiedAt = nil
        highWaterMark = 0

        // A v1 record is DISCARDED, not migrated (§7.3) — one network round trip is the
        // correct price for not carrying poisoned state forward.
        guard let record, record.v == CACHE_RECORD_VERSION else {
            cache = nil
            return
        }

        var next = CacheRecord(
            lastSyncUnauthorized: record.lastSyncUnauthorized, blocked: record.blocked)

        // Freshness is not re-checked here: a manifest expires in `cacheSeconds` (minutes),
        // so enforcing it on load would drop every discovered key on any restart.
        if let trustJws = record.trustJws,
            applyTrustManifest(trustJws, checkFreshness: false) {
            next.trustJws = trustJws
        }

        if let configJws = record.configJws, let verified = verifyCachedDoc(configJws) {
            doc = verified
            lastAcceptedIssuedAt = verified.issuedAt
            highWaterMark = max(highWaterMark, verified.issuedAt)
            // Derived, not stored: the doc was demonstrably signed at `issuedAt`, and that is
            // the only verification time we can prove offline. Guarded because `issuedAt`
            // comes off the wire and Swift traps on overflow.
            lastVerifiedAt = verified.issuedAt < Int.max / 1000 ? verified.issuedAt * 1000 : nil
            next.configJws = configJws
            next.etag = record.etag
        }

        cache = next
    }

    /// Re-verify a CACHED doc. Every §3 claim is checked exactly as on the network path,
    /// with two reload-specific differences:
    ///
    /// - freshness is NOT enforced (`checkFreshness: false`) — a cached document is expected
    ///   to be past its short `expiresAt`, and deciding what that means is the gate's job
    ///   (`grace` / `expired`), not the verifier's; and
    /// - the time claims are evaluated at `max(effectiveNow, doc.issuedAt)`, so a rolled-back
    ///   clock cannot widen a window (§4.3) and an honestly-wrong clock cannot silently
    ///   delete a licence the user paid for.
    ///
    /// Called AFTER the cached manifest is applied, so `effectiveNow` already carries the
    /// manifest's floor — a clock wound back further than `MAX_GRACE_SECONDS` therefore
    /// cannot make a current document unloadable.
    private func verifyCachedDoc(_ jws: String) -> ManagedConfigDoc? {
        // Signature-verified peek (never an unauthenticated parse) to learn `issuedAt`.
        guard let peek = JWSVerifier.verify(jws, trust: trust, typ: .config) else { return nil }
        // Evaluating at the doc's own `issuedAt` is what makes a wrong clock survivable, so
        // bound how far forward one artifact may drag the floor: a cached doc may sit ahead
        // of a badly-set clock, but not decades ahead of it.
        guard peek.payload.issuedAt <= saturatingAdd(effectiveNow(), MAX_GRACE_SECONDS)
        else { return nil }
        return verifyDoc(
            jws,
            options: VerifyDocOptions(
                trust: trust, expectedAud: product, deviceId: deviceId,
                now: max(effectiveNow(), peek.payload.issuedAt), checkFreshness: false))
    }

    // ── Gate / reads ────────────────────────────────────────────────────────────
    public func status(now: Int? = nil) -> LicenseState {
        let blockInfo = cache?.blocked.map {
            BlockInfo(reason: $0.reason, allowedRange: $0.allowedRange)
        }
        return licenseState(
            GateInput(
                hasToken: token != nil,
                doc: doc,
                now: effectiveNow(now),
                lastSyncUnauthorized: cache?.lastSyncUnauthorized ?? false,
                blocked: blockInfo,
                lastVerifiedAt: lastVerifiedAt))
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
        let entry = doc?.payload.config[key]
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
        let entry = doc?.payload.config[key]
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
        guard let config = doc?.payload.config else { return [] }
        return config.compactMap { key, entry in
            guard entry.state != .hidden else { return nil }
            return UserConfigEntry(
                key: key,
                value: self.config(key, default: entry.value),
                enforced: entry.state == .enforced)
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
        doc?.payload.secrets[key]?.value.stringValue
    }

    /// True iff the named entitlement is present and `value == true`.
    public func isEntitled(_ name: String) -> Bool {
        doc?.payload.entitlements[name]?.value.boolValue == true
    }

    public func entitlements() -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in doc?.payload.entitlements ?? [:] { out[k] = v.value }
        return out
    }

    public func profile() -> DocProfile? { doc?.profile }

    public func currentDevice() -> DeviceInfo {
        DeviceInfo(
            id: deviceId,
            current: true,
            status: status().status,
            licenseId: doc?.licenseId,
            profile: doc?.profile,
            lastVerifiedAt: lastVerifiedAt)
    }

    public func listDevices() async throws -> [DeviceInfo] {
        throw DeviceManagementError.unsupported
    }

    public func deauthorizeDevice(_ id: String) async throws {
        guard id == deviceId else { throw DeviceManagementError.unsupported }
        try await deactivate()
    }

    // ── Activation ────────────────────────────────────────────────────────────────
    /// Obtain a license with no key and no sign-in, when the product offers a free tier.
    @discardableResult
    public func enroll() async -> ActivationResult {
        let r = await Endpoints.enroll(
            baseUrl: baseUrl, product: product, deviceId: deviceId,
            fingerprint: currentFingerprint(), session: session, timeout: requestTimeout)
        return await persistActivation(r)
    }

    /// Exchange a license key for a per-device token, persist it, then force a refresh.
    @discardableResult
    public func activate(key: String) async -> ActivationResult {
        let r = await Endpoints.activateWithKey(
            baseUrl: baseUrl, product: product, key: key, deviceId: deviceId,
            fingerprint: currentFingerprint(), session: session, timeout: requestTimeout)
        return await persistActivation(r)
    }

    /// Persist a freshly issued token, then force a full refresh.
    ///
    /// A failed token write is reported, not swallowed: it used to return `.ok` having
    /// stored nothing, so the app looked activated until the next launch (R4-12). The
    /// refresh is FORCED so a stale ETag cannot 304 away the very first document (R4).
    private func persistActivation(_ result: ActivationResult) async -> ActivationResult {
        guard case .ok(let newToken, _) = result else { return result }
        do {
            try await store.setToken(newToken)
        } catch let error as StoreError {
            lastStoreError = error
            return .error(message: "could not persist the device token: \(error)")
        } catch {
            return .error(message: "could not persist the device token: \(error)")
        }
        token = newToken
        _ = await refresh(force: true)
        return result
    }

    /// This machine's hashed hardware components, or nil when collection is disabled or
    /// nothing could be read. Raw hardware values never leave the device.
    private func currentFingerprint() -> HardwareFingerprint? {
        guard fingerprintEnabled else { return nil }
        return Fingerprint.collect(productSlug: product)
    }

    /// Best-effort server-side deauthorize, then wipe all local state. Throws if the local
    /// wipe could not be completed — the caller needs to know the credential is still there.
    public func deactivate() async throws {
        if let token {
            await Endpoints.deauthorize(
                baseUrl: baseUrl, product: product, token: token, session: session,
                timeout: requestTimeout)
        }
        token = nil
        cache = nil
        doc = nil
        manifestKeys = [:]
        lastAcceptedIssuedAt = nil
        lastTrustIssuedAt = nil
        lastVerifiedAt = nil

        var failure: Error?
        do { try await store.clearToken() } catch { failure = error }
        do { try await store.clearCache() } catch { failure = failure ?? error }
        if let failure { throw failure }
    }

    // ── Refresh ─────────────────────────────────────────────────────────────────
    /// Start polling `/config`, invoking `onChange` when the managed config actually changes.
    ///
    /// `computeETag()` deliberately excludes issuedAt/expiresAt/graceUntil, so the tag is
    /// stable across a pure re-sign and differs iff the CONTENT changed. That makes it the
    /// change signal — no payload diffing, no new wire field.
    public func startRefreshLoop(
        onChange: (@Sendable (LicenseState) -> Void)? = nil
    ) {
        guard let seconds = refreshIntervalSeconds, seconds > 0, refreshTask == nil else {
            return
        }
        self.onChange = onChange
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if Task.isCancelled { return }
                _ = await self?.refresh()
            }
        }
    }

    /// Stop the refresh loop. Safe to call more than once.
    public func stopRefreshLoop() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// Re-pull `/config` and re-apply. `force` drops the conditional request, so the server
    /// must return a full, freshly signed document — required after activation and whenever
    /// the cached document is approaching its signed expiry.
    @discardableResult
    public func refresh(force: Bool = false) async -> RefreshResult {
        guard let token else { return RefreshResult(applied: false) }
        let beforeEtag = cache?.etag
        let result = await fetchAndApply(allowReacquire: true, force: force)
        if let onChange, result.applied, let etag = cache?.etag, etag != beforeEtag {
            onChange(status())
        }
        if result.applied || !result.unauthorized {
            let snap = reportSnapshotBody()
            _ = await Endpoints.reportSnapshot(
                baseUrl: baseUrl, product: product, token: token, snapshot: snap,
                session: session, timeout: requestTimeout)
        }
        return result
    }

    /// `refreshTrustFirst` is cleared on the recursive calls below (401 re-acquire, 304
    /// escalation) so one `refresh()` never fetches the trust manifest twice.
    private func fetchAndApply(
        allowReacquire: Bool, force: Bool = false, refreshTrustFirst: Bool = true
    ) async -> RefreshResult {
        guard let token else { return RefreshResult(applied: false) }
        if trustRefreshEnabled, refreshTrustFirst {
            _ = await refreshTrust()
        }
        let res = await fetchManagedConfig(
            FetchOptions(
                baseUrl: baseUrl, product: product, token: token, deviceId: deviceId,
                version: version, channel: channel, etag: force ? nil : cache?.etag,
                timeoutSeconds: requestTimeout),
            session: session)

        switch res {
        case .notModified:
            // A 304 IS a successful authenticated verification: it renews freshness (§5).
            lastVerifiedAt = Int(Date().timeIntervalSince1970 * 1000)
            await patchCache { c in
                c.blocked = nil
                c.lastSyncUnauthorized = false
            }
            // …but the SIGNED window it renews is not the ETag's. Once the cached document is
            // inside its refresh margin, escalate to an unconditional fetch so a continuously
            // ONLINE client can never drift into `grace` on a stable config (R2-11).
            if !force, let doc,
                effectiveNow() > saturatingAdd(doc.expiresAt, -REFRESH_MARGIN_SECONDS) {
                return await fetchAndApply(
                    allowReacquire: allowReacquire, force: true, refreshTrustFirst: false)
            }
            return RefreshResult(applied: false)

        case .unauthorized:
            if allowReacquire {
                let re = await Endpoints.reacquireToken(
                    baseUrl: baseUrl, product: product, token: token, deviceId: deviceId,
                    session: session, timeout: requestTimeout)
                if case .ok(let newToken, _) = re {
                    do {
                        try await store.setToken(newToken)
                        self.token = newToken
                    } catch let error as StoreError {
                        lastStoreError = error
                    } catch {}
                    return await fetchAndApply(
                        allowReacquire: false, force: force, refreshTrustFirst: false)
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
                let verified = verifyDoc(
                    jws,
                    options: VerifyDocOptions(
                        trust: trust, expectedAud: product, deviceId: deviceId,
                        lastAcceptedIssuedAt: lastAcceptedIssuedAt, now: effectiveNow()))
            else { return RefreshResult(applied: false) }
            doc = verified
            lastAcceptedIssuedAt = verified.issuedAt
            highWaterMark = max(highWaterMark, verified.issuedAt)
            lastVerifiedAt = Int(Date().timeIntervalSince1970 * 1000)
            // Persist the SIGNED artifact, verbatim — never the decoded doc, and never any
            // derived counter (§4.1).
            await patchCache { c in
                c.configJws = jws
                c.etag = etag
                c.lastSyncUnauthorized = false
                c.blocked = nil
            }
            return RefreshResult(applied: true)

        case .error:
            return RefreshResult(applied: false)
        }
    }

    /// Fetch, verify, and install the trust manifest. Returns whether the trust set changed.
    private func refreshTrust() async -> Bool {
        guard let url = URL(
            string: "\(baseUrl)/\(product)/.well-known/polaris-trust.jws")
        else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = requestTimeout
        req.setValue("application/jose", forHTTPHeaderField: "Accept")
        guard
            let (data, response) = try? await session.data(for: req),
            let http = response as? HTTPURLResponse,
            http.statusCode == 200,
            data.count <= JWSVerifier.maxHeaderB64 + JWSVerifier.maxPayloadB64 + 128,
            let jws = String(data: data, encoding: .utf8),
            applyTrustManifest(jws)  // network path: freshness enforced
        else { return false }
        // Persist the SIGNED manifest, never the bare keys it carries (§1.1.3).
        await patchCache { $0.trustJws = jws }
        return true
    }

    /// Verify a manifest against the PINNED keys and install what it publishes (§1).
    ///
    /// Returns false — keeping the PREVIOUS trust set intact — when the manifest is refused,
    /// stale, or attempts to substitute a pinned kid. Verification is against pins ONLY, on
    /// the network path as well as on reload: a discovered key must never be able to sign the
    /// manifest that extends its own authority.
    private func applyTrustManifest(_ jws: String, checkFreshness: Bool = true) -> Bool {
        let result = verifyTrustManifest(
            jws,
            options: VerifyTrustManifestOptions(
                pinned: pinnedKeys, expectedAud: product, now: nowSec(),
                checkFreshness: checkFreshness))
        guard let manifest = result.doc else { return false }
        // Anti-replay: a manifest older than the one we already applied is not an update.
        if let last = lastTrustIssuedAt, manifest.issuedAt <= last { return false }
        // PRUNE (§1.2.4): the discovered set is REPLACED, so a kid the server stops
        // publishing is dropped. Absence is revocation — that is what restores the server's
        // ability to revoke at all.
        manifestKeys = result.discovered
        lastTrustIssuedAt = manifest.issuedAt
        // §4.3 — the manifest is the floor's second source, and the one that actually
        // advances: `trustRefresh` is on by default, so this runs on every refresh even when
        // the config document is unchanged. A STALE cached manifest counts too — its
        // `issuedAt` is a signed lower bound on real time whether or not it is still fresh
        // enough to publish keys, so raising the floor here does not re-introduce the
        // freshness check the reload path deliberately skips.
        highWaterMark = max(highWaterMark, manifest.issuedAt)
        return true
    }

    private func patchCache(_ mutate: (inout CacheRecord) -> Void) async {
        var next = cache ?? CacheRecord()
        mutate(&next)
        cache = next
        do {
            try await store.writeCache(next)
        } catch let error as StoreError {
            lastStoreError = error
        } catch {}
    }

    /// The non-secret snapshot (software facts + config/entitlement effective values) the
    /// admin panel reads. Facts ride on the SAME report call as the config snapshot — no
    /// extra round trip — exactly as sdk-node and the Python SDK send them.
    private func reportSnapshotBody() -> Data {
        var config: [String: JSONValue] = [:]
        var ents: [String: JSONValue] = [:]
        if let doc {
            for (k, v) in doc.payload.config { config[k] = v.value }
            for (k, v) in doc.payload.entitlements { ents[k] = v.value }
        }
        let facts = Facts.collect(probes: probes)
        let body = SnapshotBody(
            os: facts.os, hardware: facts.hardware, runtime: facts.runtime,
            locale: facts.locale, timezone: facts.timezone, probes: facts.probes,
            config: config, entitlements: ents)
        return (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }
}

/// `{...facts, config, entitlements}` — the flat shape the Worker's report allowlist reads.
private struct SnapshotBody: Encodable {
    let os: DeviceFacts.OS
    let hardware: DeviceFacts.Hardware
    let runtime: DeviceFacts.Runtime
    let locale: String?
    let timezone: String?
    let probes: [String: ProbeResult]?
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
