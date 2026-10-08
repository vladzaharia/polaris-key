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
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray

public data class PolarisKeyClientOptions @JvmOverloads constructor(
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

/**
 * One event on [PolarisKeyClient.events] (notes/SDK-PARITY-PASS.md §3.11): the multi-subscriber
 * stream a UI layer listens to instead of polling.
 */
public sealed interface PolarisEvent {
    /** The licence state after a sync whose documents changed, or after an activation. */
    public data class License(val state: LicenseState) : PolarisEvent

    /** A key's effective value moved (a local override, a new config document). */
    public data class Config(val change: im.plrs.key.config.ConfigChange) : PolarisEvent

    /** A decision offered a newer app build. */
    public data class UpdateAvailable(val check: im.plrs.key.core.UpdateCheck) : PolarisEvent

    /** Pack progress (`download`, `apply`, `done`, `state-issue`). */
    public data class Packs(val progress: im.plrs.key.packs.PackProgress) : PolarisEvent
}

/** `channelChoices()`: what a channel picker offers. */
public data class ChannelChoices(
    val current: String,
    val buildChannel: String,
    val options: List<String>,
    /** The outlet (id or kind) that fixes the channel, or null when it may be switched. */
    val lockedBy: String?,
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
    /**
     * True when the roster could not be fetched (offline, no credential, a refusal) and this is the
     * device alone: a screen can say "offline" instead of showing a one-device roster as the truth.
     */
    val offline: Boolean = false,
)

public class PolarisKeyClient(options: PolarisKeyClientOptions) {
    public val product: String = options.core.productSlug

    /** True when the build pinned what the product runs (`CoreOptions.expectedServices`): `boot()` then skips discovery once a token is held. */
    public val servicesPinned: Boolean = options.core.expectedServices != null

    /** Throws `insecure-base-url` before anything else happens. */
    public val core: CoreContext = CoreContext(options.core)

    private val probes = options.probes
    private val factsSource: DeviceFactsSource = options.factsSource ?: JvmDeviceFactsSource
    private val fingerprintEnabled = options.license.fingerprint
    private val fingerprintSource: FingerprintSource = options.license.fingerprintSource ?: JvmFingerprintSource
    private val refreshIntervalSeconds = options.refreshIntervalSeconds

    /** The capability engine `supports()` reads (P1b-10). One engine for supports, caps and every report. */
    private val capabilityEngine: Capabilities = Capabilities.forStore(core.store)

    /** The §5 re-acquire every authenticated path shares (documents and edge-mint alike). */
    private val reacquire: ReacquireFn = { current, source -> reacquireToken(current, source) }

    public val license: LicenseClient = LicenseClient(
        core, options.license,
        onAcquired = { syncAfterAcquisition() },
        onDeactivated = {
            tokenRejection.clear()
            config.publish()
            publishLicense(force = true)
        },
    )
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
    private val updatePlatform: String? = options.update?.platform

    /**
     * The channels this install may switch to, and why it may not (notes/SDK-PARITY-PASS.md §3.18
     * `ChannelPicker`): [ChannelChoices.lockedBy] names the outlet when its capabilities forbid a
     * channel switch (store, Steam, itch, package-managed builds take their channel from the
     * outlet); the options are the current channel, `stable` and every channel the licence grants.
     */
    public suspend fun channelChoices(): ChannelChoices {
        core.ensureStarted()
        val current = core.channel
        val options = LinkedHashSet<String>()
        options += current
        options += im.plrs.key.core.CHANNEL_STABLE
        options += license.entitledChannels()
        val outlet = try {
            update.outlet()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val platform = updatePlatform ?: RuntimeFamily.platformHeader ?: ""
        val lockedBy = when {
            outlet == null -> null
            im.plrs.key.core.effectiveCapabilities(outlet.kind, platform, outlet.subkind).channelSwitch -> null
            else -> outlet.id ?: outlet.kind
        }
        return ChannelChoices(current, core.buildChannel, options.toList(), lockedBy)
    }

    /**
     * Switch this install's release channel at runtime, persisted (null returns to the build's
     * channel). Refused `channel_not_allowed` when the outlet locks the channel or the licence does
     * not grant it. Syncs (forced) so the documents and the next decision follow the new channel.
     */
    public suspend fun setChannel(channel: String?) {
        val choices = channelChoices()
        if (channel != null && channel != choices.buildChannel) {
            if (choices.lockedBy != null) {
                throw im.plrs.key.core.PolarisException(im.plrs.key.core.ErrorCode.channelNotAllowed, "This install's channel is set by ${choices.lockedBy}.")
            }
            if (channel !in choices.options) {
                throw im.plrs.key.core.PolarisException(im.plrs.key.core.ErrorCode.channelNotAllowed, "This licence does not grant the $channel channel.")
            }
        }
        core.setChannel(channel)
        try {
            sync(force = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Offline: the next sync uses the new channel.
        }
    }

    /**
     * The boot guard for this app build (`update.bootguard`, notes/SDK-PARITY-PASS.md §3.15), its
     * state in `boot-guard.json` beside the token store and its events in [updateEvents]. [slots]
     * are the host's staged / current / previous payloads; null (a store- or platform-installed
     * app) counts nothing and still journals `update_confirmed` on a new version's first healthy
     * launch. `bootHost()` in the Compose kit uses this by default.
     */
    public fun bootGuard(slots: im.plrs.key.update.UpdateSlots? = null, engine: String? = null): im.plrs.key.update.BootGuard {
        val slot = core.store.stateDirectory?.let { im.plrs.key.core.FileStateSlot(java.io.File(it, "boot-guard.json")) } ?: bootGuardMemory
        val store = object : im.plrs.key.update.BootGuardStore {
            override fun read(): String? = slot.read()
            override fun write(text: String) = slot.write(text)
        }
        return im.plrs.key.update.BootGuard(store, slots, core.version, engine, core.updateEvents)
    }

    private val bootGuardMemory = im.plrs.key.core.MemoryStateSlot()

    /**
     * The crash-reporter tags the Worker's Sentry hook maps to rollouts (notes/SDK-PARITY-PASS.md
     * §3.14, `W/services/distribution/sentry.ts`): `release` = `app@<version>[+<build>]`,
     * `environment` = the channel, `pkey.outlet` = this install's outlet when known. No crash SDK
     * dependency: pass them to `Sentry.init` (or any reporter) yourself.
     */
    public suspend fun crashTags(): Map<String, String> {
        core.ensureStarted()
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

    /**
     * The licence state after every transition (SP-51): an activation, a sync that moved the
     * documents OR the gate (a 401 that revoked this device, a block, grace and expiry as the floor
     * moves), a deactivation or wipe. A state equal to the last one emitted is not emitted again.
     */
    public val licenseChanges: SharedFlow<LicenseState> = changes.asSharedFlow()

    private val stateFlow = kotlinx.coroutines.flow.MutableStateFlow<LicenseState?>(null)

    /** The licence state now: null until the first read, then every transition (a hot StateFlow). */
    public val licenseState: kotlinx.coroutines.flow.StateFlow<LicenseState?> = stateFlow.asStateFlow()

    private val publishLock = kotlinx.coroutines.sync.Mutex()
    private var lastKey: Pair<LicenseState, String?>? = null

    /**
     * Read the gate and emit when it, or the licence document's content (a hash fallback for a
     * server that sends no usable ETag), differs from the last emission. [force] emits regardless.
     */
    private suspend fun publishLicense(force: Boolean = false) {
        // Read INSIDE the lock: overlapping passes would otherwise publish an older read last and
        // leave the state stale (a revoked device shown as licensed).
        var state: LicenseState? = null
        val emit = publishLock.withLock {
            val read = license.status()
            state = read
            val hash = core.cache().license?.jws?.let { sha256Hex(it) }
            val key = read to hash
            val changed = force || lastKey != key
            lastKey = key
            stateFlow.value = read
            changed
        }
        if (emit) changes.tryEmit(state!!)
    }

    private fun sha256Hex(text: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** The client's own scope: event fan-out, the refresh loop and `boot()`'s launch confirmation. */
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val eventFlow = MutableSharedFlow<PolarisEvent>(extraBufferCapacity = 64)

    /** Licence, config, update-offer and pack events, for every subscriber (§3.11). */
    public val events: SharedFlow<PolarisEvent> = eventFlow.asSharedFlow()

    init {
        scope.launch { changes.collect { eventFlow.emit(PolarisEvent.License(it)) } }
        scope.launch { config.changes.collect { eventFlow.emit(PolarisEvent.Config(it)) } }
        scope.launch { update.offers.collect { eventFlow.emit(PolarisEvent.UpdateAvailable(it)) } }
        packs.on { eventFlow.tryEmit(PolarisEvent.Packs(it)) }
    }
    private var refreshJob: Job? = null
    private val startLock = kotlinx.coroutines.sync.Mutex()
    @Volatile private var started = false

    /**
     * Load device id, token and cached documents, re-verifying everything (NO NETWORK), and start
     * the refresh loop when one is configured. Once: later calls return at once. Optional, since
     * every call loads what it needs first (SP-50), and main-safe. `core.start()` reloads.
     */
    public suspend fun start() {
        if (!started) {
            startLock.withLock {
                if (!started) {
                    core.ensureStarted()
                    config.publish(emit = false)
                    started = true
                }
            }
        }
        startRefreshLoop()
    }

    /**
     * [start] in the client's own scope, without waiting: what `PolarisKeyAndroid.client` does. A
     * failure surfaces at the next call, which starts the client itself.
     */
    public fun startInBackground() {
        scope.launch {
            try {
                start()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Never a crash from a background warm-up: the next call that needs the state loads
                // it, and reports the failure where the host can see it.
            }
        }
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
        // De-duplicated (SP-51): a call that arrives while a pass of the same kind runs shares it
        // (a forced call is not satisfied by an unforced pass). One pass at a time, never two.
        var shared: SyncFlight? = null
        val mine = SyncFlight(force)
        syncFlightLock.withLock {
            val running = syncFlight
            if (running != null && (running.force || !force)) shared = running else syncFlight = mine
        }
        shared?.let { return it.result.await() }
        try {
            val beforeLicense = core.etag(DocumentSlice.license)
            val beforeConfig = core.etag(DocumentSlice.config)
            val result = core.sync(force, reacquire) { report() }
            // The ETags say the CONTENT changed; the gate says what the device may do. A pass that
            // moved neither (a 401 that left the cache alone is the exception: it moves the gate).
            val changed = core.etag(DocumentSlice.license) != beforeLicense || core.etag(DocumentSlice.config) != beforeConfig
            if (result.applied && changed) config.publish()
            publishLicense()
            mine.result.complete(result)
            return result
        } catch (e: Throwable) {
            mine.result.completeExceptionally(e)
            throw e
        } finally {
            syncFlightLock.withLock { if (syncFlight === mine) syncFlight = null }
        }
    }

    private class SyncFlight(val force: Boolean) {
        val result = kotlinx.coroutines.CompletableDeferred<SyncResult>()
    }

    private val syncFlightLock = kotlinx.coroutines.sync.Mutex()
    @Volatile private var syncFlight: SyncFlight? = null

    /** The post-acquisition sync, forced so a stale ETag cannot 304 away the very first document. */
    private suspend fun syncAfterAcquisition() {
        tokenRejection.clear()
        core.sync(force = true, reacquire = reacquire) { report() }
        config.publish()
        publishLicense(force = true)
    }

    /**
     * §5's single re-acquire: `POST /<p>/license/token` for a licensed device, or the keyless
     * `POST /<p>/devices/register` (no bearer, the same request as `register()`) for a registered-
     * without-licence device or a product with License off. Null means the one attempt failed and
     * the hard-401 path applies.
     */
    private suspend fun reacquireToken(current: String, source: TokenSource?): Reacquired? =
        if (!tokenRejection.mayAsk(current)) null else when (chooseReacquireRoute(core.enabled(ServiceSlug.license), source)) {
            ReacquireRoute.devicesRegister ->
                (core.requestDeviceRegistration(registrationFingerprint()) as? RegisterResult.Ok)
                    ?.let { Reacquired(it.token, TokenSource.register) }
            ReacquireRoute.licenseToken -> {
                val answer = LicenseEndpoints.reacquireToken(core, current)
                // A 401 on /license/token is final for this token (SP-51): the licence is gone, and
                // asking again only hammers the Worker until a new credential arrives.
                if (answer is ActivationResult.Unauthorized) tokenRejection.reject(current)
                (answer as? ActivationResult.Ok)?.let { Reacquired(it.token, TokenSource.reacquire) }
            }
        }

    /**
     * Bounds the §5 re-acquire (SP-51): a token the Worker refused at `/license/token` is not asked
     * about again until a new credential arrives, and at most [MAX_PER_MINUTE] token requests go out
     * in any minute whatever the callers do.
     */
    private class TokenRejection(private val clock: () -> Long) {
        private val lock = Any()
        private var rejected: String? = null
        private val sent = ArrayDeque<Long>()

        fun mayAsk(token: String): Boolean = synchronized(lock) {
            if (rejected == token) return false
            val now = clock()
            while (sent.isNotEmpty() && now - sent.first() >= 60_000) sent.removeFirst()
            if (sent.size >= MAX_PER_MINUTE) return false
            sent.addLast(now)
            true
        }

        fun reject(token: String) = synchronized(lock) { rejected = token }

        fun clear() = synchronized(lock) { rejected = null }

        companion object {
            const val MAX_PER_MINUTE = 5
        }
    }

    private val tokenRejection = TokenRejection { System.currentTimeMillis() }

    /** The fingerprint a registration sends: collected when fingerprinting is enabled, none otherwise. */
    private suspend fun registrationFingerprint(): HardwareFingerprint? =
        if (fingerprintEnabled) withContext(Dispatchers.IO) { fingerprintSource.collect(product) } else null

    // ── Telemetry (§6) ───────────────────────────────────────────────────────────────────────
    /**
     * Post the device telemetry snapshot now: the values of the documents this client VERIFIED
     * (R4-05), this host's software facts and the capability list, allowlisted keys only.
     * `sync()` already reports after every pass that warrants it. Best-effort: false when no
     * credential is held, the server refused, or the network failed; never throws at the host.
     */
    public suspend fun report(): Boolean = withContext(Dispatchers.IO) { reportOnIo() }

    /** [report]'s body: the facts, the pending journal and the post are blocking work (SP-50). */
    private suspend fun reportOnIo(): Boolean {
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
    public suspend fun importBundle(jws: String): VerifiedBundle {
        val bundle = core.importBundle(jws)
        config.publish()
        publishLicense(force = true)
        return bundle
    }

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
    public suspend fun register(): RegisterResult {
        tokenRejection.clear()
        return core.registerDevice(registrationFingerprint())
    }

    public suspend fun deactivate() {
        license.deactivate()
    }

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
        var offline = false
        val roster = try {
            core.listDevices()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            offline = true
            emptyList()
        }
        if (roster.isEmpty()) return listOf(current.copy(offline = offline))
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
            deactivate()
            return
        }
        core.deauthorizeDevice(deviceId)
    }

    /** Where the token store keeps the token; null when the store does not report. */
    public suspend fun storeStatus(): StoreStatus? = core.storeStatus()

    // ── Lifecycle ────────────────────────────────────────────────────────────────────────────
    /** Start polling on `refreshIntervalSeconds` (no-op when unset, already running or local-only). */
    @Synchronized
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
    @Synchronized
    public fun close() {
        refreshJob?.cancel()
        refreshJob = null
        // SP-51: the client's own scope (event fan-out, the refresh loop, the launch confirmation) and
        // the HTTP stack's threads go too, so a JVM `main` can exit.
        scope.cancel()
        core.close()
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
