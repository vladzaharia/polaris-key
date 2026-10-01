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

    public init(
        core: CoreOptions,
        license: LicenseClientOptions = LicenseClientOptions(),
        config: ConfigClientOptions = ConfigClientOptions(),
        probes: [ProbeDeclaration] = [],
        refreshIntervalSeconds: Double? = nil
    ) {
        self.core = core
        self.license = license
        self.config = config
        self.probes = probes
        self.refreshIntervalSeconds = refreshIntervalSeconds
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
        requestTimeoutSeconds: Double = 15
    ) {
        self.core = CoreOptions(
            productSlug: productSlug, baseUrl: baseUrl, version: version, channel: channel,
            pinnedKeys: pinnedKeys, trustRefresh: trustRefresh, store: store,
            transport: transport, requestTimeoutSeconds: requestTimeoutSeconds,
            expectedServices: expectedServices)
        self.license = LicenseClientOptions(fingerprint: fingerprint)
        self.config = ConfigClientOptions(localOverrides: localOverrides)
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

    public init(
        id: String, current: Bool, status: LicenseStatus, licenseId: String? = nil,
        profile: DocProfile? = nil, lastVerifiedAt: Int? = nil, label: String? = nil
    ) {
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
    /// Device-code sign-in. Refuses with `service-unavailable` unless the product runs Identity.
    public nonisolated let identity: IdentityClient

    private let probes: [ProbeDeclaration]
    private let fingerprintEnabled: Bool
    private let refreshIntervalSeconds: Double?
    private var refreshTask: Task<Void, Never>?
    private var onChange: (@Sendable (LicenseState) -> Void)?

    public init(options: PolarisKeyClientOptions) throws {
        self.product = options.core.productSlug
        let core = try CoreContext(options: options.core)
        self.core = core
        self.config = ConfigClient(
            core: core, options: options.config,
            reacquire: { token in
                // An edge-mint 401 gets the same single re-acquire a document fetch does, on the
                // route the license module owns.
                guard case .ok(let next, _) = await LicenseEndpoints.reacquireToken(
                    core, token: token)
                else { return nil }
                return next
            })
        // A completed device-code sign-in raises the same acquisition event activation does: a
        // signed-in device holds a licensed token exactly as an activated one does.
        self.identity = IdentityClient(core: core) {
            await PolarisKeyClient.syncAfterAcquisition(core: core, probes: options.probes)
        }
        self.probes = options.probes
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
                core: core, probes: options.probes,
                fingerprintEnabled: options.license.fingerprint)
        }
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
        let result = await core.sync(
            force: force,
            reacquire: PolarisKeyClient.reacquire(core: core, fingerprintEnabled: fingerprintEnabled),
            report: { await PolarisKeyClient.report(core: core, probes: probes) })
        // The ETags are the change signal: they exclude the per-request timestamps, so a
        // differing tag means the CONTENT changed rather than that the document was re-signed.
        let afterLicense = await core.etag(.license)
        let afterConfig = await core.etag(.config)
        let changed = afterLicense != before || afterConfig != beforeConfig
        if let onChange, result.applied, changed {
            onChange(await license.status())
        }
        return result
    }

    /// The post-activation sync, forced so a stale ETag cannot 304 away the very first document.
    private static func syncAfterAcquisition(
        core: CoreContext, probes: [ProbeDeclaration], fingerprintEnabled: Bool
    ) async {
        _ = await core.sync(
            force: true,
            reacquire: reacquire(core: core, fingerprintEnabled: fingerprintEnabled),
            report: { await PolarisKeyClient.report(core: core, probes: probes) })
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
    private static func report(core: CoreContext, probes: [ProbeDeclaration]) async {
        let cache = await core.cache()
        var config: [String: JSONValue] = [:]
        var entitlements: [String: JSONValue] = [:]
        for (key, entry) in cache.config?.doc.config ?? [:] { config[key] = entry.value }
        for (key, entry) in cache.license?.doc.entitlements ?? [:] {
            entitlements[key] = entry.value
        }
        let facts = Facts.collect(probes: probes)
        let body = SnapshotBody(
            os: facts.os, hardware: facts.hardware, runtime: facts.runtime,
            locale: facts.locale, timezone: facts.timezone, probes: facts.probes,
            config: config, entitlements: entitlements)
        await core.reportSnapshot((try? JSONEncoder().encode(body)) ?? Data("{}".utf8))
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

    // ── Offline bundles (§7) ─────────────────────────────────────────────────────────────
    /// Verify and install an offline activation bundle. All-or-nothing; no token is created.
    /// Throws `PolarisError` carrying the §7 step that refused.
    @discardableResult
    public func importBundle(_ jws: String, now: Int? = nil) async throws -> ImportBundleResult {
        try await core.importBundle(jws, now: now)
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
        await core.registerDevice(
            fingerprint: PolarisKeyClient.registrationFingerprint(
                product: product, enabled: fingerprintEnabled))
    }

    public func deactivate() async throws {
        try await license.deactivate()
    }

    public func currentDevice() async -> DeviceInfo {
        let cache = await core.cache()
        return DeviceInfo(
            id: await core.deviceId,
            current: true,
            status: await license.status().status,
            licenseId: cache.license?.doc.licenseId,
            profile: cache.license?.doc.profile,
            lastVerifiedAt: cache.lastVerifiedAt)
    }

    /// The device roster, blended with this device's locally-derived state.
    ///
    /// Without a credential there is no roster to fetch, so the answer is THIS DEVICE ALONE —
    /// which is the honest offline answer, not an error. The same is true in local-only mode.
    public func listDevices() async -> [DeviceInfo] {
        let current = await currentDevice()
        guard let roster = try? await core.listDevices(), !roster.isEmpty else {
            return [current]
        }
        return roster.map { device in
            let isCurrent = device.current ?? (device.id == current.id)
            return DeviceInfo(
                id: device.id,
                current: isCurrent,
                // Only THIS device's status is derived from a signature we checked; another
                // device's is the server's opinion, and inventing a gate state for it would be
                // reporting a decision we did not make.
                status: isCurrent ? current.status : .ok,
                licenseId: device.licenseId ?? (isCurrent ? current.licenseId : nil),
                profile: isCurrent ? current.profile : nil,
                lastVerifiedAt: isCurrent ? current.lastVerifiedAt : nil,
                label: device.label)
        }
    }

    public func renameDevice(_ deviceId: String, label: String?) async throws {
        try await core.renameDevice(deviceId, label: label)
    }

    /// Deauthorizing THIS device is a full local deactivation; any other device is a roster
    /// operation that needs a credential.
    public func deauthorizeDevice(_ deviceId: String) async throws {
        if deviceId == (await core.deviceId) {
            try await license.deactivate()
            return
        }
        try await core.deauthorizeDevice(deviceId)
    }

    /// The last persistence failure, for a host that wants to surface it.
    public func storeFailure() async -> StoreError? {
        await core.lastStoreError
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
            expectedServices: core.expectedServices)
        return try await create(
            options: PolarisKeyClientOptions(
                core: local, license: options.license, config: options.config,
                probes: options.probes, refreshIntervalSeconds: nil))
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
