// @pkey-feature identity.nearby
//
// `client.cloudConnect.nearby` (CC-15.K4; WIRE-CONTRACT-V5 section 15.6.1): two real clients in one process
// over loopback, D with no sign-in and M signed in, a fake LAN and a scripted Worker whose `nearby/approve`
// keeps the key-binding rule. The codes equal, `VOUCH_REQ` verifies, `approved` reaches D and the wrap is
// held until D's person confirms the account. Also the gating (Identity discovery, never Connect), the
// typed N/A, the sign-out order and the sign-out races. Mirrors sdk-node's `nearby.e2e.test.ts`.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.FinishOutcome
import im.plrs.key.core.peer.nearby.NearbyApproval
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import im.plrs.key.core.peer.nearby.PickOutcome
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.identity.SignOutResult
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ConnectNearbyTest {
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val idM = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idD = "NEARBYDEVICEZZZZZZZZZZZZZZZZZZZD"
    private val request = "nr_0IvbE7YHMGPBP0VAfZDQhg"
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

    /** One LAN: every advert and browser on one network, all at 127.0.0.1. [gate] holds an advert back. */
    private class Net : MdnsAdapter {
        val adverts = LinkedHashMap<String, MdnsAdvert>()
        val browsers = CopyOnWriteArrayList<Pair<(MdnsFound) -> Unit, (String) -> Unit>>()

        @Volatile var gate: CountDownLatch? = null

        @Volatile var entered: CountDownLatch? = null

        private fun found(a: MdnsAdvert) = MdnsFound(a.instance, "127.0.0.1", a.port, a.txt)

        fun approverAdverts(): List<MdnsAdvert> = synchronized(adverts) { adverts.values.filter { "m=v" in it.txt } }

        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
            entered?.countDown()
            gate?.await(10, TimeUnit.SECONDS)
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

    /** What `nearby/start` registered for D and the key-binding rule of `nearby/approve` (section 12.11.5 rule 3). */
    private class Worker {
        val start = HashMap<String, Triple<String, String, String>>()
        val approved = ArrayList<String>()

        fun approve(r: VouchRequest): Pair<Int, String?> {
            val s = start[r.request] ?: return 404 to null
            if (s != Triple(r.deviceId, r.signKey, r.agreeKey)) return 404 to null
            approved += r.deviceId
            return 200 to "{\"status\":\"approved\"}"
        }
    }

    private inner class World(nearbyOn: Boolean = true, identityOn: Boolean = true) {
        val net = Net()
        val worker = Worker()
        val dKeys: DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val mKeys: DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())

        /** A latch the discovery answer waits on, to hold a start in flight. */
        @Volatile var discoveryGate: CountDownLatch? = null

        @Volatile var discoveryHit: CountDownLatch? = null
        private val base = "https://key.plrs.im/djdl/identity"
        private val signout = """"signout":"$base/signout""""
        private val nearbyMember = if (nearbyOn) {
            """"nearby":true,"endpoints":{$signout,"nearbyStart":"$base/nearby/start","nearbyPoll":"$base/nearby/poll","nearbyApprove":"$base/nearby/approve"}"""
        } else {
            """"endpoints":{$signout}"""
        }
        private val identity = if (identityOn) """"identity":{"enabled":true,"account":true,$nearbyMember}""" else """"identity":{"enabled":false}"""

        fun handle(r: PolarisRequest): PolarisResponse = when {
            r.path.endsWith("/.well-known/polaris.json") -> {
                discoveryHit?.countDown()
                discoveryGate?.await(10, TimeUnit.SECONDS)
                respond(200, """{"product":"djdl","services":{$identity}}""")
            }

            r.path.endsWith("/identity/signout") -> respond(200, """{"released":false}""")

            r.path.endsWith("/devices/keys") -> respond(200, """{"keySeq":1}""")

            else -> respond(404, "")
        }

        fun client(keys: DeviceKeyPort, deviceId: String, signedIn: Boolean): PolarisKeyClient = runBlocking {
            val store = InMemoryStore("djdl", deviceId)
            if (signedIn) store.setToken("pkeyt_held")
            PolarisKeyClient.create(
                PolarisKeyClientOptions(
                    core = CoreOptions(
                        productSlug = "djdl",
                        version = "1.0.0",
                        pinnedKeys = signer.trust,
                        trustRefresh = false,
                        store = store,
                        transport = ScriptedTransport { handle(it) },
                        clock = { now },
                        deviceName = "Test",
                    ),
                    license = LicenseClientOptions(fingerprint = false),
                    connect = ConnectOptions(deviceKeys = keys, allowEphemeralKeys = true),
                ),
            ).also {
                clients += it
                if (signedIn) it.core.setSubject(sub)
            }
        }

        val m: PolarisKeyClient by lazy { client(mKeys, idM, signedIn = true) }
        val d: PolarisKeyClient by lazy { client(dKeys, idD, signedIn = false) }

        fun approverOptions(prompt: Boolean = true) = NearbyApproverOptions(
            prompt = prompt,
            background = !prompt,
            label = "Ana's laptop",
            mdns = net,
            host = "127.0.0.1",
            allowLoopback = true,
        )

        fun requestOptions() = NearbyRequestOptions(request = request, label = "New phone", mdns = net, allowLoopback = true)
    }

    private fun codeOf(a: NearbyApproval, shown: String): String = a.codes.first { it.replace(" ", "") == shown.replace(" ", "") }

    // -- the whole vouch -----------------------------------------------------------------------------

    @Test
    fun twoDevicesVouchOverLoopbackWithConnectOff() = runBlocking<Unit> {
        val w = World()
        val approvals = CopyOnWriteArrayList<NearbyApproval>()
        val h = w.m.cloudConnect.nearby.onRequest({ approvals += it }, w.approverOptions())
        assertEquals(1, w.net.approverAdverts().size)
        // D registered its keys on nearby/start (the host's route; faked here) and browses.
        val dk = w.dKeys.ensure()
        w.worker.start[request] = Triple(idD, dk.signKey, dk.agreeKey)
        val r = w.d.cloudConnect.nearby.request(w.requestOptions())
        until { r.approvers.size == 1 }
        assertEquals("Ana's laptop", r.approvers[0].label)
        val shown = r.choose(r.approvers[0].id).code
        until { approvals.size == 1 }
        val a = approvals[0]
        // The codes equal: D's is among the three M shows.
        val real = codeOf(a, shown)
        val req = (a.pick(real) as PickOutcome.Verified).request
        assertEquals(request, req.request)
        assertEquals(idD, req.deviceId)
        assertEquals(dk.signKey, req.signKey)
        assertEquals(dk.agreeKey, req.agreeKey)
        assertEquals("New phone", req.label)
        // M's host calls approve with exactly what pick returned and gives the answer back.
        val (http, body) = w.worker.approve(req)
        assertTrue(a.finish(ApproveAnswerInput(http, body, true)) is FinishOutcome.Sent)
        until { r.result == VouchStatus.approved }
        assertEquals(listOf(idD), w.worker.approved)
        // The wrap is carried only after approved, and D holds it until its person confirms the account.
        val got = CopyOnWriteArrayList<Int>()
        r.onRecord { got += it.type }
        a.sendRecord(0x0030, byteArrayOf(7))
        Thread.sleep(100)
        assertEquals(emptyList<Int>(), got.toList())
        r.confirmAccount()
        assertEquals(listOf(0x0030), got.toList())
        assertEquals(VouchStatus.approved, r.result)
        // Connect never started on either client.
        assertFalse(w.m.cloudConnect.status().running)
        assertFalse(w.d.cloudConnect.status().running)
        h.stop()
        r.close()
    }

    @Test
    fun aWrongPickDeliversNoRequestAndCallsNoRoute() = runBlocking<Unit> {
        val w = World()
        val approvals = CopyOnWriteArrayList<NearbyApproval>()
        w.m.cloudConnect.nearby.onRequest({ approvals += it }, w.approverOptions())
        val dk = w.dKeys.ensure()
        w.worker.start[request] = Triple(idD, dk.signKey, dk.agreeKey)
        val r = w.d.cloudConnect.nearby.request(w.requestOptions())
        until { r.approvers.size == 1 }
        val shown = r.choose(r.approvers[0].id).code
        until { approvals.size == 1 }
        val decoy = approvals[0].codes.first { it.replace(" ", "") != shown.replace(" ", "") }
        assertEquals(PickOutcome.Mismatch, approvals[0].pick(decoy))
        Thread.sleep(100)
        assertEquals(emptyList<String>(), w.worker.approved)
        assertNull(r.result)
    }

    // -- gating and the typed N/A ---------------------------------------------------------------------

    private fun assertNA(reason: String, code: String, f: suspend () -> Unit) {
        val e = assertThrows(PolarisException::class.java) { runBlocking { f() } }
        assertEquals(code, e.code)
        assertEquals(reason, e.unsupported?.reason)
        assertEquals("identity.nearby", e.unsupported?.feature)
    }

    @Test
    fun aProductThatDoesNotServeNearbyAnswersTheTypedNotAvailable() {
        val w = World(nearbyOn = false)
        assertNA(UnsupportedReason.product, "service-unavailable") { w.d.cloudConnect.nearby.request(w.requestOptions()) }
        assertNA(UnsupportedReason.product, "service-unavailable") { w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions()) }
        assertEquals(0, w.net.approverAdverts().size)
    }

    @Test
    fun aProductWithIdentityOffAnswersTheTypedNotAvailable() {
        val w = World(identityOn = false)
        assertNA(UnsupportedReason.product, "service-unavailable") { w.d.cloudConnect.nearby.request(w.requestOptions()) }
        assertNA(UnsupportedReason.product, "service-unavailable") { w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions()) }
    }

    @Test
    fun aSignedOutDeviceCannotApprove() {
        val w = World()
        val e = assertThrows(PolarisException::class.java) { runBlocking { w.d.cloudConnect.nearby.onRequest({ }, w.approverOptions()) } }
        assertEquals("account_required", e.code)
        assertEquals(0, w.net.approverAdverts().size)
    }

    @Test
    fun anAdapterThatCannotStartIsTheTypedNearbyUnsupported() {
        val w = World()
        val broken = object : MdnsAdapter by w.net {
            override suspend fun advertise(advert: MdnsAdvert): MdnsHandle =
                throw im.plrs.key.core.peer.lan.MdnsUnavailableException("no multicast socket")
        }
        assertNA(UnsupportedReason.dependency, "nearby-unsupported") {
            w.m.cloudConnect.nearby.onRequest({ }, NearbyApproverOptions(prompt = true, mdns = broken, host = "127.0.0.1", allowLoopback = true))
        }
    }

    // -- sign-out ------------------------------------------------------------------------------------

    @Test
    fun signingOutStopsTheAdvertAndClosesTheRequestWhileConnectIsOff() = runBlocking<Unit> {
        val w = World()
        val h = w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions())
        val r = w.d.cloudConnect.nearby.request(w.requestOptions())
        until { r.approvers.size == 1 }
        assertEquals(1, w.net.approverAdverts().size)
        assertTrue(w.m.identity.signOut() is SignOutResult.SignedOut)
        assertEquals(0, w.net.approverAdverts().size)
        assertEquals("stopped", h.status().state.name)
        // The request side stops at its own sign-out or close.
        w.d.cloudConnect.stopForSignOut()
        until { r.closed }
    }

    @Test
    fun aHandleStoppedByTheHostLeavesTheSignOutNothingToDo() = runBlocking<Unit> {
        val w = World()
        val h = w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions())
        h.stop()
        assertEquals(0, w.net.approverAdverts().size)
        assertTrue(w.m.identity.signOut() is SignOutResult.SignedOut)
    }

    @Test
    fun aSignOutDuringTheDiscoveryReadLeavesNoAdvert() {
        val w = World()
        val hit = CountDownLatch(1)
        val gate = CountDownLatch(1)
        w.discoveryHit = hit
        w.discoveryGate = gate
        val result = CompletableDeferred<Throwable?>()
        val t = Thread {
            result.complete(
                try {
                    runBlocking { w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions()) }
                    null
                } catch (e: Throwable) {
                    e
                },
            )
        }
        t.start()
        assertTrue(hit.await(5, TimeUnit.SECONDS))
        runBlocking { w.m.cloudConnect.nearby.stopAll() }
        gate.countDown()
        t.join(10_000)
        val e = runBlocking { result.await() }
        assertTrue(e is PolarisException && e.code == "account_required")
        assertEquals(0, w.net.approverAdverts().size)
    }

    @Test
    fun aSignOutDuringTheAdvertStartLeavesNoAdvert() {
        val w = World()
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        w.net.entered = entered
        w.net.gate = gate
        val result = CompletableDeferred<Throwable?>()
        val t = Thread {
            result.complete(
                try {
                    runBlocking { w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions()) }
                    null
                } catch (e: Throwable) {
                    e
                },
            )
        }
        t.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        runBlocking { w.m.cloudConnect.nearby.stopAll() }
        gate.countDown()
        t.join(10_000)
        val e = runBlocking { result.await() }
        assertTrue("$e", e is PolarisException && e.code == "account_required")
        until { w.net.approverAdverts().isEmpty() }
    }

    @Test
    fun aSignOutDuringARequestStartClosesTheRequest() {
        val w = World()
        val hit = CountDownLatch(1)
        val gate = CountDownLatch(1)
        w.discoveryHit = hit
        w.discoveryGate = gate
        val result = CompletableDeferred<Throwable?>()
        val t = Thread {
            result.complete(
                try {
                    runBlocking { w.d.cloudConnect.nearby.request(w.requestOptions()) }
                    null
                } catch (e: Throwable) {
                    e
                },
            )
        }
        t.start()
        assertTrue(hit.await(5, TimeUnit.SECONDS))
        runBlocking { w.d.cloudConnect.nearby.stopAll() }
        gate.countDown()
        t.join(10_000)
        val e = runBlocking { result.await() }
        assertTrue("$e", e is im.plrs.key.core.peer.nearby.NearbyException)
        assertEquals(0, w.net.browsers.size)
    }

    @Test
    fun closingTheClientStopsTheNearbyAdvert() = runBlocking<Unit> {
        val w = World()
        w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions())
        assertEquals(1, w.net.approverAdverts().size)
        w.m.close()
        until { w.net.approverAdverts().isEmpty() }
    }

    @Test
    fun forceStopDropsEverythingAtOnce() = runBlocking<Unit> {
        val w = World()
        val h = w.m.cloudConnect.nearby.onRequest({ }, w.approverOptions())
        w.m.cloudConnect.nearby.forceStop()
        assertEquals("stopped", h.status().state.name)
    }

    // -- the Java mirrors ----------------------------------------------------------------------------

    @Test
    fun theFuturesMirrorsRunTheSameCalls() {
        val w = World()
        val pk = PolarisKeyFutures(w.m)
        val approvals = CopyOnWriteArrayList<NearbyApproval>()
        val h = pk.nearbyOnRequest({ approvals += it }, w.approverOptions()).get(10, TimeUnit.SECONDS)
        val dk = runBlocking { w.dKeys.ensure() }
        w.worker.start[request] = Triple(idD, dk.signKey, dk.agreeKey)
        val dpk = PolarisKeyFutures(w.d)
        val r: NearbyRequest = dpk.nearbyRequest(w.requestOptions()).get(10, TimeUnit.SECONDS)
        until { r.approvers.size == 1 }
        val shown = dpk.nearbyChoose(r, r.approvers[0].id).get(10, TimeUnit.SECONDS).code
        until { approvals.size == 1 }
        val a = approvals[0]
        val picked = pk.nearbyPick(a, codeOf(a, shown)).get(10, TimeUnit.SECONDS)
        val req = (picked as PickOutcome.Verified).request
        val (http, body) = w.worker.approve(req)
        pk.nearbyFinish(a, ApproveAnswerInput(http, body, true)).get(10, TimeUnit.SECONDS)
        until { r.result == VouchStatus.approved }
        pk.nearbySendRecord(a, 0x0030, byteArrayOf(1)).get(10, TimeUnit.SECONDS)
        dpk.nearbyConfirmAccount(r).get(10, TimeUnit.SECONDS)
        pk.nearbyStop(h).get(10, TimeUnit.SECONDS)
        dpk.nearbyClose(r).get(10, TimeUnit.SECONDS)
        assertEquals(0, w.net.approverAdverts().size)
    }
}
