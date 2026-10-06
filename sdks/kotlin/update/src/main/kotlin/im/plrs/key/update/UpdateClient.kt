// The update sub-client (P6-08): the version check over Release's truth store (D-05, §R1) and wire
// v4's signed update decision (plans/P3-01.md §2.5–§2.8), a port of Swift's `UpdateClient.swift`.
//
//   `check()`         `GET /<p>/update/version` → the newest build on this channel, and whether the
//                     running version is behind it (Core's `Semver.compare`, as the build gate).
//   `decide()`        wire v4: the signed channel feed (`pkey-feed+jws`), the release record it pins
//                     (`pkey-release+jws`, fetched by hash), and the decision over both; with a
//                     content host (the packs facet), the content decision too (plans/P4-13.md).
//   `channelFeed()`   the verified feed `decide()` would use, without the record.
//   `releaseRecord()` one release record by hash, verified against the PINNED release keys.
//   `buildUrl()`      the route an install downloads a build from (`distribution/builds`).
//   `install()`       hand a decision to the platform's installer (the [InstallDriver] port; Play
//                     In-App Updates and PackageInstaller are P6-12's; a JVM desktop has none).
//
// WHAT THE v4 CALLS TRUST: feeds verify against the EFFECTIVE product trust set (pins ∪ verified
// manifest keys); records against `UpdateClientOptions.pinnedReleaseKeys` only, never merged with
// the product trust set (a key that is also a trust pin raises `invalid-options` at construction);
// the clock is Core's EFFECTIVE clock; the cache holds signed JWSs only, re-verified before use.
// The order, the floors, the fallback and the error map are :core's `runUpdateCheck`; this file is
// transport, storage (Core's read-modify-write of the `feeds` and `releaseRecords` slices) and options.

package im.plrs.key.update

import im.plrs.key.core.ARCH_VALUES
import im.plrs.key.core.BINARY_METHOD_VALUES
import im.plrs.key.core.Base64Url
import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.CoreContext
import im.plrs.key.core.DELEGATED_KID_PATTERN
import im.plrs.key.core.DetectedOutlet
import im.plrs.key.core.DetectionStamp
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.FetchOutcome
import im.plrs.key.core.FileStore
import im.plrs.key.core.HostOutlet
import im.plrs.key.core.InstalledBuild
import im.plrs.key.core.JsonText
import im.plrs.key.core.MAX_RECORD_JWS_BYTES
import im.plrs.key.core.OUTLET_KIND_VALUES
import im.plrs.key.core.OUTLET_SUBKIND_VALUES
import im.plrs.key.core.OUTLET_UNKNOWN
import im.plrs.key.core.OutletStamp
import im.plrs.key.core.PLATFORM_VALUES
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.ReleaseRecordPin
import im.plrs.key.core.ReleaseRecordStep
import im.plrs.key.core.ResolvedOutlet
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.Semver
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.StagedUpdate
import im.plrs.key.core.TrustSet
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateCheckError
import im.plrs.key.core.UpdateCheckInput
import im.plrs.key.core.UpdateCheckOutcome
import im.plrs.key.core.UpdateContentHost
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.UpdateOutlet
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.ChannelFeedDoc
import im.plrs.key.core.detectOutlet
import im.plrs.key.core.expandTemplate
import im.plrs.key.core.feedTarget
import im.plrs.key.core.isValidHostOutlet
import im.plrs.key.core.objectValue
import im.plrs.key.core.packMatch
import im.plrs.key.core.record
import im.plrs.key.core.reloadFeeds
import im.plrs.key.core.resolveUpdateOutlet
import im.plrs.key.core.runUpdateCheck
import im.plrs.key.core.sameOrigin
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyReleaseRecord
import im.plrs.key.core.wireErrorCode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import java.io.File

/** Reads this process's outlet signals (`outlet-matrix.json#/signals`); Android's readers are P6-12's. */
public fun interface OutletSignalReader {
    public suspend fun read(outletIds: Map<String, String>): Map<String, JsonElement>
}

