// @pkey-feature sync.files.delta
//
// The synced-file primitives against conformance/corpus/v2/sync-vectors.json (U-23.K1;
// WIRE-CONTRACT-V5 section 13.8.3), read in place: cdcCases, cdcEditCases, deltaCases, chunkCases
// and manifestCases. fileStreamCases and transferPlanCases belong to U-23.K2. Core links no zstd,
// so the chunk rows inject the opt-in :packs decoder (zstd-jni).

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCdc
import im.plrs.key.core.sync.SyncChunks
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncManifest
import im.plrs.key.core.sync.ZstdDecode
import im.plrs.key.packs.LibZstd
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SyncFileVectorsTest : ConformanceSuite() {
    private val v: JsonObject = Corpus.v2("sync-vectors.json")
    private val zstd: ZstdDecode = { frame, size -> LibZstd().decode(frame, size) }

    private fun bytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun hex(b: ByteArray): String = SyncChunks.hex(b)

    private fun list(name: String): List<JsonObject> = v[name]!!.arrayValue!!.map { it.obj }

    private fun JsonObject.s(name: String): String = this[name].stringValue!!

    private fun JsonObject.i(name: String): Int = this[name].longValue!!.toInt()

    private fun JsonObject.ints(name: String): List<Int> = this[name]!!.arrayValue!!.map { it.longValue!!.toInt() }

    private fun JsonObject.strings(name: String): List<String> = this[name]!!.arrayValue!!.map { it.stringValue!! }

    /** SHA-256 counter blocks of `prefix + label`, then the 4-byte big-endian counter. */
    private fun counterBytes(prefix: String, label: String, length: Int): ByteArray {
        val out = ByteArray(length)
        var at = 0
        var n = 0
        while (at < length) {
            val ctr = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
            SyncCrypto.sha256(SyncCrypto.utf8(prefix + label) + ctr).copyInto(out, at, 0, minOf(32, length - at))
            at += 32
            n++
        }
        return out
    }

    private fun cdcInput(i: JsonObject): ByteArray = if (i.s("kind") ==
        "byte"
    ) {
        ByteArray(i.i("length")) { i.i("value").toByte() }
    } else {
        counterBytes("pkey-sync vector cdc ", i.s("label"), i.i("length"))
    }

    /** The chunks of [data] fed in pieces of [piece] bytes. */
    private fun cut(data: ByteArray, avg: Int, piece: Int): List<ByteArray> {
        val c = SyncCdc.Chunker(SyncCdc.params(avg)!!)
        val out = ArrayList<ByteArray>()
        var at = 0
        while (at < data.size) {
            out += c.push(data, at, minOf(at + piece, data.size))
            at += piece
        }
        return out + c.finish()
    }

    @Test
    fun cdc() {
        val f = Failures("sync cdc")
        for (c in list("cdcCases")) {
            f.equal(SyncCdc.Params(c.i("avg"), c.i("min"), c.i("max")), SyncCdc.params(c.i("avg"))) { "${c.s("id")} params" }
            val input = cdcInput(c["input"]!!.obj)
            // Whole, then in awkward pieces: the cuts do not depend on how the input arrives.
            for (piece in listOf(maxOf(input.size, 1), 1000, 65537)) {
                f.equal(c.ints("lens"), cut(input, c.i("avg"), piece).map { it.size }) { "${c.s("id")} in pieces of $piece" }
            }
        }
        f.done(list("cdcCases").size)
    }

    @Test
    fun cdcParameters() {
        assertEquals(SyncCdc.Params(262144, 65536, 1048576), SyncCdc.DEFAULT_PARAMS)
        assertNull(SyncCdc.params(1000))
        assertNull(SyncCdc.params(32))
        assertNull(SyncCdc.params(0))
        assertNull(SyncCdc.params(-64))
    }

    private fun chunkRow(c: JsonObject, f: Failures) {
        val id = c.s("id")
        val root = bytes(c.s("rootHex"))
        val collection = c.s("collection")
        when (c.s("kind")) {
            "id" -> {
                val plain = bytes(c.s("plainHex"))
                f.equal(c.s("e2eIdHex"), SyncChunks.chunkIdHex(root, collection, plain)) { "$id e2e" }
                f.equal(c.s("serverIdHex"), SyncChunks.chunkIdHex(null, collection, plain)) { "$id server" }
            }

            "pair" -> {
                f.check(c.s("rawNonceHex") != c.s("zstdNonceHex")) { "$id nonces differ" }
                val sides = listOf(Triple(c.s("rawObjectHex"), c.s("rawNonceHex"), 0), Triple(c.s("zstdObjectHex"), c.s("zstdNonceHex"), 1))
                for ((obj, nonce, codec) in sides) {
                    val raw = bytes(obj)
                    f.equal(nonce, hex(raw.copyOfRange(2, 14))) { "$id codec $codec nonce" }
                    val o = SyncChunks.open(root, collection, bytes(c.s("idHex")), raw, zstd)
                    f.check(o is SyncChunks.Opened.Ok && hex(o.plain) == c.s("plainHex") && o.codec == codec) { "$id codec $codec opens" }
                }
            }

            else -> objectRow(c, f)
        }
    }

    private fun objectRow(c: JsonObject, f: Failures) {
        val id = c.s("id")
        val root = bytes(c.s("rootHex"))
        val collection = c.s("collection")
        val opened = SyncChunks.open(root, collection, bytes(c.s("idHex")), bytes(c.s("objectHex")), zstd)
        val e = c["expect"]!!.obj
        if (e.s("result") == "ok") {
            val ok = opened is SyncChunks.Opened.Ok && hex(opened.plain) == e.s("plainHex") && opened.codec == e.i("codec")
            f.check(ok) { "$id opens" }
        } else {
            f.equal(e.s("reason"), (opened as? SyncChunks.Opened.Refused)?.reason?.wire ?: "ok") { "$id reason" }
        }
        val seal = c["seal"]?.takeIf { it is JsonObject }?.obj
        if (seal != null) {
            val sealed = SyncChunks.seal(root, collection, bytes(c.s("idHex")), seal.i("codec"), bytes(seal.s("bodyHex")))
            f.equal(c.s("objectHex"), hex(sealed)) { "$id seals" }
        }
    }

    @Test
    fun chunks() {
        val f = Failures("sync chunks")
        for (c in list("chunkCases")) chunkRow(c, f)
        f.done(list("chunkCases").size)
    }

    private fun manifestRow(c: JsonObject, f: Failures) {
        val id = c.s("id")
        val raw = bytes(c.s("manifestHex"))
        val parsed = SyncManifest.parse(raw)
        val e = c["expect"]!!.obj
        if (parsed is SyncManifest.Parsed.Ok) {
            val m = parsed.manifest
            f.equal("ok", e.s("result")) { "$id result" }
            f.equal(e["plainSize"].longValue, m.plainSize) { "$id plainSize" }
            f.equal(e.s("plainSha256Hex"), hex(m.plainSha256)) { "$id plainSha256" }
            val want = e["records"]!!.arrayValue!!.map { it.obj.s("idHex") to it.obj.i("plainLen") }
            f.equal(want, m.records.map { hex(it.id) to it.plainLen }) { "$id records" }
            f.check(raw.contentEquals(SyncManifest.encode(m))) { "$id encodes back" }
        } else {
            f.equal(e.s("reason"), (parsed as SyncManifest.Parsed.Refused).reason.wire) { "$id reason" }
        }
    }

    @Test
    fun manifests() {
        val f = Failures("sync manifests")
        for (c in list("manifestCases")) manifestRow(c, f)
        f.done(list("manifestCases").size)
    }

    private fun applyEdit(base: ByteArray, e: JsonObject): ByteArray {
        val at = e.i("at")
        val length = e.i("length")
        val op = e.s("op")
        val mid = if (op == "delete") ByteArray(0) else counterBytes("pkey-sync vector cdc-edit ", e.s("label"), length)
        return base.copyOfRange(0, at) + mid + base.copyOfRange(if (op == "insert") at else at + length, base.size)
    }

    private class Side(val label: String, val buf: ByteArray, val lens: List<Int>, val ids: List<String>, val manifestHex: String)

    private fun sideRow(name: String, c: JsonObject, side: Side, f: Failures) {
        val chunks = cut(side.buf, c.i("avg"), 65537)
        f.equal(side.lens, chunks.map { it.size }) { "$name ${side.label} lengths" }
        f.equal(side.ids, chunks.map { SyncChunks.chunkIdHex(bytes(c.s("rootHex")), c.s("collection"), it) }) { "$name ${side.label} ids" }
        val parsed = SyncManifest.parse(bytes(side.manifestHex))
        f.check(parsed is SyncManifest.Parsed.Ok) { "$name ${side.label} manifest refused" }
        if (parsed is SyncManifest.Parsed.Ok) {
            val m = parsed.manifest
            f.equal(side.buf.size.toLong(), m.plainSize) { "$name ${side.label} plainSize" }
            f.check(SyncCrypto.sha256(side.buf).contentEquals(m.plainSha256)) { "$name ${side.label} plainSha256" }
            f.equal(side.ids, m.records.map { hex(it.id) }) { "$name ${side.label} manifest ids" }
            f.equal(side.lens, m.records.map { it.plainLen }) { "$name ${side.label} manifest lengths" }
            f.equal(side.manifestHex, hex(SyncManifest.encode(m))) { "$name ${side.label} manifest encodes back" }
        }
    }

    private fun editRow(c: JsonObject, f: Failures) {
        val name = c.s("id")
        val base = cdcInput(c["base"]!!.obj)
        val edited = applyEdit(base, c["edit"]!!.obj)
        sideRow(name, c, Side("base", base, c.ints("baseLens"), c.strings("baseIdsHex"), c.s("baseManifestHex")), f)
        sideRow(name, c, Side("edited", edited, c.ints("editedLens"), c.strings("editedIdsHex"), c.s("editedManifestHex")), f)
        val have = c.strings("baseIdsHex").toSet()
        val edIds = c.strings("editedIdsHex")
        f.equal(c.ints("keptIndexes"), edIds.indices.filter { edIds[it] in have }) { "$name kept" }
        f.equal(c.ints("changedIndexes"), edIds.indices.filter { edIds[it] !in have }) { "$name changed" }
    }

    private fun records(rows: Map<String, JsonObject>, s: JsonObject): List<Pair<String, Int>> {
        val row = rows[s.s("row")]!!
        val hexOf = row.s(if (s.s("side") == "base") "baseManifestHex" else "editedManifestHex")
        val m = (SyncManifest.parse(bytes(hexOf)) as SyncManifest.Parsed.Ok).manifest
        return m.records.map { hex(it.id) to it.plainLen }
    }

    private fun deltaRow(d: JsonObject, rows: Map<String, JsonObject>, f: Failures) {
        val h = d["have"]!!.obj
        val have = (if (h.containsKey("idsHex")) h.strings("idsHex") else records(rows, h).map { it.first }).toSet()
        val move = LinkedHashMap<String, Int>()
        for ((id, len) in records(rows, d["want"]!!.obj)) if (id !in have && id !in move) move[id] = len
        f.equal(d.strings("moveIdsHex"), move.keys.toList()) { "${d.s("id")} ids" }
        f.equal(d.i("moveBytes"), move.values.sum()) { "${d.s("id")} bytes" }
    }

    @Test
    fun editsAndDeltas() {
        val f = Failures("sync cdc edits")
        val rows = list("cdcEditCases").associateBy { it.s("id") }
        for (c in rows.values) editRow(c, f)
        for (d in list("deltaCases")) deltaRow(d, rows, f)
        f.done(rows.size + list("deltaCases").size)
    }
}
