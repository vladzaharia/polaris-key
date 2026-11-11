// The export corpus rows (`sync-vectors.json` `exportCases`, WIRE-CONTRACT-V5 section 13.12) as a transport: the changes as served, a
// file source built from each row's recipes with the SDK's own primitives (not the reference), and the zip read back through
// `java.util.zip.ZipFile` (the central directory) with every CRC-32 recomputed. Shared by `SyncVectorsTest` and the host tests.

package im.plrs.key.conformance

import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.ExportCaps
import im.plrs.key.core.sync.ExportFileRef
import im.plrs.key.core.sync.ExportFileSource
import im.plrs.key.core.sync.ExportInput
import im.plrs.key.core.sync.ExportSink
import im.plrs.key.core.sync.ExportStored
import im.plrs.key.core.sync.ExportSummary
import im.plrs.key.core.sync.SyncCodecPort
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncExport
import im.plrs.key.core.sync.SyncFileStream
import im.plrs.key.core.sync.SyncKeys
import im.plrs.key.core.sync.SyncManifest
import im.plrs.key.sdk.E2eFileCodec
import im.plrs.key.sdk.FileCodec
import im.plrs.key.sdk.FileExportCodec
import im.plrs.key.sdk.ServerFileCodec
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.ZipFile

/** One archive entry as read back. */
class ExportEntry(val name: String, val data: ByteArray)

/** A sink that keeps everything it is given, and the largest write. */
class CollectSink : ExportSink {
    private val out = java.io.ByteArrayOutputStream()
    var maxPiece = 0
        private set

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        out.write(bytes, offset, length)
        maxPiece = maxOf(maxPiece, length)
    }

    fun bytes(): ByteArray = out.toByteArray()
}

object ExportCorpus {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun sha(b: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(b))

