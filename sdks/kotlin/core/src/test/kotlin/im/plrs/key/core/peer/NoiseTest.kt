// @pkey-feature connect.noise
// The Noise engine beyond the vectors (mirrors client-core's peerNoise.test.ts): random keys end to
// end on both curve backends, order and reuse refusals, concurrent sends, no-leak strings and the
// fresh Cipher per AES-GCM operation. The known answers are conformance's NoiseVectorsTest.
package im.plrs.key.core.peer

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.JcaDeviceCurves
import im.plrs.key.core.TinkDeviceCurves
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NoiseTest {
    private val backends = listOf<DeviceCurves>(JcaDeviceCurves, TinkDeviceCurves)
    private val none = ByteArray(0)

    private fun rnd() = NoisePorts().random(32)

    private fun options(c: DeviceCurves, role: NoiseRole, mode: PeerMode = PeerMode.v, psk: ByteArray? = null, slug: String = "demo") =
        NoiseHandshakeOptions(
            role = role,
            protocol = peerNoiseProtocol(mode),
            prologue = peerPrologue(slug, mode),
            psk = psk,
            staticKey = RawNoiseStatic(rnd(), c),
            ports = NoisePorts(curves = c),
        )

    private suspend fun pair(c: DeviceCurves, mode: PeerMode = PeerMode.v): Pair<NoiseHandshake, NoiseHandshake> {
        val psk = if (mode == PeerMode.a) rnd() else null
        val i = NoiseHandshake(options(c, NoiseRole.initiator, mode, psk))
        val r = NoiseHandshake(options(c, NoiseRole.responder, mode, psk))
        r.readMessage(i.writeMessage("one".toByteArray()))
        i.readMessage(r.writeMessage("two".toByteArray()))
        r.readMessage(i.writeMessage("three".toByteArray()))
        return i to r
    }

    private fun code(block: suspend () -> Unit): NoiseErrorCode {
        try {
            runBlocking { block() }
        } catch (e: NoiseException) {
            return e.code
        }
        fail("expected a NoiseException")
        error("unreachable")
    }

    @Test
    fun roundTripsWithRandomKeysOnEveryBackend() = runBlocking<Unit> {
        for (c in backends) for (mode in PeerMode.values()) {
            val (i, r) = pair(c, mode)
            assertTrue(i.finished && r.finished)
            assertArrayEquals(i.handshakeHash, r.handshakeHash)
            val ti = i.transport()
            val tr = r.transport()
            val ct = ti.send.encrypt(none, "hello".toByteArray())
            assertEquals("hello", String(tr.receive.decrypt(none, ct)))
            val back = tr.send.encrypt(none, "yo".toByteArray())
            assertEquals("yo", String(ti.receive.decrypt(none, back)))
        }
    }

    @Test
    fun refusesOutOfTurnCallsAndUseAfterAFailure() {
        val h = NoiseHandshake(options(JcaDeviceCurves, NoiseRole.responder))
        assertEquals(NoiseErrorCode.state, code { h.writeMessage("x".toByteArray()) })
        assertEquals(NoiseErrorCode.malformed, code { h.readMessage(ByteArray(3)) })
        assertEquals(NoiseErrorCode.state, code { h.readMessage(rnd()) })
    }

    @Test
    fun needsThePskExactlyForXXpsk0() {
        assertEquals(NoiseErrorCode.bad_key, code { NoiseHandshake(options(JcaDeviceCurves, NoiseRole.initiator, PeerMode.a)) })
        assertEquals(NoiseErrorCode.bad_key, code { NoiseHandshake(options(JcaDeviceCurves, NoiseRole.initiator, PeerMode.v, rnd())) })
        assertEquals(NoiseErrorCode.bad_key, code { NoiseHandshake(options(JcaDeviceCurves, NoiseRole.initiator, PeerMode.a, ByteArray(31))) })
        assertEquals(
            NoiseErrorCode.state,
            code {
                NoiseHandshake(
                    NoiseHandshakeOptions(NoiseRole.initiator, "Noise_NN_25519_AESGCM_SHA256", none, null, RawNoiseStatic(rnd())),
                )
            },
        )
    }

    @Test
    fun anEphemeralKeyIsThirtyTwoRandomBytes() {
        val a = NoisePorts().random(32)
        val b = NoisePorts().random(32)
        assertEquals(32, a.size)
        assertFalse(a.contentEquals(b))
        assertEquals(32, JcaDeviceCurves.x25519(a, im.plrs.key.core.X25519Points.BASE)!!.size)
    }

    @Test
    fun neverReusesANonceAcrossConcurrentSends() = runBlocking<Unit> {
        val (i, r) = pair(JcaDeviceCurves)
        val ti = i.transport()
        val tr = r.transport()
        val cts = (1..8).map { n -> async { ti.send.encrypt(none, byteArrayOf(n.toByte())) } }.awaitAll()
        // Decrypting in send order proves the nonces were 0..7 with no gap and no reuse.
        cts.forEachIndexed { k, ct -> assertArrayEquals(byteArrayOf((k + 1).toByte()), tr.receive.decrypt(none, ct)) }
        assertEquals(8, cts.map { it.toList() }.toSet().size)
    }

    @Test
    fun aFailedTagLeavesTheCounterAlone() = runBlocking<Unit> {
        val (i, r) = pair(JcaDeviceCurves)
        val ti = i.transport()
        val tr = r.transport()
        val ct = ti.send.encrypt(none, byteArrayOf(1, 2))
        val bad = ct.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertEquals(NoiseErrorCode.decrypt, code { tr.receive.decrypt(none, bad) })
        assertArrayEquals(byteArrayOf(1, 2), tr.receive.decrypt(none, ct))
        assertEquals(NoiseErrorCode.decrypt, code { tr.receive.decrypt(none, ct) })
        assertEquals(NoiseErrorCode.malformed, code { tr.receive.decrypt(none, ByteArray(15)) })
    }

    @Test
    fun aDeadHandshakeStaysDeadAndAHandshakeIsSpentAfterTransport() = runBlocking<Unit> {
        val i = NoiseHandshake(options(JcaDeviceCurves, NoiseRole.initiator))
        val r = NoiseHandshake(options(JcaDeviceCurves, NoiseRole.responder))
        i.writeMessage(none)
        assertEquals(NoiseErrorCode.malformed, code { r.readMessage(ByteArray(5)) })
        assertEquals(NoiseErrorCode.state, code { r.readMessage(rnd()) })
        assertEquals(NoiseErrorCode.state, code { r.transport() })
        val (i2, r2) = pair(JcaDeviceCurves)
        i2.transport()
        assertEquals(NoiseErrorCode.state, code { i2.transport() })
        r2.transport()
    }

    @Test
    fun theFreshCipherPerOperationSealsTheSameAnswerTwice() {
        val key = ByteArray(32) { it.toByte() }
        val nonce = ByteArray(12)
        val a = JcaNoiseAead.seal(key, nonce, none, "x".toByteArray())
        // A shared GCM Cipher refuses to encrypt twice under one (key, nonce); a fresh one does not.
        val b = JcaNoiseAead.seal(key, nonce, none, "x".toByteArray())
        assertArrayEquals(a, b)
        assertArrayEquals("x".toByteArray(), JcaNoiseAead.open(key, nonce, none, a))
        assertEquals(null, JcaNoiseAead.open(key.copyOf().also { it[0] = 9 }, nonce, none, a))
    }

    @Test
    fun rekeyChangesTheKeyAndBothSidesAgree() = runBlocking<Unit> {
        val (i, r) = pair(JcaDeviceCurves)
        val ti = i.transport()
        val tr = r.transport()
        ti.send.rekey()
        val ct = ti.send.encrypt(none, byteArrayOf(7))
        assertEquals(NoiseErrorCode.decrypt, code { tr.receive.decrypt(none, ct) })
        tr.receive.rekey()
        assertArrayEquals(byteArrayOf(7), tr.receive.decrypt(none, ct))
    }

    @Test
    fun noSecretReachesAToStringOrAnError() = runBlocking<Unit> {
        val psk = rnd()
        val (i, _) = pair(JcaDeviceCurves, PeerMode.v)
        val t = i.transport()
        val text = listOf(
            t.toString(), t.send.toString(), i.toString(),
            options(JcaDeviceCurves, NoiseRole.initiator, PeerMode.a, psk).toString(),
            RawNoiseStatic(psk).toString(), NoiseException(NoiseErrorCode.decrypt).message!!,
        ).joinToString(" ")
        val hex = psk.joinToString("") { "%02x".format(it) }
        assertFalse(text.contains(hex))
        assertNotEquals("", text)
        assertEquals("noise: decrypt", NoiseException(NoiseErrorCode.decrypt).message)
    }
}
