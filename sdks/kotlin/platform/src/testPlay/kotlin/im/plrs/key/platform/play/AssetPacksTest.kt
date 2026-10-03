package im.plrs.key.platform.play

import android.app.Activity
import com.google.android.play.core.assetpacks.model.AssetPackErrorCode
import com.google.android.play.core.assetpacks.model.AssetPackStatus
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * A fake [PackManager] that behaves like Play Core under `bundletool --local-testing` (notes/S-10
 * §2): `fetch` answers PENDING at once and the listener carries PENDING → DOWNLOADING →
 * TRANSFERRING → COMPLETED; an unknown name fails; the install-time pack is APK_ASSETS with no path.
 */
class FakePackManager(private val root: String = "/data/data/im.plrs.key.test/files/assetpacks") : PackManager {
    val calls = mutableListOf<String>()
    val packs = mutableMapOf("foes" to AssetPackStatus.NOT_INSTALLED, "maps" to AssetPackStatus.NOT_INSTALLED)
    private val listeners = mutableListOf<(PackState) -> Unit>()
    var confirmResult: Result<Int> = Result.failure(PackError("com.google.android.play.core.assetpacks.AssetPackException", "not installed by Play", AssetPackErrorCode.CONFIRMATION_NOT_REQUIRED))

    private fun state(name: String, status: Int, pct: Int = 0) = PackState(name, status, 0, if (status >= 2) 5_000_000 else 0, 5_000_000, pct)

    override fun state(name: String, callback: (Result<PackState>) -> Unit) {
        calls.add("state:$name")
        val s = packs[name] ?: return callback(Result.failure(PackError("LocalTestingException", "No APKs available for pack", null)))
        callback(Result.success(state(name, s)))
    }

    override fun fetch(name: String, callback: (Result<PackState>) -> Unit) {
        calls.add("fetch:$name")
        if (name !in packs) return callback(Result.failure(PackError("LocalTestingException", "unknown pack", null)))
        callback(Result.success(state(name, AssetPackStatus.PENDING)))
        for ((status, pct) in listOf(AssetPackStatus.PENDING to 0, AssetPackStatus.DOWNLOADING to 0, AssetPackStatus.TRANSFERRING to 0, AssetPackStatus.TRANSFERRING to 100, AssetPackStatus.COMPLETED to 100)) {
            packs[name] = status
            emit(state(name, status, pct))
        }
    }

    fun emit(s: PackState) = listeners.toList().forEach { it(s) }

    override fun location(name: String): PackLocation? {
        calls.add("location:$name")
        if (name == "assetPackInstallTime") return PackLocation(name, AssetPackStorageMethod.APK_ASSETS, null, null)
        if (packs[name] != AssetPackStatus.COMPLETED) return null
        return PackLocation(name, AssetPackStorageMethod.STORAGE_FILES, "$root/$name/7/7/assets", "$root/$name/7/7")
    }

    override fun remove(name: String, callback: (Result<Unit>) -> Unit) {
        calls.add("remove:$name")
        packs[name] = AssetPackStatus.NOT_INSTALLED
        callback(Result.success(Unit))
    }

    override fun cancel(name: String): PackState? {
        calls.add("cancel:$name")
        return packs[name]?.let { state(name, it) }
    }

    override fun confirm(activity: Activity, callback: (Result<Int>) -> Unit) {
        calls.add("confirm")
        callback(confirmResult)
    }

    override fun listen(listener: (PackState) -> Unit) {
        listeners.add(listener)
    }

    override fun unlisten(listener: (PackState) -> Unit) {
        listeners.remove(listener)
    }
}

@RunWith(RobolectricTestRunner::class)
class AssetPacksTest {
    private val fake = FakePackManager()

    @Test
    fun fetchIsAcceptedThenTheListenerCarriesTheStates() {
        val packs = AssetPacks(fake)
        val seen = mutableListOf<Int>()
        packs.listen { seen.add(it.status) }
        var accepted: PackState? = null
        packs.fetch("foes") { accepted = it.getOrThrow() }
        assertEquals(AssetPackStatus.PENDING, accepted!!.status)
        assertEquals(
            listOf(AssetPackStatus.PENDING, AssetPackStatus.DOWNLOADING, AssetPackStatus.TRANSFERRING, AssetPackStatus.TRANSFERRING, AssetPackStatus.COMPLETED),
            seen,
        )
    }

