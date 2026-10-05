// `PolarisKeyClient` — the suite facade: Core plus one sub-client per service. A port of Swift's
// `PolarisKeyClient`; polaris-key-sdk is the one-line dependency (it re-exports :core and every
// service module through `api` dependencies).
//
// Every concern is owned by exactly one module; this file composes them and wires the three things
// that need a whole-client view:
//
//   * `onAcquired` → `sync()`. Activation, enrolment and a device-code sign-in raise an EVENT and
//     the facade decides to sync (forced, so a stale ETag cannot 304 away the first document).
//   * the REACQUIRE injection. §5's single re-acquire is Core's rule, but the route is a service's:
//     `POST /license/token` for a licensed device, `POST /devices/register` for a registered-
//     without-licence device or a product with License off (P1b-06, `chooseReacquireRoute`).
//   * the TELEMETRY BODY. Core owns the `POST /devices/report` call; the snapshot needs both
//     documents plus this host's software facts (`DeviceFactsSource`) and the capability list.
//
// SECURITY (wire contract v3): every security-relevant value this client holds is DERIVED from a
// signature it has just checked; the cache stores compact JWSs and nothing else (§4.1).
//
// The update and packs facets (P6-08): `update` is the update client (check, signed feed, decide,
// install) and `packs` the pack facet; the facade hands the packs facet to the update client as its
// content host, so the decision sees the running pack set and the engine sees the feed's delta menu,
// while :update and :packs never depend on each other. The packs facet is also the source of the
// device report's `content.packSetId`.

package im.plrs.key.sdk

import im.plrs.key.config.ConfigClient
import im.plrs.key.config.ConfigClientOptions
import im.plrs.key.core.ActivationSource
import im.plrs.key.core.AttestResult
import im.plrs.key.core.AttestationProvider
import im.plrs.key.core.AttestationProviders
import im.plrs.key.core.NoAttestation
import im.plrs.key.core.attestDevice
import im.plrs.key.core.BlockInfoRecord
import im.plrs.key.core.Capabilities
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceFactsSource
import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.DocProfile
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.FingerprintSource
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.JvmDeviceFactsSource
import im.plrs.key.core.JvmFingerprintSource
import im.plrs.key.core.LicenseDoc
import im.plrs.key.core.LicenseState
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.NoNetworkTransport
import im.plrs.key.core.ProbeDeclaration
import im.plrs.key.core.ReacquireFn
import im.plrs.key.core.ReacquireRoute
import im.plrs.key.core.Reacquired
import im.plrs.key.core.RegisterResult
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.ServicesMap
import im.plrs.key.core.StoreStatus
import im.plrs.key.core.Support
import im.plrs.key.core.SyncResult
import im.plrs.key.core.TokenSource
import im.plrs.key.core.VerifiedBundle
import im.plrs.key.core.chooseReacquireRoute
import im.plrs.key.core.deauthorizeDevice
import im.plrs.key.core.listDevices
import im.plrs.key.core.registerDevice
import im.plrs.key.core.renameDevice
import im.plrs.key.core.requestDeviceRegistration
import im.plrs.key.identity.IdentityClient
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClient
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.license.LicenseEndpoints
import im.plrs.key.packs.FeedMenu
import im.plrs.key.packs.PacksClient
import im.plrs.key.packs.PacksOptions
import im.plrs.key.release.DistributionClient
import im.plrs.key.release.ReleaseClient
import im.plrs.key.core.PortalFlow
import im.plrs.key.update.UpdateClient
import im.plrs.key.update.UpdateClientOptions
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.boundChannels
import im.plrs.key.core.reloadFeeds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray

