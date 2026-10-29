// @pkey-feature connect.lan
//
// The LAN service (CC-12.12; WIRE-CONTRACT-V5 sections 15.4 to 15.6): two services, a fake mDNS network
// and real TCP on 127.0.0.1 (loopback allowed in these tests only). Mirrors sdk-node's `lan.e2e.test.ts`
// and the Python `test_connect_lan.py`.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.ADVERT_EPOCH_SECONDS
import im.plrs.key.core.peer.accountInstance
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ConnectLanTest {
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val now0 = 1_700_000_000L
    private val signer = TestSigner()
    private val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    private val idC = "CCCCDDDDEEEEFFFFGGGGHHHHAAAABBBB"
    private val rng = SecureRandom()
    private val scope = CoroutineScope(Dispatchers.Default + Job())
    private val services = ArrayList<LanService>()

    @After
    fun tearDown() {
        for (s in services) runBlocking { s.stop() }
        scope.cancel()
    }

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    private fun until(timeoutMillis: Long = 8000, cond: () -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(10)
        }
    }

    // -- a fake LAN: every advert and browser on one network, all at 127.0.0.1 ----------------------

    private class Network : MdnsAdapter {
        val adverts = LinkedHashMap<String, MdnsAdvert>()
        val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()
        val log = CopyOnWriteArrayList<String>()

        private fun found(a: MdnsAdvert) = MdnsFound(a.instance, "127.0.0.1", a.port, a.txt)

        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
            synchronized(adverts) { adverts[advert.instance] = advert }
            log += "up " + advert.instance
            for ((up, _) in browsers) up(found(advert))
            return MdnsHandle {
                synchronized(adverts) { adverts.remove(advert.instance) }
                log += "down " + advert.instance
                for ((_, down) in browsers) down(advert.instance)
            }
        }

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle {
            val b = onUp to onDown
            browsers += b
            for (a in synchronized(adverts) { adverts.values.toList() }) onUp(found(a))
            return MdnsHandle { browsers -= b }
        }

        fun inject(f: MdnsFound) {
            for ((up, _) in browsers) up(f)
        }

        fun names(): List<String> = synchronized(adverts) { adverts.keys.toList() }
    }

    // -- devices and sources --------------------------------------------------------------------

    private class Device(val id: String, val port: DeviceKeyPort, val signKey: String, val agreeKey: String)

    private fun device(id: String): Device = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val k = port.ensure()
        Device(id, port, k.signKey, k.agreeKey)
    }

    private fun ring(devs: List<Device>, epoch: Long, subject: String = sub): String = signer.sign(
        "pkey-ring+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"),
                "aud" to JsonPrimitive("djdl"),
                "sub" to JsonPrimitive(subject),
                "epoch" to jsonInt(epoch),
                "issuedAt" to jsonInt(now0 - 10),
                "expiresAt" to jsonInt(now0 + 600_000),
                "devices" to JsonArray(
                    devs.sortedBy { it.id }.map {
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

    private inner class World {
        val a = device(idA)
        val b = device(idB)
        val k = rnd()
        val ring = ring(listOf(a, b), 1)
        val net = Network()

        @Volatile
        var now = now0

        fun peerSource(
            d: Device,
            keys: ByteArray = k,
            certExp: Long = now0 + 1000,
            ringJws: String = ring,
            subject: String = sub,
            roster: List<String> = listOf(idA, idB),
        ): PeerSource {
            val cert = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(subject),
                        "deviceId" to JsonPrimitive(d.id), "signKey" to JsonPrimitive(d.signKey), "agreeKey" to JsonPrimitive(d.agreeKey),
                        "ringEpoch" to jsonInt(1), "issuedAt" to jsonInt(now0 - 10), "expiresAt" to jsonInt(certExp),
                    ),
                ),
            )
            return PeerSource(
                slug = "djdl", trust = signer.trust, sub = subject, deviceId = d.id, certificate = cert, certificateExpiresAt = certExp,
                ring = ringJws, ringEpoch = 1, roster = roster, discovery = DiscoveryKeys(keys, null),
                agreePublic = Base64Url.decodeStrict(d.agreeKey)!!, keys = d.port,
            )
        }

        fun source(d: Device, ps: PeerSource = peerSource(d), onLoad: () -> PeerSource = { ps }) = LanSource(load = { onLoad() }, now = { now })

        fun start(
            d: Device,
            src: LanSource = source(d),
            mdns: MdnsAdapter = net,
            allowLoopback: Boolean = true,
            advertise: Boolean = true,
            browse: Boolean = true,
            maxPending: Int = 32,
            maxPendingPerAddress: Int = 4,
            handshakeSeconds: Double = 30.0,
            dialSeconds: Double = 5.0,
            rekeyMessages: Int? = null,
            timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
            lanPermission: suspend () -> Boolean = { true },
        ): LanService = runBlocking {
            val o = LanOptions(
                mdns = mdns, host = "127.0.0.1", allowLoopback = allowLoopback, advertise = advertise, browse = browse,
                maxPending = maxPending, maxPendingPerAddress = maxPendingPerAddress,
                handshakeSeconds = handshakeSeconds, dialSeconds = dialSeconds,
                rekeyMessages = rekeyMessages, timer = timer, lanPermission = lanPermission,
            )
            LanService.start(src, o).also { services += it }
        }
    }

    private fun pair(la: LanService, lb: LanService): Pair<ConnectSession, ConnectSession> {
        val inbound = CopyOnWriteArrayList<ConnectSession>()
        la.onSession { inbound += it }
        until { lb.peers().any { it.deviceId == idA } }
        val out = runBlocking { lb.connect(idA) }
        until { inbound.isNotEmpty() }
        return out to inbound[0]
    }

    // -- discovery and sessions -----------------------------------------------------------------

    @Test
    fun twoServicesFindEachOtherHandshakeExchangeRekeyAndClose() = runBlocking {
        val w = World()
        val la = w.start(w.a, rekeyMessages = 3)
        val lb = w.start(w.b, rekeyMessages = 3)
        until { la.peers().size == 1 && lb.peers().size == 1 }
        assertEquals(idB, la.peers()[0].deviceId)
        assertEquals(LanPeer(idA, "127.0.0.1", la.port), lb.peers()[0])
        // The advert carries the account instance name and `v=1`, `m=a` only.
        val name = accountInstance(w.k, advertEpoch(now0), idA)
        assertEquals(la.port, w.net.adverts[name]!!.port)
        assertEquals(listOf("v=1", "m=a"), w.net.adverts[name]!!.txt)
        assertTrue(la.port != lb.port)

        val (out, inn) = pair(la, lb)
        assertEquals(idA, out.peerDeviceId)
        assertEquals(idB, inn.peerDeviceId)
        assertEquals(listOf("app/1"), out.caps)
        assertEquals("lan", out.path)
        out.send("hello from b".toByteArray())
        assertEquals("hello from b", String(inn.receive(5000).body))
        inn.send("hello from a".toByteArray(), 0x0101)
        assertEquals(0x0101, out.receive(5000).type)
        repeat(8) {
            // past the rekey threshold in each direction
            out.send("b$it".toByteArray())
            inn.send("a$it".toByteArray())
        }
        assertEquals(List(8) { "b$it" }, List(8) { String(inn.receive(5000).body) })
        assertEquals(List(8) { "a$it" }, List(8) { String(out.receive(5000).body) })
        val order = CopyOnWriteArrayList<String>()
        inn.onClose { order += "inn:${it.code}:${it.byPeer}" }
        out.onClose { order += "out:${it.code}:${it.byPeer}" }
        out.close()
        until { order.size == 2 }
        assertEquals(listOf("inn:peer_bye:true", "out:peer_bye:false"), order.sorted())
        try {
            out.send("x".toByteArray())
            fail("closed")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
    }

    @Test
    fun aLargeMessageCrossesAndTheLimitsHold() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b)
        val (out, inn) = pair(la, lb)
        val big = ByteArray(1_048_576) { (it % 251).toByte() }
        out.send(big)
        assertTrue(big.contentEquals(inn.receive(10_000).body))
        try {
            out.send(ByteArray(1_048_577))
            fail("too large")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.too_large, e.reason)
        }
        try {
            out.send("x".toByteArray(), 0x8100)
            fail("bad type")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.bad_type, e.reason)
        }
        assertNull(out.closed)
    }

    @Test
    fun aDeviceThatWentAwayIsForgotten() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b)
        until { lb.peers().size == 1 }
        la.stop()
        until { lb.peers().isEmpty() }
    }

    @Test
    fun theAdvertRotatesAtTheEpochBoundaryAndDropsTheOldOne() = runBlocking {
        val w = World()
        val timers = CopyOnWriteArrayList<Pair<() -> Unit, Double>>()
        val svc = w.start(w.a, browse = false, timer = { secs, fn ->
            timers += fn to secs;
            {}
        })
        val first = accountInstance(w.k, advertEpoch(now0), idA)
        assertEquals(listOf(first), w.net.names())
        val (fn, secs) = timers.last()
        assertEquals((advertEpoch(now0) + 1) * ADVERT_EPOCH_SECONDS - now0, secs.toLong())
        w.now = (advertEpoch(now0) + 1) * ADVERT_EPOCH_SECONDS
        fn()
        val second = accountInstance(w.k, advertEpoch(w.now), idA)
        until { second in w.net.names() && first !in w.net.names() }
        assertEquals(listOf("up $first", "up $second", "down $first"), w.net.log.toList())
        until { timers.size == 2 }
        assertEquals(ADVERT_EPOCH_SECONDS, timers.last().second.toLong())
        assertEquals(svc.port, w.net.adverts[second]!!.port)
    }

    @Test
    fun aNewDiscoveryKeyChangesTheAdvertInsideTheEpoch() = runBlocking {
        val w = World()
        var key = w.k
        val svc = w.start(w.a, src = w.source(w.a, onLoad = { w.peerSource(w.a, keys = key) }), browse = false)
        val first = accountInstance(w.k, advertEpoch(now0), idA)
        assertTrue(first in w.net.names())
        key = rnd()
        svc.storedFromWorker()
        val second = accountInstance(key, advertEpoch(now0), idA)
        until { second in w.net.names() && first !in w.net.names() }
    }

    @Test
    fun forgedAndUnrelatedAdvertsAreDropped() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val right = accountInstance(w.k, advertEpoch(now0), idB)
        val wrongKey = accountInstance(ByteArray(32) { 7 }, advertEpoch(now0), idB)
        val me = accountInstance(w.k, advertEpoch(now0), idA)

        fun f(instance: String, host: String = "127.0.0.1", txt: List<String> = listOf("v=1", "m=a")) =
            w.net.inject(MdnsFound(instance, host, 4000, txt))
        f(wrongKey)
        f(me) // this device's own advert is not a peer
        f(right, txt = listOf("v=1", "m=v", "h=0123456789abcdef")) // wrong mode
        f(right, txt = listOf("v=2", "m=a"))
        f(right, txt = listOf("v=1", "m=a", "v=1")) // a repeated key
        f(right, host = "8.8.8.8") // not a LAN address
        f(right, host = "169.254.1.1")
        f("not-an-instance")
        Thread.sleep(300)
        assertTrue(la.peers().isEmpty())
        f(right)
        until { la.peers().size == 1 }
        assertEquals(idB, la.peers()[0].deviceId)
        assertEquals(4000, la.peers()[0].port)
    }

    @Test
    fun aPeerUnderThePreviousEpochIsAccepted() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        w.net.inject(MdnsFound(accountInstance(w.k, advertEpoch(now0) - 1, idB), "127.0.0.1", 4001, listOf("v=1", "m=a")))
        until { la.peers().size == 1 }
    }

    @Test
    fun aForgedNameIsNotWorkedOutTwice() = runBlocking {
        val w = World()
        val loads = AtomicInteger()
        val ps = w.peerSource(w.a)
        val la = w.start(
            w.a,
            src = w.source(w.a, onLoad = {
                loads.incrementAndGet()
                ps
            }),
        )
        val before = loads.get()
        val bogus = accountInstance(ByteArray(32) { 3 }, advertEpoch(now0), idB)
        repeat(5) {
            w.net.inject(MdnsFound(bogus, "127.0.0.1", 4000, listOf("v=1", "m=a")))
            Thread.sleep(50)
        }
        assertTrue(la.peers().isEmpty())
        assertTrue(loads.get() - before <= 1)
    }

    @Test
    fun itRefusesToStartWithoutAnIdentity() = runBlocking {
        val w = World()
        try {
            LanService.start(
                LanSource(load = { throw LanException(LanErrorReason.no_identity, "none") }, now = { now0 }),
                LanOptions(mdns = w.net),
            )
            fail("no identity")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.no_identity, e.reason)
        }
        assertTrue(w.net.adverts.isEmpty())
    }

    @Test
    fun aRefusedLocalNetworkPermissionOpensNothing() = runBlocking {
        val w = World()
        try {
            w.start(w.a, lanPermission = { false })
            fail("denied")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.permission_denied, e.reason)
            assertEquals("nearby-permission-denied", e.code)
        }
        assertTrue(w.net.adverts.isEmpty())
        assertTrue(w.net.browsers.isEmpty())
    }

    @Test
    fun aFailedStartReleasesWhatItOpened() = runBlocking {
        val w = World()
        val net = object : MdnsAdapter {
            val inner = Network()
            override suspend fun advertise(advert: MdnsAdvert) = inner.advertise(advert)

            override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle =
                error("no socket")
        }
        try {
            w.start(w.a, mdns = net)
            fail("browse fails")
        } catch (e: IllegalStateException) {
            assertEquals("no socket", e.message)
        }
        assertTrue(net.inner.adverts.isEmpty()) // the advert it had made is withdrawn
    }

    @Test
    fun itDoesNotDialAnUnknownDeviceOrAnAddressOffTheLan() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val targets: List<suspend () -> ConnectSession> = listOf(
            { la.connect(idC) },
            { la.connect(LanPeer(idB, "8.8.8.8", 9)) },
            { la.connect(LanPeer(idB, "169.254.1.1", 9)) },
            { la.connect(LanPeer(idB, "100.64.0.1", 9)) },
        )
        for (t in targets) {
            try {
                t()
                fail("unknown")
            } catch (e: LanException) {
                assertEquals(LanErrorReason.unknown_peer, e.reason)
            }
        }
    }

    @Test
    fun loopbackIsNotDialledUnlessTheCallerAllowsIt() = runBlocking {
        val w = World()
        val svc = w.start(w.a, allowLoopback = false, advertise = false, browse = false)
        try {
            svc.connect(LanPeer(idB, "127.0.0.1", 9))
            fail("loopback")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.unknown_peer, e.reason)
        }
    }

    @Test
    fun aRefusedConnectIsConnectFailed() = runBlocking {
        val w = World()
        val la = w.start(w.a, advertise = false, browse = false)
        try {
            la.connect(LanPeer(idB, "127.0.0.1", 1))
            fail("refused")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.connect_failed, e.reason)
        }
    }

    @Test
    fun theDeviceThatAnswersMustBeTheOneDialled() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b, advertise = false, browse = false)
        // B dials A's port believing it is device C.
        try {
            lb.connect(LanPeer(idC, "127.0.0.1", la.port))
            fail("wrong peer")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.wrong_peer, e.reason)
        }
    }

    @Test
    fun stopClosesOpenSessionsAndTheListener() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b)
        val (_, inn) = pair(la, lb)
        val gone = CountDownLatch(1)
        inn.onClose { gone.countDown() }
        val port = la.port
        la.stop()
        assertTrue(gone.await(5, TimeUnit.SECONDS))
        la.stop() // twice is fine
        try {
            la.connect(idB)
            fail("stopped")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.not_listening, e.reason)
        }
        assertFalse(la.listening)
        try {
            Socket("127.0.0.1", port).use {
                // On Linux a connect to a free ephemeral port can pair with itself (the kernel picks the
                // port as the source too): that is no listener. Anything else that answers is one.
                if (it.localPort != port) fail("the listener is closed")
            }
        } catch (e: java.io.IOException) {
            // refused
        }
    }

    @Test
    fun aServiceDoesNotLeakSecretsThroughToString() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        assertFalse(la.toString().contains(Base64Url.encode(w.k)))
        assertTrue(la.toString().startsWith("LanService"))
    }

    // -- admission refusals ---------------------------------------------------------------------

    private fun dialRefused(w: World, srcB: LanSource) {
        val la = w.start(w.a)
        val seen = CopyOnWriteArrayList<ConnectSession>()
        la.onSession { seen += it }
        val lb = w.start(w.b, srcB, advertise = false, browse = false)
        try {
            runBlocking { lb.connect(LanPeer(idA, "127.0.0.1", la.port)) }
            fail("refused")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.handshake_failed, e.reason)
        }
        Thread.sleep(100)
        assertTrue(seen.isEmpty())
    }

    @Test
    fun aWrongDiscoveryKeyIsRefusedWithoutASession() {
        val w = World()
        dialRefused(w, w.source(w.b, w.peerSource(w.b, keys = ByteArray(32) { 9 })))
    }

    @Test
    fun anExpiredCertificateIsRefused() {
        val w = World()
        dialRefused(w, w.source(w.b, w.peerSource(w.b, certExp = now0 - 5)))
    }

    private fun flooredAt(floor: Long, run: (World, LanService, LanService) -> Unit) {
        // The host clock reads now0 (rolled back, or just behind); the trust floor is `floor`. B's
        // certificate (default expiry now0 + 1000) is checked on the floor.
        val w = World()
        val la = w.start(w.a, LanSource(load = { w.peerSource(w.a) }, now = { now0 }, floored = { floor }))
        val lb = w.start(w.b, w.source(w.b), advertise = false, browse = false)
        run(w, la, lb)
    }

    @Test
    fun aClockBehindTheFloorDoesNotMakeAnExpiredCertificateLive() {
        flooredAt(now0 + 1_100) { _, la, lb ->
            try {
                runBlocking { lb.connect(LanPeer(idA, "127.0.0.1", la.port)) }
                fail("refused")
            } catch (e: LanException) {
                assertEquals(LanErrorReason.handshake_failed, e.reason)
            }
        }
    }

    @Test
    fun theSameCertificateIsLiveWhileTheFloorIsBeforeItsExpiry() {
        flooredAt(now0 + 900) { _, la, lb ->
            val s = runBlocking { lb.connect(LanPeer(idA, "127.0.0.1", la.port)) }
            assertEquals(idA, s.peerDeviceId)
        }
    }

    @Test
    fun aDialTriesEveryAnnouncedAddressInTurn() {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b, advertise = false, browse = false, dialSeconds = 0.5)
        // The first address does not answer (nothing listens there); the second is the device.
        val s = runBlocking { lb.connect(LanPeer(idA, "192.168.254.254", la.port, listOf("127.0.0.1"))) }
        assertEquals(idA, s.peerDeviceId)
        // With no address left that answers, the dial fails as a connect failure.
        try {
            runBlocking { lb.connect(LanPeer(idA, "192.168.254.254", la.port, listOf("192.168.254.253", "8.8.8.8"))) }
            fail("no answer")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.connect_failed, e.reason)
        }
    }

    @Test
    fun aDeviceOfAnotherSubjectIsRefused() {
        val w = World()
        val other = "ps_BBBBBBBBBBBBBBBBBBBBBB"
        val c = device(idC)
        val foreign = ring(listOf(c), 1, other)
        dialRefused(w, w.source(c, w.peerSource(c, ringJws = foreign, subject = other, roster = listOf(idC))))
    }

    // -- the listener's bounds ------------------------------------------------------------------

    private class Raw(port: Int) {
        val sock = Socket("127.0.0.1", port)

        @Volatile var received = 0
        val closed = CountDownLatch(1)

        init {
            Thread {
                try {
                    val b = ByteArray(4096)
                    while (true) {
                        val n = sock.getInputStream().read(b)
                        if (n < 0) break
                        received += n
                    }
                } catch (e: java.io.IOException) {
                    // reset: the listener dropped us
                }
                closed.countDown()
            }.also { it.isDaemon = true }.start()
        }

        val isClosed: Boolean get() = closed.count == 0L

        fun write(b: ByteArray) {
            sock.getOutputStream().write(b)
            sock.getOutputStream().flush()
        }

        fun drop() = sock.close()
    }

    @Test
    fun theLimitsAre32UnauthenticatedSocketsAnd4PerAddress() {
        assertEquals(32, LAN_MAX_PENDING)
        assertEquals(4, LAN_MAX_PENDING_PER_ADDRESS)
        val o = LanOptions()
        assertEquals(32, o.maxPending)
        assertEquals(4, o.maxPendingPerAddress)
        assertEquals(30.0, o.handshakeSeconds, 0.0)
    }

    @Test
    fun garbageAndOversizedAndEmptyFirstFramesCloseWithoutAWord() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val g = Raw(la.port)
        g.write(byteArrayOf(0, 48) + ByteArray(48) { 1 })
        assertTrue(g.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, g.received)
        val big = Raw(la.port)
        big.write(byteArrayOf(-1, -1) + ByteArray(65535) { 2 })
        assertTrue(big.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, big.received)
        val zero = Raw(la.port)
        zero.write(byteArrayOf(0, 0))
        assertTrue(zero.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, zero.received)
    }

    @Test
    fun socketsThatHaveNotHandshakenAreCappedPerAddress() = runBlocking {
        val w = World()
        val la = w.start(w.a, maxPendingPerAddress = 2)
        val socks = List(4) { Raw(la.port) }
        until { socks.count { it.isClosed } == 2 }
        Thread.sleep(100)
        assertEquals(2, socks.count { it.isClosed })
        assertTrue(socks.all { it.received == 0 })
        // A closed pending socket frees its slot.
        socks.first { !it.isClosed }.drop()
        until { la.pendingCount == 1 }
        val extra = Raw(la.port)
        Thread.sleep(200)
        assertFalse(extra.isClosed)
    }

    @Test
    fun socketsThatHaveNotHandshakenAreCappedInTotal() = runBlocking {
        val w = World()
        val la = w.start(w.a, maxPending = 3, maxPendingPerAddress = 50)
        val socks = List(5) { Raw(la.port) }
        until { socks.count { it.isClosed } == 2 }
        assertEquals(3, la.pendingCount)
    }

    @Test
    fun aSocketThatStallsInTheHandshakeIsDropped() = runBlocking {
        val w = World()
        val la = w.start(w.a, handshakeSeconds = 0.3)
        val s = Raw(la.port)
        assertTrue(s.closed.await(3, TimeUnit.SECONDS))
        assertEquals(0, s.received)
        until { la.pendingCount == 0 && la.pendingAddresses.isEmpty() }
    }

    @Test
    fun anAdmittedSessionStopsCountingAsPending() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b)
        pair(la, lb)
        until { la.pendingCount == 0 && la.pendingAddresses.isEmpty() }
    }

    @Test
    fun aSourceOffTheLanIsRefusedAtAccept() = runBlocking {
        val w = World()
        val svc = w.start(w.a, allowLoopback = false, advertise = false, browse = false)
        // Loopback is not allowed: every 127.0.0.1 source is off the LAN.
        val s = Raw(svc.port)
        assertTrue(s.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, svc.pendingCount)
    }

    @Test
    fun aPushedRosterIsReportedAsANotice() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val notices = CopyOnWriteArrayList<ConnectNotice>()
        la.onNotice { notices += it }
        la.documents.ring(w.ring)
        until { notices.isNotEmpty() }
        assertEquals(ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = "unsupported"), notices[0])
    }
}
