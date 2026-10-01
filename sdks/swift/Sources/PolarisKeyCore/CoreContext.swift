// Core's live state and the sync loop — wire contract v3 §4–§6.
//
// Polaris Key is a suite of opt-in services over an always-on Core, and on the client that division
// is the same one the Worker makes: Core owns the device principal, the credential, the trust
// set, the verified cache, the monotonic clock floor and the sync pass; a service module owns
// its own routes and the reads they feed.
//
// ── WHY THIS IS AN ACTOR AND THE MANAGERS ARE NOT ───────────────────────────────────────────
//
// v2's `PolarisKeyClient` was one 780-line actor fusing all of the above with config
// resolution, the gate, device management and a refresh timer. The Node re-shape split that
// into five collaborating classes (`CoreContext`/`TrustManager`/`CacheManager`/`TokenManager`/
// `sync`). Swift does not need five OBJECTS to get five responsibilities, because the thing
// that made them separate in TypeScript — every verification being `async` under WebCrypto — is
// not true here: CryptoKit verification is synchronous, so trust custody and cache re-derivation
// are ordinary synchronous folds over this actor's state. What stays asynchronous is I/O, and
// that is exactly what the actor boundary should be drawn around.
//
// ── WHY THE OPTIONS SPLIT ───────────────────────────────────────────────────────────────────
//
// `CoreOptions` carries what Core needs and ONLY that. The pinned trust set lives here rather
// than in the license module because it verifies config documents, trust manifests and offline
// bundles too — a product that has disabled License still needs pins. Conversely `envPrefix` /
// `localOverrides` are absent: they are inputs to config RESOLUTION, so they ride
// `ConfigClientOptions` in PolarisKeyConfig.

import Foundation

/// What Core needs. Per-service inputs live in that service's own option bag.
public struct CoreOptions: Sendable {
    public let productSlug: String
    /// MUST be `https:` — or `http://localhost` / `http://127.0.0.1` for local development.
    public let baseUrl: String
    /// The HOST APPLICATION's version, sent as `X-PKey-Version` and gated on by the server.
    public let version: String
    /// Release channel; derived from `version` when omitted.
    public let channel: String?
    /// Pinned trust set (kid → raw Ed25519 pubkey base64url). The ONLY root: keys learned from
    /// a signed trust manifest extend it but never shadow it. Core-owned because it verifies
    /// license documents, config documents, trust manifests and offline bundles alike.
    public let pinnedKeys: TrustSet
    /// Refresh the signed trust manifest on Core's own cadence inside `sync()`. Defaults to
    /// true. §4.2 forbids riding a service's document fetch: a product with ANY service enabled
    /// must still advance the independent signed clock.
    public let trustRefresh: Bool
    public let store: (any Store)?
    public let configDir: URL?
    /// Defaults to `URLSessionTransport`; `NoNetworkTransport` gives the §7.3 local-only build.
    public let transport: (any PolarisTransport)?
    /// Per-request deadline in seconds. `0` disables it.
    public let requestTimeoutSeconds: Double
    /// What this build was compiled expecting the product to run — the D-21 fallback.
    ///
    /// Capability resolution is: a discovery document loaded this session, else this list, else
    /// `DEFAULT_SERVICES`. It exists because discovery is a NETWORK read and an offline-first
    /// client must not be told it has no license service simply because the control plane is
    /// unreachable. Naming the expectation here is how a config-only or release-enabled product
    /// gets the right answer with no round trip at all.
    public let expectedServices: [ServiceSlug]?
    /// The system clock, epoch SECONDS. Defaults to the wall clock. Every claim check, every gate
    /// comparison and every `lastVerifiedAt` stamp reads it — never `Date()` directly — so a
    /// host that replays recorded traffic (the HTTP transcripts, P1b-03) can run the client at
    /// the instant the traffic was signed. The §4.2 floor still applies on top of it.
    public let clock: (@Sendable () -> Int)?

    public init(
        productSlug: String,
        baseUrl: String = "https://key.plrs.im",
        version: String,
        channel: String? = nil,
        pinnedKeys: TrustSet,
        trustRefresh: Bool = true,
        store: (any Store)? = nil,
        configDir: URL? = nil,
        transport: (any PolarisTransport)? = nil,
        requestTimeoutSeconds: Double = 15,
        expectedServices: [ServiceSlug]? = nil,
        clock: (@Sendable () -> Int)? = nil
    ) {
        self.productSlug = productSlug
        self.baseUrl = baseUrl
        self.version = version
        self.channel = channel
        self.pinnedKeys = pinnedKeys
        self.trustRefresh = trustRefresh
        self.store = store
        self.configDir = configDir
        self.transport = transport
        self.requestTimeoutSeconds = requestTimeoutSeconds
        self.expectedServices = expectedServices
        self.clock = clock
    }
}

/// The status taxonomy every signed-document GET collapses to (§5). One shape for both
/// documents so `sync()` can drive them through identical machinery.
public enum DocumentResult: Sendable, Equatable {
    case ok(jws: String, etag: String?)
    case notModified
    case unauthorized
    case deviceCap(limit: Int?, deviceCount: Int?)
    case blocked(reason: BlockReason, allowedRange: AllowedRange?)
    case error(status: Int, message: String)
}

/// What happened to one document this pass.
public enum DocOutcome: Sendable, Equatable {
    case applied
    case unchanged
    case unauthorized
    case blocked(BlockInfoRecord)
    case deviceCap(limit: Int?, deviceCount: Int?)
    /// The product does not run this service — nothing was fetched.
    case skipped
    case error
}

