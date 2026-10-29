// @pkey-feature connect.lan
//
// The `lanAddresses` and `mdnsAnswers` sections of conformance/corpus/v2/peer-matrix.json
// (WIRE-CONTRACT-V5 sections 15.4 and 15.4.1; CC-IPV6.5a), read in place. It mirrors
// conformance/runners/node/peerMatrixSuites.ts and packages/sdk-node/test/mdnsAnswers.test.ts.
//
// - `lanAddresses.rows`: every row through :core's `lanVerdict` and `lanGroupKey`, with the exact row
//   count, so a row added or dropped is a deliberate corpus change.
// - `lanAddresses.candidates`: NOT run. The Kotlin SDK neither sends nor reads the CANDIDATES record
//   in v1 (CC-08R), so it has no `candidateTarget`; the runner pins the row count only.
// - `mdnsAnswers.rows`: each packet is decoded by :core's own DNS codec (`parseMdnsPacket`, which
//   knows A and AAAA), its address records go to `MdnsAddressBook` with the row's source and zone, in
//   packet order, and the table must equal `learned`; `prior` is the table held before the packet.
//   The corpus carries no interface data, so the source-subnet check (RFC 6762 section 11) is
//   tested in JvmMdnsTest.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.peer.lan.MdnsAddress
import im.plrs.key.core.peer.lan.MdnsAddressBook
import im.plrs.key.core.peer.lan.lanGroupKey
import im.plrs.key.core.peer.lan.lanVerdict
import im.plrs.key.core.peer.lan.parseMdnsPacket
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PeerMatrixLanTest : ConformanceSuite() {
    private val m: JsonObject = Corpus.v2("peer-matrix.json")

    private fun rows(e: JsonElement?): List<JsonObject> = e!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    @Test
    fun lanVerdictRows() {
        val section = m["lanAddresses"]!!.obj
        val rows = rows(section["rows"])
        val candidates = rows(section["candidates"]!!.obj["rows"])
        // Exact: a row added or dropped is a deliberate corpus change, never a silent one.
        assertEquals(133, rows.size)
        assertEquals(73, candidates.size)
        assertEquals(rows.size, rows.map { it.s("id") }.toSet().size)
        val f = Failures("peer-matrix lanAddresses")
        for (r in rows) {
            val got = lanVerdict(r.s("remote"), r["local"].stringValue, r["allowLoopback"].boolValue == true)
            f.equal(r["dial"].boolValue, got.dial) { "${r.s("id")} dial" }
            f.equal(r["key"].stringValue, got.key) { "${r.s("id")} key" }
            f.equal(r["group"].stringValue, lanGroupKey(r["key"].stringValue)) { "${r.s("id")} group" }
        }
        f.done(rows.size)
    }

    private fun entries(e: JsonElement?): List<MdnsAddress> = if (e ==
        null
    ) {
        emptyList()
    } else {
        rows(e).map { MdnsAddress(it.s("name"), it.s("address")) }
    }

    /** The table grouped by name: the order across names carries no meaning, the order within one does. */
    private fun grouped(t: List<MdnsAddress>): Map<String, List<String>> = t.groupBy({ it.name }, { it.address })

    private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun mdnsAnswerRows() {
        val rows = rows(m["mdnsAnswers"]!!.obj["rows"])
        assertEquals(36, rows.size)
        assertEquals(rows.size, rows.map { it.s("id") }.toSet().size)
        val f = Failures("peer-matrix mdnsAnswers")
        for (r in rows) {
            val book = MdnsAddressBook()
            for (p in entries(r["prior"])) book.hold(p.name, p.address)
            val packet = runCatching { parseMdnsPacket(unhex(r.s("packet"))) }.getOrNull()
            f.check(packet != null) { "${r.s("id")}: the codec refused the packet" }
            if (packet != null) {
                for (a in packet.answers) book.learn(a, r.s("source"), r["zone"].stringValue, 0.0)
            }
            f.equal(grouped(entries(r["learned"])), grouped(book.table())) { r.s("id") }
        }
        f.done(rows.size)
    }
}
