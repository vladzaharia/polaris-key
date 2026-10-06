// `PolarisKeyClient` — the suite facade: Core plus one sub-client per service.
//
// The pre-suite `PolarisKeyClient` was a 780-line actor that fused the device principal, the
// credential, the trust set, the cache, the gate, config resolution, device management and the
// refresh loop into one type with a twenty-field option bag. Every one of those is now owned by
// exactly one module, and this file does nothing but compose them and wire the three things that
// genuinely need a whole-client view:
//
//   * `onLicenseAcquired` → `sync()`. Activation used to call refresh inline, so every mint path
//     had to remember to, and a config-only product had no way to say "there is no licence here,
//     sync anyway". Now the license client raises an EVENT and the facade decides.
//   * the REACQUIRE injection. §5's single re-acquire is Core's rule, but the ROUTE
//     (`POST /license/token`) is the license service's, so Core takes it as a closure. That is
//     what lets a registered-without-licence device use the same budget on a different mint path.
//   * the TELEMETRY BODY. Core owns the `POST /devices/report` call; assembling the snapshot
//     needs both documents plus this host's software facts, and Core verifies rather than
//     interprets them.
//
// SECURITY (wire contract v3): every security-relevant value this client holds is DERIVED from a
// signature it has just checked. The cache stores compact JWSs and nothing else; the trust set is
// `manifest ∪ pins` with the pins terminal; the per-type anti-replay floors, the monotonic clock
// floor and `lastVerifiedAt` are recomputed on every load. There is no unsigned field left for a
// local attacker to poison.

import Foundation
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyIdentity
import PolarisKeyLicense
import PolarisKeyPlatform
import PolarisKeyRelease

public struct PolarisKeyClientOptions: Sendable {
    public let core: CoreOptions
    public let license: LicenseClientOptions
    public let config: ConfigClientOptions
    /// Product-declared companion-app probes answered in the telemetry snapshot.
    public let probes: [ProbeDeclaration]
    /// Poll on this interval (seconds). OFF by default — enabling it would silently add network
    /// traffic and background wakeups to every already-shipped integration. Call `close()` to
    /// stop the timer.
    public let refreshIntervalSeconds: Double?
    /// The pinned release-signing keys (`update.pinnedReleaseKeys`), for `client.update` (import
    /// `PolarisKeyUpdate`) and its packs. `PolarisKeyClient.fromBundle()` reads them from
    /// `PolarisKey.plist`.
    public let pinnedReleaseKeys: TrustSet
    /// App Attest seams for `client.devices.attest()`; the defaults are the system's.
    public let attest: AttestOptions
    /// StoreKit behind its seam, for `client.commerce`; nil uses StoreKit 2 where available.
    public let storeClient: (any StoreClient)?

    public init(
        core: CoreOptions,
        license: LicenseClientOptions = LicenseClientOptions(),
        config: ConfigClientOptions = ConfigClientOptions(),
        probes: [ProbeDeclaration] = [],
        refreshIntervalSeconds: Double? = nil,
        pinnedReleaseKeys: TrustSet = [:],
        attest: AttestOptions = AttestOptions(),
        storeClient: (any StoreClient)? = nil
    ) {
        self.core = core
        self.license = license
        self.config = config
        self.probes = probes
        self.refreshIntervalSeconds = refreshIntervalSeconds
        self.pinnedReleaseKeys = pinnedReleaseKeys
        self.attest = attest
        self.storeClient = storeClient
    }