public data class PolarisKeyClientOptions(
    val core: CoreOptions,
    val license: LicenseClientOptions = LicenseClientOptions(),
    val config: ConfigClientOptions = ConfigClientOptions(),
    /** Product-declared companion-app probes answered in the telemetry snapshot. */
    val probes: List<ProbeDeclaration> = emptyList(),
    /** Where the report's software facts come from; defaults to [JvmDeviceFactsSource] (Android's is P6-12's). */
    val factsSource: DeviceFactsSource? = null,
    /**
     * Poll on this interval (seconds). OFF by default: enabling it silently would add network
     * traffic and wakeups to every shipped integration. `close()` stops it.
     */
    val refreshIntervalSeconds: Double? = null,
    /**
     * Wire v4 update options (`pinnedReleaseKeys`, the outlet, methods, the install driver). Null: the
     * update client answers `check()` only, and `decide()` raises `not-configured`.
     */
    val update: UpdateClientOptions? = null,
    /** Packs: the content stamp, embedded baselines, variant preferences and the store directory. */
    val packs: PacksOptions = PacksOptions(),
    /**
     * The platform attestation `devices.attest()` uses (Play Integrity on Android, installed by
     * `PolarisKeyAndroid.client`). Null: the process's [im.plrs.key.core.AttestationProviders]
     * provider, else the typed `runtime` N/A ([im.plrs.key.core.NoAttestation]).
     */
    val attestation: AttestationProvider? = null,
)

/** One snapshot of everything a UI layer renders from. `doc` is the LICENCE document. */
public data class SyncState(
    val activation: ActivationSource?,
    val doc: LicenseDoc?,
    val lastSyncUnauthorized: Boolean,
    val blocked: BlockInfoRecord?,
    /** Epoch MILLIseconds, or null; offline it derives from the newest signed `issuedAt` (R4-04). */
    val lastVerifiedAt: Long?,
    /** §4.2's monotonic floor, in epoch SECONDS. */
    val highWaterMark: Long,
)

/** One device as the facade reports it: the server's roster blended with this device's own state. */
public data class DeviceInfo(
    val id: String,
    val current: Boolean,
    val status: LicenseStatus,
    val licenseId: String? = null,
    val profile: DocProfile? = null,
    /** Epoch MILLIseconds. */
    val lastVerifiedAt: Long? = null,
    val label: String? = null,
)

public class PolarisKeyClient(options: PolarisKeyClientOptions) {
    public val product: String = options.core.productSlug

    /** Throws `insecure-base-url` before anything else happens. */
    public val core: CoreContext = CoreContext(options.core)

    private val probes = options.probes
    private val factsSource: DeviceFactsSource = options.factsSource ?: JvmDeviceFactsSource
    private val fingerprintEnabled = options.license.fingerprint
    private val fingerprintSource: FingerprintSource = options.license.fingerprintSource ?: JvmFingerprintSource
    private val refreshIntervalSeconds = options.refreshIntervalSeconds

    /** The capability engine `supports()` reads (P1b-10). One engine for supports, caps and every report. */
    private val capabilityEngine: Capabilities = Capabilities.sdk()

    /** The §5 re-acquire every authenticated path shares (documents and edge-mint alike). */
    private val reacquire: ReacquireFn = { current, source -> reacquireToken(current, source) }

    public val license: LicenseClient = LicenseClient(core, options.license) { syncAfterAcquisition() }
    private val attestationProvider: AttestationProvider? = options.attestation

    /** The provider attest() uses now (the option, the process's installed one, or none). */
    private fun attestation(): AttestationProvider = attestationProvider ?: AttestationProviders.installed ?: NoAttestation

    /** §3.10: attest once for a retry; false when this runtime cannot (the refusal then stands). */
    private suspend fun attestForRetry(): Boolean {
        val provider = attestation()
        if (provider.unavailable() != null) return false
        return core.attestDevice(provider).trustLevel == "attested"
    }

    public val config: ConfigClient = ConfigClient(core, options.config, reacquire) { attestForRetry() }
    /**
     * The changelog, the URLs, record verification and `fetch()` (a verified, resumable build
     * download; its records verify against `UpdateClientOptions.pinnedReleaseKeys`).
     */
    public val release: ReleaseClient = ReleaseClient(core, records = { sha -> update.releaseRecord(sha).record }) { attestForRetry() }