/** A JVM desktop process observes no install-source signal: detection falls to the stamp. */
public object NoOutletSignals : OutletSignalReader {
    override suspend fun read(outletIds: Map<String, String>): Map<String, JsonElement> = emptyMap()
}

/**
 * Wire v4 update inputs. The installed VERSION is `CoreOptions.version`; everything else the decision
 * needs about this install is here, validated at construction (`invalid-options`).
 */
public data class UpdateClientOptions @JvmOverloads constructor(
    /** `kid` → raw 32-byte Ed25519 release key, base64url: the ONLY keys a release record verifies against. */
    val pinnedReleaseKeys: TrustSet = emptyMap(),
    /** Where this install came from; wins over [stamp] and [detected]. */
    val outlet: HostOutlet? = null,
    /** The build stamp's outlet fields (P1-11), with the product's `outletIds`. */
    val stamp: OutletStamp? = null,
    /** An outlet detection result the host computed itself. */
    val detected: DetectedOutlet? = null,
    /** Detect the outlet when neither [outlet] nor [detected] is given (default true). */
    val detect: Boolean = true,
    /** What detection reads; [NoOutletSignals] by default (Android's readers are P6-12's). */
    val signals: OutletSignalReader = NoOutletSignals,
    /** The installed build's build number (informational in v4). */
    val buildNumber: String? = null,
    /** The installed build's format (`apk`, `aab`, `zip`, …); null is any format. */
    val format: String? = null,
    /** What this host can do with a `binary` decision. Default `["download"]`. */
    val methods: List<String> = listOf(BinaryMethod.download),
    /** The executable's version when it differs from `CoreOptions.version`. */
    val binaryVersion: String? = null,
    /** `godot-<major>.<minor>` for a host that runs Godot code packs; null otherwise. */
    val engine: String? = null,
    /** The install's `Platform` value. Default: this runtime's (`android`, `macos`, `linux`, `windows`). */
    val platform: String? = null,
    /** The device's `Arch` value. Default: this runtime's. */
    val arch: String? = null,
    /**
     * The platform installer. Default [JvmInstallDriver], the marker [UpdateClient.install] replaces
     * with the JVM desktop driver (UK-40); Android's are P6-12's.
     */
    val installDriver: InstallDriver = JvmInstallDriver,
)

/** The app-updater feeds [UpdateClient.feedUrl] expands (discovery's `update.endpoints` keys). */
public object FeedKind {
    public const val appcast: String = "appcast"
    public const val winsparkle: String = "winsparkle"
    public const val velopack: String = "velopack"
    public const val appInstaller: String = "appInstaller"
    public const val zsync: String = "zsync"
}

/** `channelFeed()`'s answer: the verified feed `decide()` would decide from. */
public data class FeedCheck(
    /** The canonical channel: the feed's own `channel` claim. */
    val channel: String,
    val feed: ChannelFeedDoc,
    val source: UpdateCheck.FeedSource,
    val errors: List<UpdateCheckError>,
)

/** `releaseRecord()`'s answer. */
public data class ReleaseRecordCheck(
    val sha256: String,
    val record: ReleaseRecordDoc,
    val source: Source,
    /** True when a committed feed's target for this platform pins the hash (then cross-checked and cached). */
    val pinned: Boolean,
) {
    public enum class Source(public val wire: String) { network("network"), cache("cache") }
}

/** `check()`'s answer. */
public data class VersionCheck(
    /** The newest version on the requested channel. */
    val version: String,
    val tag: String,
    val url: String,
    /** Whether the host APPLICATION's own version is older than [version]. */
    val updateAvailable: Boolean,
)

private class ConfiguredUpdate(val releaseKeys: TrustSet, val outlet: ResolvedOutlet?, val options: UpdateClientOptions)

private fun invalidOptions(message: String) = PolarisException(ErrorCode.invalidOptions, message)

