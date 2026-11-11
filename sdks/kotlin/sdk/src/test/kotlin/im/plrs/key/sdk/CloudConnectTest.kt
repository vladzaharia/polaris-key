// @pkey-feature connect.app connect.local
//
// `client.cloudConnect` (CC-12.15; WIRE-CONTRACT-V5 section 15; plans CC-01 G9, G18, G21): two real clients
// of one person, a fake LAN, the in-process relay room and a scripted Worker that signs real rosters and
// certificates. Mirrors sdk-node's `cloudConnect.test.ts` and the Python `test_cloud_connect.py`.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.StoreException
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.identity.SignOutResult
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class CloudConnectTest {
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    private val clients = ArrayList<PolarisKeyClient>()

    @After
    fun tearDown() {
        for (c in clients) runBlocking { c.cloudConnect.stopForSignOut() }
        for (c in clients) c.close()
    }

    private fun until(timeoutMillis: Long = 8000, cond: () -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(10)
        }
    }

    /** One LAN: every advert and browser on one network, all at 127.0.0.1. */
    private class Network : MdnsAdapter {
        val adverts = LinkedHashMap<String, MdnsAdvert>()
        val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()

        private fun found(a: MdnsAdvert) = MdnsFound(a.instance, "127.0.0.1", a.port, a.txt)

        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
            synchronized(adverts) { adverts[advert.instance] = advert }
            for ((up, _) in browsers) up(found(advert))
            return MdnsHandle {
                synchronized(adverts) { adverts.remove(advert.instance) }
                for ((_, down) in browsers) down(advert.instance)
            }
        }

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle {
            val b = onUp to onDown
            browsers += b
            for (a in synchronized(adverts) { adverts.values.toList() }) onUp(found(a))
            return MdnsHandle { browsers -= b }
        }
    }

    /** A Connect state storage whose removal fails on demand; everything else is the wrapped storage. */
    private class FaultyState(val inner: im.plrs.key.core.InMemoryDeviceKeyStorage) : DeviceKeyStorage by inner {
        var removeFault: Exception? = null

        override suspend fun clear() {
            removeFault?.let { throw it }
            inner.clear()
        }

        override suspend fun deleteRecord() {
            removeFault?.let { throw it }
            inner.deleteRecord()
        }
    }

    private class Device(val id: String, val port: DeviceKeyPort, val signKey: String, val agreeKey: String)

    private fun device(id: String): Device = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val k = port.ensure()
        Device(id, port, k.signKey, k.agreeKey)
    }

    private val disc = ByteArray(32) { (it + 1).toByte() }

    /** The world: two devices, one relay room, and the discovery fragment and counters the tests turn. */
    private inner class World {
        val a = device(idA)
        val b = device(idB)
        val room = FakeRoom(setOf(idA, idB))
        val net = Network()
        private val ticketUrl = "https://key.plrs.im/djdl/connect/relay/ticket"
        var connectFragment = """{"enabled":true,"relay":true,"endpoints":{"identity":"x","devices":"y","ticket":"$ticketUrl"}}"""
        val tickets = AtomicInteger()
        val deauthorized = AtomicInteger()

        fun ring(): String = ringAt(1, listOf(a, b))

        fun ringAt(epoch: Int, keep: List<Device>): String = this@CloudConnectTest.signer.sign(
            "pkey-ring+jws",
            JsonObject(
                mapOf(
                    "iss" to JsonPrimitive("key.plrs.im"),
                    "aud" to JsonPrimitive("djdl"),
                    "sub" to JsonPrimitive(sub),
                    "epoch" to jsonInt(epoch.toLong()),
                    "issuedAt" to jsonInt(now),
                    "expiresAt" to jsonInt(now + 604_800),
                    "devices" to JsonArray(
                        keep.sortedBy { it.id }.map {
                            JsonObject(
                                mapOf(
                                    "deviceId" to JsonPrimitive(it.id),
                                    "signKey" to JsonPrimitive(it.signKey),
                                    "agreeKey" to JsonPrimitive(it.agreeKey),
                                ),
                            )
                        },
                    ),
                ),
            ),
        )

        fun handle(me: Device, r: PolarisRequest): PolarisResponse = when {
            r.path.endsWith("/.well-known/polaris.json") -> respond(
                200,
                """{"product":"djdl","services":{"connect":$connectFragment,"identity":{"enabled":true,"account":true,""" +
                    """"endpoints":{"signout":"https://key.plrs.im/djdl/identity/signout"}}}}""",
            )

            r.path.endsWith("/identity/signout") -> respond(200, """{"released":false}""")

            r.path.endsWith("/devices/keys") -> respond(200, """{"keySeq":1}""")

            r.path.endsWith("/license/deauthorize") -> {
                deauthorized.incrementAndGet()
                respond(200, "{}")
            }

            r.path.endsWith("/connect/relay/ticket") -> {
                tickets.incrementAndGet()
                val g = room.issue(me.id, "wss://key.plrs.im/djdl/connect/relay")
                respond(200, """{"ticket":"${g.ticket}","url":"${g.url}","protocol":"pkey-relay.1","expiresAt":${now + 60}}""")
            }

            r.path.endsWith("/connect/identity") -> {
                val cert = signer.sign(
                    "pkey-peer+jws",
                    JsonObject(
                        mapOf(
                            "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                            "deviceId" to JsonPrimitive(me.id), "signKey" to JsonPrimitive(me.signKey), "agreeKey" to JsonPrimitive(me.agreeKey),
                            "ringEpoch" to jsonInt(1), "issuedAt" to jsonInt(now), "expiresAt" to jsonInt(now + 604_800),
                        ),
                    ),
                )
                val body = JsonObject(
                    mapOf(
                        "ring" to JsonPrimitive(ring()),
                        "certificate" to JsonPrimitive(cert),
                        "discKeys" to JsonArray(listOf(JsonPrimitive(im.plrs.key.core.Base64Url.encode(disc)))),
                    ),
                )
                respond(200, body.toString())
            }

            r.path.endsWith(
                "/connect/devices",
            ) -> respond(200, """{"devices":[{"deviceId":"${me.id}","label":"Mac","platform":"macos","lastSeen":1700000000,"self":true}]}""")

            else -> respond(404, "")
        }

        fun client(me: Device, trustRefresh: Boolean = false, state: DeviceKeyStorage? = null, signedIn: Boolean = true): PolarisKeyClient =
            runBlocking {
                val store = InMemoryStore("djdl", me.id)
                if (signedIn) store.setToken("pkeyt_held")
                PolarisKeyClient.create(
                    PolarisKeyClientOptions(
                        core = CoreOptions(
                            productSlug = "djdl",
                            version = "1.0.0",
                            pinnedKeys = signer.trust,
                            trustRefresh = trustRefresh,
                            store = store,
                            transport = ScriptedTransport { handle(me, it) },
                            clock = { now },
                            deviceName = "Test",
                        ),
                        license = LicenseClientOptions(fingerprint = false),
                        connect = ConnectOptions(deviceKeys = me.port, allowEphemeralKeys = true, state = state),
                    ),
                ).also { clients += it }
            }

        fun options(lan: Boolean = true, relay: Boolean = true, permission: Boolean = true, attempt: Double = 4.0): CloudConnectOptions =
            CloudConnectOptions(
                lan = lan,
                lanOptions = LanOptions(mdns = net, allowLoopback = true, host = "127.0.0.1", lanPermission = { permission }),
                relay = relay,
                lanAttemptSeconds = attempt,
            ).also {
                it.relayOptions = RelayOptions(opener = room::opener, sleep = ManualSleep(), random = { 0.5 }, pingSeconds = 1000.0)
            }
    }

    private fun both(w: World, o: () -> CloudConnectOptions = { w.options() }): Pair<PolarisKeyClient, PolarisKeyClient> {
        val ca = w.client(w.a)
        val cb = w.client(w.b)
        runBlocking {
            ca.cloudConnect.start(o())
            cb.cloudConnect.start(o())
        }
        return ca to cb
    }

    @Test
    fun deactivationLeavesCloudConnect() = runBlocking {
        for (viaRoster in listOf(false, true)) {
            val w = World()
            val (ca, _) = both(w)
            until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
            val s = ca.cloudConnect.open(idB)
            assertNotNull(ca.connect.discoveryKeys())
            if (viaRoster) ca.deauthorizeDevice(idA) else ca.license.deactivate()
            until { s.closed != null }
            assertFalse(ca.cloudConnect.status().running)
            assertNull(ca.connect.current())
            assertNull(ca.connect.discoveryKeys())
            assertEquals(1, w.deauthorized.get())
        }
    }

    @Test
    fun deactivationStopsWhenConnectStateCannotBeCleared() = runBlocking {
        val w = World()
        val state = FaultyState(im.plrs.key.core.InMemoryDeviceKeyStorage())
        val ca = w.client(w.a, state = state)
        ca.cloudConnect.start(w.options())
        assertNotNull(ca.connect.discoveryKeys())
        state.removeFault = StoreException("busy")
        try {
            ca.license.deactivate()
            fail("expected store_failed")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.storeFailed, e.code)
        }
        assertNotNull(ca.core.token())
        assertEquals("no deauthorize request was sent", 0, w.deauthorized.get())
        // Once the state can be removed, a retry completes.
        state.removeFault = null
        ca.license.deactivate()
        assertNull(ca.core.token())
        assertNull(ca.connect.discoveryKeys())
        assertEquals(1, w.deauthorized.get())
    }

    @Test
    fun lanComesUpBeforeTheRelayAndPeersReportTheirPaths() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        until { ca.cloudConnect.status().relay == "open" && cb.cloudConnect.status().relay == "open" }
        val st = ca.cloudConnect.status()
        assertTrue(st.running)
        assertEquals("on", st.lan)
        assertNull(st.relayReason)
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        ca.cloudConnect.refreshPeers()
        val p = ca.cloudConnect.peers().single()
        assertEquals(CloudPeer(idB, lan = true, relay = true), p)
        assertEquals(1, w.tickets.get() / 2)
        assertEquals(idA, ca.cloudConnect.devices().single().deviceId)
    }

    @Test
    fun discoveryAndTheHostTurnTheRelayOffWithNoSocketAndNoTicket() = runBlocking {
        val fragments = mapOf(
            """{"enabled":true,"relay":false,"endpoints":{"identity":"x"}}""" to "product",
            """{"enabled":true,"endpoints":{"identity":"x","devices":"y"}}""" to "no_ticket",
        )
        for ((fragment, reason) in fragments) {
            val w = World()
            w.connectFragment = fragment
            val c = w.client(w.a)
            c.cloudConnect.start(w.options())
            val st = c.cloudConnect.status()
            assertEquals("off", st.relay)
            assertEquals(reason, st.relayReason)
            assertEquals("on", st.lan)
            assertEquals(0, w.tickets.get())
            assertEquals(0, w.room.ever.size)
        }
        val w = World()
        val c = w.client(w.a)
        c.cloudConnect.start(w.options(relay = false))
        assertEquals("host", c.cloudConnect.status().relayReason)
        assertEquals(0, w.tickets.get())
        // A discovery that does not mention the relay allows it.
        assertNull(relayWanted(null))
    }

    @Test
    fun aLanThatCannotStartIsNotFatalWhileTheRelayIsOn() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        c.cloudConnect.start(w.options(permission = false))
        val st = c.cloudConnect.status()
        assertEquals("failed", st.lan)
        assertTrue(st.lanError is LanException)
        assertEquals(LanErrorReason.permission_denied, (st.lanError as LanException).reason)
        until { c.cloudConnect.status().relay == "open" }
        assertTrue(c.cloudConnect.status().running)
    }

    private class FakePlatform(override val mdns: MdnsAdapter?, var verdict: LocalNetworkVerdict = LocalNetworkVerdict.Ok) : ConnectPlatform {
        override suspend fun localNetwork(): LocalNetworkVerdict = verdict
    }

    /** Run [block] as Android with [platform] installed (the JVM stands in), and put both back. */
    private fun <T> asAndroid(platform: ConnectPlatform?, block: () -> T): T {
        ConnectPlatforms.android = true
        ConnectPlatforms.installed = platform
        try {
            return block()
        } finally {
            ConnectPlatforms.android = im.plrs.key.core.RuntimeFamily.isAndroid
            ConnectPlatforms.installed = null
        }
    }

    private fun androidOptions(w: World) = CloudConnectOptions(
        lanOptions = LanOptions(allowLoopback = true, host = "127.0.0.1"),
        lanAttemptSeconds = 4.0,
    ).also { it.relayOptions = RelayOptions(opener = w.room::opener, sleep = ManualSleep(), random = { 0.5 }, pingSeconds = 1000.0) }

    @Test
    fun androidUsesTheInstalledPlatformWhenTheHostBroughtNoAdapter() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        asAndroid(FakePlatform(w.net)) { runBlocking { c.cloudConnect.start(androidOptions(w)) } }
        val st = c.cloudConnect.status()
        assertEquals("on", st.lan)
        assertNull(st.lanReason)
        assertEquals(1, w.net.adverts.size)
    }

    @Test
    fun androidWithoutAnAdapterAnswersUnsupportedAndTheRelayStillWorks() = runBlocking {
        for (platform in listOf(null, FakePlatform(null))) {
            val w = World()
            val c = w.client(w.a)
            asAndroid(platform) { runBlocking { c.cloudConnect.start(androidOptions(w)) } }
            val st = c.cloudConnect.status()
            assertEquals("off", st.lan)
            assertEquals("unsupported", st.lanReason)
            until { c.cloudConnect.status().relay == "open" }
        }
    }

    @Test
    fun androidMapsTheLocalNetworkPermissionToItsRegisteredCodes() = runBlocking {
        val denied = World()
        val c1 = denied.client(denied.a)
        asAndroid(FakePlatform(denied.net, LocalNetworkVerdict.Denied)) { runBlocking { c1.cloudConnect.start(androidOptions(denied)) } }
        val e1 = c1.cloudConnect.status().lanError as LanException
        assertEquals(LanErrorReason.permission_denied, e1.reason)
        assertEquals("nearby-permission-denied", e1.code)
        assertTrue(denied.net.adverts.isEmpty())

        val missing = World()
        val c2 = missing.client(missing.a)
        asAndroid(FakePlatform(missing.net, LocalNetworkVerdict.NotDeclared)) { runBlocking { c2.cloudConnect.start(androidOptions(missing)) } }
        val e2 = c2.cloudConnect.status().lanError as PolarisException
        assertEquals("not-configured", e2.code)
        assertTrue(missing.net.adverts.isEmpty())
        // The relay keeps working either way.
        until { c2.cloudConnect.status().relay == "open" }
    }

    @Test
    fun aLanErrorIsThrownWhenTheRelayIsOffToo() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        try {
            c.cloudConnect.start(w.options(permission = false, relay = false))
            fail("expected permission_denied")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.permission_denied, e.reason)
        }
        assertFalse(c.cloudConnect.status().running)
        assertEquals(0, w.tickets.get())
    }

    @Test
    fun openBeforeStartAndForADeviceNobodyCanReach() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        try {
            c.cloudConnect.open(idB)
            fail("not started")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.not_started, e.reason)
        }
        c.cloudConnect.start(w.options(relay = false))
        try {
            c.cloudConnect.open(idB)
            fail("unknown")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.unknown_peer, e.reason)
        }
    }

    @Test
    fun openTakesTheLanWhenTheDeviceWasSeenThereAndTheRelayOtherwise() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        val got = CopyOnWriteArrayList<ConnectSession>()
        cb.cloudConnect.onChannel { got += it }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        assertEquals("lan", s.path)
        until { got.isNotEmpty() }
        s.send("hi".toByteArray())
        assertEquals("hi", String(got[0].receive(5000).body))
        s.close()
        // A relay-only pair: nothing on the LAN, so the relay carries it.
        val w2 = World()
        val (ra, rb) = both(w2) { w2.options(lan = false) }
        val got2 = CopyOnWriteArrayList<ConnectSession>()
        rb.cloudConnect.onChannel { got2 += it }
        until { ra.cloudConnect.status().relay == "open" && rb.cloudConnect.status().relay == "open" }
        ra.cloudConnect.refreshPeers()
        val r = ra.cloudConnect.open(idB)
        assertEquals("relay", r.path)
        until { got2.isNotEmpty() }
        r.send("yo".toByteArray())
        assertEquals("yo", String(got2[0].receive(5000).body))
    }

    @Test
    fun aFailedLanAttemptFallsBackToTheRelayUnlessTheHostSaidNo() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        until { ca.cloudConnect.status().relay == "open" && cb.cloudConnect.status().relay == "open" }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val got = CopyOnWriteArrayList<ConnectSession>()
        cb.cloudConnect.onChannel { got += it }
        ca.cloudConnect.refreshPeers()
        val s = ca.cloudConnect.open(idB, relay = true, lanAttemptSeconds = 0.0001)
        assertTrue(s.path == "relay" || s.path == "lan")
        s.close()
        try {
            ca.cloudConnect.open("CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB", relay = false)
            fail("unknown")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.unknown_peer, e.reason)
        }
    }

    @Test
    fun anInboundSessionWithNoListenerIsClosedWithPeerBye() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        until { s.closed != null }
        assertEquals("peer_bye", s.closed!!.code)
        assertTrue(s.closed!!.byPeer)
        assertTrue(ca.cloudConnect.status().running)
        assertTrue(cb.cloudConnect.status().running)
    }

    @Test
    fun storedRosterClosesSessionsWithDroppedDevice() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        cb.cloudConnect.onChannel { }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        val src = ca.cloudConnect.watch(lanSource(ca.connect, now = { now }))
        val adopt = src.adoptRing!!
        fun roster(epoch: Int, vararg keep: Device): String = w.ringAt(epoch, keep.toList())
        // A roster that only adds devices keeps the session.
        assertTrue(adopt(roster(2, w.a, w.b)) is RingAdoption.Stored)
        Thread.sleep(200)
        assertNull(s.closed)
        // A roster that drops the peer ends it.
        assertTrue(adopt(roster(3, w.a)) is RingAdoption.Stored)
        until { s.closed != null }
        assertEquals("peer_revoked", s.closed!!.code)
        assertTrue(cb.cloudConnect.status().running)
    }

    @Test
    fun aListenerCanBeRemovedAndARaisingOneDoesNotEndTheSession() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        val seen = CountDownLatch(1)
        val off = cb.cloudConnect.onChannel { throw IllegalStateException("host bug") }
        cb.cloudConnect.onChannel {
            seen.countDown()
        }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        assertTrue(seen.await(5, TimeUnit.SECONDS))
        assertNull(s.closed)
        off()
        s.close()
    }

    @Test
    fun stopClosesSessionsTheRelayAndTheLanAndIsSafeTwiceAndBeforeStart() = runBlocking {
        val w = World()
        val idle = w.client(w.a)
        idle.cloudConnect.stop() // before start: nothing
        val (ca, cb) = both(w)
        cb.cloudConnect.onChannel { }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        ca.cloudConnect.stop()
        ca.cloudConnect.stop()
        assertFalse(ca.cloudConnect.status().running)
        assertEquals("off", ca.cloudConnect.status().relay)
        assertEquals("off", ca.cloudConnect.status().lan)
        assertTrue(ca.cloudConnect.peers().isEmpty())
        until { s.closed != null }
        until { w.room.sockets.none { it.device == idA } }
        // And it can start again.
        ca.cloudConnect.start(w.options())
        assertTrue(ca.cloudConnect.status().running)
    }

    @Test
    fun aBlockedHostCallbackDoesNotHoldSignOutOrKeepTheTransportsUp() = runBlocking {
        val w = World()
        val (ca, cb) = both(w)
        val release = CountDownLatch(1)
        val inCallback = CountDownLatch(1)
        cb.cloudConnect.onChannel { s ->
            s.onMessage {
                inCallback.countDown()
                release.await() // a host callback that never returns
            }
        }
        until { ca.cloudConnect.peers().any { it.deviceId == idB && it.lan } }
        val s = ca.cloudConnect.open(idB)
        s.send("hello".toByteArray())
        assertTrue(inCallback.await(5, TimeUnit.SECONDS))
        cb.cloudConnect.stopMillis = 300
        val t0 = System.nanoTime()
        cb.cloudConnect.stopForSignOut() // never fails
        val took = (System.nanoTime() - t0) / 1_000_000
        try {
            assertTrue("sign-out waited $took ms", took < 12_000)
            assertFalse(cb.cloudConnect.status().running)
            assertEquals("off", cb.cloudConnect.status().relay)
            assertEquals("off", cb.cloudConnect.status().lan)
            until { w.room.sockets.none { it.device == idB } }
            until { s.closed != null }
        } finally {
            release.countDown()
        }
    }

    @Test
    fun signingOutStopsConnectBeforeTheCredentialGoes() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        c.cloudConnect.start(w.options())
        until { c.cloudConnect.status().relay == "open" }
        val running = AtomicInteger(-1)
        // The sign-out request is the first thing that reads the token; by then Connect has stopped.
        val r = c.identity.signOut()
        running.set(if (c.cloudConnect.status().running) 1 else 0)
        assertTrue(r is SignOutResult.SignedOut)
        assertEquals(0, running.get())
        assertEquals("off", c.cloudConnect.status().relay)
        until { w.room.sockets.none { it.device == idA } }
    }

    @Test
    fun aPeerTrustManifestFollowsTheHostsTrustRefreshSwitch() = runBlocking {
        val w = World()
        val off = w.client(w.a, trustRefresh = false)
        val refused = off.cloudConnect.applyPeerTrust("x.y.z")
        assertFalse(refused.applied)
        assertEquals(PEER_TRUST_REFRESH_OFF, refused.reason)
    }

    @Test
    fun noKeyOrTicketIsInAnyString() = runBlocking {
        val w = World()
        val c = w.client(w.a)
        c.cloudConnect.start(w.options())
        until { c.cloudConnect.status().relay == "open" }
        val text = c.cloudConnect.toString() + c.cloudConnect.status().toString() + w.options().toString()
        assertFalse(text.contains("pkeyrt_"))
        assertFalse(text.contains(im.plrs.key.core.Base64Url.encode(disc)))
    }

    // -- local links with no account (CC-29; WIRE-CONTRACT-V5 section 15.12) -------------------------

    private val localFragment =
        """{"enabled":true,"localPairing":true,"relay":true,"endpoints":{"identity":"x","devices":"y",""" +
            """"ticket":"https://key.plrs.im/djdl/connect/relay/ticket"}}"""

    private fun linkRow(c: PolarisKeyClient): String = runBlocking {
        val r = java.security.SecureRandom()

        fun k() = ByteArray(32).also { r.nextBytes(it) }
        c.connect.local.store.add(NewLocalLink(k(), k(), k(), k(), "Bo", listOf("docs")), 1L)!!
    }

    @Test
    fun localLinksKeptInMemoryOnlyWarnOnceThroughTheSdkLogger() = runBlocking {
        val w = World()
        val c = w.client(w.a, signedIn = false)
        val seen = java.util.concurrent.CopyOnWriteArrayList<String>()
        val logger = java.util.logging.Logger.getLogger("im.plrs.key")
        val handler = object : java.util.logging.Handler() {
            override fun publish(record: java.util.logging.LogRecord) {
                seen += record.message
            }

            override fun flush() = Unit

            override fun close() = Unit
        }
        logger.addHandler(handler)
        try {
            c.connect.local.store.rows()
            c.connect.local.store.rows()
            linkRow(c)
        } finally {
            logger.removeHandler(handler)
        }
        assertEquals(1, seen.count { it.contains("kept in memory only") })
    }

    private fun Network.kinds(): List<String> = synchronized(adverts) { adverts.values.map { a -> a.txt.first { it.startsWith("m=") } } }

    @Test
    fun withNoAccountTheLanServiceServesLocalLinksAloneAndOnlyWhileALinkIsHeld() = runBlocking {
        val w = World()
        w.connectFragment = localFragment
        val c = w.client(w.a, signedIn = false)
        c.discover()
        assertTrue(c.cloudConnect.localLinks.localPairing())
        c.cloudConnect.start(w.options())
        // No link yet: nothing is bound and nothing is advertised (nothing to find, nothing to scan).
        assertTrue(c.cloudConnect.status().running)
        assertEquals("off", c.cloudConnect.status().lan)
        assertTrue(w.net.adverts.isEmpty())
        // The first link brings the listener up, reachable by default; no account name is ever advertised.
        val id = linkRow(c)
        c.connect.local.notifyChanged()
        until { c.cloudConnect.status().lan == "on" && w.net.kinds() == listOf("m=l") }
        assertEquals(0, w.tickets.get())
        // The last link forgotten takes it down again.
        assertTrue(c.cloudConnect.localLinks.remove(id))
        until { c.cloudConnect.status().lan == "off" && w.net.adverts.isEmpty() }
        assertTrue(c.cloudConnect.status().running)
    }

    @Test
    fun noAccountAndNoLocalGateStillAnswersTheAccountErrorAndStartsNothing() = runBlocking {
        val w = World()
        val c = w.client(w.a, signedIn = false)
        c.discover()
        assertFalse(c.cloudConnect.localLinks.localPairing())
        try {
            c.cloudConnect.start(w.options())
            fail("expected no-token")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.noToken, e.code)
        }
        assertFalse(c.cloudConnect.status().running)
    }

    @Test
    fun signOutKeepsLocalLinksReachableWithoutTheAccountHalfAndStopNeverRestartsThem() = runBlocking {
        val w = World()
        w.connectFragment = localFragment
        val c = w.client(w.a)
        c.discover()
        linkRow(c)
        c.cloudConnect.start(w.options(relay = false))
        until { w.net.kinds().sorted() == listOf("m=a", "m=l") }
        c.cloudConnect.stopForSignOut()
        until { w.net.kinds() == listOf("m=l") }
        assertTrue(c.cloudConnect.status().running)
        // stop() ends everything and does not bring the local-only service back.
        c.cloudConnect.stop()
        until { w.net.adverts.isEmpty() }
        assertFalse(c.cloudConnect.status().running)
    }

    @Test
    fun aDiscoveryReadThatClearsTheGateWithdrawsTheLocalAdverts() = runBlocking {
        val w = World()
        w.connectFragment = localFragment
        val c = w.client(w.a, signedIn = false)
        c.discover()
        linkRow(c)
        c.cloudConnect.start(w.options())
        until { w.net.kinds() == listOf("m=l") }
        w.connectFragment = """{"enabled":true,"relay":true,"endpoints":{"identity":"x","devices":"y"}}"""
        c.discover()
        assertFalse(c.cloudConnect.localLinks.localPairing())
        until { w.net.adverts.isEmpty() }
        // The link stays on disk, inert; the gate coming back brings the advert back.
        assertEquals(1, c.cloudConnect.localLinks.list().size)
        w.connectFragment = localFragment
        c.discover()
        until { w.net.kinds() == listOf("m=l") }
    }

    @Test
    fun localLinksOnChangeFollowsTheGateTheListAndTheLastSeenTime() = runBlocking {
        val w = World()
        val c = w.client(w.a, signedIn = false)
        val links = c.cloudConnect.localLinks
        var n = 0
        val off = links.onChange { n++ }
        // The gate flips on: an event, in both directions.
        w.connectFragment = localFragment
        c.discover()
        assertTrue(links.localPairing())
        val flipped = n
        assertTrue(flipped >= 1)
        w.connectFragment = """{"enabled":true,"relay":true,"endpoints":{"identity":"x","devices":"y"}}"""
        c.discover()
        assertFalse(links.localPairing())
        assertTrue(n > flipped)
        // Rename is an event even with the gate off (never gated); a last-seen write is one, a repeat in the hour is not.
        val id = linkRow(c)
        val before = n
        assertTrue(links.rename(id, "Studio"))
        assertEquals(before + 1, n)
        val row = c.connect.local.store.rows().single()
        val ref = LocalRef(id, row.label, row.cats, row.peerKey, localTag(im.plrs.key.core.Base64Url.decode(row.secret)!!))
        c.connect.local.touch(ref)
        assertEquals(before + 2, n)
        c.connect.local.touch(ref)
        assertEquals(before + 2, n)
        off()
        links.rename(id, "Again")
        assertEquals(before + 2, n)
    }
}