    /** The public download page's model (`downloadModel()`, `thisPlatform()`). */
    public val distribution: DistributionClient = DistributionClient(core)

    private val buildNumber: String? = options.update?.buildNumber

    /**
     * The customer portal's URL for [flow] (notes/SDK-PARITY-PASS.md §3.5): `freeDevice` names this
     * device unless [deviceId] is given; a `returnTo` outside [allowedReturn] (or not absolute) is
     * dropped.
     */
    public suspend fun portalUrl(
        flow: PortalFlow,
        returnTo: String? = null,
        key: String? = null,
        platform: String? = null,
        deviceId: String? = null,
        allowedReturn: List<String>? = null,
    ): String = im.plrs.key.core.portalUrl(
        core.endpoints.baseUrl, product, flow,
        deviceId = deviceId ?: if (flow == PortalFlow.freeDevice) core.deviceId() else null,
        returnTo = returnTo, key = key, platform = platform ?: RuntimeFamily.platformHeader, allowedReturn = allowedReturn,
    )

    /**
     * The crash-reporter tags the Worker's Sentry hook maps to rollouts (notes/SDK-PARITY-PASS.md
     * §3.14, `W/services/distribution/sentry.ts`): `release` = `app@<version>[+<build>]`,
     * `environment` = the channel, `pkey.outlet` = this install's outlet when known. No crash SDK
     * dependency: pass them to `Sentry.init` (or any reporter) yourself.
     */
    public suspend fun crashTags(): Map<String, String> {
        val out = linkedMapOf(
            "release" to "app@${core.version}${buildNumber?.let { "+$it" } ?: ""}",
            "environment" to core.channel,
        )
        try {
            update.reportedOutlet()?.let { out["pkey.outlet"] = it }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // An outlet that cannot be resolved is simply not tagged.
        }
        return out
    }

    /**
     * The pack facet (`ensure`, `state`, `registerHandler`, progress events). Pack records verify
     * against the update options' `pinnedReleaseKeys`, never the product trust set.
     */
    public val packs: PacksClient = PacksClient(
        core, options.update?.pinnedReleaseKeys ?: emptyMap(), options.packs,
        loadFeedDeltas = { committedFeedMenu(options.update) },
    )

    /** The update client: `check()`, and with `update` options the signed decision. */
    public val update: UpdateClient = options.update?.let { UpdateClient(core, it, packs) } ?: UpdateClient(core)

    /** Device attestation and the roster: `client.devices.attest()` (§3.10). */
    public val devices: DevicesFacet = DevicesFacet()

    /** Store purchases to licence flags (§3.9): `binding()`, `claim()`, `claimPlay()`, `claimSteam()`. */
    public val commerce: CommerceClient = CommerceClient(
        core,
        attest = { attestForRetry() },
        isEntitled = { license.isEntitled(it) },
        outletKind = { update.outlet()?.kind },
    )

    /** The `devices.*` calls under one name, as every SDK spells them. */
    public inner class DevicesFacet internal constructor() {
        /**
         * Raise this device to trust level `attested` (P6-02): the Worker's challenge, the platform
         * token (Play Integrity on a play build Google Play installed), `POST /devices/attest`.
         * Throws [im.plrs.key.core.UnsupportedException] (`runtime` on a JVM desktop, `outlet` on a
         * build that cannot attest) or a [im.plrs.key.core.PolarisException] with the Worker's code.
         */
        public suspend fun attest(): AttestResult = core.attestDevice(attestation())

        /** Why this install cannot attest, or null when it can. Offline. */
        public fun attestUnavailable(): im.plrs.key.core.Unsupported? = attestation().unavailable()

        public suspend fun register(): RegisterResult = this@PolarisKeyClient.register()

        public suspend fun list(): List<DeviceInfo> = listDevices()

        public suspend fun current(): DeviceInfo = currentDevice()

        public suspend fun rename(deviceId: String, label: String?): Unit = renameDevice(deviceId, label)

        public suspend fun deauthorize(deviceId: String): Unit = deauthorizeDevice(deviceId)
    }

