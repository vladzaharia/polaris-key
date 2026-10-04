// @pkey-feature packs.transport.play
package im.plrs.key.android

import android.app.Activity
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import im.plrs.key.core.ErrorCode
import im.plrs.key.packs.EmbeddedPack
import im.plrs.key.platform.play.AssetPacks
import im.plrs.key.platform.play.PackError
import im.plrs.key.platform.play.PackLocation
import im.plrs.key.platform.play.PackManager
import im.plrs.key.platform.play.PackState
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** A Play asset-pack manager whose locations and state sequence the test sets. */
class FakePackManager : PackManager {
    val locations = mutableMapOf<String, PackLocation>()

    /** What fetch() makes Play report, in order, through the listener. */
    val script = mutableMapOf<String, MutableList<Int>>()
    var fetchFails: PackError? = null
    var confirmResult: Result<Int> = Result.success(Activity.RESULT_OK)
    val calls = mutableListOf<String>()
    private val listeners = mutableListOf<(PackState) -> Unit>()

    private fun state(name: String, status: Int) = PackState(name, status, if (status == 5) -6 else 0, 10, 100, 0)

    private fun emitNext(name: String) {
        val next = script[name]?.removeFirstOrNull() ?: return
        for (l in listeners.toList()) l(state(name, next))
        // Statuses that need no action from the transport continue on their own.
        if (next in listOf(1, 2, 3)) emitNext(name)
    }

    override fun state(name: String, callback: (Result<PackState>) -> Unit) = callback(Result.success(state(name, 8)))

    override fun fetch(name: String, callback: (Result<PackState>) -> Unit) {
        calls += "fetch:$name"
        fetchFails?.let { return callback(Result.failure(it)) }
        callback(Result.success(state(name, 1)))
        emitNext(name)
    }

    override fun location(name: String): PackLocation? = locations[name]

    override fun remove(name: String, callback: (Result<Unit>) -> Unit) = callback(Result.success(Unit))

    override fun cancel(name: String): PackState? {
        calls += "cancel:$name"
        return state(name, 6)
    }

    override fun confirm(activity: Activity, callback: (Result<Int>) -> Unit) {
        calls += "confirm"
        callback(confirmResult)
        if (confirmResult.getOrNull() == Activity.RESULT_OK) script.keys.forEach { emitNext(it) }
    }

    override fun listen(listener: (PackState) -> Unit) {
        listeners += listener
    }

    override fun unlisten(listener: (PackState) -> Unit) {
        listeners -= listener
    }
}

/**
 * packs.transport.play on a play build: Play's paths read fresh into embedded baselines (container,
 * tree, texture-format directory, install-time and missing packs) and the fetch state machine
 * (completed, failed, cancelled, the confirmation hook and Play's dialog, timeouts).
 */
@RunWith(RobolectricTestRunner::class)
class PadPackTransportTest {
    @get:Rule val tmp = TemporaryFolder()

    private val manager = FakePackManager()
    private var activity: Activity? = null

    private fun transport(
        packs: List<String> = listOf("diceroll.foes", "diceroll.music-hd"),
        confirm: (suspend (String, PlayPackState) -> Boolean)? = null,
        timeout: Long = 60_000,
    ) = PadPackTransport(AssetPacks(manager), packs, { activity }, confirm, timeout)

    /** A Play-delivered pack directory: `<root>/<name>/assets/<sub>/`. */
    private fun assets(name: String, sub: String): File = File(tmp.root, "assetpacks/$name/7/7/assets/$sub").apply { mkdirs() }

    private fun onDisk(name: String) {
        manager.locations[name] = PackLocation(name, AssetPackStorageMethod.STORAGE_FILES, File(tmp.root, "assetpacks/$name/7/7/assets").path, File(tmp.root, "assetpacks/$name/7/7").path)
    }

    @Test
    fun padNamesFollowTheManifestMapping() {
        assertEquals("diceroll_foes", PlayPackTransport.padName("diceroll.foes"))
        assertEquals("diceroll_music_hd", PlayPackTransport.padName("diceroll.music-hd"))
    }

    @Test
    fun installedReadsEachCarriedPackFresh() {
        // A container with its marker beside it.
        val foes = assets("diceroll_foes", "pkey")
        File(foes, "foes.pck").writeBytes(ByteArray(64) { it.toByte() })
        File(foes, "foes.pck.pkey.json").writeText("{}")
        onDisk("diceroll_foes")
        // A tree, delivered in a texture-format directory.
        val hd = assets("diceroll_music_hd", "pkey#tcf_astc")
        File(hd, ".pkey").mkdirs()
        File(hd, ".pkey/pack.json").writeText("{}")
        File(hd, "theme.ogg").writeBytes(ByteArray(8))
        onDisk("diceroll_music_hd")
        val got = transport().installed()
        assertEquals(
            listOf(EmbeddedPack(File(foes, "foes.pck"), File(foes, "foes.pck.pkey.json")), EmbeddedPack(hd)),
            got,
        )
        // Re-read on every call: a pack Play removed is gone at once.
        manager.locations.remove("diceroll_foes")
        assertEquals(listOf(EmbeddedPack(hd)), transport().installed())
    }