public struct SyncResult: Sendable, Equatable {
    /// True when ANY document's content changed and was applied.
    public var applied: Bool = false
    /// Set when a document fetch ended on a hard 401 after the single re-acquire.
    public var unauthorized: Bool = false
    /// Set when `/license/document` answered 403 with a version/channel block.
    public var blocked: Bool = false
    /// Set when the server refused on the device cap.
    public var deviceCap: Bool = false
    /// Per-service detail, for callers that fetch more than one document.
    public var documents: [DocumentSlice: DocOutcome] = [:]
}

/// One re-verified document slice: the decoded payload plus the artifact it came from.
public struct CachedDoc<T: DocClaims>: Sendable, Equatable {
    public let jws: String
    public let doc: T
}

/// What a cache load produced. Every field is DERIVED from a signature checked microseconds ago.
public struct LoadedCache: Sendable, Equatable {
    public var license: CachedDoc<LicenseDoc>?
    public var config: CachedDoc<ConfigDoc>?
    /// Present ⇒ this install was activated from an offline bundle (§7).
    public var importedBundle: ImportedBundle?
    public var lastSyncUnauthorized: Bool = false
    public var blocked: BlockInfoRecord?
    /// Epoch MILLIseconds of the last verification. Offline this is derived from the newest
    /// document's signed `issuedAt` — the server's own statement of when it minted is the only
    /// trustworthy "last checked" signal there is (R4-04).
    public var lastVerifiedAt: Int?
}

/// What `importBundle` installed.
public struct ImportBundleResult: Sendable, Equatable {
    public let bundleId: String
    /// Which documents landed, in §7 order. `license` present ⇒ the gate is now activated by
    /// bundle; a config-only bundle imports settings and grants nothing (D-08).
    public let imported: [DocumentSlice]
}

/// One device as the SERVER reports it (§6). Every field but `id` is optional because the
/// roster shape is the Worker's, and an SDK that predates a column must not fail to read a row.
public struct AccountDevice: Sendable, Codable, Equatable {
    public let id: String
    public let licenseId: String?
    public let label: String?
    public let status: String?
    public let current: Bool?
    public let firstSeen: Int?
    public let lastSeen: Int?
    public let platform: String?
    public let arch: String?
    public let appVersion: String?
    public let sdkName: String?
    public let sdkVersion: String?
}

/// `POST /<p>/devices/register` (§6).
public enum RegisterResult: Sendable, Equatable {
    case ok(token: String, deviceId: String)
    /// The product's policy is `requires-license` or `requires-identity`: activation (or a
    /// sign-in) is the mint path, and the endpoint refuses without telling you which.
    case registrationClosed
    case rateLimited
    case notConfigured
    case error(message: String)
}

