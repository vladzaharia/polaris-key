package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import im.plrs.key.platform.PolarisKeyPlatform
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** A Host over a Robolectric activity; UI work runs inline. */
class TestHost(val act: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()) : Host {
    override val appContext: Context get() = act.applicationContext
    override val foregroundActivity: Activity? get() = act
    override fun onUi(r: Runnable) = r.run()
}

fun Commands.json(q: JSONObject): JSONObject = JSONObject(cmd(q.toString()))

/** Drains the queue until the result for [req] arrives (worker results land asynchronously). */
fun Commands.awaitResult(req: Int, timeoutMs: Long = 5000): JSONObject {
    val t0 = System.currentTimeMillis()
    while (System.currentTimeMillis() - t0 < timeoutMs) {
        val events = json(JSONObject().put("op", "poll")).getJSONArray("events")
        for (i in 0 until events.length()) {
            val e = events.getJSONObject(i)
            if (e.optString("ev") == "result" && e.optInt("req") == req) return e
        }
        org.robolectric.shadows.ShadowLooper.idleMainLooper()
        Thread.sleep(10)
    }
    throw AssertionError("no result for req $req")
}

@RunWith(RobolectricTestRunner::class)
class CommandsTest {
    private val host = TestHost()
    private val c = Commands(host)

    private fun op(name: String, extra: JSONObject = JSONObject()) = c.json(extra.put("op", name))

    @Test
    fun pollStartsEmpty() {
        val r = op("poll")
        assertTrue(r.getBoolean("ok"))
        assertEquals(0, r.getJSONArray("events").length())
        assertEquals(0, r.getInt("dropped"))
    }

    @Test
    fun badRequestsAndUnknownOpsFail() {
        val bad = JSONObject(c.cmd("{not json"))
        assertFalse(bad.getBoolean("ok"))
        assertEquals("bad_request", bad.getString("error"))
        assertEquals("unknown_op", op("call").getString("error"))
        assertEquals("unknown_op", op("").getString("error"))
    }

    @Test
    fun theOtherFlavoursOpsAreUnsupportedForTheOutlet() {
        val foreign = if (PolarisKeyPlatform.isPlay) "pi_install" else "iau_check"
        val r = op(foreign)
        assertFalse(r.getBoolean("ok"))
        assertTrue(r.getBoolean("unsupported"))
        assertEquals("outlet", r.getString("reason"))
    }

    @Test
    fun capabilitiesNameTheFlavour() {
        val r = op("capabilities")
        assertTrue(r.getBoolean("ok"))
        assertEquals(PolarisKeyPlatform.PROTOCOL, r.getInt("protocol"))
        assertEquals(PolarisKeyPlatform.flavor, r.getString("flavor"))
        assertTrue(r.getBoolean("keystore"))
        assertEquals(PolarisKeyPlatform.isPlay, r.getBoolean("inAppUpdates"))
        assertEquals(PolarisKeyPlatform.isPlay, r.getBoolean("assetPacks"))
        assertEquals(PolarisKeyPlatform.isDirect, r.getBoolean("packageInstaller"))
    }

    @Test
    fun installSourceIsRaw() {
        shadowOf(host.appContext.packageManager).setInstallSourceInfo(host.appContext.packageName, "com.android.shell", "com.android.vending")
        val r = op("install_source")
        assertTrue(r.getBoolean("ok"))
        assertEquals("com.android.vending", r.getString("installer"))
        assertEquals("com.android.shell", r.getString("initiator"))
    }

    @Test
    fun keystoreFailuresAreSurfacedNeverFallenBack() {
        // Robolectric has no AndroidKeyStore: the write must fail loudly, not land in a file.
        val r = op("ks_set", JSONObject().put("product", "diceroll").put("account", "token").put("value", "pkeyt_x"))
        assertFalse(r.getBoolean("ok"))
        assertEquals("keystore", r.getString("error"))
        assertEquals("keystore", r.getString("reason"))
        val bad = op("ks_get", JSONObject().put("product", "../x").put("account", "token"))
        assertEquals("invalid-name", bad.getString("reason"))
        assertEquals("bad_request", op("ks_get", JSONObject().put("product", "diceroll")).getString("error"))
    }

    @Test
    fun asyncResultsAndEventsQueueInOrder() {
        val a = c.async { done -> done(JSONObject().put("ok", true).put("x", 1)) }
        c.onResume()
        val events = op("poll").getJSONArray("events")
        assertEquals(2, events.length())
        assertEquals("result", events.getJSONObject(0).getString("ev"))
        assertEquals(a.getInt("req"), events.getJSONObject(0).getInt("req"))
        assertEquals("resumed", events.getJSONObject(1).getString("ev"))
        assertEquals(0, op("poll").getJSONArray("events").length())
    }

    @Test
    fun anAsyncResultIsDeliveredOnce() {
        val a = c.async { done ->
            done(JSONObject().put("ok", true))
            done(JSONObject().put("ok", false))
        }
        val events = op("poll").getJSONArray("events")
        assertEquals(1, events.length())
        assertEquals(a.getInt("req"), events.getJSONObject(0).getInt("req"))
    }

    @Test
    fun aThrowingAsyncOpAnswersAnError() {
        val a = c.async { throw IllegalStateException("boom") }
        val r = c.awaitResult(a.getInt("req"))
        assertFalse(r.getBoolean("ok"))
        assertEquals("exception", r.getString("error"))
    }

    @Test
    fun theQueueKeepsTheNewestAndCountsDrops() {
        val q = EventQueue(capacity = 3)
        for (i in 1..5) q.push(JSONObject().put("i", i))
        val d = q.drain()
        assertEquals(2, d.getInt("dropped"))
        assertEquals(3, d.getJSONArray("events").getJSONObject(0).getInt("i"))
        assertEquals(0, q.drain().getInt("dropped"))
    }
}