    @Test
    fun completedPackMountsFromItsAssetsPath() {
        val packs = AssetPacks(fake)
        assertNull(packs.location("foes"))
        packs.fetch("foes") {}
        val loc = packs.location("foes")!!
        assertEquals("/data/data/im.plrs.key.test/files/assetpacks/foes/7/7/assets/foes.pck", loc.pckPath)
        assertFalse(loc.installTime)
        assertEquals(loc.pckPath, loc.toJson().getString("pck"))
    }

    @Test
    fun installTimePackIsNotAFile() {
        val loc = AssetPacks(fake).location("assetPackInstallTime")!!
        assertTrue(loc.installTime)
        assertNull(loc.pckPath)
        assertTrue(loc.toJson().isNull("pck"))
    }

    @Test
    fun filesWithoutAPathAreNotAvailable() {
        assertNull(PackLocation("foes", AssetPackStorageMethod.STORAGE_FILES, "", null).pckPath)
        assertNull(PackLocation("foes", AssetPackStorageMethod.STORAGE_FILES, null, null).pckPath)
        assertNull(PackLocation("foes", AssetPackStorageMethod.APK_ASSETS, "/x", null).pckPath)
    }

    @Test
    fun invalidNamesNeverReachPlay() {
        val packs = AssetPacks(fake)
        for (bad in listOf("", "1foes", "foes/../x", "foes,maps", "with space", "x".repeat(129))) {
            var err: Throwable? = null
            packs.fetch(bad) { err = it.exceptionOrNull() }
            assertEquals("invalid-name", (err as PackError).exception)
            try {
                packs.location(bad)
                fail("location($bad) must refuse")
            } catch (e: PackError) {
                assertEquals("invalid-name", e.exception)
            }
        }
        assertTrue(fake.calls.isEmpty())
    }

    @Test
    fun unknownPacksAreRefusedBeforeABatchCanFail() {
        val packs = AssetPacks(fake, known = setOf("foes"))
        var err: Throwable? = null
        packs.state("maps") { err = it.exceptionOrNull() }
        assertEquals("unknown-pack", (err as PackError).exception)
        packs.state("foes") { assertTrue(it.isSuccess) }
        assertEquals(listOf("state:foes"), fake.calls)
    }

    @Test
    fun anUnknownNameWithoutAListFailsAlone() {
        var err: Throwable? = null
        AssetPacks(fake).state("nosuchpack") { err = it.exceptionOrNull() }
        assertTrue(err is PackError)
    }

    @Test
    fun waitingForWifiAndUserConfirmationNeedTheDialog() {
        assertTrue(PackState("foes", AssetPackStatus.WAITING_FOR_WIFI, 0, 0, 0, 0).needsConfirmation)
        assertTrue(PackState("foes", AssetPackStatus.REQUIRES_USER_CONFIRMATION, 0, 0, 0, 0).needsConfirmation)
        assertFalse(PackState("foes", AssetPackStatus.DOWNLOADING, 0, 0, 0, 0).needsConfirmation)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        var r: Result<Int>? = null
        AssetPacks(fake).confirm(activity) { r = it }
        // Off Play the dialog answers error -14 (notes/S-10 §2).
        assertEquals(AssetPackErrorCode.CONFIRMATION_NOT_REQUIRED, (r!!.exceptionOrNull() as PackError).errorCode)
    }

    @Test
    fun removeAndCancelAreSinglePack() {
        val packs = AssetPacks(fake)
        packs.fetch("foes") {}
        assertEquals(AssetPackStatus.COMPLETED, packs.cancel("foes")!!.status)
        var removed = false
        packs.remove("foes") { removed = it.isSuccess }
        assertTrue(removed)
        assertNull(packs.location("foes"))
    }

    @Test
    fun unlistenStopsEvents() {
        val packs = AssetPacks(fake)
        val seen = mutableListOf<Int>()
        val l: (PackState) -> Unit = { seen.add(it.status) }
        packs.listen(l)
        packs.unlisten(l)
        packs.fetch("foes") {}
        assertTrue(seen.isEmpty())
    }
}
