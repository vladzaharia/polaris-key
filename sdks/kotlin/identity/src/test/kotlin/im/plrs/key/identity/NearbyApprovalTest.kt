// @pkey-feature identity.nearby
//
// Nearby sign-in on the approving device M (I-45.13; WIRE-CONTRACT-V5 section 12.11.5, 13.11.3 and 15.6.1): the ask the SDK hands
// a host, `nearby/approve` and the wrap. The LAN half is a fake `NearbyApproval` here (CC-15's own tests and the :sdk loopback
// test drive the real one); the Worker is scripted.
//
// What is pinned: nothing is sent before a code matched; a wrong code and "none of these match" call no route; the request goes to
// the Worker with D's id and keys from the verified request and M's own proof, bearer and device id; leaving the licence choice is
// a deny; a 404 is read through a fresh discovery; the wrap is sealed, sent over the channel and only then stored, once; a lost
// channel or a refused store leaves the other copy.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.DeviceProof
import im.plrs.key.core.DeviceProofFields
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.VouchRequest
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.nearby.ApproveAnswerInput
import im.plrs.key.core.peer.nearby.FinishOutcome
import im.plrs.key.core.peer.nearby.NearbyApproval
import im.plrs.key.core.peer.nearby.NearbyApprovalHandler
import im.plrs.key.core.peer.nearby.NearbyApproverHandle
import im.plrs.key.core.peer.nearby.NearbyApproverOptions
import im.plrs.key.core.peer.nearby.NearbyApproverStatus
import im.plrs.key.core.peer.nearby.NearbyErrorReason
import im.plrs.key.core.peer.nearby.NearbyException
import im.plrs.key.core.peer.nearby.NearbyState
import im.plrs.key.core.peer.nearby.PickOutcome
import im.plrs.key.core.peer.nearby.RequesterSigner
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class NearbyApprovalTest {
    private val base = "https://key.plrs.im/djdl/identity"
    private val handle = "nr_pA71hdu4pwET01lPlZ_Pow"
    private val dDevice = "DEVICE00000000000000000000000009"
    private val mDevice = "APPROVER000000000000000000000001"
    private val dSign = "a".repeat(43)
    private val dAgree = "b".repeat(43)
    private val approvePath = "/djdl/identity/nearby/approve"

    private class Durable(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private class FakeApproval(val verified: VouchRequest, override val codes: List<String>) : NearbyApproval {
        override val label: String? = "Living-room console"
        override val platform: String = "linux"
        val finishes = CopyOnWriteArrayList<ApproveAnswerInput>()
        val records = CopyOnWriteArrayList<Pair<Int, ByteArray>>()
        val order = CopyOnWriteArrayList<String>()
        val declines = AtomicInteger()
        val closes = AtomicInteger()
        var onFinish: (ApproveAnswerInput) -> FinishOutcome = { FinishOutcome.Sent(VouchStatus.approved) }
        var sendFails = false

        override suspend fun pick(code: String): PickOutcome = if (code == codes[1]) PickOutcome.Verified(verified) else PickOutcome.Mismatch

        override suspend fun decline() {
            declines.incrementAndGet()
        }

        override suspend fun finish(answer: ApproveAnswerInput): FinishOutcome {
            finishes += answer
            return onFinish(answer)
        }

        override suspend fun sendRecord(type: Int, body: ByteArray) {
            order += "channel"
            if (sendFails) throw NearbyException(NearbyErrorReason.closed, "gone")
            records += type to body.copyOf()
        }

        override suspend fun close() {
            closes.incrementAndGet()
        }

        override fun onClose(fn: (SessionEvent.Closed) -> Unit): () -> Unit = {}
    }

    private class FakeHandle : NearbyApproverHandle {
        override suspend fun stop() = Unit

        override suspend fun pause() = Unit

        override suspend fun resume() = Unit

        override suspend fun setPrompt(open: Boolean) = Unit

        override suspend fun reopen() = Unit

        override fun status() = NearbyApproverStatus(NearbyState.advertising, null, true)

        override fun destroy() = Unit
    }

    private inner class World(
        val token: String? = "pkeyt_approver",
        val sealer: NearbyWrapSealer? = null,
        registerKeys: Boolean = false,
        approver: Boolean = true,
    ) {
        val answers = java.util.ArrayDeque<Pair<Int, String>>()
        var discoveryNearby = true
        val registrations = AtomicInteger()
        val discoveries = AtomicInteger()
        private var handler: NearbyApprovalHandler? = null
        val asks = CopyOnWriteArrayList<NearbyAsk>()

        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> {
                    discoveries.incrementAndGet()
                    val e = if (discoveryNearby) ""","nearbyApprove":"$base/nearby/approve"""" else ""
                    val flag = if (discoveryNearby) """"nearby":true,""" else ""
                    respond(
                        200,
                        """{"product":"djdl","services":{"identity":{"enabled":true,"account":true,$flag""" +
                            """"endpoints":{"subject":"$base/subject"$e}}}}""",
                    )
                }

                approvePath -> answers.pollFirst()?.let { respond(it.first, it.second) } ?: respond(500, "{}")

                else -> respond(404)
            }
        }
        val store = InMemoryStore("djdl", mDevice).also { s -> if (token != null) runBlocking { s.setToken(token) } }
        val core: CoreContext = CoreContext(
            CoreOptions(
                productSlug = "djdl",
                version = "1.0.0",
                pinnedKeys = emptyMap(),
                trustRefresh = false,
                store = store,
                transport = transport,
                clock = { 1_700_000_000L },
            ),
        )
        val keys: DeviceKeyPort = DeviceKeyStore(Durable())
        val client = IdentityClient(core).also { c ->
            c.installNearby(
                NearbyHost(
                    request = { throw AssertionError("M does not request") },
                    signer = { RequesterSigner(keys, mDevice) },
                    runtime = { true },
                    approver = if (approver) {
                        { h, _ ->
                            handler = h
                            FakeHandle()
                        }
                    } else {
                        null
                    },
                    registerKeys = if (registerKeys) {
                        { registrations.incrementAndGet() }
                    } else {
                        null
                    },
                    sealer = sealer,
                ),
            )
        }

        init {
            runBlocking { core.start() }
        }

        suspend fun reqs() = transport.requests().filter { it.path == approvePath }

        /** M starts, a session reaches the code stage, and the host holds its ask. */
        suspend fun ask(fake: FakeApproval): NearbyAsk {
            client.nearby.onRequest({ asks += it }, NearbyApproverOptions(prompt = true))
            handler!!.onApproval(fake)
            return asks.last()
        }
    }

    private fun fake() = FakeApproval(
        VouchRequest(handle, dDevice, dSign, dAgree, "Living-room console", "linux"),
        listOf("111 111", "482 913", "222 222"),
    )

    private val approved = 200 to """{"status":"approved","deviceLabel":"Living-room console"}"""

    private fun json(r: PolarisRequest) = String(r.body!!)

    @Test
    fun nothingIsSentBeforeACodeMatched() = runBlocking {
        val w = World()
        val a = w.ask(fake())
        assertEquals(3, a.codes.size)
        assertEquals("Living-room console", a.device)
        assertTrue(w.reqs().isEmpty())
    }

    @Test
    fun theMatchedCodeSendsDsIdAndKeysFromTheVerifiedRequestWithMsOwnProofBearerAndDevice() = runBlocking {
        val w = World()
        w.answers.add(approved)
        val f = fake()
        val step = w.ask(f).pick("482 913")
        assertEquals(NearbyApprovalStep.Approved("Living-room console", wrapSent = false), step)
        val req = w.reqs().single()
        val body = json(req)
        assertTrue(body.contains(""""request":"$handle""""))
        assertTrue(body.contains(""""deviceId":"$dDevice""""))
        assertTrue(body.contains(""""signKey":"$dSign""""))
        assertTrue(body.contains(""""agreeKey":"$dAgree""""))
        assertTrue(body.contains(""""decision":"approve""""))
        assertEquals("Bearer pkeyt_approver", req.headers.entries.first { it.key.equals("authorization", true) }.value)
        assertEquals(mDevice, req.headers.entries.first { it.key.equals("x-pkey-device", true) }.value)
        val proof = Regex(""""proof":"([^"]+)"""").find(body)!!.groupValues[1]
        val k = w.keys.ensure()
        assertTrue(DeviceProofs.verify(DeviceProof(DeviceProofFields("nearby-approve", "djdl", mDevice, handle), k.signKey, proof)))
        // The finish step read the Worker's answer as it came.
        assertEquals(200, f.finishes.single().http)
    }

    @Test
    fun aWrongCodeCallsNoRouteAndAnAnsweredAskRefusesAnother() = runBlocking {
        val w = World()
        val a = w.ask(fake())
        assertEquals(NearbyApprovalStep.Mismatch, a.pick("111 111"))
        assertTrue(w.reqs().isEmpty())
        try {
            a.pick("482 913")
            fail("an answered ask took a second pick")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
        }
        assertTrue(w.reqs().isEmpty())
    }

    @Test
    fun noneOfTheseMatchClosesTheSessionAndSendsNothing() = runBlocking {
        val w = World()
        val f = fake()
        val a = w.ask(f)
        assertEquals(NearbyApprovalStep.Denied, a.deny())
        assertEquals(1, f.declines.get())
        assertTrue(w.reqs().isEmpty())
    }

    @Test
    fun aDenyAfterAMatchedCodeIsSentAsDeny() = runBlocking {
        val w = World()
        w.answers.add(200 to chooseBody)
        w.answers.add(204 to "")
        val f = fake()
        f.onFinish = { a -> if (a.http == 200) FinishOutcome.Wait("choice") else FinishOutcome.Sent(VouchStatus.denied) }
        // The code matched and the licence choice is shown; the person leaves it: that is a deny.
        val choose = w.ask(f).pick("482 913") as NearbyApprovalStep.Choose
        assertEquals(NearbyApprovalStep.Denied, choose.cancel())
        val bodies = w.reqs().map { json(it) }
        assertEquals(2, bodies.size)
        assertTrue(bodies[0].contains(""""decision":"approve""""))
        assertTrue(bodies[1].contains(""""decision":"deny""""))
    }

    private val chooseBody =
        """{"status":"choose","choices":{"state":"choose","choices":[{"id":"lic_a","name":"A","state":"free"}],"keep":false,"create":null}}"""

    @Test
    fun aLicenceChoiceIsMadeOnThisDeviceAndSentWithTheApproval() = runBlocking {
        val w = World()
        w.answers.add(200 to chooseBody)
        w.answers.add(approved)
        val f = fake()
        f.onFinish = { a -> if (a.http == 200 && f.finishes.size == 1) FinishOutcome.Wait("choice") else FinishOutcome.Sent(VouchStatus.approved) }
        val step = w.ask(f).pick("482 913") as NearbyApprovalStep.Choose
        assertEquals(listOf("lic_a"), step.choices.licenseIds)
        val done = step.choose(LicenseChoice.License("lic_a"))
        assertTrue(done is NearbyApprovalStep.Approved)
        val second = json(w.reqs()[1])
        assertTrue(second.contains(""""choice":{"kind":"license","licenseId":"lic_a"}"""))
    }

    @Test
    fun aRefusalIsOneOfTheMatrixStates() = runBlocking {
        val cases = listOf(
            (403 to """{"error":"not_nearby"}""") to NearbyApprovalStep.NotNearby,
            (409 to """{"error":{"code":"device_limit"}}""") to NearbyApprovalStep.DeviceLimit,
            (403 to """{"error":"account_required"}""") to NearbyApprovalStep.AccountRequired,
            (400 to """{"error":"invalid_grant"}""") to NearbyApprovalStep.Expired,
        )
        for ((answer, want) in cases) {
            val w = World()
            w.answers.add(answer)
            assertEquals(want, w.ask(fake()).pick("482 913"))
        }
        val w = World()
        w.answers.add(429 to """{"error":"rate_limited","retryAfter":30}""")
        assertEquals(NearbyApprovalStep.RateLimited(30), w.ask(fake()).pick("482 913"))
    }

    @Test
    fun a404IsReadThroughAFreshDiscovery() = runBlocking {
        val still = World()
        still.answers.add(404 to """{"error":"not_found"}""")
        val f1 = fake()
        still.ask(f1).pick("482 913")
        assertTrue(f1.finishes.single().discoveryNearby)
        assertTrue(still.discoveries.get() >= 1)

        val gone = World()
        gone.discoveryNearby = false
        gone.answers.add(404 to """{"error":"not_found"}""")
        val f2 = fake()
        gone.ask(f2).pick("482 913")
        // Discovery no longer names nearby: nothing is sent at all.
        assertTrue(gone.reqs().isEmpty())
        assertTrue(f2.finishes.isEmpty())
    }

    @Test
    fun deviceKeysRequiredRegistersOnceAndAsksOnceMore() = runBlocking {
        val w = World(registerKeys = true)
        w.answers.add(409 to """{"error":"device_keys_required"}""")
        w.answers.add(approved)
        val f = fake()
        val step = w.ask(f).pick("482 913")
        assertTrue(step is NearbyApprovalStep.Approved)
        assertEquals(1, w.registrations.get())
        assertEquals(2, w.reqs().size)
        // The machine was told of the registration first.
        assertEquals(409, f.finishes.first().http)

        val twice = World(registerKeys = true)
        twice.answers.add(409 to """{"error":"device_keys_required"}""")
        twice.answers.add(409 to """{"error":"device_keys_required"}""")
        twice.ask(fake()).pick("482 913")
        assertEquals(1, twice.registrations.get())
        assertEquals(2, twice.reqs().size)
    }

    @Test
    fun noBearerIsAccountRequiredAndSendsNothing() = runBlocking {
        val w = World(token = null)
        assertEquals(NearbyApprovalStep.AccountRequired, w.ask(fake()).pick("482 913"))
        assertTrue(w.reqs().isEmpty())
    }

    // ── The wrap ──────────────────────────────────────────────────────────────────────────

    @Test
    fun theWrapIsSealedSentOverTheChannelAndOnlyThenStoredAndOnlyOnce() = runBlocking {
        val sealedFor = CopyOnWriteArrayList<String>()
        val f = fake()
        val stored = AtomicInteger()
        val sealer = NearbyWrapSealer { deviceId, agree ->
            sealedFor += "$deviceId/$agree"
            NearbySealedWrap(byteArrayOf(1, 2, 3)) {
                f.order += "store"
                stored.incrementAndGet()
            }
        }
        val w = World(sealer = sealer)
        w.answers.add(approved)
        val step = w.ask(f).pick("482 913")
        assertEquals(NearbyApprovalStep.Approved("Living-room console", wrapSent = true), step)
        // Sealed to the VERIFIED request's device and agreement key; channel first, store second.
        assertEquals(listOf("$dDevice/$dAgree"), sealedFor.toList())
        assertEquals(listOf("channel", "store"), f.order.toList())
        assertEquals(0x0030, f.records.single().first)
        assertEquals(1, stored.get())
    }

    @Test
    fun aLostChannelLeavesTheStoredCopyAndARefusedStoreLeavesTheChannelCopy() = runBlocking {
        val f = fake()
        f.sendFails = true
        val w = World(sealer = NearbyWrapSealer { _, _ -> NearbySealedWrap(byteArrayOf(1)) {} })
        w.answers.add(approved)
        assertEquals(true, (w.ask(f).pick("482 913") as NearbyApprovalStep.Approved).wrapSent)

        val g = fake()
        val w2 =
            World(sealer = NearbyWrapSealer { _, _ -> NearbySealedWrap(byteArrayOf(1)) { throw PolarisException(ErrorCode.keyringConflict, "x") } })
        w2.answers.add(approved)
        assertEquals(true, (w2.ask(g).pick("482 913") as NearbyApprovalStep.Approved).wrapSent)
        assertEquals(1, g.records.size)

        // Both lost: the wrap did not go.
        val h = fake()
        h.sendFails = true
        val w3 =
            World(sealer = NearbyWrapSealer { _, _ -> NearbySealedWrap(byteArrayOf(1)) { throw PolarisException(ErrorCode.keyringConflict, "x") } })
        w3.answers.add(approved)
        assertEquals(false, (w3.ask(h).pick("482 913") as NearbyApprovalStep.Approved).wrapSent)
    }

    @Test
    fun noRootHeldMeansNoWrapAndNoHardFailure() = runBlocking {
        val f = fake()
        val w = World(sealer = NearbyWrapSealer { _, _ -> null })
        w.answers.add(approved)
        assertEquals(false, (w.ask(f).pick("482 913") as NearbyApprovalStep.Approved).wrapSent)
        assertTrue(f.records.isEmpty())
    }

    @Test
    fun aDenyOrARefusalSendsNoWrap() = runBlocking {
        val f = fake()
        val calls = AtomicInteger()
        val w = World(sealer = NearbyWrapSealer { _, _ -> calls.incrementAndGet().let { null } })
        w.answers.add(403 to """{"error":"not_nearby"}""")
        w.ask(f).pick("482 913")
        assertEquals(0, calls.get())
    }

    @Test
    fun withoutAnApproverHostTheTypedUnsupportedAnswers() = runBlocking {
        val w = World(approver = false)
        try {
            w.client.nearby.onRequest({ }, NearbyApproverOptions(prompt = true))
            fail("no approver host")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.nearbyUnsupported, e.code)
        }
        assertNotNull(w)
        assertFalse(w.asks.isNotEmpty())
    }
}