    @Test
    fun packsThatAreNotFilesAreNoBaseline() {
        manager.locations["diceroll_foes"] = PackLocation("diceroll_foes", AssetPackStorageMethod.APK_ASSETS, null, null)
        assertNull("the install-time pack is APK_ASSETS", transport().located("diceroll.foes"))
        onDisk("diceroll_foes")
        assets("diceroll_foes", "other")
        assertNull("no pkey directory", transport().located("diceroll.foes"))
        val two = assets("diceroll_foes", "pkey")
        File(two, "a.pkey.json").writeText("{}")
        File(two, "b.pkey.json").writeText("{}")
        assertNull("two markers are ambiguous", transport().located("diceroll.foes"))
        assertNull("an uncarried pack is not looked up", transport(packs = emptyList()).installed().firstOrNull())
    }

    @Test
    fun ensureWaitsForCompleted() {
        manager.script["diceroll_foes"] = mutableListOf(2, 3, 4)
        val r = pumped { transport().ensure("diceroll.foes") }
        assertTrue(r is PlayPackResult.Completed)
        assertEquals(PlayPackState.COMPLETED, (r as PlayPackResult.Completed).state.status)
        assertEquals(listOf("fetch:diceroll_foes"), manager.calls)
    }

    @Test
    fun failedAndCancelledDownloads() {
        manager.script["diceroll_foes"] = mutableListOf(2, 5)
        val failed = pumped { transport().ensure("diceroll.foes") }
        assertEquals(ErrorCode.platformError, (failed as PlayPackResult.Failed).code)
        assertEquals(-6, failed.state?.errorCode)
        manager.script["diceroll_foes"] = mutableListOf(6)
        assertEquals(ErrorCode.cancelled, (pumped { transport().ensure("diceroll.foes") } as PlayPackResult.Failed).code)
        manager.fetchFails = PackError("com.google.android.play.core.assetpacks.AssetPackException", "network", -7)
        val refused = pumped { transport().ensure("diceroll.foes") } as PlayPackResult.Failed
        assertEquals(ErrorCode.platformError, refused.code)
        assertTrue(refused.detail.contains("-7"))
    }

    @Test
    fun cellularDownloadsAskTheHookThenPlay() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val asked = mutableListOf<String>()
        manager.script["diceroll_foes"] = mutableListOf(9, 2, 4)
        val ok = pumped { transport(confirm = { id, s -> asked += "$id:${s.status}"; true }).ensure("diceroll.foes") }
        assertTrue(ok is PlayPackResult.Completed)
        assertEquals(listOf("diceroll.foes:9"), asked)
        assertTrue("confirm" in manager.calls)

        // A declined hook cancels the download and never shows Play's dialog.
        manager.calls.clear()
        manager.script["diceroll_foes"] = mutableListOf(7)
        val no = pumped { transport(confirm = { _, _ -> false }).ensure("diceroll.foes") } as PlayPackResult.Failed
        assertEquals(ErrorCode.cancelled, no.code)
        assertEquals(listOf("fetch:diceroll_foes", "cancel:diceroll_foes"), manager.calls)

        // The player declining Play's own dialog.
        manager.script["diceroll_foes"] = mutableListOf(9)
        manager.confirmResult = Result.success(Activity.RESULT_CANCELED)
        assertEquals(ErrorCode.cancelled, (pumped { transport().ensure("diceroll.foes") } as PlayPackResult.Failed).code)
    }

    @Test
    fun confirmationWithoutAnActivityFails() {
        manager.script["diceroll_foes"] = mutableListOf(9)
        val r = pumped { transport().ensure("diceroll.foes") } as PlayPackResult.Failed
        assertEquals(ErrorCode.platformError, r.code)
    }

    @Test
    fun unknownPacksAndTimeouts() {
        assertEquals(ErrorCode.invalidOptions, (pumped { transport().ensure("diceroll.other") } as PlayPackResult.Failed).code)
        manager.script["diceroll_foes"] = mutableListOf(2)
        assertEquals(ErrorCode.timeout, (pumped { transport(timeout = 50).ensure("diceroll.foes") } as PlayPackResult.Failed).code)
        assertNull(transport().availability())
    }
}