public actor CoreContext {
    // ── Immutable configuration ──────────────────────────────────────────────────────────
    // `nonisolated` throughout: these never change after construction, so making a sub-client
    // `await` for its own product slug would buy nothing but noise. Swift requires it to be
    // explicit ACROSS MODULES — a `let` could become a `var` in a later version of this package,
    // and the compiler will not assume otherwise on our behalf.
    public nonisolated let product: String
    public nonisolated let endpoints: Endpoints
    public nonisolated let version: String
    public nonisolated let channel: String
    /// Tier 1 — compiled into the host application, never mutated at runtime.
    public nonisolated let pinnedTrust: TrustSet
    public nonisolated let trustRefreshEnabled: Bool
    public nonisolated let store: any Store
    public nonisolated let transport: any PolarisTransport
    public nonisolated let requestTimeoutSeconds: Double
    /// True when the transport refuses to dial (§7.3). Surfaced so the facade can decline to
    /// start a refresh timer that could only ever throw.
    public nonisolated let localOnly: Bool
    /// The system clock (epoch seconds) — `CoreOptions.clock`, else the wall clock.
    public nonisolated let systemClock: @Sendable () -> Int
    /// The same clock in MILLIseconds, keeping the wall clock's sub-second precision for
    /// `lastVerifiedAt` when no clock was injected.
    private nonisolated let systemClockMillis: @Sendable () -> Int

    private let expectedServices: [ServiceSlug]?

    // ── Live state ───────────────────────────────────────────────────────────────────────
    private var deviceIdValue = ""
    private var tokenValue: String?
    private var discoveredServices: ServicesMap?
    private var discoveryDocumentValue: ProductDiscoveryDocument?
    /// Tier 2 — REPLACED, never merged into, on every successful verification (§1 rule 2).
    private var manifestKeys: TrustSet = [:]
    private var manifest: TrustManifestDoc?
    private var clock = MonotonicClock()
    private var record: CacheRecord?
    private var loaded = LoadedCache()
    private var lastStoreErrorValue: StoreError?
    /// §5's single re-acquire budget, re-armed once per `sync()` pass. `spent` is the budget;
    /// `inFlight` is the SHARED attempt — see `reacquireOnce`.
    private var reacquireSpent = false
    private var reacquireInFlight: Task<Bool, Never>?

    public init(options: CoreOptions) throws {
        self.product = options.productSlug
        // Throws BEFORE anything else happens — no directory created, no keychain touched — so
        // a client that failed the scheme guard has taken no other action (§5).
        self.endpoints = try Endpoints(baseUrl: options.baseUrl, product: options.productSlug)
        self.version = options.version
        self.channel = options.channel ?? Semver.channelForVersion(options.version).rawValue
        self.pinnedTrust = options.pinnedKeys
        self.trustRefreshEnabled = options.trustRefresh
        self.store =
            options.store
            ?? KeychainStore(productSlug: options.productSlug, configDir: options.configDir)
        let transport = options.transport ?? URLSessionTransport()
        self.transport = transport
        self.localOnly = transport is NoNetworkTransport
        self.requestTimeoutSeconds = options.requestTimeoutSeconds
        self.expectedServices = options.expectedServices
        if let clock = options.clock {
            self.systemClock = clock
            self.systemClockMillis = { clock() * 1000 }
        } else {
            self.systemClock = { Int(Date().timeIntervalSince1970) }
            self.systemClockMillis = { Int(Date().timeIntervalSince1970 * 1000) }
        }
    }

    /// Load device id + token + cached artifacts, re-verifying everything. NO NETWORK — an
    /// offline-first host must be able to render its gate before it has ever reached the
    /// control plane.
    public func start() async throws {
        deviceIdValue = try await store.getDeviceId()
        tokenValue = try await store.getToken()
        loadCache(await store.readCache())
    }

    // ── Identity + credential ────────────────────────────────────────────────────────────
    public var deviceId: String { deviceIdValue }
    public var token: String? { tokenValue }

    /// The last persistence failure, for a host application that wants to surface it.
    public var lastStoreError: StoreError? { lastStoreErrorValue }

    public func setToken(_ token: String) async throws {
        do {
            try await store.setToken(token)
        } catch let error as StoreError {
            lastStoreErrorValue = error
            throw error
        }
        tokenValue = token
    }

    /// Wipe every credential and artifact, in memory and on disk. Throws if the local wipe could
    /// not be completed — the caller needs to know the credential is still there.
    public func clearAll() async throws {
        tokenValue = nil
        record = nil
        loaded = LoadedCache()
        manifestKeys = [:]
        manifest = nil
        clock.reset()

        var failure: Error?
        do { try await store.clearToken() } catch { failure = error }
        do { try await store.clearCache() } catch { failure = failure ?? error }
        if let failure { throw failure }
    }

    // ── Clock (§4.2) ─────────────────────────────────────────────────────────────────────
    public var highWaterMark: Int { clock.highWaterMark }

    /// The time every gate comparison and every network-path claim check runs at.
    public func now(_ systemNow: Int? = nil) -> Int {
        clock.effectiveNow(systemNow ?? systemClock())
    }

    // ── Trust (§1) ───────────────────────────────────────────────────────────────────────
    /// The effective set: manifest keys UNION pinned keys, PINS LAST so they are terminal.
    public var trust: TrustSet { mergeTrust(pinnedTrust, manifestKeys) }

    public var trustManifest: TrustManifestDoc? { manifest }

    /// Verify a manifest against the PINNED keys and install what it publishes (§1).
    ///
    /// Returns false — keeping the PREVIOUS trust set intact — when the manifest is refused,
    /// stale, replayed, or attempts to substitute a pinned kid. Verification is against pins
    /// ONLY, on the network path as well as on reload: a discovered key must never be able to
    /// sign the manifest that extends its own authority.
    @discardableResult
    func applyTrustManifest(_ jws: String, checkFreshness: Bool) -> Bool {
        let result = verifyTrustManifest(
            jws,
            options: VerifyTrustManifestOptions(
                pinned: pinnedTrust, expectedAud: product,
                now: systemClock(),
                lastTrustIssuedAt: manifest?.issuedAt, checkFreshness: checkFreshness))
        guard let doc = result.doc else { return false }
        // PRUNE (§1 rule 2): the discovered set is REPLACED, so a kid the server stops
        // publishing is dropped. Absence is revocation — that is what restores the server's
        // ability to revoke at all.
        manifestKeys = result.discovered
        manifest = doc
        // §4.2 — the manifest is the floor's second source, and the one that actually advances.
        // A STALE cached manifest counts too: its `issuedAt` is a signed lower bound on real
        // time whether or not it may still publish keys, so raising the floor here does not
        // re-introduce the freshness check the reload path deliberately skips.
        clock.raise(doc.issuedAt)
        return true
    }

    /// Fetch, verify and install the signed trust manifest — on CORE's cadence.
    ///
    /// This is the method that moved out of the v2 client actor. It matters where it lives:
    /// v2's floor rode the `/config` fetch, so a product that fetched no config advanced no
    /// clock, and the floor built from a document alone is provably inert (R4-04). Here it is
    /// called by `sync()` before and independently of whichever documents this product happens
    /// to fetch (§4.2).
    @discardableResult
    public func refreshTrust() async -> Bool {
        let response: PolarisResponse
        do {
            response = try await request(
                endpoints.trustManifest, headers: ["accept": "application/jose"])
        } catch {
            // A manifest we could not fetch is a manifest we KEEP, not a reason to fail a sync.
            return false
        }
        guard response.isOK,
            // Bound the body before it becomes a String: the manifest is a compact JWS whose
            // segments are already capped, so anything larger is not a manifest.
            response.body.count
                <= JWSVerifier.maxHeaderB64 + JWSVerifier.maxPayloadB64 + 128,
            let jws = String(data: response.body, encoding: .utf8),
            applyTrustManifest(jws, checkFreshness: true)  // network path: freshness enforced
        else { return false }
        // Persist the SIGNED manifest, never the bare keys it carries (§4.1).
        await patchCache { $0.trustJws = jws }
        return true
    }

    // ── Capabilities (D-21) ──────────────────────────────────────────────────────────────
    /// Which services this product runs, resolved WITHOUT a network call. Precedence: a
    /// discovery document loaded this session > `expectedServices` > the suite default.
    public func services() -> ServicesMap {
        if let discoveredServices { return discoveredServices }
        if let expectedServices { return servicesFromList(expectedServices) }
        return DEFAULT_SERVICES
    }

    public func enabled(_ slug: ServiceSlug) -> Bool {
        services()[slug] ?? false
    }

    /// Refuse a sub-client whose service this product does not run (D-21).
    public func requireService(_ slug: ServiceSlug) throws {
        guard enabled(slug) else {
            throw PolarisError(
                code: PolarisError.serviceUnavailable,
                message: "The \(slug.rawValue) service is not enabled for \(product).")
        }
    }

    public var discoveryDocument: ProductDiscoveryDocument? { discoveryDocumentValue }

    /// Fetch `/.well-known/polaris.json` and install the product's real capability map.
    ///
    /// Explicit rather than automatic, because it is a NETWORK read and `sync()` must stay
    /// predictable: a client that has never called this resolves capabilities from
    /// `expectedServices` or the suite default. Once a document is loaded it wins over both —
    /// discovery is the authority when it is available.
    @discardableResult
    public func discover() async -> DiscoveryResult {
        let result = await Discovery.fetch(
            endpoints: endpoints, transport: transport, headers: headers(),
            timeoutSeconds: requestTimeoutSeconds)
        if case .ok(let document) = result {
            discoveryDocumentValue = document
            discoveredServices = document.servicesMap
        }
        return result
    }

    // ── Transport (§5) ───────────────────────────────────────────────────────────────────
    /// The `X-PKey-*` client metadata every product-scoped call carries.
    public func headers(_ extra: [String: String] = [:]) -> [String: String] {
        var out: [String: String] = [
            HEADER_DEVICE: deviceIdValue,
            HEADER_VERSION: version,
            HEADER_CHANNEL: channel,
            HEADER_PLATFORM: PlatformFamily.current,
            HEADER_ARCH: ArchFamily.current,
            HEADER_SDK_NAME: POLARIS_SDK_NAME,
            HEADER_SDK_VERSION: POLARIS_SDK_VERSION,
        ]
        for (key, value) in extra { out[key] = value }
        return out
    }

    /// One request, with this client's metadata headers and deadline already applied. Every
    /// service module goes through here, which is what keeps a new endpoint from shipping
    /// without a timeout on it (R4-08).
    public func request(
        _ url: URL, method: String = "GET", headers extra: [String: String] = [:],
        body: Data? = nil
    ) async throws -> PolarisResponse {
        try await transport.send(
            PolarisRequest(
                url: url, method: method, headers: headers(extra), body: body,
                timeoutSeconds: requestTimeoutSeconds))
    }

    /// GET one signed document with conditional-request support, mapping the whole §5 status
    /// taxonomy. Shared verbatim by `/license/document` and `/config/document`, so the two can
    /// never drift on what a 403, a 429 or a dropped connection means.
    ///
    /// Verification is emphatically NOT here: this returns the raw compact JWS and lets `sync()`
    /// hand it to the verifier with the right trust set and anti-replay floor. An HTTP layer
    /// that verified would be an HTTP layer that could be talked into not verifying.
    public func getDocument(
        _ slice: DocumentSlice, token: String, etag: String? = nil
    ) async -> DocumentResult {
        var extra = ["authorization": "Bearer \(token)"]
        if let etag { extra["if-none-match"] = etag }

        let response: PolarisResponse
        do {
            response = try await request(endpoints.document(slice), headers: extra)
        } catch let error as PolarisError {
            return .error(status: 0, message: error.message)
        } catch {
            return .error(status: 0, message: error.localizedDescription)
        }

        switch response.status {
        case 304:
            return .notModified
        case 401:
            return .unauthorized
        case 429:
            let body = try? JSONDecoder().decode(DeviceCapBody.self, from: response.body)
            return .deviceCap(limit: body?.limit, deviceCount: body?.deviceCount)
        case 403:
            // v3 nests the machine-readable code and keeps `allowedRange` at the TOP level
            // (§5). `reason` rides inside the error object so a client can still tell too-old
            // from too-new; a body that says nothing at all falls back to the stricter of the
            // two rather than guessing the permissive one.
            let body = try? JSONDecoder().decode(BlockBody.self, from: response.body)
            let reason =
                body?.error?.reason ?? body?.reason
                ?? (body?.error?.code == "channel_not_allowed"
                    ? .channelNotEntitled : .versionTooOld)
            return .blocked(reason: reason, allowedRange: body?.allowedRange)
        case 200:
            return .ok(
                jws: String(decoding: response.body, as: UTF8.self),
                etag: response.header("etag"))
        default:
            return .error(
                status: response.status,
                message: String(decoding: response.body, as: UTF8.self))
        }
    }

    // ── Cache (§4.1) ─────────────────────────────────────────────────────────────────────
    public func cache() -> LoadedCache { loaded }

    /// The ETag held for one document. Non-security: it is a conditional-request validator, and
    /// the worst a forged one achieves is an unnecessary 200.
    public func etag(_ slice: DocumentSlice) -> String? { record?.etags[slice] }

    /// Re-verify the whole record and derive every counter from it (§4.1).
    ///
    ///   1. a record whose `v != CACHE_RECORD_VERSION` is DISCARDED, never migrated — `v` is
    ///      checked before any field is read, so a v1/v2 record's `trustedKeys` and unsigned
    ///      counters are never even looked at;
    ///   2. `trustJws` against the PINS only, freshness off → the effective set;
    ///   3. each entry of `docs` against THAT set, freshness off, full §3 claim validation
    ///      including `aud` and `deviceId`;
    ///   4. every derived counter — the per-type anti-replay floors, `lastVerifiedAt`, the
    ///      clock floor — computed from what verified, never read from the file.
    ///
    /// Any artifact that fails is treated as ABSENT and dropped from the in-memory record, so a
    /// failed license document yields `needs-activation` rather than a partial state.
    func loadCache(_ stored: CacheRecord?) {
        manifestKeys = [:]
        manifest = nil
        clock.reset()
        loaded = LoadedCache()

        guard let stored, stored.v == CACHE_RECORD_VERSION else {
            record = nil
            return
        }
        var next = stored

        if let trustJws = stored.trustJws {
            // Freshness is not re-checked: a manifest expires in `cacheSeconds` (minutes), so
            // enforcing it on load would drop every discovered key on any restart.
            if applyTrustManifest(trustJws, checkFreshness: false) {
                next.trustJws = trustJws
            } else {
                next.trustJws = nil
            }
        }

        var newestIssuedAt = 0
        if let jws = stored.docs[.license] {
            if let doc = verifyCached(jws, spec: LICENSE_DOC) {
                loaded.license = CachedDoc(jws: jws, doc: doc)
                clock.raise(doc.issuedAt)
                newestIssuedAt = Swift.max(newestIssuedAt, doc.issuedAt)
            } else {
                next.docs[.license] = nil
                next.etags[.license] = nil
            }
        }
        if let jws = stored.docs[.config] {
            if let doc = verifyCached(jws, spec: CONFIG_DOC) {
                loaded.config = CachedDoc(jws: jws, doc: doc)
                clock.raise(doc.issuedAt)
                newestIssuedAt = Swift.max(newestIssuedAt, doc.issuedAt)
            } else {
                next.docs[.config] = nil
                next.etags[.config] = nil
            }
        }

        loaded.importedBundle = stored.importedBundle
        loaded.lastSyncUnauthorized = stored.lastSyncUnauthorized == true
        loaded.blocked = stored.blocked
        loaded.lastVerifiedAt =
            newestIssuedAt > 0 && newestIssuedAt < Int.max / 1000 ? newestIssuedAt * 1000 : nil
        record = next
    }

    /// Re-verify a CACHED document. Every §3 claim is checked exactly as on the network path,
    /// with two reload-specific differences:
    ///
    /// - freshness is NOT enforced — a cached document is expected to be past its short
    ///   `expiresAt`, and deciding what that means is the gate's job (`grace`/`expired`); and
    /// - the time claims are evaluated at `max(effectiveNow, doc.issuedAt)`, so a rolled-back
    ///   clock cannot widen a window and an honestly-wrong clock cannot silently delete a
    ///   licence the user paid for.
    ///
    /// Called AFTER the cached manifest is applied, so `effectiveNow` already carries the
    /// manifest's floor.
    private func verifyCached<T: DocClaims>(_ jws: String, spec: DocTypeSpec<T>) -> T? {
        // Signature-verified peek (never an unauthenticated parse) to learn `issuedAt`.
        guard
            let peek = JWSVerifier.verifyDecoding(
                T.self, jws, trust: trust, typ: spec.typ, requireTyp: true)
        else { return nil }
        // Evaluating at the document's own `issuedAt` is what makes a wrong clock survivable,
        // so bound how far forward ONE artifact may drag the floor: a cached doc may sit ahead
        // of a badly-set clock, but not decades ahead of it.
        guard peek.issuedAt <= saturatingAdd(now(), MAX_GRACE_SECONDS) else { return nil }
        return verifyDoc(
            jws, spec: spec,
            options: VerifyOptions(
                trust: trust, expectedAud: product, deviceId: deviceIdValue,
                now: Swift.max(now(), peek.issuedAt), checkFreshness: false))
    }

    /// Read-modify-write the whole record. The ONLY mutation path (§4.1): a service module that
    /// wrote the file directly could not be prevented from writing a half-record.
    func patchCache(_ mutate: (inout CacheRecord) -> Void) async {
        var next = record ?? CacheRecord()
        mutate(&next)
        next.v = CACHE_RECORD_VERSION
        record = next
        loaded.lastSyncUnauthorized = next.lastSyncUnauthorized == true
        loaded.blocked = next.blocked
        loaded.importedBundle = next.importedBundle
        do {
            try await store.writeCache(next)
        } catch let error as StoreError {
            lastStoreErrorValue = error
        } catch {}
    }

    // ── Offline bundles (§7) ─────────────────────────────────────────────────────────────
    /// Verify and install an offline activation bundle. All-or-nothing; no token is created.
    /// Throws `PolarisError` carrying the §7 step that refused — the step is the operator's
    /// remedy ("get a bundle minted for THIS machine" is a different action from "the mint bound
    /// the wrong device"), and collapsing them would make the air-gapped path the least
    /// diagnosable one.
    @discardableResult
    public func importBundle(
        _ jws: String, now importedAt: Int? = nil
    ) async throws -> ImportBundleResult {
        let stamp = importedAt ?? systemClock()
        let inspection = inspectBundle(
            jws,
            options: BundleOptions(
                pinned: pinnedTrust, product: product, deviceId: deviceIdValue, now: stamp))
        guard case .ok(let bundle) = inspection else {
            guard case .refused(let reason) = inspection else {
                throw PolarisError(code: "bundle", message: "bundle import failed")
            }
            throw PolarisError(code: reason.rawValue, message: bundleMessage(reason))
        }

        // REPLACE rather than merge: importing a bundle is a re-provisioning, and a stale
        // license slice surviving an air-gapped re-import would be a device running on a licence
        // its operator deliberately replaced. No ETags — these documents did not come from a
        // conditional GET, and inventing validators would make the next online sync send an
        // `If-None-Match` the server never issued.
        var docs: [DocumentSlice: String] = [:]
        if let license = bundle.license { docs[.license] = license.jws }
        if let config = bundle.config { docs[.config] = config.jws }
        let fresh = CacheRecord(
            trustJws: bundle.trustJws, docs: docs,
            importedBundle: ImportedBundle(bundleId: bundle.bundleId, importedAt: stamp))
        record = fresh
        do {
            try await store.writeCache(fresh)
        } catch let error as StoreError {
            lastStoreErrorValue = error
            throw error
        }
        // Re-run the normal load path over what we just wrote rather than trusting the
        // in-memory objects: the imported install must reach exactly the state a RESTART would
        // reach, and the only way to be sure of that is to take the same route.
        loadCache(fresh)
        return ImportBundleResult(
            bundleId: bundle.bundleId, imported: bundle.importedSlices)
    }

    /// Human-readable causes, so a CLI can tell an operator WHICH thing is wrong with the file
    /// they were handed. The machine-readable form is the `PolarisError.code`.
    private func bundleMessage(_ reason: BundleRefusalReason) -> String {
        switch reason {
        case .bundleJwsRejected:
            return "The bundle's signature, type or size was not acceptable."
        case .bundleClaimsRejected:
            return
                "The bundle is not addressed to this device, or its import window has closed."
        case .bundleTrustRejected:
            return "The trust manifest inside the bundle was rejected against the pinned keys."
        case .innerDocRejected:
            return "A document inside the bundle failed verification; nothing was imported."
        }
    }

    // ── Device principal (§6) ────────────────────────────────────────────────────────────
    /// `POST /<p>/devices/register` — the keyless mint path.
    ///
    /// It lives in Core, not License, because that is the whole point of D-08: until v3 the only
    /// way to become a device was to present a licence key, which made "device" a licensing
    /// concept. A config-only product's installs need an identity to fetch a document AS and a
    /// credential to fetch it WITH, and this is where they get one.
    ///
    /// No `Authorization` header is sent even when a stale token is held: a client re-registering
    /// is asking for a FRESH credential, not authenticating with the old one.
    public func registerDevice(fingerprint: HardwareFingerprint? = nil) async -> RegisterResult {
        var extra: [String: String] = [:]
        var body: Data?
        if let fingerprint, let encoded = try? JSONEncoder().encode(
            FingerprintBody(fingerprint: fingerprint))
        {
            extra["content-type"] = "application/json"
            body = encoded
        }
        let response: PolarisResponse
        do {
            response = try await request(
                endpoints.devicesRegister, method: "POST", headers: extra, body: body)
        } catch let error as PolarisError {
            return .error(message: error.message)
        } catch {
            return .error(message: error.localizedDescription)
        }
        switch response.status {
        case 200:
            guard let ok = try? JSONDecoder().decode(RegisterBody.self, from: response.body)
            else { return .error(message: "malformed register response") }
            do { try await setToken(ok.token) } catch {
                return .error(message: "could not persist the device token: \(error)")
            }
            return .ok(token: ok.token, deviceId: ok.deviceId)
        case 403:
            return .registrationClosed
        case 429:
            return .rateLimited
        case 404:
            return .notConfigured
        default:
            return .error(message: String(decoding: response.body, as: UTF8.self))
        }
    }

    /// `GET /<p>/devices` — the roster this credential can see (§6).
    ///
    /// A Core surface, available under every registration policy, because a device roster is a
    /// property of the product's FLEET rather than of any one grant. The server decides what
    /// "visible" means: a licensed device sees its licence's whole seat pool, while a registered
    /// device with no licence sees only itself.
    public func listDevices() async throws -> [AccountDevice] {
        let token = try requireToken()
        let response = try await request(
            endpoints.devices, headers: ["authorization": "Bearer \(token)"])
        guard response.isOK else {
            throw PolarisError(
                code: "device_list_failed",
                message: "device list failed with status \(response.status).")
        }
        return (try? JSONDecoder().decode(DeviceListBody.self, from: response.body))?.devices
            ?? []
    }

    /// `PATCH /<p>/devices/:id` — rename. Self-only, enforced server-side.
    public func renameDevice(_ deviceId: String, label: String?) async throws {
        let token = try requireToken()
        let body = try? JSONEncoder().encode(DeviceLabelBody(label: label))
        let response = try await request(
            endpoints.device(deviceId), method: "PATCH",
            headers: [
                "authorization": "Bearer \(token)", "content-type": "application/json",
            ], body: body)
        guard response.isOK else {
            throw PolarisError(
                code: "device_rename_failed",
                message: "device rename failed with status \(response.status).")
        }
    }

    /// `DELETE /<p>/devices/:id` — release another device's seat. Deauthorizing THIS device is a
    /// full local deactivation and belongs to the license client, not here.
    public func deauthorizeDevice(_ deviceId: String) async throws {
        let token = try requireToken()
        let response = try await request(
            endpoints.device(deviceId), method: "DELETE",
            headers: ["authorization": "Bearer \(token)"])
        guard response.isOK else {
            throw PolarisError(
                code: "device_deauthorize_failed",
                message: "device deauthorize failed with status \(response.status).")
        }
    }

    private func requireToken() throws -> String {
        guard let token = tokenValue else {
            throw PolarisError(
                code: PolarisError.deviceManagementUnsupported,
                message: "Activate or register before managing devices.")
        }
        return token
    }

    /// `POST /<p>/devices/report` — best-effort telemetry.
    ///
    /// It moved out of the config service in v3 (`POST /<p>/config/report` is gone) because it
    /// was never config: it is the device's software facts plus a snapshot of what it BELIEVES
    /// it was granted, which is licence anti-fraud data. Core owns the CALL; the caller owns the
    /// BODY, because assembling it needs both documents and this module verifies rather than
    /// interprets them.
    @discardableResult
    public func reportSnapshot(_ body: Data) async -> Bool {
        guard let token = tokenValue else { return false }
        do {
            let response = try await request(
                endpoints.devicesReport, method: "POST",
                headers: [
                    "authorization": "Bearer \(token)", "content-type": "application/json",
                ], body: body)
            return response.isOK
        } catch {
            // Telemetry must never be able to fail a sync.
            return false
        }
    }

    // ── The sync pass (§4.2, §5) ─────────────────────────────────────────────────────────
    /// One Core pass:
    ///
    ///   1. no token ⇒ return immediately, ZERO network calls. An unactivated client that polls
    ///      must not generate traffic, and an offline-first `start()` must not either.
    ///   2. re-arm the single re-acquire budget for this pass.
    ///   3. TRUST REFRESH on Core's own cadence (§4.2) — before the documents, independent of
    ///      them. Errors are swallowed: a manifest we could not fetch is a manifest we keep.
    ///   4. the ENABLED documents IN PARALLEL. License and config are independent services with
    ///      independent ETags; serialising them would make every sync cost two round trips for
    ///      no reason, and a product that runs only one must not pay for the other at all.
    ///   5. verify each against the effective trust set, with the per-TYPE anti-replay floor
    ///      taken from the document currently held (§3).
    ///   6. ONE cache write folding every slice that changed plus the unsigned hints. Two
    ///      parallel fetches finishing microseconds apart would otherwise both read-modify-write
    ///      the record, and the loser's slice would vanish.
    ///   7. the floor rises from whatever verified.
    ///   8. telemetry, best-effort.
    ///
    /// - Parameters:
    ///   - reacquire: the §5 single re-acquire. INJECTED rather than imported so Core does not
    ///     depend on the license module: for a registered-without-licence device the mint path
    ///     is `POST /devices/register`, and the same single-attempt rule applies to it.
    ///   - report: the telemetry body builder, called only if the pass warrants a report.
    @discardableResult
    public func sync(
        force: Bool = false,
        reacquire: (@Sendable (String) async -> String?)? = nil,
        report: (@Sendable () async -> Void)? = nil
    ) async -> SyncResult {
        // §5 — nothing to authenticate with means nothing to fetch. Returning here is what makes
        // "offline start performs zero network calls" a structural property, not a habit.
        guard tokenValue != nil else { return SyncResult() }
        // Re-arm the single-attempt budget for this pass. Without this the memo below would make
        // the SECOND sync of a session unable to recover from a rotated token.
        reacquireSpent = false
        reacquireInFlight = nil

        var trustJws: String?
        if trustRefreshEnabled, await refreshTrust() {
            trustJws = record?.trustJws
        }

        let wantLicense = enabled(.license)
        let wantConfig = enabled(.config)
        // The two fetches genuinely overlap: each `await` on the transport releases this actor,
        // so the second request is issued while the first is in flight. What stays serialized is
        // the bookkeeping between awaits — which is exactly the part that must be.
        async let licenseTask: DocOutcome =
            wantLicense ? syncDocument(.license, force: force, reacquire: reacquire) : .skipped
        async let configTask: DocOutcome =
            wantConfig ? syncDocument(.config, force: force, reacquire: reacquire) : .skipped
        let outcomes: [DocumentSlice: DocOutcome] = [
            .license: await licenseTask, .config: await configTask,
        ]

        var result = SyncResult()
        var patch: BlockInfoRecord??
        for (slice, outcome) in outcomes {
            guard outcome != .skipped else { continue }
            result.documents[slice] = outcome
            switch outcome {
            case .applied: result.applied = true
            case .unauthorized: result.unauthorized = true
            case .blocked(let info):
                result.blocked = true
                patch = .some(info)
            case .deviceCap: result.deviceCap = true
            default: break
            }
        }
        // A successful authenticated exchange — 200 OR 304 — clears both unsigned hints. They
        // can only ever tighten the gate (§4.1), so clearing them on evidence of a healthy
        // session is safe; SETTING them requires the server to have said so.
        let healthy = outcomes.values.contains { $0 == .applied || $0 == .unchanged }
        if patch == nil, healthy { patch = .some(nil) }

        // ── One write ────────────────────────────────────────────────────────────────────
        await patchCache { rec in
            if let trustJws { rec.trustJws = trustJws }
            if result.unauthorized {
                rec.lastSyncUnauthorized = true
            } else if healthy {
                rec.lastSyncUnauthorized = false
            }
            if let patch { rec.blocked = patch }
        }

        // Skipped only on a hard 401 with nothing applied: reporting with a credential the
        // server has just rejected is noise, and the report is best-effort in every other
        // respect.
        if result.applied || !result.unauthorized { await report?() }
        return result
    }

    /// One document's fetch → verify → stage cycle, including the §5 half-life escalation and
    /// the single 401 re-acquire. Written once, generic over the two documents, because the two
    /// rules that matter — "a 304 renews freshness but not the signed window" and "exactly one
    /// re-acquire" — are contract-level and must not be able to differ per service.
    private func syncDocument(
        _ slice: DocumentSlice,
        force: Bool,
        reacquire: (@Sendable (String) async -> String?)?,
        allowReacquire: Bool = true
    ) async -> DocOutcome {
        guard let token = tokenValue else { return .skipped }
        let result = await getDocument(slice, token: token, etag: force ? nil : etag(slice))

        switch result {
        case .notModified:
            // §5 — a 304 means "content unchanged, freshness RENEWED". The ETag deliberately
            // excludes the timestamps, so a content-stable document 304s forever; left alone a
            // continuously online, continuously authenticated client coasts into `grace` at
            // `expiresAt` and `expired` at `graceUntil` (R2-11). Past the half-life we re-ask
            // UNCONDITIONALLY so the server re-signs the validity window.
            if !force, let expiresAt = currentExpiresAt(slice),
                now() > saturatingAdd(expiresAt, -REFRESH_MARGIN_SECONDS) {
                return await syncDocument(
                    slice, force: true, reacquire: reacquire, allowReacquire: allowReacquire)
            }
            markVerified()
            return .unchanged

        case .unauthorized:
            if allowReacquire, let reacquire, await reacquireOnce(reacquire) {
                // One retry, with re-acquire now spent for this pass.
                return await syncDocument(
                    slice, force: force, reacquire: reacquire, allowReacquire: false)
            }
            return .unauthorized

        case .deviceCap(let limit, let deviceCount):
            return .deviceCap(limit: limit, deviceCount: deviceCount)

        case .blocked(let reason, let allowedRange):
            return .blocked(BlockInfoRecord(reason: reason, allowedRange: allowedRange))

        case .ok(let jws, let tag):
            // A document that fails verification is simply not applied — and, crucially,
            // nothing about the previous one is disturbed. The anti-replay floor is DERIVED
            // from the document currently held, never from an on-disk counter (R4-03).
            guard applyDocument(slice, jws: jws, etag: tag) else { return .error }
            markVerified()
            return .applied

        case .error:
            return .error
        }
    }

    /// At most ONE re-acquire per sync pass, SHARED across every concurrent 401.
    ///
    /// §5 gives a 401 exactly one `POST /<p>/license/token` attempt and then one retry of the
    /// failed fetch. Not a loop: a device whose token has genuinely been revoked would otherwise
    /// hammer the control plane forever, and the recorded hard 401 is the offline revocation
    /// signal (§4.3) that a retry loop would keep postponing.
    ///
    /// v3 makes that rule harder to state than v2 did, because `sync()` now fetches license and
    /// config IN PARALLEL and both can 401 at the same instant. Memoising the attempt as a task
    /// collapses them: the first caller starts it, every other caller in the same pass awaits
    /// THAT task, and the result is one network call no matter how many documents were in
    /// flight — while both still get their retry. Setting a bare "spent" flag instead would let
    /// the second document report a hard 401 after a re-acquire that had just succeeded, which
    /// records `lastSyncUnauthorized` and gates `revoked` on a routine token rotation.
    ///
    /// Returns true when a NEW token is in hand and the caller should retry its fetch once.
    private func reacquireOnce(_ reacquire: @escaping @Sendable (String) async -> String?) async
        -> Bool
    {
        if let inFlight = reacquireInFlight { return await inFlight.value }
        if reacquireSpent { return false }
        guard let current = tokenValue else { return false }
        reacquireSpent = true
        let task = Task { () -> Bool in
            guard let next = await reacquire(current) else { return false }
            try? await self.setToken(next)
            return true
        }
        reacquireInFlight = task
        return await task.value
    }

    /// Verify a freshly arrived document and stage it: artifact + ETag in the record, payload in
    /// the derived state, `issuedAt` into the floor.
    private func applyDocument(_ slice: DocumentSlice, jws: String, etag: String?) -> Bool {
        switch slice {
        case .license:
            guard
                let doc = verifyLicenseDoc(
                    jws,
                    options: VerifyOptions(
                        trust: trust, expectedAud: product, deviceId: deviceIdValue,
                        lastAcceptedIssuedAt: loaded.license?.doc.issuedAt, now: now()))
            else { return false }
            loaded.license = CachedDoc(jws: jws, doc: doc)
            clock.raise(doc.issuedAt)
        case .config:
            guard
                let doc = verifyConfigDoc(
                    jws,
                    options: VerifyOptions(
                        trust: trust, expectedAud: product, deviceId: deviceIdValue,
                        lastAcceptedIssuedAt: loaded.config?.doc.issuedAt, now: now()))
            else { return false }
            loaded.config = CachedDoc(jws: jws, doc: doc)
            clock.raise(doc.issuedAt)
        }
        var next = record ?? CacheRecord()
        next.docs[slice] = jws
        next.etags[slice] = etag
        next.v = CACHE_RECORD_VERSION
        record = next
        return true
    }

    private func currentExpiresAt(_ slice: DocumentSlice) -> Int? {
        switch slice {
        case .license: return loaded.license?.doc.expiresAt
        case .config: return loaded.config?.doc.expiresAt
        }
    }

    /// Mark the last verification time from a successful authenticated exchange (including a
    /// 304 — content unchanged still means freshness renewed, §5).
    private func markVerified() {
        loaded.lastVerifiedAt = systemClockMillis()
    }
}

