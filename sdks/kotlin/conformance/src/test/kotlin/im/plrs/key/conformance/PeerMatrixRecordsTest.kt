// @pkey-feature connect.protocol
//
// The `records` rows of conformance/corpus/v2/peer-matrix.json (WIRE-CONTRACT-V5 section 15.6): the
// type table, parsing a plaintext and every `sessions` row through a `RecordAssembler`. Mirrors
// conformance/runners/node/peerMatrix.test.ts. Runs on JCA (`test`) and on Tink (`testTink`).

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.AssembleResult
import im.plrs.key.core.peer.PeerRecord
import im.plrs.key.core.peer.RecordAssembler
import im.plrs.key.core.peer.RecordMode
import im.plrs.key.core.peer.parseRecord
import im.plrs.key.core.peer.sha256
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Test

class PeerMatrixRecordsTest : ConformanceSuite() {
    private val records: JsonObject = Corpus.v2("peer-matrix.json")["records"]!!.obj

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun body(e: JsonElement): ByteArray =
        (e as? JsonObject)?.let { o -> ByteArray(o["count"].longValue!!.toInt()) { o.s("fill").toInt(16).toByte() } } ?: unhex(e.stringValue!!)

    @Test
    fun parse() {
        val f = Failures("peer-matrix records parse")
        for (r in rows(records["parse"])) {
            val got = parseRecord(unhex(r.s("plaintext")))
            val want = r["want"]!!.obj
            if (want["error"] != null) {
                f.check(got == null) { "${r.s("plaintext")} must be refused" }
            } else if (got == null) {
                f.check(false) { "${r.s("plaintext")} must parse" }
            } else {
                f.equal(want.s("type"), "%04x".format(got.type)) { "type" }
                f.equal(want["more"].boolValue, (got.flags and 1) != 0) { "more" }
                f.equal(want.s("body"), hex(got.body)) { "body" }
            }
        }
        f.done(10)
    }

    @Test
    fun sessions() {
        val f = Failures("peer-matrix records sessions")
        for (s in rows(records["sessions"])) {
            val asm = RecordAssembler(RecordMode.valueOf(s.s("mode")))
            val delivered = ArrayList<List<Any>>()
            var close: Pair<String, Int>? = null
            val recs = rows(s["records"])
            var i = 0
            while (i < recs.size && close == null) {
                val rec = recs[i]
                val r = asm.push(PeerRecord(rec.s("type").toInt(16), rec["flags"].longValue?.toInt() ?: 0, body(rec["body"]!!)))
                if (r is AssembleResult.Close) close = r.code.name to i
                if (r is AssembleResult.Message) delivered += listOf("%04x".format(r.type), r.body.size.toLong(), hex(sha256(r.body)))
                i++
            }
            val want = s["want"]!!.obj
            val id = s.s("id")
            if (want["close"] != null) {
                f.equal(want.s("close") to want["at"].longValue!!.toInt(), close) { "$id close" }
            } else {
                f.check(close == null) { "$id closed with $close" }
                val wantRows = rows(want["delivered"]).map { listOf(it.s("type"), it["length"].longValue!!, it.s("sha256")) }
                f.equal(wantRows, delivered) { "$id delivered" }
            }
        }
        f.done(80)
    }
}
