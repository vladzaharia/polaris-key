// The one call an Android app makes (P6-12): PolarisKeyClient with every Android edge filled in, so
// an app goes from the client to a verified update and a mounted pack with SDK modules only.
//
//   core.store            AndroidKeystoreStore (unless CoreOptions.store is set)
//   devices.fingerprint   AndroidFingerprintSource (unless LicenseClientOptions.fingerprintSource is set)
//   devices.facts         AndroidDeviceFactsSource (unless PolarisKeyClientOptions.factsSource is set)
//   outlet.detect         AndroidOutletSignalReader (unless UpdateClientOptions.signals is set)
//   update.driver         this flavour's driver (unless UpdateClientOptions.installDriver is set), with
//                         `platform: android`, the flavour's format and binary methods
//   devices.attest       PlayIntegrityAttestation (unless PolarisKeyClientOptions.attestation is set)
//   packs.transport.play  the carried packs Play holds now join PacksOptions.embedded (re-read at
//                         every client construction, i.e. every launch); the pack store defaults to
//                         `noBackupFilesDir/pkey/<product>/packs`
//
// A pack Play delivers during this session (PlayPackTransport.ensure) mounts at the pack facet's next
// start: :packs loads its baselines once per process (P6-08's PackEngine.load contract).

package im.plrs.key.android

import android.app.Activity
import android.content.Context
import android.os.Build
import im.plrs.key.core.AttestationProviders
import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.Platform
import im.plrs.key.core.Store
import im.plrs.key.packs.PacksOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.update.JvmInstallDriver
import im.plrs.key.update.NoOutletSignals
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** The Android-only inputs to [PolarisKeyAndroid.client]. */
public data class AndroidOptions @JvmOverloads constructor(
    /** The host's current activity: In-App Updates' flows and Play's pack confirmation start from it. */
    val activity: () -> Activity? = { null },
    /** The pack ids this build ships as Play asset packs (fast-follow or on-demand). */
    val playPacks: List<String> = emptyList(),
    /** Asked before Play's cellular-download confirmation (the game's own size disclosure); null: yes. */
    val confirmPack: (suspend (packId: String, state: PlayPackState) -> Boolean)? = null,
    /** When Play's own priority and staleness make an update urgent (play build). */
    val playUpdates: PlayUpdatePolicy = PlayUpdatePolicy(),
    /** A store an earlier build used (a FileStore); its token and device id move into the Keystore. */
    val legacyStore: Store? = null,
    /**
     * The Play Integrity cloud project number `devices.attest()` uses when the Worker's challenge
     * names none (the operator usually configures it there). Digits only.
     */
    val playCloudProjectNumber: String? = null,
)

/** When Play's own signals make an update urgent (play build; PlayInstallDriver); null turns a signal off. */
public data class PlayUpdatePolicy(
    /** Play's in-app update priority (0–5) at or above which the update is urgent. */
    val immediatePriority: Int? = null,
    /** Days Play has offered the update (clientVersionStalenessDays) after which it is urgent. */
    val immediateAfterDays: Int? = null,
)

/** The Android entry point. */
public object PolarisKeyAndroid {
    /** `play` or `direct`: this build's flavour. */
    public val flavor: String get() = FlavorAndroid.FLAVOR

    /** This build's Play Asset Delivery transport for [android]'s packs. */
    public fun playPacks(context: Context, android: AndroidOptions = AndroidOptions()): PlayPackTransport =
        PlayPackTransport.create(context.applicationContext, android.playPacks, android.activity, android.confirmPack)

    /** [options] with every Android edge the host left unset filled in; see the file comment. */
    public fun client(context: Context, options: PolarisKeyClientOptions, android: AndroidOptions = AndroidOptions()): PolarisKeyClient {
        val ctx = context.applicationContext
        val product = options.core.productSlug
        val self = AtomicReference<PolarisKeyClient>()
        fun client(): PolarisKeyClient = self.get() ?: error("the client is still being constructed")

        val core = options.core.copy(store = options.core.store ?: AndroidKeystoreStore(ctx, product, android.legacyStore))
        val license = options.license.copy(fingerprintSource = options.license.fingerprintSource ?: AndroidFingerprintSource(ctx, product))
        val update = options.update?.let { u ->
            u.copy(
                signals = if (u.signals === NoOutletSignals) AndroidOutletSignalReader(ctx) else u.signals,
                installDriver = if (u.installDriver === JvmInstallDriver) {
                    FlavorAndroid.installDriver(
                        ctx, product, android.activity,
                        records = { sha -> client().update.releaseRecord(sha).record },
                        buildUrl = { version, build -> client().update.buildUrl(version, build) },
                        download = { OkHttpBuildDownload(client().core) },
                        play = android.playUpdates,
                        events = { self.get()?.core?.updateEvents },
                        runningVersion = options.core.version,
                    )
                } else {
                    u.installDriver
                },
                platform = u.platform ?: Platform.android,
                format = u.format ?: FlavorAndroid.FORMAT,
                methods = if (u.methods == DEFAULT_METHODS) FlavorAndroid.methods else u.methods,
            )
        }
        val p = options.packs
        val packs = PacksOptions(
            contentStamp = p.contentStamp,
            embedded = p.embedded + playPacks(ctx, android).installed(),
            axes = p.axes,
            engine = p.engine,
            memBudget = p.memBudget,
            // java.nio.file arrives on API 26; below it the host passes a directory itself.
            dir = p.dir ?: if (Build.VERSION.SDK_INT >= 26) File(ctx.noBackupFilesDir, "pkey/$product/packs").toPath() else null,
            handlers = p.handlers,
            objectTransport = p.objectTransport,
        )
        // devices.attest (SP-K04): Play Integrity, unless the host brought its own provider. Installed
        // process-wide too, so supports(devices.attest) answers `outlet` on a build that cannot attest.
        val attestation = options.attestation ?: PlayIntegrityAttestation.create(ctx, android.playCloudProjectNumber)
        if (options.attestation == null) AttestationProviders.installed = attestation
        val built = PolarisKeyClient(
            options.copy(
                attestation = attestation,
                core = core,
                license = license,
                factsSource = options.factsSource ?: AndroidDeviceFactsSource(ctx),
                update = update,
                packs = packs,
            ),
        )
        self.set(built)
        return built
    }

    /** UpdateClientOptions' default methods, which the flavour's replace. */
    private val DEFAULT_METHODS = listOf(BinaryMethod.download)
}