// ── Response bodies ────────────────────────────────────────────────────────────────

private struct DeviceCapBody: Decodable {
    let limit: Int?
    let deviceCount: Int?
}

/// The §5 403 body. `allowedRange` rides at the TOP level while the machine-readable code is
/// nested, so both spellings of `reason` are read.
private struct BlockBody: Decodable {
    struct Nested: Decodable {
        let code: String?
        let reason: BlockReason?
    }
    let error: Nested?
    let reason: BlockReason?
    let allowedRange: AllowedRange?
}

private struct RegisterBody: Decodable {
    let token: String
    let deviceId: String
}

private struct DeviceListBody: Decodable {
    let devices: [AccountDevice]?
}

/// `{"label": …}` — a null label clears it, which is why the field is explicitly encoded rather
/// than omitted when nil.
private struct DeviceLabelBody: Encodable {
    let label: String?
}

/// `{ "fingerprint": { "components": {...}, "hwid": "..." } }` — the shape both the register and
/// activation endpoints read.
struct FingerprintBody: Encodable {
    struct Payload: Encodable {
        let components: [String: String]
        let hwid: String
    }
    let fingerprint: Payload

    init(fingerprint: HardwareFingerprint) {
        self.fingerprint = Payload(
            components: fingerprint.components, hwid: fingerprint.hwid)
    }
}
