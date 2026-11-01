// @pkey-feature identity.nearby
//
// Nearby sign-in on the new device D (I-45.12; WIRE-CONTRACT-V5 section 12.11.5 and 15.6.1): `nearby/start` and
// `nearby/poll` with their proofs, and the session that joins them to the LAN request. The LAN half is a fake
// `NearbyRequest` here (CC-15's own tests and the :sdk loopback test drive the real one); the Worker is scripted.
//
// What is pinned: the proofs verify and are by the key D started with; the first poll is one interval after `start`;
// the poll's token is held UNCONFIRMED (no stored subject, no event, no ladder rung 1, the sign-out flag untouched)
// until the person confirms; and every way out of the confirm screen (a decline, a cancel, the deadline, the next
// start) drops the token, its mark and the identity, once, whatever the Worker answers, acting only on its own token.

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
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.TokenSource
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.nearby.ChosenCode
import im.plrs.key.core.peer.nearby.NearbyApproverInfo
import im.plrs.key.core.peer.nearby.NearbyRecord
import im.plrs.key.core.peer.nearby.NearbyRequest
import im.plrs.key.core.peer.nearby.RequesterSigner
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NearbySignInTest {
    private val base = "https://key.plrs.im/djdl/identity"
    private val handle = "nr_pA71hdu4pwET01lPlZ_Pow"
    private val deviceId = "DEVICE00000000000000000000000001"
    private val subject = "ps_Wnnfb0uwgWH1iDEe7g0Fbg"

    private fun ready(token: String = "pkeyt_nearby_one") =
        """{"access_token":"$token","token_type":"Bearer","scope":"email","schemaVersion":1,"device":{"id":"$deviceId"},""" +
            """"license":{"id":"lic_nearby_0","name":"Ada Lovelace","email":"ada@example.com"},"subject":"$subject"}"""

    /** The LAN request, as the session sees it. */
    private class FakeRequest : NearbyRequest {
        override var approvers: List<NearbyApproverInfo> = emptyList()
        override var result: VouchStatus? = null
        override var closed: Boolean = false
        private val recordFns = CopyOnWriteArrayList<(NearbyRecord) -> Unit>()
        private val closeFns = CopyOnWriteArrayList<(String) -> Unit>()
        val confirms = AtomicInteger()
        val declines = AtomicInteger()
        val closes = AtomicInteger()
        var chosen: String? = null

        override fun onApprovers(fn: (List<NearbyApproverInfo>) -> Unit): () -> Unit = {}

        override fun onResult(fn: (VouchStatus) -> Unit): () -> Unit = {}

        override fun onRecord(fn: (NearbyRecord) -> Unit): () -> Unit {
            recordFns += fn
            return { recordFns -= fn }
        }

        override fun onClose(fn: (String) -> Unit): () -> Unit {
            closeFns += fn
            return { closeFns -= fn }
        }

        override suspend fun choose(id: String): ChosenCode {
            chosen = id
            return ChosenCode("482 913")
        }

        @Volatile var confirmGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null

        override suspend fun confirmAccount() {
            confirms.incrementAndGet()
            confirmGate?.await()
        }

        override suspend fun declineAccount() {
            declines.incrementAndGet()
        }

        override suspend fun close() {
            closes.incrementAndGet()
            closed = true
        }

        override fun destroy() {
            closed = true
        }

        fun deliver(type: Int, body: ByteArray) = recordFns.forEach { it(NearbyRecord(type, body)) }

        fun peerClosed(why: String) = closeFns.forEach { it(why) }
    }

    @Suppress("LongParameterList")
    private inner class World(
        val nearbyOn: Boolean = true,
        val token: String? = null,
        val subjectBefore: String? = null,
        val directory: File? = null,
        val signoutStatus: Int = 200,
        var now: Long = 1_700_000_000L,
        supported: Boolean = true,
        host: Boolean = true,
        wrap: NearbyWrapAdopter? = null,
    ) {
        val polls = java.util.ArrayDeque<Pair<Int, String>>()
        val request = FakeRequest()
        val events = CopyOnWriteArrayList<String?>()
        val sleeps = CopyOnWriteArrayList<Long>()
        val timers = CopyOnWriteArrayList<Pair<Double, () -> Unit>>()
        val acquired = AtomicInteger()
        val runtimeAsked = AtomicInteger()
        var startStatus = 201
        var startBody = """{"request":"$handle","expiresIn":300,"interval":3}"""
        var discoveryNearby = nearbyOn

        private fun discovery(): String {
            val flag = if (discoveryNearby) """"nearby":true,""" else ""
            val routes = if (discoveryNearby) {
                ""","nearbyStart":"$base/nearby/start","nearbyPoll":"$base/nearby/poll","nearbyApprove":"$base/nearby/approve""""
            } else {
                ""
            }
            return """{"product":"djdl","services":{"identity":{"enabled":true,"account":true,$flag""" +
                """"endpoints":{"subject":"$base/subject","signout":"$base/signout"$routes}}}}"""
        }

        /** Runs inside the next poll request, before the Worker answers it. */
        @Volatile var onPoll: (() -> Unit)? = null

        /** Holds the acquisition sync that follows the stored token until a test releases it. */
        @Volatile var acquireGate: kotlinx.coroutines.CompletableDeferred<Unit>? = null

        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery())

                "/djdl/identity/nearby/start" -> respond(startStatus, startBody)

                "/djdl/identity/nearby/poll" -> {
                    onPoll?.invoke()
                    polls.pollFirst()?.let { respond(it.first, it.second) } ?: respond(200, """{"status":"pending"}""")
                }

                "/djdl/identity/signout" -> respond(signoutStatus, """{"released":false}""")

                else -> respond(404)
            }
        }
        val store = InMemoryStore("djdl", deviceId).also { s -> if (token != null) runBlocking { s.setToken(token) } }
        val core: CoreContext = CoreOptions(
            productSlug = "djdl",
            version = "1.0.0",
            pinnedKeys = emptyMap(),
            trustRefresh = false,
            store = store,
            transport = transport,
            clock = { now },
        ).let { o -> if (directory != null) CoreContext.withFileStore(o, directory) else CoreContext(o) }
        val keys: DeviceKeyPort = DeviceKeyStore(Durable())
        val client = IdentityClient(
            core,
            onAcquired = {
                acquired.incrementAndGet()
                acquireGate?.await()
            },
            onSubject = { events += it },
            sleep = { sleeps += it },
        ).also { c ->
            c.nearbyTimer = { seconds, fn ->
                timers += seconds to fn
                { timers.removeAll { it.second === fn } }
            }
            if (host) {
                c.installNearby(
                    NearbyHost(
                        request = { request },
                        signer = { RequesterSigner(keys, core.deviceId()) },
                        runtime = {
                            runtimeAsked.incrementAndGet()
                            supported
                        },
                        wrap = wrap,
                    ),
                )
            }
        }

        init {
            runBlocking {
                core.start()
                if (subjectBefore != null) core.setSubject(subjectBefore)
            }
        }

        suspend fun reqs(path: String) = transport.requests().filter { it.path == path }

        suspend fun start(name: String? = "Living-room console") = client.signIn.startNearby(NearbySignInOptions(name))

        /** Poll to a ready answer and return the settled session. */
        suspend fun signedIn(token: String = "pkeyt_nearby_one"): NearbySignInSession {
            polls.add(200 to ready(token))
            val s = start()
            val out = s.wait()
            assertTrue(out is SignInOutcome.SignedIn)
            return s
        }
    }

    private class Durable(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private fun json(r: PolarisRequest) = String(r.body!!)

    // ── start and poll: the proofs, the pacing, the answers ──────────────────────────────────

    @Test
    fun startSendsTheKeysAndAProofThatVerifiesThenTheFirstPollIsOneIntervalLater() = runBlocking {
        val w = World()
        w.polls.add(200 to """{"status":"pending"}""")
        w.polls.add(200 to ready())
        val s = w.start()
        val k = w.keys.ensure()
        val req = w.reqs("/djdl/identity/nearby/start").single()
        val body = json(req)
        assertTrue(body.contains(""""signKey":"${k.signKey}""""))
        assertTrue(body.contains(""""agreeKey":"${k.agreeKey}""""))
        assertTrue(body.contains(""""deviceName":"Living-room console""""))
        val proof = Regex(""""proof":"([^"]+)"""").find(body)!!.groupValues[1]
        val fields = DeviceProofFields("nearby-start", "djdl", deviceId, "${k.signKey}.${k.agreeKey}")
        assertTrue(DeviceProofs.verify(DeviceProof(fields, k.signKey, proof)))
        // No credential, no bearer.
        assertNull(req.headers.entries.firstOrNull { it.key.equals("authorization", true) })
        assertEquals(300L, s.expiresIn)
        assertEquals(3L, s.interval)
        assertTrue(s.wait(once = true) is SignInOutcome.Pending)
        // The paced loop sleeps one interval before its poll.
        val out = s.wait()
        assertTrue(out is SignInOutcome.SignedIn)
        assertEquals(listOf(3L), w.sleeps.toList())
        val poll = w.reqs("/djdl/identity/nearby/poll").first()
        val pollProof = Regex(""""proof":"([^"]+)"""").find(json(poll))!!.groupValues[1]
        assertTrue(DeviceProofs.verify(DeviceProof(DeviceProofFields("nearby-poll", "djdl", deviceId, handle), k.signKey, pollProof)))
        assertTrue(json(poll).contains(""""request":"$handle""""))
    }

    @Test
    fun startSendsTheBearerOnlyWhenTheDeviceHoldsACredential() = runBlocking {
        val w = World(token = "pkeyt_held")
        w.start()
        val req = w.reqs("/djdl/identity/nearby/start").single()
        assertEquals("Bearer pkeyt_held", req.headers.entries.first { it.key.equals("authorization", true) }.value)
    }

    @Test
    fun aPollAfterTheKeysChangedIsRefusedLocally() = runBlocking {
        val w = World()
        val s = w.start()
        w.keys.rotate()
        try {
            s.wait(once = true)
            fail("a rotated key must not poll")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertTrue(w.reqs("/djdl/identity/nearby/poll").isEmpty())
    }

    @Test
    fun slowDownLengthensTheIntervalAndATransientFailureIsRiddenOut() = runBlocking {
        val w = World()
        w.polls.add(429 to """{"interval":8}""")
        w.polls.add(503 to """{"error":{"code":"unavailable"}}""")
        w.polls.add(200 to ready())
        val s = w.start()
        val out = s.wait()
        assertTrue(out is SignInOutcome.SignedIn)
        assertEquals(8L, s.interval)
        // 3 before the first poll, then the slow-down's 8, then the 503 retried at the current interval.
        assertEquals(listOf(3L, 8L, 8L), w.sleeps.toList())
    }

    @Test
    fun aDenialThrowsSignInDeniedAndTheFirstTerminalAnswerIsKept() = runBlocking {
        val w = World()
        w.polls.add(200 to """{"status":"error","reason":"access_denied"}""")
        val s = w.start()
        repeat(2) {
            try {
                s.wait()
                fail("denied must throw")
            } catch (e: SignInError) {
                assertEquals(ErrorCode.signInDenied, e.code)
            }
        }
        // The second wait() was answered from the latch: no second poll.
        assertEquals(1, w.reqs("/djdl/identity/nearby/poll").size)
        // The LAN half closes off the caller's thread, once.
        awaitTrue { w.request.closes.get() == 1 }
    }

    @Test
    fun aTimeoutIsExpiredAndStoresNothing() = runBlocking {
        val w = World()
        w.polls.add(200 to """{"status":"timeout"}""")
        val s = w.start()
        assertEquals(SignInOutcome.Expired, s.wait())
        assertEquals(SignInOutcome.Expired, s.wait())
        assertNull(w.core.token())
        assertEquals(1, w.reqs("/djdl/identity/nearby/poll").size)
    }

    @Test
    fun a404IsUnavailableOnlyAfterAFreshDiscoveryLostNearby() = runBlocking {
        val w = World()
        w.polls.add(404 to """{"error":{"code":"not_found"}}""")
        val s = w.start()
        // The routes are still named: an unknown or decided request, a refusal.
        try {
            s.wait(once = true)
            fail("a 404 with nearby still named is a refusal")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.notFound, e.code)
            assertEquals(404, e.httpStatus)
        }
        // The Worker rolled the routes back after discovery was read: a fresh read now loses `nearby`.
        w.polls.add(404 to """{"error":{"code":"not_found"}}""")
        w.discoveryNearby = false
        try {
            s.wait(once = true)
            fail("the routes went away")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
        }
    }

    @Test
    fun aWorkerRefusalCarriesItsCodeAndStatus() = runBlocking {
        val w = World()
        w.startStatus = 400
        w.startBody = """{"error":{"code":"invalid_grant"}}"""
        try {
            w.start()
            fail("start refused")
        } catch (e: PolarisException) {
            assertEquals("invalid_grant", e.code)
            assertEquals(400, e.httpStatus)
        }
        w.startStatus = 404
        try {
            w.start()
            fail("the gate is off")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
            assertNotNull(e.unsupported)
        }
    }

    @Test
    fun aProductWithoutNearbyAnswersTheTypedNaBeforeAnyRequest() = runBlocking {
        val w = World(nearbyOn = false)
        try {
            w.start()
            fail("no nearby")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
            assertNotNull(e.unsupported)
        }
        assertTrue(w.reqs("/djdl/identity/nearby/start").isEmpty())
        assertFalse(w.client.nearby.available(NearbyRole.Requester))
    }

    @Test
    fun anUnsupportedRuntimeNeverCallsARoute() = runBlocking {
        val w = World(supported = false)
        try {
            w.start()
            fail("no discovery adapter")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.nearbyUnsupported, e.code)
        }
        assertTrue(w.reqs("/djdl/identity/nearby/start").isEmpty())
        assertFalse(w.client.nearby.available(NearbyRole.Requester))
        val bare = World(host = false)
        try {
            bare.start()
            fail("no host")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.nearbyUnsupported, e.code)
        }
    }

    @Test
    fun availableNeedsNearbyTheRolesEndpointsAndTheRuntime() = runBlocking {
        val w = World()
        assertTrue(w.client.nearby.available(NearbyRole.Requester))
        assertTrue(w.client.nearby.available(NearbyRole.Approver))
    }

    // ── unconfirmed until the person confirms ────────────────────────────────────────────────

    @Test
    fun theTokenIsHeldUnconfirmedAndIsNotASignIn() = runBlocking {
        val w = World(subjectBefore = "ps_PREVIOUSPERSON0000000")
        w.core.setExplicitSignOut(true)
        val s = w.signedIn()
        assertEquals("pkeyt_nearby_one", w.core.token())
        assertTrue(w.core.tokenUnconfirmed())
        // Rung 1 does not count it, the stored subject is gone, no event named the new person, the flag stands.
        assertNotEquals(TokenProvenance.signin, w.core.tokenProvenance())
        assertNull(w.core.storedSubject())
        assertEquals(listOf<String?>(null), w.events.toList())
        assertTrue(w.core.explicitSignOut())
        assertEquals(1, w.acquired.get())
        assertEquals(ShownIdentity("Ada Lovelace", "ada@example.com"), s.identity)
        assertEquals(1, w.timers.size)
        assertEquals(300.0, w.timers.single().first, 0.0)
    }

    @Test
    fun aReacquireKeepsTheMarkAndAnotherTokenEndsIt() = runBlocking {
        val w = World()
        w.signedIn()
        // The one re-acquire rotates the token of the same sign-in: still unconfirmed.
        w.core.setToken("pkeyt_rotated", TokenSource.reacquire)
        assertTrue(w.core.tokenUnconfirmed())
        // A token any other way replaces it, and the mark goes with the old token.
        w.core.setToken("pkeyt_activated", TokenSource.activate)
        assertFalse(w.core.tokenUnconfirmed())
        assertEquals("pkeyt_activated", w.core.token())
    }

    @Test
    fun confirmingMakesItASignInRaisesTheEventAndEndsTheSignOut() = runBlocking {
        val w = World()
        w.core.setExplicitSignOut(true)
        val s = w.signedIn()
        s.confirmAccount()
        assertFalse(w.core.tokenUnconfirmed())
        assertEquals(TokenProvenance.signin, w.core.tokenProvenance())
        assertEquals(subject, w.core.storedSubject())
        assertEquals(listOf<String?>(subject), w.events.toList())
        assertFalse(w.core.explicitSignOut())
        assertEquals(1, w.request.confirms.get())
        // The deadline was cancelled by the confirmation.
        assertTrue(w.timers.isEmpty())
        // Confirming twice is a no-op for the device: one event.
        s.confirmAccount()
        assertEquals(1, w.events.count { it == subject })
    }

    @Test
    fun confirmingBeforeASignInIsRefused() = runBlocking {
        val w = World()
        val s = w.start()
        try {
            s.confirmAccount()
            fail("nothing to confirm")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertEquals(0, w.request.confirms.get())
    }

    @Test
    fun aMarkThatCannotBeWrittenFailsThePollWithNothingStored() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("nearby-mark").toFile()
        try {
            // A directory where the mark file goes: the write fails.
            File(dir, "token-unconfirmed").mkdirs()
            File(dir, "token-unconfirmed/keep").writeText("x")
            val w = World(directory = dir)
            w.polls.add(200 to ready())
            val s = w.start()
            try {
                s.wait(once = true)
                fail("the poll must fail")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.storeFailed, e.code)
            }
            assertNull(w.core.token())
            assertFalse(w.core.tokenUnconfirmed())
        } finally {
            dir.deleteRecursively()
        }
    }

    // ── a wait cancelled mid-acquisition, a late decline, a second confirm, the replacing token ──

    @Test
    fun cancellingTheWaitDuringTheAcquisitionStillDiscardsTheToken() = runBlocking {
        val w = World()
        w.acquireGate = kotlinx.coroutines.CompletableDeferred()
        w.polls.add(200 to ready("pkeyt_orphan"))
        val s = w.start()
        val job = kotlinx.coroutines.GlobalScope.launch(Dispatchers.Default) { s.wait() }
        awaitTrue { w.acquired.get() == 1 }
        // The kit ends a run by cancelling the wait and then the session.
        job.cancel()
        s.cancel()
        w.acquireGate!!.complete(Unit)
        job.join()
        awaitTrue { w.core.token() == null }
        w.assertDropped()
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
    }

    @Test
    fun aWaitCancelledAfterTheStoreLeavesTheDeadlineToDiscard() = runBlocking {
        val w = World()
        w.acquireGate = kotlinx.coroutines.CompletableDeferred()
        w.polls.add(200 to ready("pkeyt_orphan"))
        val s = w.start()
        val job = kotlinx.coroutines.GlobalScope.launch(Dispatchers.Default) { s.wait() }
        awaitTrue { w.acquired.get() == 1 }
        job.cancel()
        w.acquireGate!!.complete(Unit)
        job.join()
        awaitTrue { w.timers.isNotEmpty() }
        w.timers.single().second()
        awaitTrue { w.core.token() == null }
        w.assertDropped()
    }

    @Test
    fun aDeclineAfterTheConfirmationLeavesTheSignInAlone() = runBlocking {
        val w = World()
        val s = w.signedIn()
        s.confirmAccount()
        s.declineAccount()
        assertEquals("pkeyt_nearby_one", w.core.token())
        assertEquals(subject, w.core.storedSubject())
        assertEquals(0, w.reqs("/djdl/identity/signout").size)
    }

    @Test
    fun aSecondConfirmWaitsForTheFirstToFinish() = runBlocking {
        val w = World()
        val s = w.signedIn()
        w.request.confirmGate = kotlinx.coroutines.CompletableDeferred()
        val first = async(Dispatchers.Default) { s.confirmAccount() }
        awaitTrue { w.request.confirms.get() == 1 }
        val second = async(Dispatchers.Default) { s.confirmAccount() }
        delayBriefly()
        assertEquals("the second confirm waits", 1, w.request.confirms.get())
        w.request.confirmGate!!.complete(Unit)
        awaitAll(first, second)
        assertEquals(1, w.events.count { it == subject })
    }

    @Test
    fun aReplacingTokenIsWrittenBeforeTheOldMarkGoes() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-mark").toFile()
        try {
            val w = World(directory = dir)
            w.signedIn()
            w.core.setToken("pkeyt_other", TokenSource.activate)
            assertEquals("pkeyt_other", w.core.token())
            assertFalse(w.core.tokenUnconfirmed())
            assertFalse(java.io.File(dir, "token-unconfirmed").readText().trim() == "1")
        } finally {
            dir.deleteRecursively()
        }
    }

    // ── every way out of the confirm screen ──────────────────────────────────────────────────

    private suspend fun World.assertDropped() {
        assertNull(core.token())
        assertNull(core.store.getToken())
        assertFalse(core.tokenUnconfirmed())
        assertNull(core.storedSubject())
    }

    @Test
    fun declineSignsOutDropsTheTokenAndClosesTheLanOnce() = runBlocking {
        val w = World()
        val s = w.signedIn()
        s.declineAccount()
        s.declineAccount()
        s.cancel()
        w.assertDropped()
        assertTrue(s.ended)
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
        assertTrue(w.request.declines.get() >= 1)
        assertTrue(w.request.closes.get() >= 1)
        assertEquals(0, w.request.confirms.get())
        // No event named the person who was declined.
        assertTrue(w.events.none { it == subject })
    }

    @Test
    fun theHostEndingTheSessionDiscardsLikeADecline() = runBlocking {
        val w = World()
        val s = w.signedIn()
        val ended = CountDownLatch(1)
        s.onEnd { ended.countDown() }
        s.cancel()
        assertTrue(ended.await(10, TimeUnit.SECONDS))
        // The discard runs off the caller's thread.
        awaitTrue { w.core.token() == null }
        w.assertDropped()
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
    }

    @Test
    fun theScreenDeadlineDiscardsAnUnconfirmedSignIn() = runBlocking {
        val w = World()
        val s = w.signedIn()
        w.timers.single().second()
        awaitTrue { w.core.token() == null }
        w.assertDropped()
        assertTrue(s.ended)
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
    }

    @Test
    fun theTokenGoesLocallyWhateverTheWorkerAnsweredToTheSignOut() = runBlocking {
        val w = World(signoutStatus = 503)
        val s = w.signedIn()
        s.declineAccount()
        w.assertDropped()
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
    }

    @Test
    fun aReadyPollThatLandsAfterAnEndDiscardsAtOnce() = runBlocking {
        val w = World()
        w.polls.add(200 to ready())
        val s = w.start()
        // The cancel gets in while the poll is in flight: the answer then brings a token nobody will confirm.
        w.onPoll = { s.cancel() }
        assertEquals(SignInOutcome.Cancelled, s.wait(once = true))
        // Nothing is handed over and nothing stays, and the Worker was asked to sign out once.
        w.assertDropped()
        assertEquals(1, w.reqs("/djdl/identity/signout").size)
        assertEquals(0, w.timers.size)
        assertTrue(w.events.none { it == subject })
    }

    @Test
    fun theLanPeerClosingIsNotAnEnd() = runBlocking {
        val w = World()
        val s = w.signedIn()
        w.request.peerClosed("peer_bye")
        assertFalse(s.ended)
        s.confirmAccount()
        assertEquals(subject, w.core.storedSubject())
    }

    @Test
    fun confirmAfterAnEndThrowsAndNothingIsWritten() = runBlocking {
        val w = World()
        val s = w.signedIn()
        s.declineAccount()
        try {
            s.confirmAccount()
            fail("the sign-in ended")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        w.assertDropped()
        assertTrue(w.events.none { it == subject })
    }

    @Test
    fun theDeadlineAfterAConfirmationDoesNothing() = runBlocking {
        val w = World()
        val s = w.signedIn()
        val deadline = w.timers.single().second
        s.confirmAccount()
        deadline()
        delayBriefly()
        assertEquals("pkeyt_nearby_one", w.core.token())
        assertEquals(subject, w.core.storedSubject())
        assertFalse(s.ended)
        assertTrue(w.reqs("/djdl/identity/signout").isEmpty())
    }

    @Test
    fun confirmingAndTheDeadlineRaceToOneDecision() = runBlocking {
        repeat(40) {
            val w = World()
            val s = w.signedIn()
            val deadline = w.timers.single().second
            val results = listOf(
                async(Dispatchers.Default) { runCatching { s.confirmAccount() }.isSuccess },
                async(Dispatchers.Default) {
                    deadline()
                    true
                },
            ).awaitAll()
            val confirmed = results[0]
            if (confirmed) {
                // The confirmation won: the device is signed in and the deadline left it alone.
                assertEquals(subject, w.core.storedSubject())
                assertEquals("pkeyt_nearby_one", w.core.token())
                assertFalse(s.ended)
            } else {
                awaitTrue { w.core.token() == null }
                w.assertDropped()
                assertTrue(s.ended)
            }
        }
    }

    @Test
    fun anAbandonedSessionsDeadlineLeavesALaterSignInAlone() = runBlocking {
        val w = World()
        val s = w.signedIn()
        val deadline = w.timers.single().second
        // A later sign-in, made another way, replaces the token.
        w.core.storeSignIn("pkeyt_other_person", "ps_OTHERPERSON000000000A", TokenSource.signin, personInitiated = true)
        deadline()
        delayBriefly()
        assertEquals("pkeyt_other_person", w.core.token())
        assertEquals("ps_OTHERPERSON000000000A", w.core.storedSubject())
        assertTrue(w.reqs("/djdl/identity/signout").isEmpty())
        assertFalse(w.core.tokenUnconfirmed())
        // Confirming the abandoned one is refused and writes nothing of it.
        try {
            s.confirmAccount()
            fail("the token was replaced")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertEquals("pkeyt_other_person", w.core.token())
        assertEquals("ps_OTHERPERSON000000000A", w.core.storedSubject())
        assertTrue(w.events.none { it == subject })
    }

    // ── the wrap ─────────────────────────────────────────────────────────────────────────────

    @Test
    fun aWrapIsHeldUntilConfirmedThenOpenedOnceAndDroppedOnADecline() = runBlocking {
        val opened = CopyOnWriteArrayList<Int>()
        val adopter = NearbyWrapAdopter {
            opened += it.size
            true
        }
        val w = World(wrap = adopter)
        val s = w.signedIn()
        val states = CopyOnWriteArrayList<NearbyWrapState>()
        s.onWrap { states += it }
        w.request.deliver(0x0030, ByteArray(7) { 1 })
        assertTrue(opened.isEmpty())
        s.confirmAccount()
        assertEquals(listOf(7), opened.toList())
        assertEquals(NearbyWrapState.Applied, s.wrap)
        assertEquals(listOf(NearbyWrapState.Applied), states.toList())
        // An applied wrap closes the LAN half: nothing else is expected.
        assertTrue(w.request.closes.get() >= 1)

        val d = World(wrap = adopter)
        val declined = d.signedIn()
        d.request.deliver(0x0030, ByteArray(5) { 1 })
        declined.declineAccount()
        assertEquals(listOf(7), opened.toList())
        assertEquals(NearbyWrapState.None, declined.wrap)
    }

    @Test
    fun anOtherRecordTypeIsNotThisSessionsAndNoKeyRingDropsTheWrap() = runBlocking {
        val w = World()
        val s = w.signedIn()
        w.request.deliver(0x0031, ByteArray(3))
        w.request.deliver(0x0030, ByteArray(3))
        s.confirmAccount()
        assertEquals(NearbyWrapState.None, s.wrap)
    }

    // ── no secret in a print ─────────────────────────────────────────────────────────────────

    @Test
    fun nothingSecretIsInAPrint() = runBlocking {
        val w = World()
        w.polls.add(200 to ready())
        val s = w.start()
        s.choose("a1")
        s.wait()
        val prints =
            listOf(
                s.toString(),
                w.client.nearbyHost.get().toString(),
                s.identity.toString().replace("Ada Lovelace", "").replace("ada@example.com", ""),
            )
        for (p in prints) {
            assertFalse(p, p.contains(handle))
            assertFalse(p, p.contains("pkeyt_"))
            assertFalse(p, p.contains("482"))
        }
        assertEquals("482 913", s.code.toString())
        val e = runCatching { w.client.signIn.startNearby() }.exceptionOrNull()
        assertFalse(e?.message.orEmpty().contains(handle))
    }

    // ── the next start ───────────────────────────────────────────────────────────────────────

    @Test
    fun theNextStartDropsAnUnconfirmedTokenAndItsMark() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("nearby-start").toFile()
        try {
            val w = World(directory = dir)
            w.signedIn()
            assertTrue(File(dir, "token").exists())
            // The process ends on the confirm screen. A new run finds the mark and drops the token before anything reads it.
            val again = CoreContext.withFileStore(
                CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false, clock = { 1_700_000_000L }),
                dir,
            )
            again.start()
            assertNull(again.token())
            assertFalse(again.tokenUnconfirmed())
            assertFalse(File(dir, "token").exists() && File(dir, "token").readText().isNotBlank())
            assertEquals("", File(dir, "token-unconfirmed").takeIf { it.exists() }?.readText()?.trim().orEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aConfirmedSignInSurvivesTheNextStart() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("nearby-confirmed").toFile()
        try {
            val w = World(directory = dir)
            w.signedIn().confirmAccount()
            val again = CoreContext.withFileStore(
                CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false, clock = { 1_700_000_000L }),
                dir,
            )
            again.start()
            assertEquals("pkeyt_nearby_one", again.token())
            assertEquals(TokenProvenance.signin, again.tokenProvenance())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aStartThatCannotRemoveTheMarkedTokenKeepsTheMarkInMemoryToo() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("nearby-keep").toFile()
        try {
            World(directory = dir).signedIn()
            val refusing = object : im.plrs.key.core.Store by im.plrs.key.core.FileStore("djdl", dir) {
                override suspend fun clearToken() {
                    throw java.io.IOException("not removable")
                }
            }
            val again = CoreContext(
                CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                    store = refusing, clock = { 1_700_000_000L },
                ),
            )
            again.start()
            assertNull(again.token())
            assertEquals("1", File(dir, "token-unconfirmed").readText().trim())
            // A sign-in made later in this run clears the stale mark, so the next start keeps it.
            again.setToken("pkeyt_later", TokenSource.activate)
            assertEquals("pkeyt_later", again.token())
            assertFalse(File(dir, "token-unconfirmed").readText().trim() == "1")
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun theTokenIsClearedBeforeItsMark() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("nearby-order").toFile()
        try {
            val w = World(directory = dir)
            val s = w.signedIn()
            // A token that cannot be removed keeps its mark, so the next start drops it.
            val tokenFile = File(dir, "token")
            assertTrue(tokenFile.exists())
            tokenFile.delete()
            tokenFile.mkdirs()
            File(tokenFile, "x").writeText("x")
            runCatching { s.declineAccount() }
            assertEquals("1", File(dir, "token-unconfirmed").readText().trim())
        } finally {
            dir.deleteRecursively()
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────

    private suspend fun awaitTrue(cond: suspend () -> Boolean) {
        val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!cond()) {
            if (System.nanoTime() > until) fail("timed out")
            kotlinx.coroutines.delay(10)
        }
    }

    private suspend fun delayBriefly() = kotlinx.coroutines.delay(150)

    private fun assertNotEquals(a: Any?, b: Any?) = org.junit.Assert.assertNotEquals(a, b)
}
