// @pkey-feature connect.local
//
// The `cpace` section of conformance/corpus/v2/noise-vectors.json (WIRE-CONTRACT-V5 section 15.12, "The mode-q
// handshake"), read in place; it mirrors conformance/runners/node/cpaceSuites.ts. CPace's string functions, the
// Elligator 2 map (BigInteger here, as the reference's is bigint), the generators, the share and frame checks, whole
// attempts (K, ISK, the Noise PSK) and the mode-q handshakes byte for byte run through :core's `peer/CPace.kt` and its
// Noise engine on the curve backend this run forces: the Gradle `test` task uses the JCA, `testTink` Tink
// (-Dpkey.ed25519=tink), so a vector that one backend answers differently fails that task.

package im.plrs.key.conformance

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.JcaDeviceCurves
import im.plrs.key.core.TinkDeviceCurves
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.CPACE_C1_LENGTH
import im.plrs.key.core.peer.CPACE_C2_LENGTH
import im.plrs.key.core.peer.CpaceKind
import im.plrs.key.core.peer.FrameVerdict
import im.plrs.key.core.peer.NoiseException
import im.plrs.key.core.peer.NoiseHandshake
import im.plrs.key.core.peer.NoiseHandshakeOptions
import im.plrs.key.core.peer.NoisePorts
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.ShareVerdict
import im.plrs.key.core.peer.checkShare
import im.plrs.key.core.peer.cpaceGenerator
import im.plrs.key.core.peer.cpaceIsk
import im.plrs.key.core.peer.cpacePrsCode
import im.plrs.key.core.peer.cpacePrsQr
import im.plrs.key.core.peer.cpacePsk
import im.plrs.key.core.peer.cpaceShare
import im.plrs.key.core.peer.elligator2
import im.plrs.key.core.peer.encodeC1
import im.plrs.key.core.peer.encodeC2
import im.plrs.key.core.peer.generatorString
import im.plrs.key.core.peer.lvCat
import im.plrs.key.core.peer.parseC1
import im.plrs.key.core.peer.parseC2
import im.plrs.key.core.peer.peerNoiseProtocol
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.prependLen
import im.plrs.key.core.peer.transcriptIr
import im.plrs.key.core.stringValue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class CpaceVectorsTest : ConformanceSuite() {
    private val c: JsonObject = Corpus.v2("noise-vectors.json")["cpace"]!!.obj
    private val none = ByteArray(0)

    private val curves: DeviceCurves = when (Corpus.backend) {
        "tink" -> TinkDeviceCurves
        else -> JcaDeviceCurves
    }

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    private fun sha512(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(b)

    private fun rows(o: JsonObject, name: String): List<JsonObject> = o[name]!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.sOrNull(name: String): String? = this[name].stringValue

    private fun prsOf(kind: String, secret: String): ByteArray = if (kind == "code") cpacePrsCode(secret) else cpacePrsQr(bytes(secret))

    private fun vectorOf(id: String): JsonObject = rows(c["anchors"]!!.obj, "vectors").first { it.s("id") == id }["vector"]!!.obj

    @Test
    fun pinsTheSuite() {
        assertEquals("CPACE-X25519-SHA512", c.s("suite"))
        assertEquals("CPace255", c.s("dsi"))
        assertEquals("CPace255_ISK", c.s("dsiIsk"))
        assertEquals(128L, c["sInBytes"].longValue)
    }

    @Test
    fun prependLenLvCatAndTranscriptIrMatchTheDraftsAppendixAVectors() {
        val f = Failures("cpace string functions")
        for (a in rows(c["anchors"]!!.obj, "vectors")) {
            val v = a["vector"]!!.obj
            val cases = v["cases"]?.arrayValue ?: continue
            for (k in cases.map { it.obj }) {
                val id = a.s("id")
                val input: JsonElement = k["in"]!!
                when (v.s("fn")) {
                    "prepend_len" -> f.equal(k.s("out"), hex(prependLen(bytes(input.stringValue!!)))) { id }

                    "lv_cat" -> f.equal(k.s("out"), hex(lvCat(*input.arrayValue!!.map { bytes(it.stringValue!!) }.toTypedArray()))) { id }

                    "transcript_ir" -> {
                        val p = input.arrayValue!!.map { bytes(it.stringValue!!) }
                        f.equal(k.s("out"), hex(transcriptIr(p[0], p[1], p[2], p[3]))) { id }
                    }
                }
            }
        }
        f.done(3)
    }

    @Test
    fun theDraftsB11GeneratorAndB12ToB15TranscriptAndIsk() {
        val b11 = vectorOf("B.1.1")
        val gs = generatorString(bytes(b11.s("DSI")), bytes(b11.s("PRS")), bytes(b11.s("CI")), bytes(b11.s("sid")), c["sInBytes"].longValue!!.toInt())
        assertEquals(b11.s("generatorString"), hex(gs))
        val hash = sha512(gs).copyOf(32)
        assertEquals(b11.s("hashGeneratorString"), hex(hash))
        assertEquals(b11.s("g"), hex(elligator2(hash).u))
        assertEquals(b11.s("g"), hex(cpaceGenerator(bytes(b11.s("PRS")), bytes(b11.s("CI")), bytes(b11.s("sid")))))
        val b12 = vectorOf("B.1.2-B.1.5")
        val ir = transcriptIr(bytes(b12.s("Ya")), bytes(b12.s("ADa")), bytes(b12.s("Yb")), bytes(b12.s("ADb")))
        assertEquals(b12.s("transcriptIr"), hex(ir))
        val input = lvCat(bytes(b12.s("dsiIsk")), bytes(b11.s("sid")), bytes(b12.s("K"))) + ir
        assertEquals(b12.s("iskInput"), hex(input))
        assertEquals(b12.s("isk"), hex(sha512(input)))
    }

    @Test
    fun mapToCurveElligator2Rows() {
        val f = Failures("cpace elligator")
        for (r in rows(c, "elligator")) {
            val out = elligator2(bytes(r.s("input")))
            f.equal(r.s("r"), hex(out.r)) { "${r.s("id")} r" }
            f.equal(r["onCurve"].boolValue, out.onCurve) { "${r.s("id")} onCurve" }
            f.equal(r.s("u"), hex(out.u)) { "${r.s("id")} u" }
        }
        f.done(10)
    }

    @Test
    fun generatorRowsPrsGeneratorStringHashAndG() {
        val f = Failures("cpace generators")
        for (r in rows(c, "generators")) {
            val id = r.s("id")
            val prs = prsOf(r.s("kind"), r.s("secret"))
            f.equal(r.s("prs"), hex(prs)) { "$id prs" }
            f.equal(r.s("ci"), hex(peerPrologue(r.s("slug"), PeerMode.q))) { "$id ci" }
            val gs = generatorString(utf8(c.s("dsi")), prs, bytes(r.s("ci")), bytes(r.s("sid")), c["sInBytes"].longValue!!.toInt())
            f.equal(r.s("generatorString"), hex(gs)) { "$id generator string" }
            f.equal(r.s("hash"), hex(sha512(gs).copyOf(32))) { "$id hash" }
            f.equal(r.s("g"), hex(cpaceGenerator(prs, bytes(r.s("ci")), bytes(r.s("sid"))))) { "$id g" }
        }
        f.done(5)
    }

    private fun shareJson(v: ShareVerdict): Pair<Boolean, String?> = when (v) {
        ShareVerdict.Ok -> true to null
        is ShareVerdict.Refused -> false to v.reason
    }

    @Test
    fun shareCheckLengthCanonicalThenLowOrder() {
        val f = Failures("cpace shares")
        for (r in rows(c, "shares")) {
            val want = r["want"]!!.obj
            val (ok, reason) = shareJson(checkShare(bytes(r.s("share"))))
            f.equal(want["ok"].boolValue, ok) { "${r.s("id")} ok" }
            if (!ok) f.equal(want.sOrNull("reason"), reason) { "${r.s("id")} reason" }
        }
        f.done(20)
    }

    private fun verdictJson(v: FrameVerdict): Pair<Boolean, Map<String, String?>> = when (v) {
        is FrameVerdict.Ok -> true to mapOf("kind" to v.kind?.name?.lowercase(), "share" to hex(v.share))
        is FrameVerdict.Refused -> false to mapOf("reason" to v.reason)
    }

    @Test
    fun c1AsTheShowerJudgesItAndC2AsTheJoinerJudgesIt() {
        val f = Failures("cpace frames")
        val frames = c["frames"]!!.obj
        for ((name, parse) in listOf<Pair<String, (ByteArray) -> FrameVerdict>>("c1" to ::parseC1, "c2" to ::parseC2)) {
            for (r in rows(frames, name)) {
                val want = r["want"]!!.obj
                val (ok, got) = verdictJson(parse(bytes(r.s("frame"))))
                f.equal(want["ok"].boolValue, ok) { "$name ${r.s("id")} ok" }
                if (ok) {
                    f.equal(want.sOrNull("share"), got["share"]) { "$name ${r.s("id")} share" }
                    f.equal(want.sOrNull("kind"), got["kind"]) { "$name ${r.s("id")} kind" }
                } else {
                    f.equal(want.sOrNull("reason"), got["reason"]) { "$name ${r.s("id")} reason" }
                }
            }
        }
        assertEquals(34, CPACE_C1_LENGTH)
        assertEquals(33, CPACE_C2_LENGTH)
        f.done(10)
    }

    private fun sideGenerator(a: JsonObject, side: String): Triple<String, ByteArray, ByteArray> {
        val slug = a.s("${side}Slug")
        val sid = bytes(a.s("${side}Sid"))
        val g = cpaceGenerator(prsOf(a.s("kind"), a.s("${side}Secret")), peerPrologue(slug, PeerMode.q), sid)
        return Triple(slug, sid, g)
    }

    @Test
    fun wholeAttemptsSharesFramesKIskAndTheNoisePsk() {
        val f = Failures("cpace attempts")
        for (a in rows(c, "attempts")) {
            val id = a.s("id")
            val kind = CpaceKind.entries.first { it.name.equals(a.s("kind"), ignoreCase = true) }
            val (jSlug, jSid, jG) = sideGenerator(a, "joiner")
            val (sSlug, sSid, sG) = sideGenerator(a, "shower")
            f.equal(a.s("joinerG"), hex(jG)) { "$id joiner g" }
            f.equal(a.s("showerG"), hex(sG)) { "$id shower g" }
            val ya = cpaceShare(bytes(a.s("ya")), jG, curves)!!
            val yb = if (a["reflect"].boolValue == true) ya else cpaceShare(bytes(a.s("yb")), sG, curves)!!
            f.equal(a.s("Ya"), hex(ya)) { "$id Ya" }
            f.equal(a.s("Yb"), hex(yb)) { "$id Yb" }
            f.equal(a.s("c1"), hex(encodeC1(kind, ya))) { "$id c1" }
            f.equal(a.s("c2"), hex(encodeC2(yb))) { "$id c2" }
            f.equal(a.s("joinerK"), curves.x25519(bytes(a.s("ya")), yb)?.let(::hex)) { "$id joiner K" }
            f.equal(a.s("showerK"), curves.x25519(bytes(a.s("yb")), ya)?.let(::hex)) { "$id shower K" }
            val iskJ = cpaceIsk(jSid, bytes(a.s("ya")), ya, yb, initiator = true, curves = curves)!!
            val iskS = cpaceIsk(sSid, bytes(a.s("yb")), ya, yb, initiator = false, curves = curves)!!
            f.equal(a.s("joinerIsk"), hex(iskJ)) { "$id joiner isk" }
            f.equal(a.s("showerIsk"), hex(iskS)) { "$id shower isk" }
            f.equal(a.s("joinerPsk"), hex(cpacePsk(iskJ, jSlug))) { "$id joiner psk" }
            f.equal(a.s("showerPsk"), hex(cpacePsk(iskS, sSlug))) { "$id shower psk" }
            f.equal(a["agree"].boolValue, hex(iskJ) == hex(iskS)) { "$id agree" }
        }
        f.done(9)
    }

    @Test
    fun aScalarIsOverwrittenOnceTheIskIsMade() {
        val a = rows(c, "attempts").first()
        val (_, sid, _) = sideGenerator(a, "joiner")
        val scalar = bytes(a.s("ya"))
        cpaceIsk(sid, scalar, bytes(a.s("Ya")), bytes(a.s("Yb")), initiator = true, curves = curves)
        assertTrue(scalar.all { it.toInt() == 0 })
    }

    @Test
    fun abortALowOrderUGivesAZeroKWhichRefusesAndItsShareIsRefusedFirst() {
        val f = Failures("cpace abort")
        val abort = c["abort"]!!.obj
        for (r in rows(abort, "rows")) {
            val id = r.s("id")
            val out = curves.x25519(bytes(abort.s("scalar")), bytes(r.s("u")))
            val zero = out == null || out.all { it.toInt() == 0 }
            if (r["kAllZero"].boolValue == true) f.check(zero) { "$id: K must be zero" } else f.equal(r.s("k"), out?.let(::hex)) { "$id K" }
            f.equal(r["shareRefused"].boolValue, checkShare(bytes(r.s("u"))) !is ShareVerdict.Ok) { "$id share refused" }
            val isk = cpaceIsk(ByteArray(10), bytes(abort.s("scalar")), ByteArray(32), bytes(r.s("u")), initiator = true, curves = curves)
            f.equal(r["kAllZero"].boolValue, isk == null) { "$id isk null" }
        }
        f.done(10)
    }

    /** One side's inputs of a handshake row, as the corpus writes them (hex). */
    private class Side(val protocol: String, val prologue: String, val psk: String, val static: String, val eph: String)

    private fun handshake(role: NoiseRole, side: Side, swap: ByteArray? = null): NoiseHandshake {
        val e = bytes(side.eph)
        val used: DeviceCurves = if (role == NoiseRole.initiator && swap != null) {
            object : DeviceCurves by curves {
                override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray? = if (privateKey.contentEquals(e) &&
                    peer.contentEquals(im.plrs.key.core.X25519Points.BASE)
                ) {
                    swap
                } else {
                    curves.x25519(privateKey, peer)
                }
            }
        } else {
            curves
        }
        return NoiseHandshake(
            NoiseHandshakeOptions(
                role,
                side.protocol,
                bytes(side.prologue),
                bytes(side.psk),
                RawNoiseStatic(bytes(side.static), curves),
                e,
                NoisePorts(curves = used),
            ),
        )
    }

    @Test
    fun everyModeQHandshakeByteForByte() = runBlocking<Unit> {
        val f = Failures("cpace handshakes")
        val attempts = rows(c, "attempts")
        for (h in rows(c, "handshakes")) {
            val id = h.s("id")
            f.equal(h.s("protocol"), peerNoiseProtocol(PeerMode.valueOf(h.s("mode")))) { "$id protocol" }
            f.equal(h.s("prologue"), hex(peerPrologue(h.s("slug"), PeerMode.valueOf(h.s("mode"))))) { "$id prologue" }
            h.sOrNull("attempt")?.let { at ->
                val a = attempts.first { it.s("id") == at }
                f.equal(h.s("psk"), a.s("joinerPsk")) { "$id psk" }
                f.equal(h.sOrNull("isk"), a.s("joinerIsk")) { "$id isk" }
            }
            val i = handshake(NoiseRole.initiator, Side(h.s("protocol"), h.s("prologue"), h.s("psk"), h.s("initStatic"), h.s("initEphemeral")))
            val r = handshake(NoiseRole.responder, Side(h.s("protocol"), h.s("prologue"), h.s("psk"), h.s("respStatic"), h.s("respEphemeral")))
            val msgs = rows(h, "messages")
            val hs = msgs.filter { it.s("kind") == "handshake" }
            for ((k, m) in hs.withIndex()) {
                val (w, d) = if (k % 2 == 0) i to r else r to i
                val wire = w.writeMessage(bytes(m.s("payload")))
                f.equal(m.s("ciphertext"), hex(wire)) { "$id message $k" }
                f.equal(m.s("payload"), hex(d.readMessage(wire))) { "$id message $k opens" }
            }
            f.equal(h.s("handshakeHash"), hex(i.handshakeHash)) { "$id hash (i)" }
            f.equal(h.s("handshakeHash"), hex(r.handshakeHash)) { "$id hash (r)" }
            val ti = i.transport()
            val tr = r.transport()
            val m = msgs.first { it.s("kind") == "transport" }
            val ct = ti.send.encrypt(none, bytes(m.s("payload")))
            f.equal(m.s("ciphertext"), hex(ct)) { "$id record" }
            f.equal(m.s("payload"), hex(tr.receive.decrypt(none, ct))) { "$id record opens" }
        }
        f.done(5)
    }

    @Test
    fun everyFailureRowFailsWhereAndWhyTheCorpusSays() = runBlocking<Unit> {
        val f = Failures("cpace failures")
        for (r in rows(c, "failures")) {
            val id = r.s("id")
            val swap = r.sOrNull("initEphemeralPublic")?.let(::bytes)
            val i = handshake(NoiseRole.initiator, Side(r.s("protocol"), r.s("prologue"), r.s("psk"), r.s("initStatic"), r.s("initEphemeral")), swap)
            val re = handshake(
                NoiseRole.responder,
                Side(
                    r.s("protocol"),
                    r.sOrNull("responderPrologue") ?: r.s("prologue"),
                    r.sOrNull("responderPsk") ?: r.s("psk"),
                    r.s("respStatic"),
                    r.s("respEphemeral"),
                ),
            )
            var failure: Pair<Int, String>? = null
            for ((idx, p) in r["payloads"]!!.arrayValue!!.withIndex()) {
                val (w, d) = if (idx % 2 == 0) i to re else re to i
                try {
                    val wire = w.writeMessage(bytes(p.stringValue!!))
                    assertEquals(p.stringValue, hex(d.readMessage(wire)))
                } catch (e: NoiseException) {
                    failure = idx to e.code.name
                    break
                }
            }
            f.equal(r["failedAt"].longValue!!.toInt() to r.s("reason"), failure) { "$id failure" }
        }
        f.done(10)
    }
}
