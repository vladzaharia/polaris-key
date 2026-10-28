// @pkey-feature connect.protocol
//
// The byte-level rows of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 sections 15.5 to
// 15.7), read in place and driven through :core's peer byte layer: the prologue and PSK
// derivations, TCP frames (encode, limits, decode, the stateful reader) and relay envelopes
// (round trips both ways, refusals, sizes). It mirrors conformance/runners/node/peerMatrix.test.ts.
// The Gradle `test` task runs it on the JCA backend and `testTink` on Tink.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.FrameDecode
import im.plrs.key.core.peer.FrameReader
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RelayDirection
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.decodeFrames
import im.plrs.key.core.peer.decodeRelay
import im.plrs.key.core.peer.encodeFrame
import im.plrs.key.core.peer.encodeRelay
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.peerPsk
import im.plrs.key.core.peer.sha256
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerMatrixBytesTest : ConformanceSuite() {
    private val m: JsonObject = Corpus.v2("peer-matrix.json")

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.o(name: String): JsonObject = this[name]!!.obj

    @Test
    fun prologueAndPskDerivations() {
        val f = Failures("peer-matrix prologue and psk")
        for (r in rows(m["prologue"])) f.equal(r.s("prologue"), hex(peerPrologue(r.s("slug"), PeerMode.valueOf(r.s("mode"))))) { "prologue ${r.s("slug")} ${r.s("mode")}" }
        for (r in rows(m["psk"])) f.equal(r.s("psk"), hex(peerPsk(unhex(r.s("kDisc")), r.s("slug")))) { "psk ${r.s("slug")}" }
        f.done(10)
    }

    @Test
    fun frameEncodeAndLimits() {
        val frames = m.o("frames")
        val f = Failures("peer-matrix frames encode")
        for (r in rows(frames["encode"])) f.equal(r.s("frame"), hex(encodeFrame(unhex(r.s("noise"))))) { "encode ${r.s("noise")}" }
        for (r in rows(frames["limits"])) {
            val len = r["len"].longValue!!.toInt()
            val want = r.o("want")
            val body = ByteArray(len) { 0x5a }
            val got = try {
                encodeFrame(body)
            } catch (e: IllegalArgumentException) {
                null
            }
            if (want["refused"] != null) {
                f.check(got == null) { "limit $len must be refused" }
            } else {
                f.check(got != null) { "limit $len must encode" }
                if (got != null) {
                    f.equal(want.s("header"), hex(got.copyOf(2))) { "limit $len header" }
                    f.equal(want.s("frameSha256"), hex(sha256(got))) { "limit $len sha" }
                }
            }
        }
        f.done(10)
    }

    @Test
    fun frameDecodeAndTheStatefulReaderAgree() {
        val f = Failures("peer-matrix frames decode")
        for (r in rows(m.o("frames")["decode"])) {
            val id = r.s("id")
            val stream = unhex(r.s("stream"))
            val want = r.o("want")
            val got = decodeFrames(stream)
            val reader = FrameReader()
            // Trickle one byte at a time: the reader must reach the same frames, or the same close.
            var readerFrames: MutableList<ByteArray>? = ArrayList()
            for (b in stream) readerFrames = reader.push(byteArrayOf(b))?.let { readerFrames?.apply { addAll(it) } }
            if (want["error"] != null) {
                f.check(got === FrameDecode.BadFrame) { "$id: expected peer_bad_frame" }
                f.check(readerFrames == null) { "$id: reader expected a close" }
                f.equal("peer_bad_frame", want.s("error")) { "$id code" }
            } else {
                val ok = got as? FrameDecode.Frames
                f.check(ok != null) { "$id: expected frames" }
                if (ok == null) continue
                val wantFrames = want["frames"]!!.arrayValue!!.map { it.stringValue!! }
                f.equal(wantFrames, ok.frames.map(::hex)) { "$id frames" }
                f.equal(want.s("rest"), hex(ok.rest)) { "$id rest" }
                f.equal(wantFrames, readerFrames?.map(::hex)) { "$id reader frames" }
                f.check(reader.copied <= 4L * stream.size + 8) { "$id: the reader copied ${reader.copied} bytes for ${stream.size}" }
            }
        }
        f.done(10)
    }

    private fun toMessage(x: JsonObject): RelayMessage = when (x.s("op")) {
        "send" -> RelayMessage.Send(unhex(x.s("to")), x["session"].longValue!!, unhex(x.s("noise")))
        "recv" -> RelayMessage.Recv(unhex(x.s("from")), x["session"].longValue!!, unhex(x.s("noise")))
        "list" -> RelayMessage.List
        "ping" -> RelayMessage.Ping(unhex(x.s("data")))
        "pong" -> RelayMessage.Pong(unhex(x.s("data")))
        "members" -> RelayMessage.Members(x["devices"]!!.arrayValue!!.map { unhex(it.stringValue!!) })
        "ring" -> RelayMessage.Ring(x["epoch"].longValue!!)
        "gone" -> RelayMessage.Gone(unhex(x.s("device")))
        "limit" -> RelayMessage.Limit(x["reason"].longValue!!.toInt())
        else -> error("unknown op ${x.s("op")}")
    }

    @Test
    fun relayMessagesRoundTripBothWays() {
        val f = Failures("peer-matrix relay messages")
        for (r in rows(m.o("relayEnvelopes")["messages"])) {
            val id = r.s("id")
            val msg = toMessage(r.o("message"))
            f.equal(r.s("bytes"), hex(encodeRelay(msg))) { "$id encode" }
            val dec = decodeRelay(RelayDirection.valueOf(r.s("dir")), unhex(r.s("bytes")))
            f.check(dec != null) { "$id decode refused" }
            // Equal when it re-encodes to the same bytes, and the op is the same kind.
            if (dec != null) {
                f.equal(msg::class, dec::class) { "$id kind" }
                f.equal(r.s("bytes"), hex(encodeRelay(dec))) { "$id re-encode" }
            }
        }
        f.done(18)
    }

    @Test
    fun relayRefusedAndSizes() {
        val env = m.o("relayEnvelopes")
        val f = Failures("peer-matrix relay refused and sizes")
        for (r in rows(env["refused"])) f.check(decodeRelay(RelayDirection.valueOf(r.s("dir")), unhex(r.s("bytes"))) == null) { "${r.s("id")} must be refused" }
        for (r in rows(env["sizes"])) {
            val prefix = unhex(r.o("bytes").s("prefix"))
            val b = ByteArray(r["total"].longValue!!.toInt()) { r.o("bytes").s("fill").toInt(16).toByte() }
            prefix.copyInto(b)
            val got = decodeRelay(RelayDirection.valueOf(r.s("dir")), b)
            f.check((got != null) == (r.o("want")["refused"] == null)) { "${r.s("id")}: ${if (got == null) "refused" else "accepted"}" }
        }
        f.done(30)
        assertTrue(rows(env["sizes"]).isNotEmpty())
        assertEquals(65564L, env["maxMessage"].longValue)
    }
}