    /** Device-code sign-in. Refuses with `service-unavailable` unless the product runs Identity. */
    public val identity: IdentityClient = IdentityClient(core, onAcquired = { syncAfterAcquisition() })

    private val changes = MutableSharedFlow<LicenseState>(extraBufferCapacity = 16)

    /** The licence state after every sync whose documents actually changed (the ETags moved). */
    public val licenseChanges: SharedFlow<LicenseState> = changes.asSharedFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var refreshJob: Job? = null

    /** Load device id, token and cached documents, re-verifying everything. NO NETWORK. */
    public suspend fun start() {
        core.start()
        startRefreshLoop()
    }

    // ── Capabilities (D-21) ──────────────────────────────────────────────────────────────────
    public suspend fun discover(): DiscoveryResult = core.discover()

    /** What this client currently believes the product runs. */
    public suspend fun capabilities(): ServicesMap = core.services()

    /**
     * Whether [feature] (a `Feature` constant) works here and now, or the typed N/A (PARITY §2.2).
     * Offline and side-effect free.
     */
    public suspend fun supports(feature: String): Support = capabilityEngine.supports(feature, core.services())

    /** The feature ids [supports] answers supported for, in registry order; sent as `caps`. */
    public suspend fun caps(): List<String> = capabilityEngine.caps(core.services())

    // ── Sync ─────────────────────────────────────────────────────────────────────────────────
    /** One Core pass: trust refresh, the enabled documents in parallel, verify, cache, floor, report. */
    public suspend fun sync(force: Boolean = false): SyncResult {
        val beforeLicense = core.etag(DocumentSlice.license)
        val beforeConfig = core.etag(DocumentSlice.config)
        val result = core.sync(force, reacquire) { report() }
        // The ETags are the change signal: they exclude per-request timestamps, so a differing tag
        // means the CONTENT changed rather than that the document was re-signed.
        val changed = core.etag(DocumentSlice.license) != beforeLicense || core.etag(DocumentSlice.config) != beforeConfig
        if (result.applied && changed) changes.tryEmit(license.status())
        return result
    }

    /** The post-acquisition sync, forced so a stale ETag cannot 304 away the very first document. */
    private suspend fun syncAfterAcquisition() {
        core.sync(force = true, reacquire = reacquire) { report() }
    }

    /**
     * §5's single re-acquire: `POST /<p>/license/token` for a licensed device, or the keyless
     * `POST /<p>/devices/register` (no bearer, the same request as `register()`) for a registered-
     * without-licence device or a product with License off. Null means the one attempt failed and
     * the hard-401 path applies.
     */
    private suspend fun reacquireToken(current: String, source: TokenSource?): Reacquired? =
        when (chooseReacquireRoute(core.enabled(ServiceSlug.license), source)) {
            ReacquireRoute.devicesRegister ->
                (core.requestDeviceRegistration(registrationFingerprint()) as? RegisterResult.Ok)
                    ?.let { Reacquired(it.token, TokenSource.register) }
            ReacquireRoute.licenseToken ->
                (LicenseEndpoints.reacquireToken(core, current) as? ActivationResult.Ok)
                    ?.let { Reacquired(it.token, TokenSource.reacquire) }
        }

    /** The fingerprint a registration sends: collected when fingerprinting is enabled, none otherwise. */
    private fun registrationFingerprint(): HardwareFingerprint? =
        if (fingerprintEnabled) fingerprintSource.collect(product) else null