/** Validate [UpdateClientOptions] against the trust pins (plans/P3-01.md §2.6, §2.8). */
private fun configure(opts: UpdateClientOptions, pinnedTrust: TrustSet): ConfiguredUpdate {
    // plans/P4-19.md §2.2: a delegated kid is never a pinned release key.
    if (opts.pinnedReleaseKeys.keys.any { packMatch(DELEGATED_KID_PATTERN, it) }) {
        throw invalidOptions("pinnedReleaseKeys names a pkd1- kid: a delegated content key is reached only through a delegation, never pinned.")
    }
    val pins = pinnedTrust.values.mapNotNull { Base64Url.decode(it) }.filter { it.size == 32 }
    for (key in opts.pinnedReleaseKeys.values) {
        val raw = Base64Url.decode(key)
        if (raw != null && raw.size == 32 && pins.any { it.contentEquals(raw) }) {
            throw invalidOptions("A pinned release key is also a trust pin; a release key is never a product key.")
        }
    }
    opts.outlet?.let { if (!isValidHostOutlet(it)) throw invalidOptions("update outlet is not an outlet kind or {id, kind, subkind?}.") }
    opts.detected?.let { d ->
        if (!(d.kind in OUTLET_KIND_VALUES || d.kind == OUTLET_UNKNOWN) || (d.subkind != null && d.subkind !in OUTLET_SUBKIND_VALUES)) {
            throw invalidOptions("update detected is not an outlet detection result.")
        }
    }
    if (!opts.methods.all { it in BINARY_METHOD_VALUES }) throw invalidOptions("update methods must be a subset of ${BINARY_METHOD_VALUES.joinToString(", ")}.")
    opts.platform?.let { if (it !in PLATFORM_VALUES) throw invalidOptions("update platform must be one of ${PLATFORM_VALUES.joinToString(", ")}.") }
    opts.arch?.let { if (it !in ARCH_VALUES) throw invalidOptions("update arch must be one of ${ARCH_VALUES.joinToString(", ")}.") }
    val outlet = resolveUpdateOutlet(opts.outlet, opts.stamp, opts.detected) ?: throw invalidOptions("update outlet is not a valid outlet.")
    // §2.9: detection runs at every launch, at the first decision.
    val detects = opts.outlet == null && opts.detected == null && opts.detect
    return ConfiguredUpdate(opts.pinnedReleaseKeys, if (detects) null else outlet, opts)
}

/** A code `runUpdateCheck` never produces: `channelFeed()` withholds the record fetch with it. */
private const val RECORD_WITHHELD = "record-withheld"

