// @pkey-feature connect.protocol
//
// `PeerChannel` in mode `a` (WIRE-CONTRACT-V5 sections 15.5 and 15.6): two sessions wired in memory
// and the refusals the matrix cannot show. Mirrors client-core's `peerSession.test.ts` and the
// Python engine's tests.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom

class PeerChannelTest {
    private val sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
    private val now = 1_700_001_000L
    private val signer = TestSigner("test-key")
    private val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"
    private val rng = SecureRandom()

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    private fun b64(b: ByteArray) = Base64Url.encode(b)

    private inner class Dev(val id: String, signByte: Int, val exp: Long = now + 1000, val epoch: Long = 1, val devSub: String = sub) {
        val priv = rnd()
        val stat = RawNoiseStatic(priv)
        val pub: ByteArray = runBlocking { stat.publicKey() }
        val signKey = b64(ByteArray(32) { signByte.toByte() })

        val cert: String
            get() = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(devSub),
                        "deviceId" to JsonPrimitive(id), "signKey" to JsonPrimitive(signKey), "agreeKey" to JsonPrimitive(b64(pub)),
                        "ringEpoch" to JsonPrimitive(epoch), "issuedAt" to JsonPrimitive(now - 10), "expiresAt" to JsonPrimitive(exp),
                    ),
                ),
            )

        fun entry() = JsonObject(mapOf("deviceId" to JsonPrimitive(id), "signKey" to JsonPrimitive(signKey), "agreeKey" to JsonPrimitive(b64(pub))))
    }

    private fun ring(devs: List<Dev>, epoch: Long, ringSub: String = sub): String = signer.sign(
        "pkey-ring+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"),
                "aud" to JsonPrimitive("djdl"),
                "sub" to JsonPrimitive(ringSub),
                "epoch" to JsonPrimitive(epoch),
                "issuedAt" to JsonPrimitive(now - 10),
                "expiresAt" to JsonPrimitive(now + 1000),
                "devices" to JsonArray(devs.sortedBy { it.id }.map { it.entry() }),
            ),
        ),
    )

    private inner class Side(
        role: NoiseRole,
        val dev: Dev,
        disc: List<ByteArray?>,
        var held: HeldRing? = null,
        label: String? = null,
        rekeyMessages: Int = 1 shl 20,
        rekeySeconds: Double = 3600.0,
    ) {
        val events = ArrayList<SessionEvent>()
        val out = ArrayList<ByteArray>()
        var clock = 0.0
        var wall = now
        val s = PeerChannel(
            role, "djdl", dev.stat,
            AccountContext(signer.trust, "djdl", dev.cert, sub, dev.id, { held }, disc),
            HelloInfo("test", "demo", label),
            { out.add(it) }, { events.add(it) },
            caps = listOf("app/1", "ring/1"), now = { wall }, mono = { clock },
            rekeyMessages = rekeyMessages, rekeySeconds = rekeySeconds,
        )

        inline fun <reified T : SessionEvent> of(): List<T> = events.filterIsInstance<T>()
    }

    private fun pump(a: Side, b: Side) = runBlocking {
        repeat(200) {
            if (a.out.isEmpty() && b.out.isEmpty()) return@runBlocking
            val ao = ArrayList(a.out)
            a.out.clear()
            for (m in ao) b.s.receive(m)
            val bo = ArrayList(b.out)
            b.out.clear()
            for (m in bo) a.s.receive(m)
        }
    }

    private fun pair(
        aRekeyMessages: Int = 1 shl 20,
        aRekeySeconds: Double = 3600.0,
        aEpoch: Long = 1,
        aHeld: HeldRing? = null,
        bHeld: HeldRing? = null,
        expA: Long = now + 1000,
    ): Triple<Side, Side, Pair<Dev, Dev>> {
        val da = Dev(idA, 1, exp = expA, epoch = aEpoch)
        val db = Dev(idB, 2)
        val k = rnd()
        val a = Side(NoiseRole.initiator, da, listOf(k), aHeld, rekeyMessages = aRekeyMessages, rekeySeconds = aRekeySeconds)
        val b = Side(NoiseRole.responder, db, listOf(k), bHeld)
        return Triple(a, b, da to db)
    }

    private fun closedOf(s: Side) = s.of<SessionEvent.Closed>()

    @Test
    fun admitsBothCertificatesAnswersPingRekeysAndCloses() = runBlocking {
        val (a, b, devs) = pair(aRekeyMessages = 2)
        a.s.start()
        pump(a, b)
        val est = a.of<SessionEvent.Established>().single()
        assertEquals(devs.second.id, est.peerDeviceId)
        assertTrue(est.helloAuthenticated)
        assertEquals(listOf("app/1", "ring/1"), est.caps)
        assertEquals("test", est.hello.platform)
        assertEquals(devs.first.id, b.of<SessionEvent.Established>().single().peerDeviceId)
        for (body in listOf("one", "two", "three")) a.s.sendRecord(0x0100, body.toByteArray())
        pump(a, b)
        assertEquals(listOf(3, 3, 5), b.of<SessionEvent.Record>().map { it.body.size })
        b.s.sendRecord(RecordType.PING, ByteArray(8))
        pump(a, b)
        assertEquals(3, b.of<SessionEvent.Record>().size) // the PONG is the session's, not the host's
        a.s.close()
        pump(a, b)
        assertEquals(listOf(SessionEvent.Closed("peer_bye", true)), closedOf(b))
        assertEquals(listOf(SessionEvent.Closed("peer_bye", false)), closedOf(a))
        assertTrue(a.s.closed && b.s.closed)
    }

    @Test
    fun aWrongDiscoveryKeyEndsTheResponderSilently() = runBlocking {
        val a = Side(NoiseRole.initiator, Dev(idA, 1), listOf(rnd()))
        val b = Side(NoiseRole.responder, Dev(idB, 2), listOf(rnd()))
        a.s.start()
        pump(a, b)
        assertTrue(b.out.isEmpty())
        assertEquals(listOf(SessionEvent.Closed("handshake_failed", false)), closedOf(b))
    }

    @Test
    fun theResponderAlsoTriesThePreviousKeyAndSkipsAnAbsentOne() = runBlocking {
        val old = rnd()
        val a = Side(NoiseRole.initiator, Dev(idA, 1), listOf(old))
        val b = Side(NoiseRole.responder, Dev(idB, 2), listOf(rnd(), old))
        a.s.start()
        pump(a, b)
        assertEquals(1, b.of<SessionEvent.Established>().size)
        val k = rnd()
        val c = Side(NoiseRole.initiator, Dev(idA, 1), listOf(k))
        val d = Side(NoiseRole.responder, Dev(idB, 2), listOf(k, null))
        c.s.start()
        pump(c, d)
        assertEquals(1, d.of<SessionEvent.Established>().size)
        val e = Side(NoiseRole.initiator, Dev(idA, 1), listOf(rnd()))
        val f = Side(NoiseRole.responder, Dev(idB, 2), listOf(k, null))
        e.s.start()
        pump(e, f)
        assertEquals(1, closedOf(f).size)
        assertTrue(f.of<SessionEvent.Established>().isEmpty())
    }

    @Test
    fun theInitiatorWithoutACurrentKeyCloses() = runBlocking {
        val a = Side(NoiseRole.initiator, Dev(idA, 1), listOf(null))
        a.s.start()
        assertEquals(listOf(SessionEvent.Closed("handshake_failed", false)), closedOf(a))
        assertTrue(a.out.isEmpty())
    }

    @Test
    fun anUnusableHeldRosterRefusesAndAsksButNoneAtAllAdmits() = runBlocking {
        val k = rnd()
        val a = Side(NoiseRole.initiator, Dev(idA, 1), listOf(k))
        val b = Side(NoiseRole.responder, Dev(idB, 2), listOf(k), HeldRing("not-a-roster", 1))
        a.s.start()
        pump(a, b)
        assertEquals(1, b.events.count { it === SessionEvent.RingWanted })
        assertTrue(b.of<SessionEvent.Established>().isEmpty())
        assertEquals(1, closedOf(b).size)
        val c = Side(NoiseRole.initiator, Dev(idA, 1), listOf(k))
        val d = Side(NoiseRole.responder, Dev(idB, 2), listOf(k))
        c.s.start()
        pump(c, d)
        assertEquals(1, d.of<SessionEvent.Established>().size)
        assertEquals(1, d.events.count { it === SessionEvent.RingWanted })
    }

    @Test
    fun aPeerMissingFromANewerRosterIsRevoked() = runBlocking {
        val da = Dev(idA, 1)
        val db = Dev(idB, 2)
        val k = rnd()
        val a = Side(NoiseRole.initiator, da, listOf(k))
        val b = Side(NoiseRole.responder, db, listOf(k), HeldRing(ring(listOf(db), 2), 2))
        a.s.start()
        pump(a, b)
        assertEquals(listOf(SessionEvent.Closed("peer_revoked", false)), closedOf(b))
    }

    @Test
    fun aNewerRosterIsPushedVerifiedAndApplied() = runBlocking {
        val da = Dev(idA, 1)
        val db = Dev(idB, 2)
        val k = rnd()
        val newer = ring(listOf(da, db), 3)
        val a = Side(NoiseRole.initiator, da, listOf(k), HeldRing(newer, 3))
        val b = Side(NoiseRole.responder, db, listOf(k), HeldRing(ring(listOf(da, db), 2), 2))
        a.s.start()
        pump(a, b)
        assertEquals(listOf(3L), b.of<SessionEvent.RingReceived>().map { it.epoch })
        assertTrue(a.s.isOpen && b.s.isOpen)
    }

    @Test
    fun aPeerOnANewerRosterThanTheHeldOneAsksForIt() = runBlocking {
        val da = Dev(idA, 1, epoch = 5)
        val db = Dev(idB, 2)
        val k = rnd()
        val a = Side(NoiseRole.initiator, da, listOf(k), HeldRing(ring(listOf(da, db), 5), 5))
        val b = Side(NoiseRole.responder, db, listOf(k), HeldRing(ring(listOf(da, db), 2), 2))
        a.s.start()
        pump(a, b)
        assertEquals(1, b.events.count { it === SessionEvent.RingWanted })
        assertEquals(1, b.of<SessionEvent.Established>().size)
    }

    private suspend fun sealed(a: Side, type: Int, body: ByteArray): ByteArray =
        a.s.transportForTest!!.send.encrypt(ByteArray(0), encodeRecord(PeerRecord(type, 0, body)))

    @Test
    fun trustAndBadRingRecords() = runBlocking {
        val (a, b, _) = pair()
        a.s.start()
        pump(a, b)
        b.s.receive(sealed(a, RecordType.TRUST, "{\"trust\":\"x.y.z\"}".toByteArray()))
        assertEquals("x.y.z", b.of<SessionEvent.TrustUnverified>().single().jws)
        b.s.receive(sealed(a, RecordType.TRUST, "{\"nope\":1}".toByteArray()))
        assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), closedOf(b))
    }

    @Test
    fun helloDisplayDataIsCleaned() = runBlocking {
        val k = rnd()
        val a = Side(NoiseRole.initiator, Dev(idA, 1), listOf(k), label = "  Café ‮TV\u0000  ")
        val b = Side(NoiseRole.responder, Dev(idB, 2), listOf(k))
        a.s.start()
        pump(a, b)
        assertEquals("Café TV", b.of<SessionEvent.Established>().single().hello.label)
    }

    @Test
    fun theFirstRecordMustBeHelloAndTheRefusalIsSaid() = runBlocking {
        val k = rnd()
        val da = Dev(idA, 1)
        val b = Side(NoiseRole.responder, Dev(idB, 2), listOf(k))
        val raw = NoiseHandshake(
            NoiseHandshakeOptions(NoiseRole.initiator, peerNoiseProtocol(PeerMode.a), peerPrologue("djdl", PeerMode.a), peerPsk(k, "djdl"), da.stat),
        )
        b.s.receive(raw.writeMessage(payload1()))
        raw.readMessage(b.out.removeAt(0))
        b.s.receive(raw.writeMessage(payload23(PeerMode.a, emptyList(), AccountPayload(da.cert, 1))))
        val tp = raw.transport()
        b.s.receive(tp.send.encrypt(ByteArray(0), encodeRecord(PeerRecord(RecordType.PING, 0, ByteArray(8)))))
        assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), closedOf(b))
        tp.receive.decrypt(ByteArray(0), b.out[0]) // HELLO
        val close = tp.receive.decrypt(ByteArray(0), b.out[1])
        assertEquals("{\"code\":\"peer_bad_frame\"}", String(close.copyOfRange(3, close.size)))
    }

    @Test
    fun messageOneTwiceCloses() = runBlocking {
        val (a, b, _) = pair()
        a.s.start()
        val m1 = a.out.removeAt(0)
        b.s.receive(m1)
        b.s.receive(m1)
        assertEquals(listOf(SessionEvent.Closed("handshake_failed", false)), closedOf(b))
    }

    @Test
    fun deadlinesAreEnforcedByTickOnInjectedClocks() = runBlocking {
        val (a, b, _) = pair()
        a.s.start()
        assertEquals(TRANSPORT_DEADLINE_SECONDS.toDouble(), a.s.wakeIn()!!, 0.0)
        a.clock = TRANSPORT_DEADLINE_SECONDS - 1.0
        a.s.tick()
        assertTrue(closedOf(a).isEmpty())
        assertEquals(1.0, a.s.wakeIn()!!, 0.0)
        a.clock = TRANSPORT_DEADLINE_SECONDS.toDouble()
        a.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", false)), closedOf(a))
        assertNull(a.s.wakeIn())
        val (c, d, _) = pair()
        assertNull(d.s.wakeIn())
        c.s.start()
        pump(c, d)
        assertTrue(d.s.isOpen)
        assertTrue(d.s.wakeIn() != null) // the peer certificate's expiry
        d.clock = 10_000.0
        d.s.tick()
        assertTrue(closedOf(d).isEmpty())
        assertTrue(b.events.isEmpty())
    }

    @Test
    fun aPeerCertificateThatRunsOutClosesTheSession() = runBlocking {
        val (a, b, _) = pair(expA = now + 50)
        a.s.start()
        pump(a, b)
        assertEquals(50.0, b.s.wakeIn()!!, 0.0)
        b.wall = now + 50
        b.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_expired", false)), closedOf(b))
        pump(a, b)
        assertEquals(listOf(SessionEvent.Closed("peer_expired", true)), closedOf(a))
    }

    @Test
    fun anAlreadyExpiredPeerCertificateIsRefusedAtTheHandshake() = runBlocking {
        val (a, b, _) = pair(expA = now - 1000)
        a.s.start()
        pump(a, b)
        assertEquals(listOf(SessionEvent.Closed("handshake_failed", false)), closedOf(b))
        assertTrue(b.of<SessionEvent.Established>().isEmpty())
    }

    @Test
    fun theAgeOfAKeyRekeysToo() = runBlocking {
        val (a, b, _) = pair(aRekeySeconds = 10.0)
        a.s.start()
        pump(a, b)
        a.clock = 11.0
        a.s.sendRecord(0x0100, "late".toByteArray())
        assertEquals(2, a.out.size) // REKEY, then the record
        pump(a, b)
        assertEquals(listOf("late"), b.of<SessionEvent.Record>().map { String(it.body) })
        a.s.sendRecord(0x0100, "again".toByteArray())
        assertEquals(1, a.out.size)
    }

    @Test
    fun sendRecordRefusesWhatTheSessionOwnsOrCannotCarry() = runBlocking {
        val (a, b, _) = pair()
        try {
            a.s.sendRecord(0x0100, "early".toByteArray())
            fail("must be refused before the session is open")
        } catch (e: IllegalStateException) {
            assertEquals("session not open", e.message)
        }
        a.s.start()
        pump(a, b)
        for (t in listOf(RecordType.HELLO, RecordType.CLOSE, RecordType.REKEY, RecordType.SAS_COMMIT)) {
            try {
                a.s.sendRecord(t, ByteArray(0))
                fail("record $t is owned by the session")
            } catch (e: IllegalArgumentException) {
                assertEquals("record owned by the session", e.message)
            }
        }
    }

    @Test
    fun noSecretInAToString() = runBlocking {
        val (a, b, devs) = pair()
        a.s.start()
        pump(a, b)
        a.s.sendRecord(0x0100, "secret-body".toByteArray())
        pump(a, b)
        val text = a.s.toString() + a.events + b.events + b.of<SessionEvent.Record>()
        assertFalse(text.contains("secret-body"))
        assertFalse(text.contains(devs.first.cert))
    }
}