    // ── Telemetry (§6) ───────────────────────────────────────────────────────────────────────
    /**
     * Post the device telemetry snapshot now: the values of the documents this client VERIFIED
     * (R4-05), this host's software facts and the capability list, allowlisted keys only.
     * `sync()` already reports after every pass that warrants it. Best-effort: false when no
     * credential is held, the server refused, or the network failed; never throws at the host.
     */
    public suspend fun report(): Boolean {
        val facts = try {
            factsSource.collect(probes).toJson()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emptyMap()
        }
        val body = LinkedHashMap<String, JsonElement>(facts)
        body["config"] = core.configValues()
        body["entitlements"] = core.entitlementValues()
        // `caps` rides EVERY report: the Worker overwrites the stored report each time (P1b-10).
        body["caps"] = JsonArray(caps().map { JsonPrimitive(it) })
        // The running pack set (plans/P4-01.md §2.9), omitted when this host has no packs.
        core.packSetId()?.let { body["content"] = JsonObject(mapOf("packSetId" to JsonPrimitive(it))) }
        // The gate this device renders and its outlet (W/core/devices.ts REPORT_KEYS), as Godot sends them.
        try {
            body["gate"] = JsonObject(mapOf("status" to JsonPrimitive(license.status().status.wire)))
            update.reportedOutlet()?.let { body["outlet"] = JsonPrimitive(it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best-effort facts: a report without them is still a report.
        }
        // §3.13 (P6-03): the oldest pending update-health events, at most 16, marked sent once the
        // Worker took the report; a failed report keeps them for the next one.
        val pending = core.updateEvents.pending()
        if (pending.isNotEmpty()) body["updates"] = JsonArray(pending.map { it.json })
        val ok = core.reportSnapshot(JsonObject(body).toString().toByteArray(Charsets.UTF_8))
        if (ok && pending.isNotEmpty()) core.updateEvents.markSent(pending.map { it.eventId })
        return ok
    }

    /**
     * The update-health journal (`update_offered` … `boot_rolled_back`): every SDK emitter writes
     * here and [report] carries it. Hand it to a [im.plrs.key.update.BootGuard] the host builds.
     */
    public val updateEvents: im.plrs.key.core.UpdateEventJournal get() = core.updateEvents

    /**
     * plans/P4-29.md §2.4 step 1: before any check this process, the delta menu of the committed feed
     * of the configured channel, re-verified on the reload path (no freshness: a stale menu only falls
     * back). No cache or no committed feed is no menu.
     */
    private suspend fun committedFeedMenu(update: UpdateClientOptions?): FeedMenu? {
        val platform = update?.platform ?: RuntimeFamily.platformHeader ?: return null
        val committed = reloadFeeds(core.updateSlices().feeds, core.trust(), core.product, platform)
        for (k in boundChannels(core.channel)) committed.feeds[k]?.let { return FeedMenu(it.feed.content.deltas) }
        return null
    }

    /** The bridge contract, assembled from the managers that own each piece. */
    public suspend fun syncState(): SyncState {
        val cache = core.cache()
        return SyncState(
            activation = license.activation(),
            doc = cache.license?.doc,
            lastSyncUnauthorized = cache.lastSyncUnauthorized,
            blocked = cache.blocked,
            lastVerifiedAt = cache.lastVerifiedAt,
            highWaterMark = core.highWaterMark(),
        )
    }

    // ── Offline bundles (§7) ─────────────────────────────────────────────────────────────────
    /** Verify and install an offline activation bundle. All-or-nothing; no token is created. */
    public suspend fun importBundle(jws: String): VerifiedBundle = core.importBundle(jws)

    // ── Convenience passthroughs (the suite's shape is `client.<service>.<verb>`) ────────────
    public suspend fun status(now: Long? = null): LicenseState = license.status(now)

    public suspend fun isLicensed(now: Long? = null): Boolean = license.isLicensed(now)

    public suspend fun config(key: String, default: JsonElement): JsonElement = config.config(key, default)

    public suspend fun activate(key: String): ActivationResult = license.activate(key)

    public suspend fun enroll(): ActivationResult = license.enroll()

    /**
     * The keyless mint path (§6). It does NOT sync: a registration is a provisioning step a host
     * may take long before it wants documents.
     */
    public suspend fun register(): RegisterResult = core.registerDevice(registrationFingerprint())

    public suspend fun deactivate(): Unit = license.deactivate()

    public suspend fun currentDevice(): DeviceInfo {
        val cache = core.cache()
        return DeviceInfo(
            id = core.deviceId(),
            current = true,
            status = license.status().status,
            licenseId = cache.license?.doc?.licenseId,
            profile = cache.license?.doc?.profile,
            lastVerifiedAt = cache.lastVerifiedAt,
        )
    }

    /**
     * The device roster blended with this device's locally-derived state. Without a credential (or
     * offline, or local-only) the answer is THIS DEVICE ALONE: the honest offline answer.
     */
    public suspend fun listDevices(): List<DeviceInfo> {
        val current = currentDevice()
        val roster = try {
            core.listDevices()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emptyList()
        }
        if (roster.isEmpty()) return listOf(current)
        return roster.map { device ->
            val isCurrent = device.current ?: (device.id == current.id)
            DeviceInfo(
                id = device.id,
                current = isCurrent,
                // Only THIS device's status is derived from a signature we checked.
                status = if (isCurrent) current.status else LicenseStatus.ok,
                licenseId = device.licenseId ?: if (isCurrent) current.licenseId else null,
                profile = if (isCurrent) current.profile else null,
                lastVerifiedAt = if (isCurrent) current.lastVerifiedAt else null,
                label = device.label,
            )
        }
    }

    public suspend fun renameDevice(deviceId: String, label: String?): Unit = core.renameDevice(deviceId, label)

    /** Deauthorizing THIS device is a full local deactivation; any other is a roster operation. */
    public suspend fun deauthorizeDevice(deviceId: String) {
        if (deviceId == core.deviceId()) {
            license.deactivate()
            return
        }
        core.deauthorizeDevice(deviceId)
    }

    /** Where the token store keeps the token; null when the store does not report. */
    public suspend fun storeStatus(): StoreStatus? = core.storeStatus()

    // ── Lifecycle ────────────────────────────────────────────────────────────────────────────
    /** Start polling on `refreshIntervalSeconds` (no-op when unset, already running or local-only). */
    public fun startRefreshLoop() {
        val seconds = refreshIntervalSeconds ?: return
        if (seconds <= 0 || refreshJob != null || core.localOnly) return
        refreshJob = scope.launch {
            while (isActive) {
                delay((seconds * 1000).toLong())
                try {
                    sync()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A failed pass is retried on the next tick.
                }
            }
        }
    }

    /** Stop the refresh loop. Safe to call more than once. */
    public fun close() {
        refreshJob?.cancel()
        refreshJob = null
    }

    public companion object {
        /** Construct and `start()` (load token, device and cache with NO network) in one step. */
        public suspend fun create(options: PolarisKeyClientOptions): PolarisKeyClient =
            PolarisKeyClient(options).also { it.start() }

        /**
         * A client that never touches the network (§7.3): `NoNetworkTransport` refuses at the dial,
         * so anything that would dial rejects with `local-only` while everything offline works.
         */
        public suspend fun createLocal(options: PolarisKeyClientOptions): PolarisKeyClient = create(
            options.copy(
                core = options.core.copy(transport = NoNetworkTransport, trustRefresh = false),
                refreshIntervalSeconds = null,
            ),
        )

        /** A local-only client provisioned from an offline activation bundle in one step. */
        public suspend fun createFromBundle(options: PolarisKeyClientOptions, bundle: String): Pair<PolarisKeyClient, VerifiedBundle> {
            val client = createLocal(options)
            return client to client.importBundle(bundle)
        }
    }
}
