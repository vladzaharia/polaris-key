// @pkey-feature connect.lan
package im.plrs.key.godot

import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsdListener
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** CC-14b.9: the nsd_* ops over a fake backend: validation, the name filter, permission, coalescing. */
@RunWith(RobolectricTestRunner::class)
class NsdCommandsTest {
    private val a = "p1-aaaaaaaaaaaaaaaa"
    private val b = "p1-bbbbbbbbbbbbbbbb"

    private class Fake : NsdCommands.Backend {
        var supported = true
        var permission = NsdCommands.Permission.NOT_REQUIRED
        var advertised = ArrayList<Triple<String, Int, Map<String, ByteArray>>>()
        var advertResult: ((NsdAdvertResult) -> Unit)? = null
        var advertStops = 0
        var browseListener: PeerNsdListener? = null
        var browseAccept: ((String) -> Boolean)? = null
        var browses = 0
        var browseStops = 0
        val watchListeners = HashMap<String, PeerNsdListener>()
        val watchStops = ArrayList<String>()

        override fun supported() = supported

        override fun permission() = permission

        override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): Stopper {
            advertised += Triple(instance, port, txt)
            advertResult = onResult
            return { advertStops++ }
        }

        override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): Stopper {
            browses++
            browseListener = listener
            browseAccept = accept
            return { browseStops++ }
        }

        override fun watch(instance: String, listener: PeerNsdListener): Stopper {
            watchListeners[instance] = listener
            return { watchStops += instance }
        }
    }

    private val fake = Fake()
    private val c = Commands(TestHost(), nsdBackend = fake)

    private fun op(name: String, build: JSONObject.() -> Unit = {}) = c.json(JSONObject().put("op", name).also(build))

    private fun poll(): List<JSONObject> {
        val arr = op("poll").getJSONArray("events")
        return (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optString("ev").startsWith("nsd_") }
    }

    private fun names(vararg n: String) = JSONArray(n.toList())

    private fun resolved(instance: String, vararg addr: String, port: Int = 4100, attrs: Map<String, ByteArray?> = mapOf("v" to "1".toByteArray(), "m" to "a".toByteArray())) =
        NsdResolved(instance, addr.toList(), port, attrs, null)

    /** Browse started, names accepted, [instance] found by the OS. */
    private fun watching(vararg instance: String) {
        assertTrue(op("nsd_accept") { put("names", names(a, b)) }.getBoolean("ok"))
        assertTrue(op("nsd_browse_start").getBoolean("ok"))
        for (i in instance) {
            if (fake.browseAccept!!(i)) fake.browseListener!!.onFound(i)
        }
    }

    @Test
    fun statusReportsSupportAndPermission() {
        fake.permission = NsdCommands.Permission.DENIED
        val r = op("nsd_status")
        assertTrue(r.getBoolean("supported"))
        assertEquals("denied", r.getString("permission"))
        assertTrue(op("capabilities").getBoolean("nsd"))
    }

    @Test
    fun permissionStateNeedsBothTheDeviceAndTheTargetAtApi37() {
        val p = NsdCommands.Companion
        assertEquals(NsdCommands.Permission.NOT_REQUIRED, p.permissionState(36, 37, false))
        assertEquals(NsdCommands.Permission.NOT_REQUIRED, p.permissionState(37, 36, false))
        assertEquals(NsdCommands.Permission.DENIED, p.permissionState(37, 37, false))
        assertEquals(NsdCommands.Permission.GRANTED, p.permissionState(37, 37, true))
    }

    @Test
    fun deniedPermissionStartsNothing() {
        fake.permission = NsdCommands.Permission.DENIED
        for (name in listOf("nsd_advertise", "nsd_browse_start")) {
            val r = op(name) { put("instance", a).put("port", 4100) }
            assertFalse(r.getBoolean("ok"))
            assertEquals("permission_denied", r.getString("error"))
        }
        assertTrue(fake.advertised.isEmpty())
        assertEquals(0, fake.browses)
    }

    @Test
    fun unsupportedBelowApi34() {
        fake.supported = false
        val r = op("nsd_browse_start")
        assertEquals("unsupported", r.getString("error"))
        assertEquals(0, fake.browses)
    }

    @Test
    fun advertiseValidatesTheNamePortAndTxt() {
        fun bad(build: JSONObject.() -> Unit) = assertEquals("bad_input", op("nsd_advertise", build).getString("error"))
        bad { put("instance", "p1-short").put("port", 4100) }
        bad { put("instance", a + "x").put("port", 4100) }
        bad { put("instance", a.uppercase()).put("port", 4100) }
        bad { put("instance", a).put("port", 0) }
        bad { put("instance", a).put("port", 70000) }
        bad { put("instance", a).put("port", 4100).put("txt", JSONArray(listOf("v=1", 5))) }
        bad { put("instance", a).put("port", 4100).put("txt", JSONArray(listOf("=x"))) }
        bad { put("instance", a).put("port", 4100).put("txt", JSONArray(listOf("v=1", "v=2"))) }
        bad { put("instance", a).put("port", 4100).put("txt", JSONArray(List(9) { "k$it=1" })) }
        bad { put("instance", a).put("port", 4100).put("txt", JSONArray(listOf("k=" + "x".repeat(260)))) }
        assertTrue(fake.advertised.isEmpty())
    }

    @Test
    fun advertiseUsesThePortAndAReplacementStopsTheFirst() {
        assertTrue(op("nsd_advertise") { put("instance", a).put("port", 4100).put("txt", JSONArray(listOf("v=1", "m=a"))) }.getBoolean("ok"))
        assertEquals(a, fake.advertised[0].first)
        assertEquals(4100, fake.advertised[0].second)
        assertEquals("1", String(fake.advertised[0].third["v"]!!))
        val first = fake.advertResult!!
        assertTrue(op("nsd_advertise") { put("instance", b).put("port", 4100) }.getBoolean("ok"))
        assertEquals(1, fake.advertStops)
        // The first advert's late answer is ignored: it does not describe the current one.
        first(NsdAdvertResult.Refused("renamed"))
        assertTrue(poll().isEmpty())
        fake.advertResult!!(NsdAdvertResult.Registered)
        val e = poll().single()
        assertEquals("nsd_advert", e.getString("ev"))
        assertTrue(e.getBoolean("ok"))
    }

    @Test
    fun aRefusedAdvertIsReportedAndWithdrawn() {
        op("nsd_advertise") { put("instance", a).put("port", 4100) }
        fake.advertResult!!(NsdAdvertResult.Refused("renamed"))
        val e = poll().single()
        assertFalse(e.getBoolean("ok"))
        assertEquals("renamed", e.getString("reason"))
        assertEquals(1, fake.advertStops)
    }

    @Test
    fun nothingIsAcceptedUntilTheNamesArePushed() {
        op("nsd_browse_start")
        assertFalse(fake.browseAccept!!(a))
        op("nsd_accept") { put("names", names(a)) }
        assertTrue(fake.browseAccept!!(a))
        assertFalse(fake.browseAccept!!(b))
    }

    @Test
    fun aBadNameListClearsTheSetAndTheDoorShuts() {
        op("nsd_accept") { put("names", names(a)) }
        assertEquals("bad_input", op("nsd_accept") { put("names", names(a, "p1-short")) }.getString("error"))
        assertEquals("bad_input", op("nsd_accept") {}.getString("error"))
        op("nsd_browse_start")
        assertFalse(fake.browseAccept!!(a))
        val many = JSONArray(List(NsdCommands.MAX_ACCEPTED + 1) { "p1-" + "a".repeat(15) + "a" })
        assertEquals("bad_input", op("nsd_accept") { put("names", many) }.getString("error"))
    }

    @Test
    fun aSecondBrowseIsBusy() {
        op("nsd_browse_start")
        assertEquals("busy", op("nsd_browse_start").getString("error"))
        assertEquals(1, fake.browses)
    }

    @Test
    fun aForgedNameIsNeverWatchedOrReported() {
        watching()
        // The OS could still call onFound if the filter were skipped; the command layer judges again.
        fake.browseListener!!.onFound("p1-cccccccccccccccc")
        assertTrue(fake.watchListeners.isEmpty())
        assertTrue(poll().isEmpty())
    }

    @Test
    fun resolveReportsEveryAddressTheOsGave() {
        watching(a)
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9", "fd00::2", "fe80::1%12", "10.0.0.4"))
        val e = poll().single()
        assertEquals("nsd_found", e.getString("ev"))
        assertEquals(a, e.getString("instance"))
        assertEquals(4100, e.getInt("port"))
        assertEquals(listOf("192.168.1.9", "fd00::2", "fe80::1%12", "10.0.0.4"), (0 until 4).map { e.getJSONArray("hosts").getString(it) })
        assertEquals(listOf("m=a", "v=1"), (0 until 2).map { e.getJSONArray("txt").getString(it) })
    }

    @Test
    fun unusableResolvesAreNotReportedAndRepeatsAreOne() {
        watching(a)
        val w = fake.watchListeners[a]!!
        w.onResolved(resolved(a))
        w.onResolved(resolved(a, "192.168.1.9", port = 0))
        assertTrue(poll().isEmpty())
        repeat(500) { w.onResolved(resolved(a, "192.168.1.9")) }
        assertEquals(1, poll().size)
        w.onResolved(resolved(a, "192.168.1.9"))
        assertTrue(poll().isEmpty())
        w.onResolved(resolved(a, "192.168.1.9", "10.0.0.7"))
        assertEquals(1, poll().size)
    }

    @Test
    fun txtIsBoundedToEightEntriesWithinTheDnsLimit() {
        watching(a)
        val attrs = (0 until 20).associate { "k%02d".format(it) to "v".toByteArray() as ByteArray? } + ("zz" to ByteArray(300) { 'x'.code.toByte() })
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9", attrs = attrs))
        val txt = poll().single().getJSONArray("txt")
        assertEquals(8, txt.length())
        assertEquals("k00=v", txt.getString(0))
    }

    @Test
    fun lossAfterFoundIsReportedOnceAndALossNobodySawIsNot() {
        watching(a)
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9"))
        poll()
        fake.browseListener!!.onLost(a)
        fake.browseListener!!.onLost(a)
        assertEquals(1, fake.watchStops.size)
        val e = poll().single()
        assertEquals("nsd_lost", e.getString("ev"))
        // Found then lost between two polls: the app never saw it, so there is nothing to retract.
        fake.browseListener!!.onFound(b)
        fake.watchListeners[b]!!.onResolved(resolved(b, "192.168.1.8"))
        fake.browseListener!!.onLost(b)
        assertTrue(poll().isEmpty())
    }

    @Test
    fun theBufferIsBoundedByTheWatchedNamesWhateverTheNetworkDoes() {
        watching(a)
        val w = fake.watchListeners[a]!!
        repeat(5000) { w.onResolved(resolved(a, "192.168.1.9", port = 1 + it % 60000)) }
        repeat(5000) { w.onLost(a); w.onResolved(resolved(a, "10.0.0.${it % 250}")) }
        val events = poll()
        assertTrue(events.size <= 2)
        assertEquals(0, op("poll").getInt("dropped"))
    }

    @Test
    fun changingTheNamesRestartsTheBrowseAndDropsWhatLeft() {
        watching(a)
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9"))
        poll()
        assertEquals(1, fake.browses)
        assertTrue(op("nsd_accept") { put("names", names(b)) }.getBoolean("ok"))
        assertEquals(2, fake.browses)
        assertEquals(1, fake.browseStops)
        assertEquals(listOf(a), fake.watchStops)
        assertEquals("nsd_lost", poll().single().getString("ev"))
        // The same set again changes nothing.
        op("nsd_accept") { put("names", names(b)) }
        assertEquals(2, fake.browses)
    }

    @Test
    fun aWatchTheOsRefusesIsDroppedAndReported() {
        watching(a)
        fake.watchListeners[a]!!.onFailed("limit")
        val e = poll().single()
        assertEquals("nsd_error", e.getString("ev"))
        assertEquals("limit", e.getString("reason"))
        // Platform text never leaves: any other word is "failed".
        fake.browseListener!!.onFailed("discovery_3 with detail")
        assertEquals("failed", poll().single().getString("reason"))
    }

    @Test
    fun stopAllEndsEverythingAndForgetsTheNames() {
        op("nsd_advertise") { put("instance", a).put("port", 4100) }
        watching(a)
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9"))
        assertTrue(op("nsd_stop_all").getBoolean("ok"))
        assertEquals(1, fake.advertStops)
        assertEquals(1, fake.browseStops)
        assertEquals(listOf(a), fake.watchStops)
        assertTrue(poll().isEmpty())
        op("nsd_browse_start")
        assertFalse(fake.browseAccept!!(a))
    }

    @Test
    fun unknownNsdOpsAreRefused() {
        assertEquals("unknown_op", c.nsd.handle("nsd_nope", JSONObject()).getString("error"))
        assertNull(op("poll").optJSONObject("nsd"))
    }

    @Test
    fun anUpdateWithNothingDialableRetractsTheName() {
        watching(a)
        val w = fake.watchListeners[a]!!
        w.onResolved(resolved(a, "192.168.1.9"))
        poll()
        w.onResolved(resolved(a))
        assertEquals("nsd_lost", poll().single().getString("ev"))
        w.onResolved(resolved(a, "192.168.1.9"))
        poll()
        w.onResolved(resolved(a, "192.168.1.9", port = 0))
        assertEquals("nsd_lost", poll().single().getString("ev"))
    }

    @Test
    fun aChangedNameSetReopensOnlyThroughThePermissionGate() {
        watching(a)
        fake.watchListeners[a]!!.onResolved(resolved(a, "192.168.1.9"))
        poll()
        fake.permission = NsdCommands.Permission.DENIED
        assertTrue(op("nsd_accept") { put("names", names(b)) }.getBoolean("ok"))
        assertEquals(1, fake.browses)
        assertEquals("nsd_lost", poll().single().getString("ev"))
        fake.permission = NsdCommands.Permission.NOT_REQUIRED
        assertTrue(op("nsd_browse_start").getBoolean("ok"))
        assertEquals(2, fake.browses)
    }
}