    /// The common case, spelled without nesting: one product, one version, one pin set.
    public init(
        productSlug: String,
        baseUrl: String = "https://key.plrs.im",
        version: String,
        channel: String? = nil,
        pinnedKeys: TrustSet,
        trustRefresh: Bool = true,
        store: (any Store)? = nil,
        transport: (any PolarisTransport)? = nil,
        expectedServices: [ServiceSlug]? = nil,
        localOverrides: [String: JSONValue] = [:],
        fingerprint: Bool = true,
        probes: [ProbeDeclaration] = [],
        refreshIntervalSeconds: Double? = nil,
        requestTimeoutSeconds: Double = 15,
        pinnedReleaseKeys: TrustSet = [:],
        attest: AttestOptions = AttestOptions(),
        storeClient: (any StoreClient)? = nil,
        keychainAccessGroup: String? = nil,
        appGroup: String? = nil
    ) {
        self.pinnedReleaseKeys = pinnedReleaseKeys
        self.attest = attest
        self.storeClient = storeClient
        self.core = CoreOptions(
            productSlug: productSlug, baseUrl: baseUrl, version: version, channel: channel,
            pinnedKeys: pinnedKeys, trustRefresh: trustRefresh, store: store,
            transport: transport, requestTimeoutSeconds: requestTimeoutSeconds,
            expectedServices: expectedServices, keychainAccessGroup: keychainAccessGroup, appGroup: appGroup)
        self.license = LicenseClientOptions(fingerprint: fingerprint)
        self.config = ConfigClientOptions(
            localOverrides: localOverrides, local: LocalConfigOptions(suiteName: appGroup))
        self.probes = probes
        self.refreshIntervalSeconds = refreshIntervalSeconds
    }
}

/// The bridge contract — one snapshot of everything a UI layer renders from.
///
/// `doc` is the LICENSE document because that is what a gate UI renders; config values are read
/// through `client.config`, which has its own accessors and no reason to hand out a whole doc.
public struct SyncState: Sendable, Equatable {
    public let activation: ActivationSource?
    public let doc: LicenseDoc?
    public let lastSyncUnauthorized: Bool
    public let blocked: BlockInfoRecord?
    /// Epoch MILLIseconds, or nil. Offline this is derived from the newest document's signed
    /// `issuedAt`, so it is never a value an attacker chose (R4-04).
    public let lastVerifiedAt: Int?
    /// §4.2's monotonic floor, in epoch SECONDS.
    public let highWaterMark: Int
}

/// One device as the facade reports it, blending the server's roster with this device's
/// locally-derived state.
public struct DeviceInfo: Sendable, Equatable {
    public let id: String
    public let current: Bool
    public let status: LicenseStatus
    public let licenseId: String?
    public let profile: DocProfile?
    /// Epoch MILLIseconds.
    public let lastVerifiedAt: Int?
    public let label: String?
    /// The server's view of the device (nil for this device offline).
    public let platform: String?
    public let appVersion: String?
    /// Epoch seconds the server last saw the device.
    public let lastSeen: Int?

    public init(
        id: String, current: Bool, status: LicenseStatus, licenseId: String? = nil,
        profile: DocProfile? = nil, lastVerifiedAt: Int? = nil, label: String? = nil,
        platform: String? = nil, appVersion: String? = nil, lastSeen: Int? = nil
    ) {
        self.platform = platform
        self.appVersion = appVersion
        self.lastSeen = lastSeen
        self.id = id
        self.current = current
        self.status = status
        self.licenseId = licenseId
        self.profile = profile
        self.lastVerifiedAt = lastVerifiedAt
        self.label = label
    }
}

