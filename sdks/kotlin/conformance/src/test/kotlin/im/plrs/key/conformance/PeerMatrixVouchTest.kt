// @pkey-feature identity.nearby
//
// The `vouch` section of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 section 15.6.1), read in
// place and driven through :core's `Vouch.kt`: M's check of a `VOUCH_REQ` (`verifyVouchRequest`), D's
// reading of a `VOUCH_RESULT` (`parseVouchResult`), the order guard (`VouchFlow`) and M's reading of the
// answer of `nearby/approve` (`finishMap`). It mirrors conformance/runners/node/peerMatrixSuites.ts. The
// Gradle `test` task runs it on the JCA backend and `testTink` on Tink.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.AbandonReason
import im.plrs.key.core.peer.ApproveAnswer
import im.plrs.key.core.peer.FinishAction
import im.plrs.key.core.peer.RecordType
import im.plrs.key.core.peer.VouchFlow
import im.plrs.key.core.peer.VouchHello
import im.plrs.key.core.peer.VouchResultRead
import im.plrs.key.core.peer.VouchRole
import im.plrs.key.core.peer.VouchStatus
import im.plrs.key.core.peer.VouchVerdict
import im.plrs.key.core.peer.buildVouchResult
import im.plrs.key.core.peer.finishMap
import im.plrs.key.core.peer.parseVouchResult
import im.plrs.key.core.peer.verifyVouchRequest
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PeerMatrixVouchTest : ConformanceSuite() {
    private val v: JsonObject = Corpus.v2("peer-matrix.json")["vouch"]!!.obj

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun rows(name: String): List<JsonObject> = v[name]!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    /** A row's body bytes: text, hex, or a prefix, a filler and a suffix. */
    private fun bodyOf(r: JsonObject): ByteArray {
        r["bodyHex"]?.let { return unhex(it.stringValue!!) }
        r["bodyPad"]?.let {
            val p = it.obj
            return (p.s("prefix") + p.s("fill").repeat(p["count"].longValue!!.toInt()) + p.s("suffix")).toByteArray(Charsets.UTF_8)
        }
        return r.s("body").toByteArray(Charsets.UTF_8)
    }

    @Test
    fun hasTheRows() {
        assertEquals(78, rows("requests").size)
        assertEquals(26, rows("results").size)
        assertEquals(30, rows("flows").size)
        assertEquals(29, rows("finish").size)
        for (k in listOf("requests", "results", "flows", "finish")) assertEquals(k, rows(k).size, rows(k).map { it.s("id") }.toSet().size)
    }

    @Test
    fun requests() {
        val f = Failures("peer-matrix vouch requests")
        for (r in rows("requests")) {
            val id = r.s("id")
            val body = bodyOf(r)
            if (r["bodyPad"] != null) f.equal(r["length"].longValue!!.toInt(), body.size) { "$id length" }
            val h = r.obj("hello")
            val got = verifyVouchRequest(r.s("slug"), unhex(r.s("hHex")), VouchHello(h["label"].stringValue, h.s("platform")), body)
            if (r.s("verdict") == "ok") {
                val want = r.obj("result")
                f.check(got != null) { "$id must verify" }
                if (got != null) {
                    f.equal(want.s("request"), got.request) { "$id request" }
                    f.equal(want.s("deviceId"), got.deviceId) { "$id deviceId" }
                    f.equal(want.s("signKey"), got.signKey) { "$id signKey" }
                    f.equal(want.s("agreeKey"), got.agreeKey) { "$id agreeKey" }
                    f.equal(want["label"].let { if (it == null || it is JsonNull) null else it.stringValue }, got.label) { "$id label" }
                    f.equal(want.s("platform"), got.platform) { "$id platform" }
                }
            } else {
                f.check(got == null) { "$id must be refused" }
                f.equal("peer_bad_frame", r.s("close")) { "$id close" }
            }
        }
        f.done(78)
    }

    private fun JsonObject.obj(name: String): JsonObject = this[name]!!.obj

    @Test
    fun results() {
        val f = Failures("peer-matrix vouch results")
        for (r in rows("results")) {
            val id = r.s("id")
            val got = parseVouchResult(bodyOf(r))
            if (r["refuse"] != null) {
                f.check(got is VouchResultRead.Refuse && got.code.name == r.s("refuse")) { "$id must refuse ${r["refuse"]}" }
            } else {
                f.check(got is VouchResultRead.Status && got.status.name == r.s("status")) { "$id status" }
            }
        }
        f.done(26)
    }

    private class Rec(override val type: Int, override val body: ByteArray, val at: Int) : im.plrs.key.core.peer.VouchRecord

    /** One session's order, direction and gating rules (rules 1, 4, 7, 8, 12): D and M, the receiving end checking first. */
    private fun runFlow(steps: List<JsonObject>): Triple<String?, Int?, List<Int>> {
        val d = VouchFlow<Rec>(VouchRole.Requester)
        val m = VouchFlow<Rec>(VouchRole.Approver)
        val delivered = ArrayList<Int>()
        fun take(vd: VouchVerdict<Rec>, onM: Boolean = false): String? {
            if (vd is VouchVerdict.Closed) return vd.close.name
            for (r in (vd as VouchVerdict.Ok).deliver) {
                delivered += r.at
                if (onM && r.type == RecordType.VOUCH_REQ) m.verified()
            }
            return null
        }
        for ((i, s) in steps.withIndex()) {
            var code: String? = null
            when (s["ev"].stringValue) {
                "handshake" -> {
                    val capsD = s["capsD"]!!.arrayValue!!.map { it.stringValue!! }
                    val capsM = s["capsM"]!!.arrayValue!!.map { it.stringValue!! }
                    code = take(d.negotiate(capsD, capsM))
                    code = code ?: take(m.negotiate(capsM, capsD))
                }

                "shown" -> {
                    d.codeShown()
                    m.codeShown()
                }

                "picked" -> code = take(m.picked(), true)

                "wrong-pick" -> code = take(m.abandon(AbandonReason.WrongPick))

                "none-match" -> code = take(m.abandon(AbandonReason.NoneMatch))

                "timeout" -> code = take(m.abandon(AbandonReason.Timeout))

                "confirmed" -> code = take(d.confirmAccount())

                null -> {
                    val type = s.s("type").toInt(16)
                    val body = if (type == RecordType.VOUCH_RESULT) {
                        buildVouchResult(VouchStatus.valueOf(s.s("status")))
                    } else {
                        ByteArray(s["bytes"].longValue?.toInt() ?: 0)
                    }
                    val r = Rec(type, body, i)
                    val d2m = s.s("dir") == "d2m"
                    val from = if (d2m) d else m
                    val to = if (d2m) m else d
                    code = take(to.receive(r), to === m)
                    // The sender's verdict only gates: what the receiver delivers is what counts.
                    val sent = from.send(r)
                    if (code == null && sent is VouchVerdict.Closed) code = sent.close.name
                }

                else -> error("unknown event ${s["ev"]}")
            }
            if (code != null) return Triple(code, i, delivered)
        }
        return Triple(null, null, delivered)
    }

    @Test
    fun flows() {
        val f = Failures("peer-matrix vouch flows")
        for (r in rows("flows")) {
            val id = r.s("id")
            val (close, at, delivered) = runFlow(r["steps"]!!.arrayValue!!.map { it.obj })
            val want = r.obj("want")
            f.equal(want["close"].stringValue, close) { "$id close" }
            f.equal(want["at"].longValue?.toInt(), at) { "$id at" }
            f.equal(want["delivered"]!!.arrayValue!!.map { it.longValue!!.toInt() }, delivered) { "$id delivered" }
        }
        f.done(30)
    }

    @Test
    fun finish() {
        val f = Failures("peer-matrix vouch finish")
        for (r in rows("finish")) {
            val id = r.s("id")
            val a = ApproveAnswer(
                http = r["http"].let { if (it == null || it is JsonNull) null else it.longValue!!.toInt() },
                body = r["body"].let { if (it == null || it is JsonNull) null else it.stringValue },
                discoveryNearby = r["discoveryNearby"].boolValue!!,
                keysRetried = r["keysRetried"].boolValue!!,
            )
            val want = r.obj("result")
            val got = finishMap(a)
            when {
                want["send"] != null -> f.check(got is FinishAction.Send && got.status.name == want.s("send")) { "$id send ${want["send"]}" }
                want["wait"] != null -> f.check(got is FinishAction.Wait && got.what == want.s("wait")) { "$id wait ${want["wait"]}" }
                else -> f.check(got is FinishAction.Close && got.stopAdvert == want["stopAdvert"].boolValue) { "$id close ${want["stopAdvert"]}" }
            }
        }
        f.done(29)
    }
}
