// @pkey-feature connect.noise
//
// The Kotlin conformance runner for conformance/corpus/v2/noise-vectors.json (WIRE-CONTRACT-V5
// section 15.5, 15.6), read in place; it mirrors conformance/runners/node/noiseVectors.test.ts.
// Every row runs through :core's Noise engine on the curve backend this run forces: the Gradle
// `test` task uses the JCA, `testTink` Tink (-Dpkey.ed25519=tink), so a vector that one backend
// answers differently fails that task.
//
// The X25519 and AES-256-GCM known answers, the low-order points, the three handshake modes byte
// for byte with rekey, the 15 failure rows, and the external anchors.

package im.plrs.key.conformance

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.JcaDeviceCurves
import im.plrs.key.core.TinkDeviceCurves
import im.plrs.key.core.X25519Points
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.JcaNoiseAead
import im.plrs.key.core.peer.NoiseException
import im.plrs.key.core.peer.NoiseHandshake
import im.plrs.key.core.peer.NoiseHandshakeOptions
import im.plrs.key.core.peer.NoisePorts
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.NoiseTransport
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.peerNoiseProtocol
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.peerPsk
import im.plrs.key.core.peer.sha256
import im.plrs.key.core.stringValue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NoiseVectorsTest : ConformanceSuite() {
    private val v: JsonObject = Corpus.v2("noise-vectors.json")
    private val none = ByteArray(0)

    private val curves: DeviceCurves = when (Corpus.backend) {
        "tink" -> TinkDeviceCurves
        else -> JcaDeviceCurves
    }

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun list(o: JsonObject, name: String): List<JsonObject> = o[name]!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.sOrNull(name: String): String? = this[name].stringValue

    private fun mode(s: String): PeerMode = PeerMode.valueOf(s)

    @Test
    fun versionIsOne() {
        assertEquals(1L, v["noiseVectorsVersion"].longValue)
        assertTrue(curves.name.isNotEmpty())
    }

    @Test
    fun x25519ScalarMultAndAgreement() {
        val f = Failures("noise x25519")
        val x = v["x25519"]!!.obj
        for (c in list(x, "scalarMult")) f.equal(c.s("expect"), curves.x25519(bytes(c.s("scalar")), bytes(c.s("u")))?.let(::hex)) { c.s("id") }
        for (c in list(x, "agreement")) {
            val a = bytes(c.s("alicePrivate"))
            val b = bytes(c.s("bobPrivate"))
            f.equal(c.s("alicePublic"), curves.x25519(a, X25519Points.BASE)?.let(::hex)) { "${c.s("id")} alice public" }
            f.equal(c.s("bobPublic"), curves.x25519(b, X25519Points.BASE)?.let(::hex)) { "${c.s("id")} bob public" }
            f.equal(c.s("shared"), curves.x25519(a, bytes(c.s("bobPublic")))?.let(::hex)) { "${c.s("id")} ab" }
            f.equal(c.s("shared"), curves.x25519(b, bytes(c.s("alicePublic")))?.let(::hex)) { "${c.s("id")} ba" }
        }
        f.done(6)
    }

    @Test
    fun lowOrderPointsAreClassifiedAndRefusedAsADh() {
        val f = Failures("noise lowOrder")
        val lo = v["lowOrder"]!!.obj
        val scalar = bytes(lo.s("scalar"))
        for (r in list(lo, "rows")) {
            val id = r.s("id")
            val u = bytes(r.s("u"))
            f.equal(r["lowOrder"].boolValue, X25519Points.isLowOrder(u)) { "$id classification" }
            val out = curves.x25519(scalar, u)
            if (r["allZero"].boolValue == true) {
                // The backend refuses (null) or answers zeros; either way the engine aborts on it.
                f.check(out == null || out.all { it.toInt() == 0 }) { "$id: expected a refusal or zeros" }
            } else {
                f.equal(r.s("output"), out?.let(::hex)) { "$id output" }
            }
        }
        f.done(17)
    }

    @Test
    fun aesGcmKnownAnswersAndAFlippedBitFailsTheTag() {
        val f = Failures("noise aesGcm")
        for (c in list(v, "aesGcm")) {
            val id = c.s("id")
            val key = bytes(c.s("key"))
            val nonce = bytes(c.s("nonce"))
            val aad = bytes(c.s("aad"))
            val sealed = JcaNoiseAead.seal(key, nonce, aad, bytes(c.s("plaintext")))
            f.equal(c.s("ciphertext") + c.s("tag"), hex(sealed)) { "$id seal" }
            f.equal(c.s("plaintext"), JcaNoiseAead.open(key, nonce, aad, sealed)?.let(::hex)) { "$id open" }
            val bad = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
            f.check(JcaNoiseAead.open(key, nonce, aad, bad) == null) { "$id: a flipped bit must fail the tag" }
        }
        f.done(4)
    }

    private class Side(val prologue: String, val psk: String?, val staticKey: String?, val ephemeral: String)

    private class Run(val wire: List<ByteArray>, val failure: Pair<Int, String>?, val i: NoiseHandshake, val r: NoiseHandshake)

    /** The reference swaps the initiator's message-1 public key before it mixes it; so does this. */
    private fun curvesSwapping(priv: ByteArray, pub: ByteArray): DeviceCurves = object : DeviceCurves by curves {
        override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray? =
            if (privateKey.contentEquals(priv) && peer.contentEquals(X25519Points.BASE)) pub else curves.x25519(privateKey, peer)
    }

    private fun handshake(role: NoiseRole, protocol: String, s: Side, replaceFirstEphemeral: ByteArray?): NoiseHandshake {
        val eph = bytes(s.ephemeral)
        val c = if (role == NoiseRole.initiator && replaceFirstEphemeral != null) curvesSwapping(eph, replaceFirstEphemeral) else curves
        return NoiseHandshake(
            NoiseHandshakeOptions(
                role = role,
                protocol = protocol,
                prologue = bytes(s.prologue),
                psk = s.psk?.let(::bytes),
                staticKey = RawNoiseStatic(bytes(s.staticKey ?: "00".repeat(32)), curves),
                ephemeralKey = eph,
                ports = NoisePorts(curves = c),
            ),
        )
    }

    private fun runHandshake(protocol: String, init: Side, resp: Side, payloads: List<ByteArray>, replaceFirstEphemeral: ByteArray? = null): Run {
        val i = handshake(NoiseRole.initiator, protocol, init, replaceFirstEphemeral)
        val r = handshake(NoiseRole.responder, protocol, resp, null)
        val wire = ArrayList<ByteArray>()
        for ((idx, p) in payloads.withIndex()) {
            val (w, d) = if (idx % 2 == 0) i to r else r to i
            try {
                val msg = runBlocking { w.writeMessage(p) }
                wire += msg
                val got = runBlocking { d.readMessage(msg) }
                assertEquals(hex(p), hex(got))
            } catch (e: NoiseException) {
                return Run(wire, idx to e.code.name, i, r)
            }
        }
        return Run(wire, null, i, r)
    }

    private fun transportOf(run: Run): Pair<NoiseTransport, NoiseTransport> = runBlocking { run.i.transport() to run.r.transport() }

    private fun handshakeRun(h: JsonObject, msgs: List<JsonObject>): Run {
        fun side(own: String) = Side(h.s("prologue"), h.sOrNull("psk"), h.s("${own}Static"), h.s("${own}Ephemeral"))
        return runHandshake(h.s("protocol"), side("init"), side("resp"), msgs.map { bytes(it.s("payload")) })
    }

    @Test
    fun everyHandshakeByteForByteWithRekey() {
        val all = list(v, "handshakes")
        assertEquals(listOf("a", "p", "v"), all.map { it.s("mode") }.sorted())
        val f = Failures("noise handshakes")
        for (h in all) {
            val id = h.s("id")
            val m = mode(h.s("mode"))
            f.equal(h.s("protocol"), peerNoiseProtocol(m)) { "$id protocol" }
            f.equal(h.s("prologue"), hex(peerPrologue(h.s("slug"), m))) { "$id prologue" }
            if (h.sOrNull("psk") != null) {
                // HKDF(salt empty, ikm discovery key, info), V5 15.5; the vector's key is SHA-256 of a label.
                val kDisc = sha256("pkey-peer/1 noise vector k_disc".toByteArray())
                f.equal(h.s("psk"), hex(peerPsk(kDisc, h.s("slug")))) { "$id psk" }
            }
            val msgs = list(h, "messages")
            val hs = msgs.filter { it.s("kind") == "handshake" }
            val run = handshakeRun(h, hs)
            f.check(run.failure == null) { "$id handshake failed ${run.failure}" }
            if (run.failure != null) continue
            run.wire.forEachIndexed { k, w -> f.equal(hs[k].s("ciphertext"), hex(w)) { "$id message $k" } }
            runBlocking {
                f.equal(h.s("handshakeHash"), hex(run.i.handshakeHash)) { "$id hash (i)" }
                f.equal(h.s("handshakeHash"), hex(run.r.handshakeHash)) { "$id hash (r)" }
                f.equal(h.s("respStaticPublic"), hex(run.i.remoteStatic!!)) { "$id remote static (i)" }
                f.equal(h.s("initStaticPublic"), hex(run.r.remoteStatic!!)) { "$id remote static (r)" }
                val (ti, tr) = transportOf(run)
                for (m2 in msgs.filter { it.s("kind") == "transport" }) {
                    val (from, to) = if (m2.s("from") == "i") ti to tr else tr to ti
                    val ct = from.send.encrypt(none, bytes(m2.s("payload")))
                    f.equal(m2.s("ciphertext"), hex(ct)) { "$id record ${m2["index"].longValue}" }
                    f.equal(m2.s("payload"), hex(to.receive.decrypt(none, ct))) { "$id record ${m2["index"].longValue} opens" }
                    if (m2["rekeyAfter"].boolValue == true) {
                        from.send.rekey()
                        to.receive.rekey()
                    }
                }
            }
        }
        f.done(30)
    }

    @Test
    fun aTamperedOrReplayedRecordFailsAndDoesNotAdvance() = runBlocking<Unit> {
        for (h in list(v, "handshakes")) {
            val run = handshakeRun(h, list(h, "messages").filter { it.s("kind") == "handshake" })
            val (ti, tr) = transportOf(run)
            val ct = ti.send.encrypt(none, bytes("0102"))
            val bad = ct.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
            assertEquals("decrypt", failureOf { tr.receive.decrypt(none, bad) })
            assertEquals("0102", hex(tr.receive.decrypt(none, ct)))
            assertEquals("decrypt", failureOf { tr.receive.decrypt(none, ct) })
        }
    }

    private suspend fun failureOf(block: suspend () -> Unit): String? = try {
        block()
        null
    } catch (e: NoiseException) {
        e.code.name
    }

    @Test
    fun everyFailureRowFailsWhereAndWhyTheCorpusSays() {
        val rows = list(v, "failures")
        assertEquals(15, rows.size)
        val f = Failures("noise failures")
        for (r in rows) {
            val id = r.s("id")
            val run = runHandshake(
                r.s("protocol"),
                Side(r.s("prologue"), r.sOrNull("psk"), r.s("initStatic"), r.s("initEphemeral")),
                Side(
                    r.sOrNull("responderPrologue") ?: r.s("prologue"),
                    r.sOrNull("responderPsk") ?: r.sOrNull("psk"),
                    r.s("respStatic"),
                    r.s("respEphemeral"),
                ),
                r["payloads"]!!.arrayValue!!.map { bytes(it.stringValue!!) },
                r.sOrNull("initEphemeralPublic")?.let(::bytes),
            )
            f.equal(r["failedAt"].longValue?.toInt() to r.s("reason"), run.failure) { "$id failure" }
            // A dead handshake refuses further use.
            val after = runBlocking { failureOf { run.i.writeMessage(none) } }
            f.check(after != null) { "$id: a dead handshake must refuse further use" }
        }
        f.done(30)
    }

    @Test
    fun externalAnchorsReproduce() {
        val f = Failures("noise anchors")
        var ran = 0
        for (a in list(v["anchors"]!!.obj, "vectors")) {
            val vec = a["vector"]!!.obj
            // The engine implements XX only; the NNpsk0 anchor belongs to the reference.
            if (vec.s("protocol_name") != "Noise_XX_25519_AESGCM_SHA256") continue
            ran++
            val msgs = list(vec, "messages")
            fun side(own: String) = Side(vec.s("${own}_prologue"), null, vec.s("${own}_static"), vec.s("${own}_ephemeral"))
            val run = runHandshake(vec.s("protocol_name"), side("init"), side("resp"), msgs.take(3).map { bytes(it.s("payload")) })
            f.check(run.failure == null) { "${a.s("source")} handshake failed ${run.failure}" }
            if (run.failure != null) continue
            run.wire.forEachIndexed { k, w -> f.equal(msgs[k].s("ciphertext"), hex(w)) { "${a.s("source")} message $k" } }
            runBlocking {
                vec.sOrNull("handshake_hash")?.let { f.equal(it, hex(run.i.handshakeHash)) { "${a.s("source")} hash" } }
                val (ti, tr) = transportOf(run)
                for (k in 3 until msgs.size) {
                    val (from, to) = if (k % 2 == 0) ti to tr else tr to ti
                    val ct = from.send.encrypt(none, bytes(msgs[k].s("payload")))
                    f.equal(msgs[k].s("ciphertext"), hex(ct)) { "${a.s("source")} message $k" }
                    f.equal(msgs[k].s("payload"), hex(to.receive.decrypt(none, ct))) { "${a.s("source")} message $k opens" }
                }
            }
        }
        assertNotNull(ran)
        assertTrue("no XX anchor ran", ran >= 1)
        f.done(1)
    }
}