public actor PolarisKeyClient {
    // `nonisolated` because they never change after construction: `client.config.getConfig(…)`
    // should not have to `await` twice, once for the sub-client and once for the call.
    public nonisolated let product: String
    public nonisolated let core: CoreContext
    public nonisolated let license: LicenseClient
    public nonisolated let config: ConfigClient
    public nonisolated let release: ReleaseClient
    /// Device-code sign-in. Refuses with `service-unavailable` unless the product runs Identity.
    public nonisolated let identity: IdentityClient
    /// The device roster and App Attest (`attest()`).
    public nonisolated let devices: DevicesClient
    /// Store purchases to licence flags: binding, claim, and the StoreKit one-calls.
    public nonisolated let commerce: CommerceClient
    /// The download page's model (`downloadModel()`, `thisPlatform()`).
    public nonisolated let distribution: DistributionClient
    /// The pinned release keys this client was built with (`client.update` reads them).
    public nonisolated let pinnedReleaseKeys: TrustSet
    /// Per-module state the other targets attach (`client.update` in PolarisKeyUpdate), keyed by
    /// the attaching type. Internal plumbing for the SDK's own modules.
    public nonisolated let attachments = LockedValue<[ObjectIdentifier: any Sendable]>([:])
    /// The fan-out behind `events`.
    public nonisolated let eventHub: PolarisEventHub
    /// Diffs observations into `license`, `entitlement` and `config` events.
    nonisolated let publisher: ChangePublisher
    var foregroundObserver: ForegroundObserver?
    var lastForegroundSync: Double?

    private let probes: [ProbeDeclaration]
    /// The capability engine `supports()` reads (P1b-10): the generated table, this build's
    /// runtime and the SDK's detectors.
    private nonisolated let capabilityEngine: Capabilities
    private let fingerprintEnabled: Bool
    private let refreshIntervalSeconds: Double?
    private var refreshTask: Task<Void, Never>?
    private var onChange: (@Sendable (LicenseState) -> Void)?

    public init(options: PolarisKeyClientOptions) throws {
        self.product = options.core.productSlug
        let core = try CoreContext(options: options.core)
        self.core = core
        let hub = PolarisEventHub()
        self.eventHub = hub
        // An edge-mint 401 gets the same single re-acquire a document fetch does, through the
        // same closure, so a registered-without-licence device re-registers there too (§5).
        let config = ConfigClient(
            core: core, options: options.config,
            reacquire: PolarisKeyClient.reacquire(
                core: core, fingerprintEnabled: options.license.fingerprint))
        self.config = config
        // The licence client is built below (its acquisition hook needs the publisher), so the
        // observation reads it through a box filled before init returns.
        let licenseBox = LockedValue<LicenseClient?>(nil)
        let publisher = ChangePublisher(
            hub: hub,
            observe: {
                await PolarisKeyClient.observe(core: core, license: licenseBox.current, config: config)
            },
            source: { await config.configSource($0) },
            deliver: { config.deliver($0) })
        self.publisher = publisher
        // A local `config.set` / `clear` is observed by the same publisher, so `events` and
        // `onConfigChange` listeners see it once each, before `set` returns.
        config.setChangeObserver { await publisher.publish() }
        core.setEventSink { event in
            switch event {
            case .updateAvailable(let version, let action, let mandatory, let channel):
                hub.emit(
                    .updateAvailable(
                        version: version, action: action, mandatory: mandatory, channel: channel))
            case .packs(let pack, let phase, let done, let total):
                hub.emit(.packs(pack: pack, phase: phase, done: done, total: total))
            case .config:
                Task { await publisher.publish() }
            }
        }
        // A completed device-code sign-in raises the same acquisition event activation does: a
        // signed-in device holds a licensed token exactly as an activated one does.
        // One engine for supports(), caps() and every report's `caps`.
        let engine = Capabilities.sdk()
        self.identity = IdentityClient(core: core) {
            await PolarisKeyClient.syncAfterAcquisition(
                core: core, probes: options.probes, engine: engine,
                fingerprintEnabled: options.license.fingerprint, publisher: publisher)
        }
        self.release = ReleaseClient(core: core)
        self.distribution = DistributionClient(core: core)
        self.pinnedReleaseKeys = options.pinnedReleaseKeys
        self.commerce = CommerceClient(
            core: core, store: options.storeClient ?? defaultStoreClient()
        ) {
            await PolarisKeyClient.syncAfterAcquisition(
                core: core, probes: options.probes, engine: engine,
                fingerprintEnabled: options.license.fingerprint, publisher: publisher)
        }
        self.probes = options.probes
        self.capabilityEngine = engine
        self.fingerprintEnabled = options.license.fingerprint
        self.refreshIntervalSeconds = options.refreshIntervalSeconds
        // The activation event: mint a credential, then sync. `devices.register()` deliberately
        // does NOT fire it — a keyless registration is a provisioning step a host may want to
        // take long before it wants documents (an installer that registers at setup and syncs on
        // first launch), so the SDK does not decide that for the host.
        self.license = LicenseClient(core: core, options: options.license) { _ in
            // A `nonisolated` closure so `LicenseClient` can raise it without knowing about this
            // actor; the hop back in is what makes `sync()` the facade's decision.
            await PolarisKeyClient.syncAfterAcquisition(
                core: core, probes: options.probes, engine: engine,
                fingerprintEnabled: options.license.fingerprint, publisher: publisher)
        }
        let license = self.license
        licenseBox.set(license)
        let devices = DevicesClient(
            core: core, license: license, attest: options.attest,
            onLicenseChanged: { await publisher.publish() })
        self.devices = devices
        // §3.10: where attestation can run, an `attestation_required` refusal attests once and
        // retries once. Elsewhere the caller gets the typed refusal.
        if devices.attestSupport().isSupported {
            core.setAttestor { await devices.attest().isAttested }
        }
        // `identity.signOut()` is the facade's `deactivate()`: seat release, wipe, `license`.
        identity.installSignOut {
            try await PolarisKeyClient.deactivate(license: license, publisher: publisher)
        }
    }

    /// What the change events are diffed from: the gate status, every entitlement read through
    /// the gate (nil while it is not usable), every setting's effective value, the last store
    /// failure.
    static func observe(
        core: CoreContext, license: LicenseClient?, config: ConfigClient
    ) async -> ChangeObservation {
        let status = await license?.status().status ?? .notApplicable
        var entitlements: [String: JSONValue] = [:]
        if let license, isUsable(status) {
            entitlements = await license.entitlements()
        }
        return ChangeObservation(
            status: status, entitlements: entitlements, config: await config.snapshot(),
            storeFailure: await core.lastStoreError)
    }

    static func deactivate(license: LicenseClient, publisher: ChangePublisher) async throws {
        do {
            try await license.deactivate()
        } catch {
            await publisher.publish()
            throw error
        }
        await publisher.publish()
    }

    /// Construct + `start()` (load token/device/cache with NO network) in one step.
    ///
    /// Throws when the base URL is not https/loopback, or when the credential store itself is
    /// unavailable — a locked keychain or an unwritable config dir used to be swallowed, silently
    /// re-activating on every launch and minting a new device id (burning a seat) each time
    /// (R4-12).
    public static func create(options: PolarisKeyClientOptions) async throws -> PolarisKeyClient {
        let client = try PolarisKeyClient(options: options)
        try await client.start()
        return client
    }

    /// Load device id + token + cached documents, re-verifying everything. NO NETWORK.
    public func start() async throws {
        try await core.start()
        await publisher.baseline()
        if let degraded = await core.storeStatus()?.degraded {
            eventHub.emit(.store(reason: degraded.reason.rawValue, detail: degraded.detail))
        }
        startRefreshLoop()
    }

    // ── Capabilities (D-21) ──────────────────────────────────────────────────────────────
    @discardableResult
    public func discover() async -> DiscoveryResult {
        await core.discover()
    }

    /// What this client currently believes the product runs.
    public func capabilities() async -> ServicesMap {
        await core.services()
    }

    // ── Typed "unsupported here" (PARITY §2.2, P1b-10) ───────────────────────────────────
    /// Whether `feature` (a `Feature` constant) works here and now: `.supported`, or
    /// `.unsupported` with the `reason` (`runtime`, `outlet`, `product`, `dependency`,
    /// `version`) and a `detail`. Offline and side-effect free: it reads the capability table
    /// generated from `parity.json`, the services this client believes the product runs
    /// (discovery > `expectedServices` > the default) and state already held. `async` only
    /// because the services live on the `CoreContext` actor.
    public func supports(_ feature: String) async -> Support {
        capabilityEngine.supports(feature, services: await core.services())
    }

    /// The feature ids `supports()` answers `.supported` for right now, in registry order. Sent
    /// as `caps` with every device report.
    public func caps() async -> [String] {
        capabilityEngine.caps(services: await core.services())
    }

    // ── Sync ─────────────────────────────────────────────────────────────────────────────
    /// One Core pass: trust refresh → enabled documents in parallel → verify → cache → floor →
    /// report. See `CoreContext.sync` for the full ordering rationale.
    ///
    /// This is v2's `refresh()` under its v3 name. The rename is not cosmetic: `refresh()` meant
    /// "re-pull /config", and there is no such thing any more.
    @discardableResult
    public func sync(force: Bool = false) async -> SyncResult {
        let before = await core.etag(.license)
        let beforeConfig = await core.etag(.config)
        let core = self.core
        let probes = self.probes
        let engine = self.capabilityEngine
        let result = await core.sync(
            force: force,
            reacquire: PolarisKeyClient.reacquire(core: core, fingerprintEnabled: fingerprintEnabled),
            report: {
                _ = await PolarisKeyClient.report(core: core, probes: probes, engine: engine)
            })
        // The ETags are the change signal: they exclude the per-request timestamps, so a
        // differing tag means the CONTENT changed rather than that the document was re-signed.
        let afterLicense = await core.etag(.license)
        let afterConfig = await core.etag(.config)
        let changed = afterLicense != before || afterConfig != beforeConfig
        if result.applied, changed {
            onChange?(await license.status())
        }
        await publisher.publish()
        return result
    }

    /// The post-activation sync, forced so a stale ETag cannot 304 away the very first document.
    private static func syncAfterAcquisition(
        core: CoreContext, probes: [ProbeDeclaration], engine: Capabilities,
        fingerprintEnabled: Bool, publisher: ChangePublisher
    ) async {
        _ = await core.sync(
            force: true,
            reacquire: reacquire(core: core, fingerprintEnabled: fingerprintEnabled),
            report: {
                _ = await PolarisKeyClient.report(core: core, probes: probes, engine: engine)
            })
        // A fresh credential changes the gate's inputs whatever the documents did.
        await publisher.publish()
    }

    /// The gate state straight from Core, for the static event paths that have no
    /// `LicenseClient` in hand.
    static func gateState(_ core: CoreContext, licenseOn: Bool) async -> LicenseState {
        let cache = await core.cache()
        let activation: ActivationSource? =
            await core.token != nil
            ? .token : (cache.importedBundle != nil && cache.license != nil ? .bundle : nil)
        return licenseState(
            GateInput(
                licenseServiceEnabled: licenseOn, activation: activation, doc: cache.license?.doc,
                now: await core.now(), highWaterMark: await core.highWaterMark,
                lastSyncUnauthorized: cache.lastSyncUnauthorized,
                blocked: cache.blocked.map(BlockInfo.init), lastVerifiedAt: cache.lastVerifiedAt))
    }

    /// The §5 single re-acquire, injected into `CoreContext.sync` so Core keeps no dependency on
    /// the license module: `POST /<p>/license/token` for a licensed device, or
    /// `POST /<p>/devices/register` (keyless, no bearer, the same request as `register()`) for a
    /// registered-without-licence device or a product with License off. nil means the one
    /// attempt failed (403 `registration_closed`, 401, 404, 429 or transport) and the hard-401
    /// path applies.
    private static func reacquire(core: CoreContext, fingerprintEnabled: Bool) -> ReacquireFn {
        { current, source in
            let route = chooseReacquireRoute(
                licenseEnabled: await core.enabled(.license), source: source)
            switch route {
            case .devicesRegister:
                guard
                    case .ok(let token, _) = await core.requestDeviceRegistration(
                        fingerprint: registrationFingerprint(
                            product: core.product, enabled: fingerprintEnabled))
                else { return nil }
                return Reacquired(token: token, source: .register)
            case .licenseToken:
                guard case .ok(let token, _) = await LicenseEndpoints.reacquireToken(
                    core, token: current)
                else { return nil }
                return Reacquired(token: token, source: .reacquire)
            }
        }
    }

    /// The fingerprint a registration sends: collected when fingerprinting is enabled
    /// (`PolarisKeyClientOptions.fingerprint`), none otherwise.
    private static func registrationFingerprint(product: String, enabled: Bool)
        -> HardwareFingerprint?
    {
        enabled ? Fingerprint.collect(productSlug: product) : nil
    }

    /// Assemble the telemetry snapshot from RE-VERIFIED documents and post it (§6).
    ///
    /// R4-05: v1 echoed the on-disk cache back to the control plane verbatim, so a forged local
    /// file authored the one signal that would have revealed the forgery. Everything below is
    /// read from the documents Core re-verified; if nothing verified, the maps are empty, and an
    /// empty report is a truthful one.
    @discardableResult
    private static func report(
        core: CoreContext, probes: [ProbeDeclaration], engine: Capabilities,
        extras: [String: JSONValue] = [:]
    ) async -> Bool {
        let cache = await core.cache()
        var config: [String: JSONValue] = [:]
        var entitlements: [String: JSONValue] = [:]
        for (key, entry) in cache.config?.doc.config ?? [:] { config[key] = entry.value }
        for (key, entry) in cache.license?.doc.entitlements ?? [:] {
            entitlements[key] = entry.value
        }
        let facts = Facts.collect(probes: probes)
        // `caps` rides EVERY report: the Worker overwrites the stored report each time, so a
        // report without it would erase the fleet's capability view (P1b-10).
        let caps = engine.caps(services: await core.services())
        // The active pack set (plans/P4-01.md §2.11), when the host runs `update.packs`.
        let packSetId = await core.packSetId()
        let body = SnapshotBody(
            os: facts.os, hardware: facts.hardware, runtime: facts.runtime,
            locale: facts.locale, timezone: facts.timezone, probes: facts.probes,
            config: config, entitlements: entitlements, caps: caps,
            content: packSetId.map { SnapshotContent(packSetId: $0) })
        guard
            let encoded = try? JSONEncoder().encode(body),
            case .object(var fields)? = try? JSONDecoder().decode(JSONValue.self, from: encoded)
        else { return await core.reportSnapshot(Data("{}".utf8)) }
        // The gate this device renders, the outlet the update client resolved, and the queued
        // update-health events (P6-03), wherever the SDK knows them (REPORT_KEYS).
        let licenseOn = await core.enabled(.license)
        fields["gate"] = .object([
            "status": .string(await gateState(core, licenseOn: licenseOn).status.rawValue)
        ])
        if let outlet = core.journal.outlet.current { fields["outlet"] = .string(outlet) }
        var updates = await core.journal.pending()
        // A host's extras fill only the allowlisted keys the SDK left empty; its `updates` ride
        // after the journal's, within the same cap.
        for (key, value) in extras where REPORT_EXTRA_KEYS.contains(key) {
            if key == "updates", case .array(let more) = value {
                let decoded = more.compactMap { v -> UpdateEventEntry? in
                    guard let d = try? JSONEncoder().encode(v) else { return nil }
                    return try? JSONDecoder().decode(UpdateEventEntry.self, from: d)
                }
                updates.append(contentsOf: decoded)
            } else if fields[key] == nil {
                fields[key] = value
            }
        }
        updates = Array(updates.prefix(MAX_REPORT_UPDATE_EVENTS))
        if !updates.isEmpty,
            let d = try? JSONEncoder().encode(updates),
            let v = try? JSONDecoder().decode(JSONValue.self, from: d)
        {
            fields["updates"] = v
        }
        let data = (try? JSONEncoder().encode(JSONValue.object(fields))) ?? Data("{}".utf8)
        let ok = await core.reportSnapshot(data)
        if ok { await core.journal.markReported(updates.map(\.eventId)) }
        return ok
    }

    // ── Telemetry (§6) ───────────────────────────────────────────────────────────────────
    /// Post the device telemetry snapshot now: the values of the documents this client VERIFIED
    /// (R4-05) plus this host's software facts, allowlisted keys only (`POST /devices/report`).
    ///
    /// `sync()` already reports after every pass that warrants it; this is the explicit call a
    /// host makes when it wants the console to see a fresh snapshot without a sync (the
    /// telemetry-report transcript). Best-effort: `false` when no credential is held, the server
    /// refused, or the network failed — telemetry never throws at the host.
    @discardableResult
    public func report() async -> Bool {
        await PolarisKeyClient.report(core: core, probes: probes, engine: capabilityEngine)
    }

    /// `report()` plus host-supplied keys: only the Worker's allowlisted report keys
    /// (`REPORT_EXTRA_KEYS`), never overriding what the SDK itself sends; `updates` entries are
    /// appended to the journal's (a bridged renderer's events), within the 16-event cap.
    @discardableResult
    public func report(extras: [String: JSONValue]) async -> Bool {
        await PolarisKeyClient.report(
            core: core, probes: probes, engine: capabilityEngine, extras: extras)
    }

    /// The React-bridge contract, assembled from the managers that own each piece.
    public func syncState() async -> SyncState {
        let cache = await core.cache()
        return SyncState(
            activation: await license.activation(),
            doc: cache.license?.doc,
            lastSyncUnauthorized: cache.lastSyncUnauthorized,
            blocked: cache.blocked,
            lastVerifiedAt: cache.lastVerifiedAt,
            highWaterMark: await core.highWaterMark)
    }

    // ── Crash-report tags (crash.tags, §3.14) ────────────────────────────────────────────
    /// The crash-reporter tags for this install: `release` (`app@<version>[+<build>]`),
    /// `environment` (the channel) and `pkey.outlet` (the outlet the update client resolved, left
    /// out while unknown). Pass them to a Sentry start as `releaseName`, `environment` and a tag;
    /// the Worker's Sentry hook maps an alert on them to the staged rollout it came from.
    public nonisolated func crashTags(deliverable: String = "app", build: String? = nil)
        -> CrashTags
    {
        crashTagsFor(
            version: core.version, channel: core.channel, outlet: core.journal.outlet.current,
            deliverable: deliverable, build: build)
    }

    // ── Offline bundles (§7) ─────────────────────────────────────────────────────────────
    /// Verify and install an offline activation bundle. All-or-nothing; no token is created.
    /// Throws `PolarisError` carrying the §7 step that refused.
    @discardableResult
    public func importBundle(_ jws: String, now: Int? = nil) async throws -> ImportBundleResult {
        let result = try await core.importBundle(jws, now: now)
        await publisher.publish()
        return result
    }

    // ── Convenience passthroughs ─────────────────────────────────────────────────────────
    // Kept deliberately small. The suite's shape is `client.<service>.<verb>`; these exist only
    // for the calls a host makes before it knows which service it is talking to.
    public func status(now: Int? = nil) async -> LicenseState {
        await license.status(now: now)
    }

    public func isLicensed(now: Int? = nil) async -> Bool {
        await license.isLicensed(now: now)
    }

    public func config(_ key: String, default fallback: JSONValue) async -> JSONValue {
        await config.config(key, default: fallback)
    }

    /// Whether a catalog `flag` is on for this install. Flags are entitlements and ride the
    /// licence document only, so this is `license.isEntitled(flag)`: false whenever the gate is
    /// not usable (S-19 G11).
    public func isEnabled(flag: String) async -> Bool {
        await license.isEntitled(flag)
    }

    /// The verified licence, summarised (`license.licenseInfo()`).
    public func licenseInfo() async -> LicenseInfo? {
        await license.licenseInfo()
    }

    @discardableResult
    public func activate(key: String) async -> ActivationResult {
        await license.activate(key: key)
    }

    @discardableResult
    public func enroll() async -> ActivationResult {
        await license.enroll()
    }

    /// The keyless mint path (§6) — a Core surface, because a config-only product's installs
    /// need a credential and have no licence to present.
    @discardableResult
    public func register() async -> RegisterResult {
        let result = await core.registerDevice(
            fingerprint: PolarisKeyClient.registrationFingerprint(
                product: product, enabled: fingerprintEnabled))
        if case .ok = result { await publisher.publish() }
        return result
    }

    /// Release this device's seat and wipe every local credential, then emit what changed
    /// (`license`, and `entitlement` for every entitlement it held).
    public func deactivate() async throws {
        try await PolarisKeyClient.deactivate(license: license, publisher: publisher)
    }

    public func currentDevice() async -> DeviceInfo {
        await devices.current()
    }

    /// The device roster (`devices.list()`).
    public func listDevices() async -> [DeviceInfo] {
        await devices.list()
    }

    public func renameDevice(_ deviceId: String, label: String?) async throws {
        try await devices.rename(deviceId, label: label)
    }

    /// Deauthorizing THIS device is a full local deactivation (`devices.deauthorize`).
    public func deauthorizeDevice(_ deviceId: String) async throws {
        try await devices.deauthorize(deviceId)
    }

    /// The last persistence failure, for a host that wants to surface it.
    public func storeFailure() async -> StoreError? {
        await core.lastStoreError
    }

    /// Where the token store keeps the token, and why if that is weaker than this platform's
    /// best option: `.keychain`, or `.keychain` degraded by `.legacyKeychain` for a macOS
    /// process without the data-protection keychain entitlement (P1b-09, R4-11). `nil` when a
    /// host store does not report.
    public func storeStatus() async -> StoreStatus? {
        await core.storeStatus()
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────────────────
    /// Start polling, invoking `onChange` when a sync actually changes a document.
    public func startRefreshLoop(onChange: (@Sendable (LicenseState) -> Void)? = nil) {
        if let onChange { self.onChange = onChange }
        // A local-only client's timer could only ever throw at the dial, so it is not started at
        // all (§7.3).
        guard let seconds = refreshIntervalSeconds, seconds > 0, refreshTask == nil,
            !core.localOnly
        else { return }
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                if Task.isCancelled { return }
                _ = await self?.sync()
            }
        }
    }

    /// Stop the refresh loop. Safe to call more than once.
    public func close() {
        refreshTask?.cancel()
        refreshTask = nil
    }
}

