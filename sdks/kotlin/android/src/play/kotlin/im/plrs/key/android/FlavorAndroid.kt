// The play flavour's half of :android (P6-12): Play In-App Updates as the install driver and Play
// Asset Delivery as the pack transport. No installer code exists in this source set.

package im.plrs.key.android

import android.app.Activity
import android.content.Context
import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateEventJournal
import im.plrs.key.platform.play.AssetPacks
import im.plrs.key.platform.play.InAppUpdates
import im.plrs.key.update.InstallDriver

internal object FlavorAndroid {
    const val FLAVOR: String = "play"

    /** A Play install is an app bundle's split APKs. */
    const val FORMAT: String = "aab"

    /** What a play build can do with a `binary` decision: offer the link (it never self-updates). */
    val methods: List<String> = listOf(BinaryMethod.download)

    fun playPacks(
        context: Context,
        packs: List<String>,
        activity: () -> Activity?,
        confirm: (suspend (String, PlayPackState) -> Boolean)?,
    ): PlayPackTransport = PadPackTransport(AssetPacks(context, packs.map { PlayPackTransport.padName(it) }.toSet()), packs, activity, confirm)

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
    ): InstallDriver = PlayInstallDriver(InAppUpdates(context), activity, play, events, runningVersion)
}