    /** The corpus plaintext: SHA-256(label || u32be(i)) blocks, cut to [length]. */
    fun stream(label: String, length: Int): ByteArray {
        val out = ByteArray(length)
        var at = 0
        var i = 0
        while (at < length) {
            val block = MessageDigest.getInstance(
                "SHA-256",
            ).digest(label.toByteArray() + byteArrayOf((i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte()))
            block.copyInto(out, at, 0, minOf(block.size, length - at))
            at += block.size
            i++
        }
        return out
    }

    private fun JsonObject.s(k: String) = this[k].stringValue!!

    private fun JsonObject.i(k: String) = this[k].longValue!!.toInt()

    private fun flip(b: ByteArray, at: Int): ByteArray = b.copyOf().also { it[at] = (it[at].toInt() xor 1).toByte() }

    /** What the transport serves: whole stored bytes by (collection, record, version) and chunk objects by (collection, id). */
    class Transport {
        val whole = HashMap<Triple<String, String, String>, ByteArray>()
        val chunks = HashMap<Pair<String, String>, ByteArray>()
    }

    /** The host codec (end-to-end rows) and the file codec per collection. */
    fun codecs(row: JsonObject): Pair<SyncCodecPort?, (String) -> FileExportCodec> {
        val root = row["rootHex"].stringValue?.let(::bytes) ?: return null to { FileExportCodec(ServerFileCodec()) }
        return FixtureSyncCodec(root) to { c -> FileExportCodec(E2eFileCodec(root, c)) }
    }

    fun transport(row: JsonObject): Transport {
        val root = row["rootHex"].stringValue?.let(::bytes)
        val t = Transport()
        for (f in row["files"]!!.arrayValue!!.map { it as JsonObject }) {
            val key = Triple(f.s("collection"), f.s("record"), f["version"].toString())
            f["stored"].objectValue?.let { t.whole[key] = stored(it, f.s("collection"), root) }
            f["chunked"].objectValue?.let { chunked(it, f.s("collection"), root, key, t) }
        }
        return t
    }

    private fun seal(root: ByteArray?, collection: String, salt: String?, plain: ByteArray): ByteArray = if (salt == null ||
        root == null
    ) {
        plain
    } else {
        SyncFileStream.sealFile(SyncKeys.deriveCollKey(root, collection), SyncKeys.deriveKid(root), plain, bytes(salt))
    }

    private fun stored(r: JsonObject, collection: String, root: ByteArray?): ByteArray {
        val swap = r["swap"].objectValue
        val label = swap?.s("label") ?: r.s("label")
        val salt = (swap ?: r)["saltHex"].stringValue
        var served = seal(root, collection, salt, stream(label, r.i("length")))
        r["extra"]?.let { served += stream(r.s("label") + " extra", r.i("extra")) }
        r["flipAt"]?.let { served = flip(served, r.i("flipAt")) }
        r["cut"]?.let { served = served.copyOf(r.i("cut")) }
        return served
    }

    private fun chunked(r: JsonObject, collection: String, root: ByteArray?, key: Triple<String, String, String>, t: Transport) {
        val codec: FileCodec = if (root == null) ServerFileCodec() else E2eFileCodec(root, collection)
        val lens = r["chunkLens"]!!.arrayValue!!.map { it.longValue!!.toInt() }
        val plain = stream(r.s("label"), lens.sum())
        var at = 0
        val records = ArrayList<SyncManifest.Record>()
        for ((i, n) in lens.withIndex()) {
            val body = plain.copyOfRange(at, at + n)
            at += n
            val id = codec.chunkId(body)
            records.add(SyncManifest.Record(id, n))
            if (r["dropChunk"].longValue?.toInt() == i) continue
            var obj = codec.sealChunk(id, body)
            if (r["flipChunk"].longValue?.toInt() == i) obj = obj.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
            t.chunks[collection to hex(id)] = obj
        }
        val digest = SyncCrypto.sha256(plain)
        if (r["plainSha256Flip"].boolValue == true) digest[0] = (digest[0].toInt() xor 1).toByte()
        val total = r["manifestPlainSize"].longValue ?: plain.size.toLong()
        val manifest = SyncManifest.encode(SyncManifest.Manifest(total, digest, records))
        var stored = if (root == null) manifest else seal(root, collection, r.s("saltHex"), manifest)
        r["manifestFlipAt"]?.let { stored = flip(stored, r.i("manifestFlipAt")) }
        t.whole[key] = stored
    }

    /** A file source over a row's transport: bytes arrive in awkward pieces, and the reads are counted. */
    class FakeSource(private val row: JsonObject, private val t: Transport, private val piece: Int = 300_007) : ExportFileSource {
        var storedBytes = 0L
            private set

        override suspend fun pointers(collection: String, record: String): List<JsonObject> =
            row["files"]!!.arrayValue!!.map { it as JsonObject }.filter { it.s("collection") == collection && it.s("record") == record }.map {
                JsonObject(mapOf("version" to it["version"]!!, "size" to it["size"]!!, "sha256" to it["sha256"]!!, "format" to it["format"]!!))
            }

        override suspend fun stored(ref: ExportFileRef): ExportStored {
            val data = t.whole[Triple(ref.collection, ref.record, ref.version.toString())]
            return object : ExportStored {
                var at = 0

                override suspend fun next(): ByteArray? {
                    if (data == null || at >= data.size) return null
                    val p = data.copyOfRange(at, minOf(data.size, at + piece))
                    at += p.size
                    storedBytes += p.size
                    return p
                }
            }
        }

        override suspend fun chunk(collection: String, idHex: String): ByteArray? = t.chunks[collection to idHex]
    }

    fun input(row: JsonObject, source: ExportFileSource): ExportInput {
        val (host, fileCodec) = codecs(row)
        val caps = row["caps"].objectValue
        return ExportInput(
            product = row.s("product"),
            exportedAt = row["exportedAt"].longValue!!,
            unsynced = row.i("unsynced"),
            includeRevisions = row["includeRevisions"].boolValue == true,
            changes = row["changes"]!!.arrayValue!!.toList(),
            files = source,
            codec = host,
            fileCodec = fileCodec,
            caps = caps?.let { ExportCaps(it["maxEntries"].longValue?.toInt(), it["maxBytes"].longValue) },
        )
    }

    class Run(val sink: CollectSink, val source: FakeSource, val error: Throwable?, val summary: ExportSummary?)

    /** One row through the core: the archive, or the error it threw. */
    fun run(row: JsonObject, piece: Int = 300_007): Run {
        val source = FakeSource(row, transport(row), piece)
        val sink = CollectSink()
        return try {
            Run(sink, source, null, kotlinx.coroutines.runBlocking { SyncExport.run(input(row, source), sink) })
        } catch (e: im.plrs.key.core.PolarisException) {
            Run(sink, source, e, null)
        }
    }

    /** The entries of an archive in central-directory order, every CRC-32 recomputed. */
    fun read(archive: ByteArray): List<ExportEntry> {
        val file: File = Files.createTempFile("pkey-export-", ".zip").toFile()
        try {
            file.writeBytes(archive)
            ZipFile(file).use { z ->
                return z.entries().toList().map { e ->
                    val data = z.getInputStream(e).use { it.readBytes() }
                    val crc = CRC32().also { it.update(data) }.value
                    check(e.method == java.util.zip.ZipEntry.STORED && crc == e.crc && data.size.toLong() == e.size) {
                        "entry ${e.name} is not a sound STORED entry"
                    }
                    ExportEntry(e.name, data)
                }
            }
        } finally {
            file.delete()
        }
    }

    /** The mismatches between [got] and the row's expected entries (empty when equal). */
    fun differences(got: List<ExportEntry>, want: JsonArray): List<String> {
        val bad = ArrayList<String>()
        if (got.map { it.name } != want.map { it.objectValue!!.s("name") }) bad.add("names ${got.map { it.name }}")
        for ((e, w) in got.zip(want.map { it as JsonObject })) {
            if (e.data.size.toLong() != w["size"].longValue) bad.add("${e.name}: size ${e.data.size}")
            if (sha(e.data) != w.s("sha256Hex")) bad.add("${e.name}: sha256")
            w["utf8"].stringValue?.let { if (String(e.data, Charsets.UTF_8) != it) bad.add("${e.name}: text") }
            w["hex"].stringValue?.let { if (hex(e.data) != it) bad.add("${e.name}: bytes") }
        }
        return bad
    }
}
