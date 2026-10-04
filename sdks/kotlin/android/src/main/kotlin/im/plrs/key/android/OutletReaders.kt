// outlet.detect on Android (P6-12): the readers that turn :platform's InstallSource into the two
// Android signals of `outlet-matrix.json#/signals`, for :core's detectOutlet. The MAPPING is
// detectOutlet's (every outlet-matrix.json row passes in :conformance); this file only reads.
//
//   android.installSource      {installer, initiator, initiatorCertSha256, originator, packageSource,
//                              updateOwner} from getInstallSourceInfo (API 30+; installerPackageName
//                              below, where initiator is unknown and so null)
//   android.installerMismatch  installer != initiator, from the same call
//
// The same two signals, with the same values, as Godot's outlet_signals.gd `_android` (P3-02,
// notes/S-06 §7): `adb install -i com.android.vending` records Play with the shell as initiator, and
// the mismatch vetoes a play stamp. Raw package names stay on the device: detection reads them, the
// report carries only the resolved outlet kind.

package im.plrs.key.android

import android.content.Context
import im.plrs.key.platform.InstallSource
import im.plrs.key.platform.InstallSourceInfo
import im.plrs.key.update.OutletSignalReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The Android outlet signals of one install-source read. */
public object AndroidOutletSignals {
    public const val INSTALL_SOURCE: String = "android.installSource"
    public const val INSTALLER_MISMATCH: String = "android.installerMismatch"

    /** The signals [info] yields (both, always: a read that happened is evidence of what it saw). */
    public fun of(info: InstallSourceInfo): Map<String, JsonElement> {
        fun str(v: String?): JsonElement = v?.let { JsonPrimitive(it) } ?: JsonNull
        val source = JsonObject(
            linkedMapOf(
                "installer" to str(info.installer),
                "initiator" to str(info.initiator),
                "initiatorCertSha256" to str(info.initiatorCertSha256),
                "originator" to str(info.originator),
                "packageSource" to (info.packageSource?.let { JsonPrimitive(it) } ?: JsonNull),
                "updateOwner" to str(info.updateOwner),
            ),
        )
        return linkedMapOf(
            INSTALL_SOURCE to source,
            INSTALLER_MISMATCH to JsonPrimitive(info.installer != info.initiator),
        )
    }
}

/**
 * :update's [OutletSignalReader] on Android: reads the install source on each call (it changes when
 * the app updates itself or a store takes over) and maps it with [AndroidOutletSignals.of]. A read
 * that fails yields no signal, and detection falls to the build stamp.
 */
public class AndroidOutletSignalReader(private val read: () -> InstallSourceInfo) : OutletSignalReader {
    public constructor(context: Context) : this({ InstallSource.read(context) })

    override suspend fun read(outletIds: Map<String, String>): Map<String, JsonElement> = withContext(Dispatchers.IO) {
        val info = try {
            read()
        } catch (e: Exception) {
            return@withContext emptyMap()
        }
        AndroidOutletSignals.of(info)
    }
}