/// The device-report keys a host may add through `report(extras:)`: the Worker's `REPORT_KEYS`.
public let REPORT_EXTRA_KEYS: Set<String> = [
    "os", "hardware", "runtime", "locale", "timezone", "probes", "sdk", "sdkVersion",
    "appVersion", "platform", "arch", "gate", "config", "entitlements", "timestamp", "engine",
    "outlet", "content", "updates", "caps", "packInstalls",
]

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
    /// The supported feature ids (P1b-10).
    let caps: [String]
    /// `{packSetId}` of the running pack set; omitted when the host has no packs.
    let content: SnapshotContent?
}

private struct SnapshotContent: Encodable {
    let packSetId: String
}

// ── The §7.3 local-only profile ────────────────────────────────────────────────────

extension PolarisKeyClient {
    /// A client that never touches the network.
    ///
    /// Everything offline still works: `config(_:default:)` resolves over a cached or imported
    /// config document, `status()` gates on a cached or imported licence, and `importBundle`
    /// provisions one. Anything that would dial — activation, enrolment, registration, `sync()`,
    /// discovery, the update check — rejects with `PolarisError` code `local-only`.
    ///
    /// Enforced by SUBSTITUTING THE TRANSPORT rather than by omitting endpoints: a client missing
    /// half its methods is a different type, and the host would have to branch on which one it
    /// got. `NoNetworkTransport` refuses at the dial, before a URL is built or a header is
    /// assembled, so a local-only build cannot make a request even by accident — and
    /// `deactivate()` still works, because it treats the refusal exactly as it treats being
    /// offline.
    public static func createLocal(options: PolarisKeyClientOptions) async throws -> PolarisKeyClient {
        let core = options.core
        let local = CoreOptions(
            productSlug: core.productSlug, baseUrl: core.baseUrl, version: core.version,
            channel: core.channel, pinnedKeys: core.pinnedKeys, trustRefresh: false,
            store: core.store, configDir: core.configDir, transport: NoNetworkTransport(),
            requestTimeoutSeconds: core.requestTimeoutSeconds,
            expectedServices: core.expectedServices, dataDir: core.dataDir,
            cacheDir: core.cacheDir, stateDir: core.stateDir)
        return try await create(
            options: PolarisKeyClientOptions(
                core: local, license: options.license, config: options.config,
                probes: options.probes, refreshIntervalSeconds: nil,
                pinnedReleaseKeys: options.pinnedReleaseKeys, attest: options.attest,
                storeClient: options.storeClient))
    }

    /// A local-only client provisioned from an offline activation bundle in one step.
    ///
    /// The import is verified all-or-nothing against the pins before anything is written (§7), so
    /// a rejected bundle leaves the install exactly as it was and this throws with the step that
    /// refused. On success the returned client is already gated on the imported documents.
    public static func createFromBundle(
        options: PolarisKeyClientOptions, bundle: String, now: Int? = nil
    ) async throws -> (client: PolarisKeyClient, imported: ImportBundleResult) {
        let client = try await createLocal(options: options)
        let imported = try await client.importBundle(bundle, now: now)
        return (client, imported)
    }
}
