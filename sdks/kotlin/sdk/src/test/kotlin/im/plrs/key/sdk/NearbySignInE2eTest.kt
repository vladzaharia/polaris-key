// @pkey-feature identity.nearby
//
// Nearby sign-in on the new device D through the umbrella client (I-45.12; WIRE-CONTRACT-V5 section 15.6.1): D's
// `identity.signIn.startNearby` against a real approving client M over a fake LAN, with a scripted Worker that serves
// `nearby/start`, `nearby/poll` and `signout`. The codes equal; the poll signs D in only after M's approve; the token is
// held unconfirmed (no stored subject, Connect and the approver role refuse, no ladder rung 1) until D's person
// confirms; the wrap M sends is held until then and handed to the key ring's adopter; a decline signs D out.
// Mirrors sdk-node's `nearby.e2e.test.ts`. The Android gating (no adapter, the installed platform) is here too.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.objectValue
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.NearbyApproval
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyRequestOptions
import im.plrs.key.core.peer.nearby.PickOutcome
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.identity.NearbyApprovalStep
import im.plrs.key.identity.NearbyAsk
import im.plrs.key.identity.NearbyHost
import im.plrs.key.identity.NearbyRole
import im.plrs.key.identity.NearbySealedWrap
import im.plrs.key.identity.NearbySignInSession
import im.plrs.key.identity.NearbyWrapAdopter
import im.plrs.key.identity.NearbyWrapSealer
import im.plrs.key.identity.NearbyWrapState
import im.plrs.key.identity.SignInOutcome
import im.plrs.key.license.LicenseClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class NearbySignInE2eTest {
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val idM = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idD = "NEARBYDEVICEZZZZZZZZZZZZZZZZZZZD"
    private val handle = "nr_0IvbE7YHMGPBP0VAfZDQhg"
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
    private class Net : MdnsAdapter {
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

    /** What the Worker keeps: D's keys from `nearby/start`, who M approved, and what D polled. */
    private class Worker {
        val start = HashMap<String, Triple<String, String, String>>()
        val approved = CopyOnWriteArrayList<String>()
        val signouts = AtomicInteger()
        val starts = AtomicInteger()
        val polls = AtomicInteger()

        val approveCalls = AtomicInteger()
        val approveBearers = CopyOnWriteArrayList<String?>()

        /** The Worker's `nearby/approve`: D's keys and id must be the ones D sent on `start` (the permit's contents), else 404. */
        fun approveBody(o: kotlinx.serialization.json.JsonObject): Pair<Int, String?> {
            approveCalls.incrementAndGet()
            val v = start[o["request"].stringValue]
            val sent = Triple(o["deviceId"].stringValue, o["signKey"].stringValue, o["agreeKey"].stringValue)
            if (v != sent) return 404 to """{"error":"not_found"}"""
            approved += sent.first!!
            return 200 to """{"status":"approved","deviceLabel":"Test"}"""
        }

        fun approve(r: VouchRequest): Pair<Int, String?> {
            if (start[r.request] != Triple(r.deviceId, r.signKey, r.agreeKey)) return 404 to null
            approved += r.deviceId
            return 200 to "{\"status\":\"approved\"}"
        }
    }

    private inner class World(nearbyOn: Boolean = true, val wrapped: CopyOnWriteArrayList<Int> = CopyOnWriteArrayList()) {
        val net = Net()
        val worker = Worker()
        val dKeys: DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val mKeys: DeviceKeyPort = DeviceKeyStore(InMemoryDeviceKeyStorage())
        private val base = "https://key.plrs.im/djdl/identity"
        private val routes = if (nearbyOn) {
            """"nearby":true,"endpoints":{"signout":"$base/signout","nearbyStart":"$base/nearby/start","nearbyPoll":"$base/nearby/poll",""" +
                """"nearbyApprove":"$base/nearby/approve"}"""
        } else {
            """"endpoints":{"signout":"$base/signout"}"""
        }
        private val ready = """{"access_token":"pkeyt_nearby_e2e","token_type":"Bearer","scope":"email","schemaVersion":1,"device":{"id":"$idD"},""" +
            """"license":{"id":"lic_1","name":"Ada Lovelace","email":"ada@example.com"},"subject":"$sub"}"""

        fun handle(r: PolarisRequest): PolarisResponse = when {
            r.path.endsWith("/.well-known/polaris.json") ->
                respond(200, """{"product":"djdl","services":{"identity":{"enabled":true,"account":true,$routes},"connect":{"enabled":true}}}""")

            r.path.endsWith("/identity/nearby/start") -> {
                worker.starts.incrementAndGet()
                val o = JsonText.parseOrNull(String(r.body!!)).objectValue!!
                worker.start[handle] = Triple(idD, o["signKey"].stringValue!!, o["agreeKey"].stringValue!!)
                respond(201, """{"request":"$handle","expiresIn":300,"interval":3}""")
            }

            r.path.endsWith("/identity/nearby/poll") -> {
                worker.polls.incrementAndGet()
                // The token is handed over once, after M approved.
                if (worker.approved.isNotEmpty()) respond(200, ready) else respond(200, """{"status":"pending"}""")
            }

            r.path.endsWith("/identity/nearby/approve") -> {
                worker.approveBearers += r.headers.entries.firstOrNull { it.key.equals("authorization", true) }?.value
                val (status, body) = worker.approveBody(JsonText.parseOrNull(String(r.body!!)).objectValue!!)
                respond(status, body.orEmpty())
            }

            r.path.endsWith("/identity/signout") -> {
                worker.signouts.incrementAndGet()
                respond(200, """{"released":false}""")
            }

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
        val d: PolarisKeyClient by lazy {
            client(dKeys, idD, signedIn = false).also { c ->
                // The facade's own host dials real multicast DNS; the test points it at the fake LAN and loopback.
                c.identity.installNearby(
                    NearbyHost(
                        request = {
                            c.cloudConnect.nearby.request(
                                NearbyRequestOptions(
                                    request = it.request,
                                    label = it.label,
                                    expiresIn = it.expiresIn,
                                    mdns = net,
                                    allowLoopback = true,
                                ),
                            )
                        },
                        signer = { c.connect.nearbySigner() },
                        runtime = { true },
                        wrap = NearbyWrapAdopter {
                            wrapped += it.size
                            true
                        },
                    ),
                )
            }
        }

        fun approverOptions() = NearbyApproverOptions(prompt = true, label = "Ana's laptop", mdns = net, host = "127.0.0.1", allowLoopback = true)
    }

    private fun codeOf(a: NearbyApproval, shown: String): String = a.codes.first { it.replace(" ", "") == shown.replace(" ", "") }

    /** Start D, let M see it, choose M on D, and answer M's pick with the code D shows. Returns D's session and M's approval. */
    private fun vouch(w: World): Pair<NearbySignInSession, NearbyApproval> = runBlocking {
        val approvals = CopyOnWriteArrayList<NearbyApproval>()
        w.m.cloudConnect.nearby.onRequest({ approvals += it }, w.approverOptions())
        val s = w.d.identity.signIn.startNearby()
        until { s.approvers.size == 1 }
        assertEquals("Ana's laptop", s.approvers[0].label)
        val shown = s.choose(s.approvers[0].id).code
        until { approvals.size == 1 }
        val a = approvals[0]
        val req = (a.pick(codeOf(a, shown)) as PickOutcome.Verified).request
        assertEquals(handle, req.request)
        val (http, body) = w.worker.approve(req)
        a.finish(ApproveAnswerInput(http, body, true))
        s to a
    }

    private fun settle(s: NearbySignInSession): SignInOutcome = runBlocking {
        var out: SignInOutcome = s.wait(once = true)
        val end = System.nanoTime() + 8_000_000_000L
        while (out is SignInOutcome.Pending && System.nanoTime() < end) {
            Thread.sleep(30)
            out = s.wait(once = true)
        }
        out
    }

    @Test
    fun theNewDeviceSignsInOnlyAfterTheApproverAndOnlyAfterItsPersonConfirms() = runBlocking<Unit> {
        val w = World()
        val (s, a) = vouch(w)
        // The wrap is carried only after approved; D holds it until its person confirms the account.
        a.sendRecord(0x0030, byteArrayOf(7))
        Thread.sleep(100)
        val out = settle(s)
        assertTrue(out is SignInOutcome.SignedIn)
        assertEquals(sub, (out as SignInOutcome.SignedIn).subject)
        assertEquals("ada@example.com", s.identity?.email)
        // Unconfirmed: a token, no sign-in. Connect and the approver role refuse; the ladder's first rung does not count it.
        assertEquals("pkeyt_nearby_e2e", w.d.core.token())
        assertTrue(w.d.core.tokenUnconfirmed())
        assertNull(w.d.core.storedSubject())
        assertTrue(w.d.core.tokenProvenance() != TokenProvenance.signin)
        assertEquals("no-token", assertThrows(PolarisException::class.java) { runBlocking { w.d.connect.identity() } }.code)
        assertEquals(
            "account_required",
            assertThrows(PolarisException::class.java) { runBlocking { w.d.cloudConnect.nearby.onRequest({ }, w.approverOptions()) } }.code,
        )
        assertTrue(w.wrapped.isEmpty())
        s.confirmAccount()
        assertEquals(listOf(1), w.wrapped.toList())
        assertEquals(NearbyWrapState.Applied, s.wrap)
        assertFalse(w.d.core.tokenUnconfirmed())
        assertEquals(sub, w.d.core.storedSubject())
        assertEquals(TokenProvenance.signin, w.d.core.tokenProvenance())
        assertEquals(0, w.worker.signouts.get())
        // Connect is a decision for the app: it never started on either client.
        assertFalse(w.d.cloudConnect.status().running)
        assertFalse(w.m.cloudConnect.status().running)
    }

    @Test
    fun aWrongCodeOnTheApprovingDeviceCallsNoRouteAndApprovesNobody() = runBlocking<Unit> {
        val w = World()
        val record = byteArrayOf(9, 8, 7, 6)
        val stored = CopyOnWriteArrayList<String>()
        // M's key ring holds a root in this test: the sealer stands in for it (the ring's own half is SyncKeyringTest's).
        w.m.identity.installNearby(
            NearbyHost(
                request = { throw AssertionError("M does not request") },
                signer = { w.m.connect.nearbySigner() },
                runtime = { true },
                approver = { h, o -> w.m.cloudConnect.nearby.onRequest(h, o) },
                sealer = NearbyWrapSealer { deviceId, _ ->
                    NearbySealedWrap(record.copyOf()) { stored += deviceId }
                },
            ),
        )
        val asks = CopyOnWriteArrayList<NearbyAsk>()
        w.m.identity.nearby.onRequest({ asks += it }, w.approverOptions())
        val s = w.d.identity.signIn.startNearby()
        until { s.approvers.size == 1 }
        val shown = s.choose(s.approvers[0].id).code
        until { asks.size == 1 }
        val ask = asks[0]
        assertEquals("Test", ask.device)
        val code = ask.codes.first { it.replace(" ", "") == shown.replace(" ", "") }
        // A wrong code first: no route is called, the session closes, nothing is approved.
        val wrong = ask.codes.first { it != code }
        val closed = runBlocking { ask.pick(wrong) }
        assertEquals(NearbyApprovalStep.Mismatch, closed)
        assertEquals(0, w.worker.approveCalls.get())
        assertTrue(w.worker.approved.isEmpty())
        s.cancel()
    }

    @Test
    fun theMatchedCodeApprovesWithMsBearerAndDsKeysAndTheWrapFollowsOnlyAfterD() = runBlocking<Unit> {
        val w = World()
        val record = byteArrayOf(9, 8, 7, 6)
        val stored = CopyOnWriteArrayList<String>()
        w.m.identity.installNearby(
            NearbyHost(
                request = { throw AssertionError("M does not request") },
                signer = { w.m.connect.nearbySigner() },
                runtime = { true },
                approver = { h, o -> w.m.cloudConnect.nearby.onRequest(h, o) },
                sealer = NearbyWrapSealer { deviceId, _ -> NearbySealedWrap(record.copyOf()) { stored += deviceId } },
            ),
        )
        val asks = CopyOnWriteArrayList<NearbyAsk>()
        w.m.identity.nearby.onRequest({ asks += it }, w.approverOptions())
        val s = w.d.identity.signIn.startNearby()
        until { s.approvers.size == 1 }
        val shown = s.choose(s.approvers[0].id).code
        until { asks.size == 1 }
        val ask = asks[0]
        val step = runBlocking { ask.pick(ask.codes.first { it.replace(" ", "") == shown.replace(" ", "") }) }
        assertEquals(NearbyApprovalStep.Approved("Test", wrapSent = true), step)
        assertEquals(listOf(idD), w.worker.approved.toList())
        assertEquals(listOf("Bearer pkeyt_held"), w.worker.approveBearers.toList())
        assertEquals(listOf(idD), stored.toList())
        // D signs in on its next poll, holds the wrap until its person confirms, then hands it to the ring.
        assertTrue(settle(s) is SignInOutcome.SignedIn)
        assertTrue(w.wrapped.isEmpty())
        s.confirmAccount()
        assertEquals(listOf(record.size), w.wrapped.toList())
    }

    @Test
    fun aDeclinedAccountSignsTheDeviceOutAndLeavesNothing() = runBlocking<Unit> {
        val w = World()
        val (s, a) = vouch(w)
        a.sendRecord(0x0030, byteArrayOf(7))
        assertTrue(settle(s) is SignInOutcome.SignedIn)
        s.declineAccount()
        assertNull(w.d.core.token())
        assertFalse(w.d.core.tokenUnconfirmed())
        assertNull(w.d.core.storedSubject())
        assertEquals(1, w.worker.signouts.get())
        assertTrue(w.wrapped.isEmpty())
        assertTrue(s.ended)
        // The session cannot be confirmed afterwards.
        assertEquals("sign-in-failed", assertThrows(PolarisException::class.java) { runBlocking { s.confirmAccount() } }.code)
    }

    @Test
    fun leavingBeforeApprovalCallsNoSignOutAndStoresNothing() = runBlocking<Unit> {
        val w = World()
        val s = w.d.identity.signIn.startNearby()
        s.cancel()
        assertEquals(SignInOutcome.Cancelled, s.wait(once = true))
        Thread.sleep(100)
        assertNull(w.d.core.token())
        assertEquals(0, w.worker.signouts.get())
    }

    // -- gating -----------------------------------------------------------------------------------------

    @Test
    fun aProductWithoutNearbyAnswersTheTypedNaBeforeAnyRoute() {
        val w = World(nearbyOn = false)
        val e = assertThrows(PolarisException::class.java) { runBlocking { w.d.identity.signIn.startNearby() } }
        assertEquals("service-unavailable", e.code)
        assertEquals("identity.nearby", e.unsupported?.feature)
        assertEquals(0, w.worker.starts.get())
        assertFalse(runBlocking { w.d.identity.nearby.available(NearbyRole.Requester) })
    }

    @Test
    fun availableFollowsTheDiscoveryAndTheRuntime() = runBlocking<Unit> {
        val w = World()
        // The facade's own host: off Android a discovery adapter always exists.
        val plain = w.client(w.dKeys, idD, signedIn = false)
        assertTrue(plain.identity.nearby.available(NearbyRole.Requester))
        assertTrue(plain.identity.nearby.available(NearbyRole.Approver))
        // Android below 14 has no adapter: nothing is called, the answer is the typed runtime N/A.
        ConnectPlatforms.android = true
        ConnectPlatforms.installed = null
        try {
            assertFalse(plain.identity.nearby.available(NearbyRole.Requester))
            val e = assertThrows(PolarisException::class.java) { runBlocking { plain.identity.signIn.startNearby() } }
            assertEquals("nearby-unsupported", e.code)
            assertEquals("runtime", e.unsupported?.reason)
            assertEquals(0, w.worker.starts.get())
        } finally {
            ConnectPlatforms.android = im.plrs.key.core.RuntimeFamily.isAndroid
            ConnectPlatforms.installed = null
        }
    }

    @Test
    fun theFuturesCarryTheSameVerbs() = runBlocking<Unit> {
        val w = World()
        val futures = PolarisKeyFutures(w.d)
        assertTrue(futures.nearbyAvailable().get())
    }
}
