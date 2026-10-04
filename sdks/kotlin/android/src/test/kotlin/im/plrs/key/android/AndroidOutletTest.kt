// @pkey-feature outlet.detect
package im.plrs.key.android

import im.plrs.key.core.DetectedOutlet
import im.plrs.key.core.DetectionStamp
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.detectOutlet
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.platform.InstallSourceInfo
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * outlet.detect on Android: every outlet-matrix.json row with Android signals, replayed through the
 * reader. Each row's installer, initiator and certificate digest become an InstallSourceInfo (what
 * :platform's InstallSource reads), AndroidOutletSignals maps it, and detectOutlet over the result
 * must give the row's outcome; the reader's own installerMismatch must equal the row's.
 */
class AndroidOutletTest {
    private fun info(installer: String?, initiator: String?, digest: String?, sdk: Int = 34) = InstallSourceInfo(
        packageName = "gg.vlad.diceroll", sdkInt = sdk, versionCode = 7, targetSdk = 36,
        api = if (sdk >= 30) "installSourceInfo" else "installerPackageName",
        installer = installer, initiator = initiator, originator = null,
        initiatorSigners = digest?.let { listOf(it) }, packageSource = if (sdk >= 33) 3 else null, updateOwner = null,
        selfSigners = listOf("ab".repeat(32)),
    )

    @Test
    fun everyAndroidRowOfTheOutletMatrix() {
        val rows = Corpus.load("outlet-matrix.json").objectValue!!["rows"].arrayValue!!.map { it.objectValue!! }
            .filter { r -> r["signals"].objectValue!!.keys.any { it.startsWith("android.") } }
        assertTrue("the matrix has Android rows", rows.size >= 6)
        for (row in rows) {
            val name = row["name"].stringValue!!
            val signals = row["signals"].objectValue!!
            val src = signals["android.installSource"].objectValue!!
            val read = AndroidOutletSignals.of(
                info(src["installer"].stringValue, src["initiator"].stringValue, src["initiatorCertSha256"].stringValue),
            )
            assertEquals(name, signals["android.installerMismatch"].boolValue, read[AndroidOutletSignals.INSTALLER_MISMATCH].boolValue)
            val st = row["stamp"].objectValue!!
            val stamp = DetectionStamp(
                st["outletKind"].stringValue!!, st["subkind"].stringValue,
                st["outletIds"].objectValue!!.mapValues { it.value.stringValue!! },
            )
            val e = row["expect"].objectValue!!
            val want = DetectedOutlet(e["kind"].stringValue!!, e["confidence"].stringValue, e["source"].stringValue, e["subkind"].stringValue)
            assertEquals(name, want, detectOutlet(stamp, read))
        }
    }

    @Test
    fun signalShape() {
        val s = AndroidOutletSignals.of(info("com.android.vending", "com.android.vending", "cd".repeat(32)))
        val src = s[AndroidOutletSignals.INSTALL_SOURCE] as JsonObject
        assertEquals(JsonPrimitive("com.android.vending"), src["installer"])
        assertEquals(JsonPrimitive("cd".repeat(32)), src["initiatorCertSha256"])
        assertEquals(JsonPrimitive(3), src["packageSource"])
        assertEquals(JsonNull, src["updateOwner"])
        assertEquals(JsonPrimitive(false), s[AndroidOutletSignals.INSTALLER_MISMATCH])
        // Below API 30 the initiator is unknown: the source is no evidence and the mismatch vetoes play.
        val old = AndroidOutletSignals.of(info("com.android.vending", null, null, sdk = 29))
        assertEquals(JsonNull, (old[AndroidOutletSignals.INSTALL_SOURCE] as JsonObject)["initiator"])
        assertEquals(JsonPrimitive(true), old[AndroidOutletSignals.INSTALLER_MISMATCH])
        // A sideload through the shell, with no installer recorded, confirms direct.
        val adb = AndroidOutletSignals.of(info(null, null, null))
        assertEquals(DetectedOutlet("direct", "declared", "android.installSource", null), detectOutlet(DetectionStamp("direct"), adb))
    }

    @Test
    fun aFailedReadYieldsNoSignal() = runBlocking {
        val reader = AndroidOutletSignalReader { throw IllegalStateException("no package manager") }
        assertEquals(emptyMap<String, Any>(), reader.read(emptyMap()))
        val ok = AndroidOutletSignalReader { info("org.fdroid.fdroid", "org.fdroid.fdroid", null) }
        assertEquals(DetectedOutlet("fdroid-repo", "declared", "android.installSource", null), detectOutlet(DetectionStamp("direct"), ok.read(emptyMap())))
    }
}
