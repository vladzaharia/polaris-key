// @pkey-feature sync.files sync.files.delta
//
// The synced-file primitives against conformance/corpus/v2/sync-vectors.json (U-23.K1;
// WIRE-CONTRACT-V5 section 13.8.3), read in place: cdcCases, cdcEditCases, deltaCases, chunkCases
// and manifestCases, and (U-23.K2) fileStreamCases and transferPlanCases. Core links no zstd, so
// the chunk rows inject the opt-in :packs decoder (zstd-jni).

package im.plrs.key.conformance

import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCdc
import im.plrs.key.core.sync.SyncChunks
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncCryptoException
import im.plrs.key.core.sync.SyncFileStream
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncManifest
import im.plrs.key.core.sync.SyncTransferPlan
import im.plrs.key.core.sync.ZstdDecode
import im.plrs.key.packs.LibZstd
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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

    // -- U-23.K2: the transfer planner and the file stream ---------------------------------------

    /** The parts of a multipart plan tile the file: contiguous, every one full but the last, none empty. */
    private fun partsTile(id: String, p: SyncTransferPlan.Plan, size: Long, f: Failures) {
        var at = 0L
        val parts = p.parts!!
        for (n in 1..parts) {
            val r = SyncTransferPlan.partRange(p, size, n)
            f.check(r.first == at && !r.isEmpty() && (n == parts || r.last - r.first + 1 == p.partBytes)) { "$id part $n" }
            at = r.last + 1
        }
        f.equal(size, at) { "$id parts tile the file" }
        f.check(runCatching { SyncTransferPlan.partRange(p, size, 0) }.isFailure) { "$id has no part 0" }
        f.check(runCatching { SyncTransferPlan.partRange(p, size, parts + 1) }.isFailure) { "$id has no part past the last" }
    }

    @Test
    fun transferPlans() {
        val f = Failures("sync transfer plans")
        for (c in list("transferPlanCases")) {
            val id = c.s("id")
            val size = c["size"].longValue!!
            val p = SyncTransferPlan.plan(size, c["delta"].boolValue == true)
            val e = c["expect"]!!.obj
            f.equal(e.s("mode"), p.mode.wire) { "$id mode" }
            f.equal(e["partBytes"].longValue, p.partBytes) { "$id partBytes" }
            f.equal(e["parts"].longValue, p.parts) { "$id parts" }
            if (p.mode == SyncTransferPlan.Mode.MULTIPART) {
                partsTile(id, p, size, f)
            } else {
                f.check(runCatching { SyncTransferPlan.partRange(p, size, 1) }.isFailure) { "$id has no part ranges" }
            }
        }
        f.done(list("transferPlanCases").size)
        assertThrows(IllegalArgumentException::class.java) { SyncTransferPlan.plan(-1, false) }
    }

    /** Applies the corpus's byte mutations. Segment i of a stream is at 64 + i * (1 MiB + 16). */
    private fun applyOps(stream: ByteArray, ops: List<JsonObject>): ByteArray {
        var b = stream.copyOf()
        val stride = SyncFileStream.SEGMENT_BYTES + SyncFileStream.TAG_BYTES
        fun seg(i: Int): IntRange = (64 + i * stride) until minOf(b.size, 64 + i * stride + stride)
        for (o in ops) {
            when (val op = o.s("op")) {
                "truncate" -> b = b.copyOfRange(0, o.i("length"))

                "dropSegment" -> seg(o.i("index")).let { r -> b = b.copyOfRange(0, r.first) + b.copyOfRange(r.last + 1, b.size) }

                "swapSegments" -> {
                    val r1 = seg(minOf(o.i("a"), o.i("b")))
                    val r2 = seg(maxOf(o.i("a"), o.i("b")))
                    b = b.copyOfRange(0, r1.first) + b.copyOfRange(r2.first, r2.last + 1) +
                        b.copyOfRange(r1.last + 1, r2.first) + b.copyOfRange(r1.first, r1.last + 1) + b.copyOfRange(r2.last + 1, b.size)
                }

                "appendSegment" -> seg(o.i("from")).let { r -> b += b.copyOfRange(r.first, r.last + 1) }

                "xor" -> b[o.i("offset")] = (b[o.i("offset")].toInt() xor o.i("value")).toByte()

                "setHex" -> bytes(o.s("hex")).copyInto(b, o.i("offset"))

                "appendHex" -> b += bytes(o.s("hex"))

                else -> error("unknown op $op")
            }
        }
        return b
    }

    private class Base(val bytes: ByteArray, val root: ByteArray, val collection: String)

    private fun sealedBases(f: Failures): Map<String, Base> {
        val out = HashMap<String, Base>()
        for (r in list("fileStreamCases").filter { it.s("kind") == "seal" }) {
            val id = r.s("id")
            val root = bytes(r.s("rootHex"))
            val collKey = SyncKeys.deriveCollKey(root, r.s("collection"))
            val kid = SyncKeys.deriveKid(root)
            val plainRow = r["plain"]!!.obj
            val plain = counterBytes("pkey-sync vector file ", plainRow.s("label"), plainRow.i("length"))
            val e = r["expect"]!!.obj
            f.equal(e.s("plainSha256Hex"), hex(SyncCrypto.sha256(plain))) { "$id plaintext" }
            val sealed = SyncFileStream.sealFile(collKey, kid, plain, bytes(r.s("saltHex")))
            f.equal(e.i("sealedSize"), sealed.size) { "$id sealed size" }
            f.equal(sealed.size.toLong(), SyncFileStream.sealedSize(plain.size.toLong())) { "$id sealedSize()" }
            f.equal(plain.size.toLong(), SyncFileStream.plainSize(sealed.size.toLong())) { "$id plainSize()" }
            f.equal(e.s("headerHex"), hex(sealed.copyOfRange(0, 64))) { "$id header" }
            f.equal(e.s("sealedSha256Hex"), hex(SyncCrypto.sha256(sealed))) { "$id sealed bytes" }
            // The same bytes from a source that arrives in awkward pieces.
            val s = SyncFileStream.Sealer(collKey, kid, bytes(r.s("saltHex")))
            val parts = arrayListOf(s.header)
            var at = 0
            while (at < plain.size) {
                parts += s.push(plain, at, minOf(at + 100_003, plain.size))
                at += 100_003
            }
            parts += s.finish()
            f.equal(e.s("sealedSha256Hex"), hex(SyncCrypto.sha256(SyncCrypto.cat(*parts.toTypedArray())))) { "$id streams to the same bytes" }
            out[id] = Base(sealed, root, r.s("collection"))
        }
        return out
    }

    /** The verdict of an [SyncFileStream.Opener] fed [piece] bytes at a time: the plaintext SHA-256, or "!" and the reason. */
    private fun openInPieces(collKey: ByteArray, kid: ByteArray, bytes: ByteArray, piece: Int): String = try {
        val o = SyncFileStream.Opener(collKey, kid)
        val parts = ArrayList<ByteArray>()
        var at = 0
        while (at < bytes.size) {
            parts += o.push(bytes, at, minOf(at + piece, bytes.size))
            at += piece
        }
        parts += o.finish()
        hex(SyncCrypto.sha256(SyncCrypto.cat(*parts.toTypedArray())))
    } catch (refused: SyncFileStream.Failure) {
        "!" + refused.reason.wire
    }

    private fun openRow(r: JsonObject, bases: Map<String, Base>, f: Failures) {
        val id = r.s("id")
        val base = bases[r.s("base")]!!
        val bytes = applyOps(base.bytes, r["mutate"]!!.arrayValue!!.map { it.obj })
        val collKey = SyncKeys.deriveCollKey(base.root, r["openCollection"]?.stringValue ?: base.collection)
        val kid = if (r.containsKey("expectKidHex")) bytes(r.s("expectKidHex")) else SyncKeys.deriveKid(base.root)
        val e = r["expect"]!!.obj
        val opened = SyncFileStream.openFile(collKey, kid, bytes)
        val verdict = if (e.s("result") == "ok") e.s("plainSha256Hex") else "!" + e.s("reason")
        val got = when (opened) {
            is SyncFileStream.Opened.Ok -> hex(SyncCrypto.sha256(opened.plain))
            is SyncFileStream.Opened.Refused -> "!" + opened.reason.wire
        }
        f.equal(verdict, got) { "$id whole" }
        f.equal(verdict, openInPieces(collKey, kid, bytes, 300_007)) { "$id in pieces" }
    }

    private fun rangeRow(r: JsonObject, bases: Map<String, Base>, f: Failures) {
        val id = r.s("id")
        val base = bases[r.s("base")]!!
        val bytes = applyOps(base.bytes, r["mutate"]!!.arrayValue!!.map { it.obj })
        val collKey = SyncKeys.deriveCollKey(base.root, base.collection)
        val kid = SyncKeys.deriveKid(base.root)
        val reads = ArrayList<List<Long>>()
        val reader = SyncFileStream.RangeReader { offset, length ->
            reads += listOf(offset, length.toLong())
            bytes.copyOfRange(minOf(offset.toInt(), bytes.size), minOf(offset.toInt() + length, bytes.size))
        }
        val e = r["expect"]!!.obj
        try {
            val got = SyncFileStream.openRange(
                collKey,
                kid,
                SyncFileStream.Stored(bytes.size.toLong(), reader),
                r["start"].longValue!!,
                r["end"].longValue!!,
            )
            f.equal("ok", e.s("result")) { "$id result" }
            f.equal(e.i("length"), got.size) { "$id length" }
            f.equal(e.s("sha256Hex"), hex(SyncCrypto.sha256(got))) { "$id bytes" }
            val want = e["reads"]!!.arrayValue!!.map { p -> p.arrayValue!!.map { it.longValue!! } }
            f.equal(want, reads) { "$id reads only what it needs" }
        } catch (refused: SyncFileStream.Failure) {
            f.equal("invalid", e.s("result")) { "$id result" }
            f.equal(e.s("reason"), refused.reason.wire) { "$id reason" }
        }
    }

    private fun sizeRow(r: JsonObject, f: Failures) {
        for (p in r["plainToSealed"]!!.arrayValue!!) {
            val (plain, sealed) = p.arrayValue!!.map { it.longValue!! }
            f.equal(sealed, SyncFileStream.sealedSize(plain)) { "sealedSize($plain)" }
        }
        for (p in r["sealedToPlain"]!!.arrayValue!!) {
            val (sealed, plain) = p.arrayValue!!.let { it[0].longValue!! to it[1].longValue }
            f.equal(plain, SyncFileStream.plainSize(sealed)) { "plainSize($sealed)" }
        }
    }

    @Test
    fun fileStreams() {
        val f = Failures("sync file streams")
        val bases = sealedBases(f)
        for (r in list("fileStreamCases")) {
            when (r.s("kind")) {
                "sizes" -> sizeRow(r, f)
                "open" -> openRow(r, bases, f)
                "range" -> rangeRow(r, bases, f)
            }
        }
        f.done(list("fileStreamCases").size)
    }

    @Test
    fun fileStreamBeyondTheCorpus() {
        val root = ByteArray(32) { (it * 5 + 3).toByte() }
        val collKey = SyncKeys.deriveCollKey(root, "saves")
        val kid = SyncKeys.deriveKid(root)
        val plain = ByteArray(300_000) { (it * 7 + (it shr 3)).toByte() }
        // A seal draws a fresh salt: two seals of one file differ and both open.
        val a = SyncFileStream.sealFile(collKey, kid, plain)
        val b = SyncFileStream.sealFile(collKey, kid, plain)
        check(!a.contentEquals(b) && !a.copyOfRange(32, 64).contentEquals(b.copyOfRange(32, 64)))
        assertArrayEquals(plain, (SyncFileStream.openFile(collKey, kid, a) as SyncFileStream.Opened.Ok).plain)
        assertThrows(SyncCryptoException::class.java) { SyncFileStream.encodeHeader(kid.copyOf(15), ByteArray(32)) }
        assertThrows(SyncCryptoException::class.java) { SyncFileStream.encodeHeader(kid, ByteArray(31)) }
        assertThrows(SyncCryptoException::class.java) { SyncFileStream.Sealer(collKey.copyOf(31), kid) }
        // A ranged read that answers the wrong size is `size`.
        val short = SyncFileStream.RangeReader { o, l -> a.copyOfRange(o.toInt(), o.toInt() + l - 1) }
        val refused =
            assertThrows(SyncFileStream.Failure::class.java) {
                SyncFileStream.openRange(collKey, kid, SyncFileStream.Stored(a.size.toLong(), short), 0, 10)
            }
        assertEquals(SyncFileStream.Invalid.SIZE, refused.reason)
        val whole = SyncFileStream.RangeReader { o, l -> a.copyOfRange(o.toInt(), o.toInt() + l) }
        assertArrayEquals(
            plain.copyOfRange(1000, 2000),
            SyncFileStream.openRange(collKey, kid, SyncFileStream.Stored(a.size.toLong(), whole), 1000, 2000),
        )
        // Reassembly: the manifest's plain size and SHA-256 over the pieces.
        val digest = SyncCrypto.sha256(plain)
        SyncFileStream.Reassembly(plain.size.toLong(), digest).also { r ->
            var at = 0
            while (at < plain.size) {
                r.push(plain, at, minOf(at + 70_001, plain.size))
                at += 70_001
            }
            r.finish()
        }
        val over = SyncFileStream.Reassembly(plain.size.toLong(), digest).also { it.push(plain) }
        assertEquals(SyncFileStream.Invalid.PLAIN_SIZE, assertThrows(SyncFileStream.Failure::class.java) { over.push(byteArrayOf(1)) }.reason)
        val shortR = SyncFileStream.Reassembly(plain.size.toLong(), digest).also { it.push(plain, 0, 100) }
        assertEquals(SyncFileStream.Invalid.PLAIN_SIZE, assertThrows(SyncFileStream.Failure::class.java) { shortR.finish() }.reason)
        val wrong = plain.copyOf().also { it[5] = (it[5].toInt() xor 1).toByte() }
        val bad = SyncFileStream.Reassembly(plain.size.toLong(), digest).also { it.push(wrong) }
        assertEquals(SyncFileStream.Invalid.PLAIN_SHA256, assertThrows(SyncFileStream.Failure::class.java) { bad.finish() }.reason)
        assertEquals(
            SyncFileStream.Invalid.PLAIN_SIZE,
            assertThrows(SyncFileStream.Failure::class.java) { SyncFileStream.Reassembly(SYNC_FILE_MAX_BYTES + 1L, digest) }.reason,
        )
        SyncFileStream.Reassembly(0, SyncCrypto.sha256(ByteArray(0))).finish()
    }
}