/** The update sub-client. */
public class UpdateClient private constructor(
    private val core: CoreContext,
    private val configured: ConfiguredUpdate?,
    /** The packs facet, when the host has one (the umbrella client wires it). */
    private val content: UpdateContentHost?,
) {
    /** A client for `check()` only: `decide()` and `releaseRecord()` raise `not-configured`. */
    public constructor(core: CoreContext) : this(core, null, null)

    /**
     * A client for wire v4's signed decision too. Throws `invalid-options` for an outlet outside the
     * vocabularies, a method outside `BINARY_METHOD_VALUES`, a platform or arch outside the enums, or
     * a pinned release key whose raw bytes are also a trust pin.
     */
    public constructor(core: CoreContext, options: UpdateClientOptions, content: UpdateContentHost? = null) :
        this(core, configure(options, core.pinnedTrust), content)

    private val serial = Mutex()
    private val offerFlow = kotlinx.coroutines.flow.MutableSharedFlow<UpdateCheck>(replay = 1, extraBufferCapacity = 4)

    /** Every decision that offers a newer app build (`code-ready`, `binary`, `store`, `platform`); replays the last. */
    public val offers: kotlinx.coroutines.flow.SharedFlow<UpdateCheck> = offerFlow
    private var detection: CompletableDeferred<Pair<ResolvedOutlet, DetectedOutlet?>>? = null
    private val detectionLock = Mutex()

    /** The outlet `decide()` uses, detecting it first when the host named none; null without update options. */
    public suspend fun outlet(): ResolvedOutlet? = configured?.let { resolvedOutlet(it).first }

    /** The detection result (in-process, or the host's `detected` as given); null when none applies. */
    public suspend fun detected(): DetectedOutlet? = configured?.let { resolvedOutlet(it).second }

    private suspend fun resolvedOutlet(c: ConfiguredUpdate): Pair<ResolvedOutlet, DetectedOutlet?> {
        c.outlet?.let { noteOutlet(it); return it to c.options.detected }
        val d = detectionLock.withLock {
            detection ?: CompletableDeferred<Pair<ResolvedOutlet, DetectedOutlet?>>().also { detection = it }.also { deferred ->
                val options = c.options
                val stamp = options.stamp?.let { s ->
                    val kind = s.outletKind ?: s.outlet
                    if (kind == null) null else DetectionStamp(kind, s.outletSubkind, s.outletIds)
                }
                val signals = try {
                    options.signals.read(stamp?.outletIds ?: emptyMap())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    emptyMap()
                }
                val detected = detectOutlet(stamp, signals)
                val outlet = resolveUpdateOutlet(null, options.stamp, detected) ?: ResolvedOutlet(null, OUTLET_UNKNOWN, null)
                deferred.complete(outlet to detected)
            }
        }
        return d.await().also { noteOutlet(it.first) }
    }

    /** Every journaled update event names this install's outlet (its id, else its kind) and channel. */
    private fun noteOutlet(outlet: ResolvedOutlet) {
        val reported = outlet.id ?: outlet.kind.takeIf { it != OUTLET_UNKNOWN }
        core.updateEvents.context = { reported to core.channel }
    }

    /** The outlet the device report names: its id, else its kind; null when unknown or without update options. */
    public suspend fun reportedOutlet(): String? = outlet()?.let { it.id ?: it.kind.takeIf { k -> k != OUTLET_UNKNOWN } }

    /**
     * `GET /<p>/update/version` — the newest build, and whether we are behind it. Refuses with
     * `service-unavailable` when the product does not run Update, before a socket is opened.
     */
    public suspend fun check(channel: String? = null): VersionCheck {
        core.requireService(ServiceSlug.update, Feature.updateCheck)
        val url = core.endpoints.url("update/version") + (channel?.let { "?channel=" + im.plrs.key.core.encodeUriComponent(it) } ?: "")
        val headers = LinkedHashMap<String, String>()
        core.token()?.let { headers["authorization"] = "Bearer $it" }
        val response = core.request(url, headers = headers)
        if (response.status == 403) {
            throw PolarisException(wireErrorCode(response.body) ?: "forbidden", "This build is not entitled to that update channel.")
        }
        if (!response.isOk) throw PolarisException("not_found", "update/version failed with status ${response.status}.")
        val o = JsonText.parseOrNull(response.text).objectValue ?: throw PolarisException("bad_request", "malformed update/version response")
        val version = o["version"].stringValue ?: throw PolarisException("bad_request", "malformed update/version response")
        val tag = o["tag"].stringValue ?: throw PolarisException("bad_request", "malformed update/version response")
        val u = o["url"].stringValue ?: throw PolarisException("bad_request", "malformed update/version response")
        return VersionCheck(version, tag, u, Semver.compare(core.version, version) < 0)
    }

    // ── Wire v4 ─────────────────────────────────────────────────────────────────────────────

    /**
     * The signed update decision (plans/P3-01.md §2.5 steps 1–18): fetch the channel feed, verify it
     * against the effective product trust set and the channel's `seq` floor, commit it, fetch the
     * release record its target pins for this platform (hash before signature, pinned release keys
     * only), and decide. After a refusal it decides from the committed feed, reporting the refusal in
     * `errors`. Throws [PolarisException] only when it has nothing to decide from (`feed-rejected`
     * with the step as `detail`, `feed-rollback`, `network-error` or the Worker's wire code), and for
     * `not-configured`, `service-unavailable` and `local-only`. With a content host, the content
     * decision too (plans/P4-13.md §2.5 steps 10–14).
     */
    public suspend fun decide(channel: String? = null, staged: StagedUpdate? = null, skipVersion: String? = null): UpdateCheck =
        serial.withLock { decideNow(channel, staged, skipVersion) }

    /** The verified feed `decide()` would decide from (§2.5 steps 1–10), without the record. */
    public suspend fun channelFeed(channel: String? = null): FeedCheck = serial.withLock { channelFeedNow(channel) }

    /** One release record by its lowercase hex SHA-256 (§2.5 steps 11–16), from the cache or the network. */
    public suspend fun releaseRecord(hash: String): ReleaseRecordCheck = serial.withLock { releaseRecordNow(hash) }

    /**
     * A build's download URL (plans/P3-01.md §2.4 "Bytes"): discovery's `distribution.endpoints.builds`,
     * else `release.endpoints.builds`, with `{selector}` and `{buildId}`. Null when discovery has not
     * been loaded or names neither template. Verify the bytes against the record before staging.
     */
    public suspend fun buildUrl(version: String, buildId: String): String? {
        val doc = core.discoveryDocument() ?: return null
        val template = doc.services[ServiceSlug.distribution]?.endpoints?.get("builds") ?: doc.services[ServiceSlug.release]?.endpoints?.get("builds") ?: return null
        return expandTemplate(template, core.endpoints.baseUrl, mapOf("selector" to version, "buildId" to buildId))
    }

    /**
     * An app-updater feed URL (notes/SDK-PARITY-PASS.md §3.7), expanded from discovery's
     * `update.endpoints` template for [kind]: `appcast` (Sparkle; `channelAppcast` when [channel] is
     * given), `winsparkle`, `velopack` (needs [velopackChannel], e.g. `win-x64`), `appInstaller`,
     * `zsync` (needs [buildId]). [channel] defaults to this client's. Loads discovery first when this
     * session has not. Throws [UnsupportedException] (`product`) when the Worker advertises no such
     * template, or when a needed value is missing.
     */
    public suspend fun feedUrl(kind: String, channel: String? = null, velopackChannel: String? = null, buildId: String? = null): String {
        core.requireService(ServiceSlug.update, Feature.updateFeed)
        if (core.discoveryDocument() == null && !core.localOnly) core.discover()
        val key = if (kind == FeedKind.appcast && channel != null) "channelAppcast" else kind
        fun none(why: String): Nothing = throw im.plrs.key.core.UnsupportedException(
            im.plrs.key.core.Unsupported(Feature.updateFeed, im.plrs.key.core.UnsupportedReason.product, why),
        )
        val template = core.discoveryDocument()?.services?.get(ServiceSlug.update)?.endpoints?.get(key)
            ?: none("this Worker advertises no $key feed for the product")
        val values = linkedMapOf("channel" to (channel ?: core.channel))
        if ("{velopackChannel}" in template) values["velopackChannel"] = velopackChannel ?: none("the velopack feed needs the channel the app was packed with")
        if ("{buildId}" in template) values["buildId"] = buildId ?: none("the zsync feed needs the AppImage build id")
        return expandTemplate(template, core.endpoints.baseUrl, values) ?: none("the $key template does not expand")
    }

    /** Sparkle's appcast URL (`feedUrl(appcast)`). */
    public suspend fun appcastUrl(channel: String? = null): String = feedUrl(FeedKind.appcast, channel)

    /**
     * Hand a decision to the platform's installer ([UpdateClientOptions.installDriver]). Left at the
     * default on a JVM desktop, that is [desktopDriver] (UK-40): the installer for this OS and arch,
     * downloaded, verified against the signed record and opened. On Android the :android module
     * replaces the default with the flavour's driver.
     */
    public suspend fun install(check: UpdateCheck): InstallResult {
        val driver = installDriver
        val result = driver.install(check)
        // §3.13: the desktop driver (UK-40) journals nothing itself; the Android drivers do.
        if (driver is DesktopInstallDriver && result == InstallResult.Started) {
            check.releaseId?.let { core.updateEvents.record(UpdateEvent.updateApplied, it, fromRelease = core.version) }
        }
        return result
    }

    /**
     * The install driver [install] uses: [UpdateClientOptions.installDriver]; left at the default
     * ([JvmInstallDriver]) on a JVM desktop, [desktopDriver].
     */
    public val installDriver: InstallDriver get() {
        val driver = configured?.options?.installDriver ?: JvmInstallDriver
        return if (driver === JvmInstallDriver && !RuntimeFamily.isAndroid) desktopDriver else driver
    }

    /**
     * The JVM desktop driver [install] uses by default: records from [releaseRecord], bytes from
     * [buildUrl] through [OkHttpArtifactFetch], installers under
     * `<FileStore.defaultDirectory(product)>/updates/installer`, opened by [SystemInstallerOpener].
     * PolarisKeyDesktop builds its own over the app's data directory.
     */
    public val desktopDriver: DesktopInstallDriver by lazy {
        DesktopInstallDriver(
            records = { sha -> releaseRecord(sha).record },
            buildUrl = { version, build -> buildUrl(version, build) },
            fetch = OkHttpArtifactFetch(core),
            dir = File(FileStore.defaultDirectory(core.product), "updates/installer"),
        )
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    /** §3.13: a decision that offers a newer app build journals `update_offered` once per release. */
    /** The release is named by its record's tag when it has one, else its version (the Worker's releaseId). */
    private fun noteOffer(check: UpdateCheck) {
        val release = check.releaseId ?: return
        core.updateEvents.recordOnce(UpdateEvent.updateOffered, release, fromRelease = core.version)
        offerFlow.tryEmit(check)
    }

    private fun requireKeys(): ConfiguredUpdate {
        val c = configured
        if (c == null || c.releaseKeys.isEmpty()) throw PolarisException(ErrorCode.notConfigured, "Update decisions need UpdateClientOptions.pinnedReleaseKeys.")
        return c
    }

    private val platformValue: String? get() = configured?.options?.platform ?: RuntimeFamily.platformHeader

    private fun installed(): InstalledBuild {
        val opts = configured?.options
        val platform = platformValue
        val arch = opts?.arch ?: RuntimeFamily.archHeader
        if (platform == null || arch == null) {
            throw PolarisException(ErrorCode.notConfigured, "This host's platform or arch has no canonical value; set UpdateClientOptions.platform and arch.")
        }
        return InstalledBuild(core.version, opts?.binaryVersion, opts?.buildNumber, platform, arch, opts?.format, opts?.engine)
    }

    /**
     * §2.5 step 1: the feed and record templates from discovery, loading discovery first when this
     * session has not. A loaded document that lacks a needed one is refused as `service-unavailable`
     * before dialling. When discovery cannot be reached, null: the fetches then fail as transport
     * failures and the decision comes from the committed feed.
     */
    private suspend fun endpoints(feed: Boolean, record: Boolean): Pair<String, String>? {
        var doc = core.discoveryDocument()
        if (doc == null) {
            if (core.localOnly) throw PolarisException(ErrorCode.localOnly, "This client is in local-only mode; network calls are refused.")
            core.discover()
            doc = core.discoveryDocument()
        }
        if (doc == null) return null
        val feedTemplate = doc.services[ServiceSlug.update]?.endpoints?.get("feed")
        val recordTemplate = doc.services[ServiceSlug.release]?.endpoints?.get("record")
        if ((feed && feedTemplate == null) || (record && recordTemplate == null)) {
            throw PolarisException(ErrorCode.serviceUnavailable, "This Worker serves no signed update feed (wire v4); use check().")
        }
        return (feedTemplate ?: "") to (recordTemplate ?: "")
    }

    /**
     * One `application/jose` GET. Never throws: a transport failure or a non-2xx answer is the
     * Worker's wire code when its body names one, else `network-error`. The device bearer goes only
     * to the control plane's own origin.
     */
    private suspend fun getJose(url: String?, maxBytes: Int? = null): FetchOutcome {
        if (url == null) return FetchOutcome.Failed(ErrorCode.networkError)
        val headers = linkedMapOf("accept" to "application/jose")
        core.token()?.let { if (sameOrigin(url, core.endpoints.baseUrl)) headers["authorization"] = "Bearer $it" }
        return try {
            val response = core.request(url, headers = headers, maxBodyBytes = maxBytes?.let { it + 1 })
            if (!response.isOk) return FetchOutcome.Failed(wireErrorCode(response.body) ?: ErrorCode.networkError)
            // Bounded again here whatever the transport did: a record body over the bound is refused at
            // step 12 from this prefix, without hashing.
            val body = if (maxBytes != null) response.body.copyOf(minOf(response.body.size, maxBytes + 1)) else response.body
            FetchOutcome.Ok(body.toString(Charsets.UTF_8))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            FetchOutcome.Failed(ErrorCode.networkError)
        }
    }

    private fun feedUrl(template: String?, channel: String, platform: String): String? {
        val t = template ?: return null
        val url = expandTemplate(t, core.endpoints.baseUrl, mapOf("channel" to channel)) ?: return null
        return url + (if (url.contains('?')) "&" else "?") + "platform=" + im.plrs.key.core.encodeUriComponent(platform)
    }

    private fun recordUrl(template: String?, sha256: String): String? = template?.let { expandTemplate(it, core.endpoints.baseUrl, mapOf("sha256" to sha256)) }

    private fun raise(error: UpdateCheckError): PolarisException =
        PolarisException(error.code, error.detail?.let { "update: ${error.code} ($it)" } ?: "update: ${error.code}", error.detail)

    private suspend fun decideNow(channel: String?, staged: StagedUpdate?, skipVersion: String?): UpdateCheck {
        val c = requireKeys()
        core.requireService(ServiceSlug.update, Feature.updateDecide)
        val installed = installed()
        val outlet = resolvedOutlet(c).first
        val ep = endpoints(feed = true, record = true)
        val slices = core.updateSlices()
        val deviceId = core.deviceId()
        // plans/P4-13.md §2.5: a host with a content stamp runs the content decision. A pack facet
        // that cannot start (an unreadable stamp) decides without it.
        val contentInput = try {
            content?.contentInput()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val input = UpdateCheckInput(
            channel = channel ?: core.channel,
            expectedAud = core.product,
            trust = core.trust(),
            releaseKeys = c.releaseKeys,
            now = core.now(),
            installId = deviceId.ifEmpty { null },
            installed = installed,
            outlet = outlet.outlet,
            subkind = outlet.subkind,
            staged = staged,
            skipVersion = skipVersion,
            methods = c.options.methods,
            feeds = slices.feeds,
            releaseRecords = slices.releaseRecords,
            content = contentInput,
        )
        val platform = installed.platform
        val outcome = runUpdateCheck(
            input,
            fetchFeed = { requested -> getJose(feedUrl(ep?.first, requested, platform)) },
            fetchRecord = { sha256 -> getJose(recordUrl(ep?.second, sha256), MAX_RECORD_JWS_BYTES) },
        )
        return when (outcome) {
            is UpdateCheckOutcome.Failed -> throw raise(outcome.error)
            is UpdateCheckOutcome.Ok -> {
                val run = outcome.run
                core.commitUpdateSlices(run.feeds, run.releaseRecords)
                content?.noteFeedDeltas(run.feed.content.deltas)
                run.revocations?.let { content?.recordRevocations(it) }
                noteOffer(run.check)
                run.check
            }
        }
    }

    private suspend fun channelFeedNow(channel: String?): FeedCheck {
        core.requireService(ServiceSlug.update, Feature.updateFeed)
        val installed = installed()
        val ep = endpoints(feed = true, record = false)
        val slices = core.updateSlices()
        // The same steps as `decide()`, by the same function, with the record fetch withheld.
        val input = UpdateCheckInput(
            channel = channel ?: core.channel, expectedAud = core.product, trust = core.trust(),
            releaseKeys = configured?.releaseKeys ?: emptyMap(), now = core.now(), installId = null, installed = installed,
            outlet = UpdateOutlet(null, OUTLET_UNKNOWN), subkind = null, methods = emptyList(), feeds = slices.feeds, releaseRecords = emptyMap(),
        )
        val platform = installed.platform
        val outcome = runUpdateCheck(
            input,
            fetchFeed = { requested -> getJose(feedUrl(ep?.first, requested, platform)) },
            fetchRecord = { FetchOutcome.Failed(RECORD_WITHHELD) },
        )
        return when (outcome) {
            is UpdateCheckOutcome.Failed -> throw raise(outcome.error)
            is UpdateCheckOutcome.Ok -> {
                val run = outcome.run
                core.commitUpdateSlices(feeds = run.feeds)
                content?.noteFeedDeltas(run.feed.content.deltas)
                FeedCheck(run.check.channel, run.feed, run.check.feed, run.check.errors.filter { it.code != RECORD_WITHHELD })
            }
        }
    }

    private suspend fun releaseRecordNow(sha256: String): ReleaseRecordCheck {
        val c = requireKeys()
        core.requireService(ServiceSlug.release, Feature.releaseRecord)
        val installed = installed()
        val ep = endpoints(feed = false, record = true)
        val slices = core.updateSlices()
        val trust = core.trust()

        // The pin, from a committed feed that still verifies (the reload path).
        val committed = reloadFeeds(slices.feeds, trust, core.product, installed.platform)
        var pin: ReleaseRecordPin? = null
        for (cf in committed.feeds.values) {
            val t = feedTarget(cf.feed.app.targets, installed.platform)
            if (t != null && t.release.sha256 == sha256) {
                pin = ReleaseRecordPin(deliverable = "app", version = t.release.version, seq = t.release.seq)
                break
            }
        }
        val opts = VerifyReleaseRecordOptions(c.releaseKeys, trust, core.product, sha256, pin)
        slices.releaseRecords[sha256]?.let { cached ->
            verifyReleaseRecord(cached, opts).record?.let { return ReleaseRecordCheck(sha256, it, ReleaseRecordCheck.Source.cache, pin != null) }
        }
        return when (val fetched = getJose(recordUrl(ep?.second, sha256), MAX_RECORD_JWS_BYTES)) {
            is FetchOutcome.Failed -> throw raise(UpdateCheckError(fetched.code))
            is FetchOutcome.Ok -> when (val r = verifyReleaseRecord(fetched.body, opts)) {
                is VerifyReleaseRecordResult.Refused ->
                    throw if (r.step == ReleaseRecordStep.crossCheck) raise(UpdateCheckError(ErrorCode.recordMismatch)) else raise(UpdateCheckError(ErrorCode.recordRejected, r.step.wire))
                // An app record never takes the delegated path: no delegation is passed here.
                is VerifyReleaseRecordResult.Delegated -> throw raise(UpdateCheckError(ErrorCode.recordRejected, "jws"))
                is VerifyReleaseRecordResult.Ok -> {
                    if (pin != null) core.commitUpdateSlices(releaseRecords = slices.releaseRecords + (sha256 to fetched.body))
                    ReleaseRecordCheck(sha256, r.record, ReleaseRecordCheck.Source.network, pin != null)
                }
            }
        }
    }
}
