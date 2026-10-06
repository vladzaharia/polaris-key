// The direct flavour's half of :android (P6-12): the verified PackageInstaller self-update as the
// install driver; Play Asset Delivery is the typed `outlet` N/A (this build carries no Play Core).

package im.plrs.key.android

import android.app.Activity
import android.content.Context
import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.Feature
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.UpdateEventJournal
import im.plrs.key.packs.EmbeddedPack
import im.plrs.key.update.InstallDriver
import java.io.File

internal object FlavorAndroid {
    const val FLAVOR: String = "direct"

    const val FORMAT: String = "apk"

    /** A direct build installs `binary {method: native}` itself, and can still offer the link. */
    val methods: List<String> = listOf(BinaryMethod.native, BinaryMethod.download)

    @Suppress("UNUSED_PARAMETER")
    fun playPacks(
        context: Context,
        packs: List<String>,
        activity: () -> Activity?,
        confirm: (suspend (String, PlayPackState) -> Boolean)?,
    ): PlayPackTransport = UnsupportedPlayPacks(packs)

    @Suppress("UNUSED_PARAMETER")
    fun installDriver(
        context: Context,
        productSlug: String,
        activity: () -> Activity?,
        records: suspend (String) -> ReleaseRecordDoc,
        buildUrl: suspend (String, String) -> String?,
        download: () -> BuildDownload,
        play: PlayUpdatePolicy,
        events: () -> UpdateEventJournal?,
        runningVersion: String,
    ): InstallDriver = DirectInstallDriver(
        ApkInstallerSessions(context),
        records,
        buildUrl,
        { url, dest -> download().download(url, dest) },
        File(context.filesDir, "pkey/$productSlug/updates/apk"),
        events = events,
        runningVersion = runningVersion,
    )
}

/** A direct build's Play Asset Delivery: every call answers the typed `outlet` N/A. */
internal class UnsupportedPlayPacks(override val packs: List<String>) : PlayPackTransport {
    private val why = Unsupported(Feature.packsTransportPlay, UnsupportedReason.outlet, "a direct build carries no Play Core; Play Asset Delivery reaches only a Play install")

    override fun availability(): Unsupported = why

    override fun installed(): List<EmbeddedPack> = emptyList()

    override suspend fun ensure(packId: String): PlayPackResult = PlayPackResult.NotSupported(why)
}
