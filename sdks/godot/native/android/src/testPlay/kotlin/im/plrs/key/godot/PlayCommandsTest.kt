package im.plrs.key.godot

import android.app.Activity
import android.os.Looper
import com.google.android.play.core.appupdate.testing.FakeAppUpdateManager
import com.google.android.play.core.assetpacks.model.AssetPackStatus
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import im.plrs.key.platform.play.InAppUpdates
import im.plrs.key.platform.play.PackLocation
import im.plrs.key.platform.play.PackManager
import im.plrs.key.platform.play.PackState
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** A pack manager with one on-demand pack that completes at once on fetch. */
class OnePackManager : PackManager {
    private val listeners = mutableListOf<(PackState) -> Unit>()
    var status = AssetPackStatus.NOT_INSTALLED

    override fun state(name: String, callback: (Result<PackState>) -> Unit) = callback(Result.success(PackState(name, status, 0, 0, 10, 0)))
    override fun fetch(name: String, callback: (Result<PackState>) -> Unit) {
        callback(Result.success(PackState(name, AssetPackStatus.PENDING, 0, 0, 10, 0)))
        status = AssetPackStatus.COMPLETED
        listeners.toList().forEach { it(PackState(name, status, 0, 10, 10, 100)) }
    }
    override fun location(name: String): PackLocation? =
        if (status == AssetPackStatus.COMPLETED) PackLocation(name, AssetPackStorageMethod.STORAGE_FILES, "/data/x/$name/3/3/assets", "/data/x/$name/3/3") else null
    override fun remove(name: String, callback: (Result<Unit>) -> Unit) = callback(Result.success(Unit))
    override fun cancel(name: String): PackState? = null
    override fun confirm(activity: Activity, callback: (Result<Int>) -> Unit) = callback(Result.success(-1))
    override fun listen(listener: (PackState) -> Unit) { listeners.add(listener) }
    override fun unlisten(listener: (PackState) -> Unit) { listeners.remove(listener) }
}

@RunWith(RobolectricTestRunner::class)
class PlayCommandsTest {
    private val host = TestHost()
    private val fake = FakeAppUpdateManager(host.appContext)
    private val packs = OnePackManager()
    private val c = Commands(host) { PlayCommands(it, { fake }, { packs }) }

    private fun op(name: String, extra: JSONObject = JSONObject()) = c.json(extra.put("op", name))
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun events(ev: String): List<JSONObject> {
        val all = op("poll").getJSONArray("events")
        return (0 until all.length()).map { all.getJSONObject(it) }.filter { it.getString("ev") == ev }
    }

    @Test
    fun checkStartAndProgressReachTheQueue() {
        fake.setUpdateAvailable(7)
        fake.setUpdatePriority(5)
        val check = c.awaitResult(op("iau_check").getInt("req"))
        assertTrue(check.getBoolean("ok"))
        assertEquals(2, check.getInt("availability"))
        assertEquals(7, check.getInt("availableVersionCode"))
        assertEquals(5, check.getInt("priority"))
        assertTrue(check.isNull("stalenessDays"))

        val start = c.awaitResult(op("iau_start", JSONObject().put("type", "flexible")).getInt("req"))
        assertTrue(start.getBoolean("started"))
        fake.userAcceptsUpdate()
        fake.downloadStarts()
        fake.downloadCompletes()
        idle()
        val states = events("update_state").map { it.getInt("installStatus") }
        assertEquals(listOf(1, 2, 11), states)
        val done = c.awaitResult(op("iau_complete").getInt("req"))
        assertTrue(done.getBoolean("ok"))
    }

    @Test
    fun aFailedCheckIsUnavailable() {
        fake.setInstallErrorCode(-9)
        val r = c.awaitResult(op("iau_check").getInt("req"))
        assertFalse(r.getBoolean("ok"))
        assertEquals("unavailable", r.getString("error"))
        assertEquals(-9, r.getInt("installErrorCode"))
    }

    @Test
    fun startNeedsAKnownType() {
        assertEquals("bad_request", op("iau_start", JSONObject().put("type", "instant")).getString("error"))
        val r = c.awaitResult(op("iau_start", JSONObject().put("type", "immediate")).getInt("req"))
        assertFalse(r.getBoolean("started"))
        assertEquals("no-check", r.getString("reason"))
    }

    @Test
    fun activityResultsBecomeEvents() {
        c.onActivityResult(InAppUpdates.REQUEST_CODE, Activity.RESULT_CANCELED, null)
        c.onActivityResult(1234, Activity.RESULT_OK, null)
        val r = events("update_result")
        assertEquals(1, r.size)
        assertEquals("canceled", r[0].getString("result"))
    }

    @Test
    fun packFetchStatesAndLocation() {
        assertTrue(op("pad_location", JSONObject().put("name", "foes")).isNull("location"))
        val fetch = c.awaitResult(op("pad_fetch", JSONObject().put("name", "foes")).getInt("req"))
        assertEquals(AssetPackStatus.PENDING, fetch.getJSONObject("state").getInt("status"))
        val loc = op("pad_location", JSONObject().put("name", "foes")).getJSONObject("location")
        assertEquals("/data/x/foes/3/3/assets/foes.pck", loc.getString("pck"))
        assertFalse(loc.getBoolean("installTime"))
    }

    @Test
    fun packListenerEventsAreQueued() {
        // TestHost runs UI work inline, so the fetch and its listener events are queued already.
        op("pad_fetch", JSONObject().put("name", "foes"))
        val all = op("poll").getJSONArray("events")
        val states = (0 until all.length()).map { all.getJSONObject(it) }.filter { it.getString("ev") == "pack_state" }
        assertEquals(AssetPackStatus.COMPLETED, states.last().getInt("status"))
        assertEquals("foes", states.last().getString("name"))
    }

    @Test
    fun badPackNamesAreRefused() {
        val r = op("pad_location", JSONObject().put("name", "../foes"))
        assertFalse(r.getBoolean("ok"))
        assertEquals("invalid-name", r.getString("exception"))
        val f = c.awaitResult(op("pad_fetch", JSONObject().put("name", "a,b")).getInt("req"))
        assertEquals("invalid-name", f.getString("exception"))
    }

    @Test
    fun capabilitiesAdvertisePlay() {
        val caps = op("capabilities")
        assertTrue(caps.getBoolean("inAppUpdates"))
        assertFalse(caps.getBoolean("packageInstaller"))
        assertEquals("outlet", op("pi_verify", JSONObject().put("path", "/x")).getString("reason"))
        JSONArray() // keep the import used
    }
}
