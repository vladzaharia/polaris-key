// Test fixtures for the pack engine's unit tests: wire-shaped pack records signed by a throwaway
// release key (`TestSigner`), their payload objects, and a fake byte server. The conformance corpus,
// not these, is the cross-SDK proof; these drive the engine end to end.

package im.plrs.key.packs

import com.github.luben.zstd.ZstdCompressCtx
import im.plrs.key.core.FeedRevocation
import im.plrs.key.core.LearnedRevocation
import im.plrs.key.core.ReleasePin
import im.plrs.key.core.VerifyRevocationOptions
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.jsonInt
import im.plrs.key.core.recordHash
import im.plrs.key.core.revocation
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.verifyRevocation
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

object PackFixtures {
    const val product = "djdl"
    val release = TestSigner("djdl-release-test")
    val productKey = TestSigner("pkey-test-prod")
    val releaseKeys = release.trust
    val productTrust = productKey.trust
    const val issuedAt = 1_759_000_000L
}

/** A built pack release: its record JWS and hash, and every object a strategy may fetch. */
class BuiltPack(
    val packId: String,
    val version: String,
    val seq: Long,
    val jws: String,
    val objects: Map<String, ByteArray>,
    val payloadSha256: String,
    val payloadSize: Long,
    val payload: ByteArray,
) {
    val sha256: String = recordHash(jws)
    val pin: ReleasePin get() = ReleasePin(sha256, seq, version)
    val contentPin: ContentPin get() = ContentPin(packId, sha256, seq, version)
}

private fun ref(bytes: ByteArray, size: Long = bytes.size.toLong(), codec: String = "none"): JsonObject = buildJsonObject {
    put("sha256", JsonPrimitive(sha256Of(bytes)))
    put("bytes", jsonInt(bytes.size.toLong()))
    put("size", jsonInt(size))
    put("codec", JsonPrimitive(codec))
}

private fun record(packId: String, version: String, seq: Long, type: String, variants: List<JsonObject>, extra: Map<String, JsonElement>): JsonObject = buildJsonObject {
    put("schemaVersion", jsonInt(1))
    put("aud", JsonPrimitive(PackFixtures.product))
    put("deliverable", JsonPrimitive(packId))
    put("kind", JsonPrimitive("pack"))
    put("version", JsonPrimitive(version))
    put("seq", jsonInt(seq))
    put("issuedAt", jsonInt(PackFixtures.issuedAt + seq))
    put("type", JsonPrimitive(type))
    put("formatVersion", jsonInt(1))
    put("variants", JsonArray(variants))
    for ((k, v) in extra) put(k, v)
}

/** A `tree` pack of [files] (paths sorted by bytes), with a `full` object and a `none`-coded index. */
fun treePack(
    packId: String,
    version: String,
    seq: Long,
    files: Map<String, ByteArray>,
    type: String = "files.tree",
    extra: Map<String, JsonElement> = emptyMap(),
    variant: Map<String, String> = emptyMap(),
    signer: TestSigner = PackFixtures.release,
    kid: String = signer.kid,
): BuiltPack {
    val sorted = files.entries.sortedWith { a, b -> compareUtf8Bytes(a.key, b.key) }
    val payloadSha = treeDigest(sorted.map { TreeFile(it.key, it.value.size.toLong(), sha256Of(it.value)) })
    val payload = sorted.fold(ByteArray(0)) { acc, e -> acc + e.value }
    val index = canonicalJson(
        buildJsonObject {
            put("format", JsonPrimitive("pkey-files/1"))
            put("layout", JsonPrimitive("tree"))
            put("payload", buildJsonObject { put("size", jsonInt(payload.size.toLong())); put("sha256", JsonPrimitive(payloadSha)) })
            put("files", JsonArray(sorted.map { e ->
                buildJsonObject {
                    put("path", JsonPrimitive(e.key))
                    put("size", jsonInt(e.value.size.toLong()))
                    put("sha256", JsonPrimitive(sha256Of(e.value)))
                    put("blob", buildJsonObject { put("sha256", JsonPrimitive(sha256Of(e.value))); put("bytes", jsonInt(e.value.size.toLong())); put("codec", JsonPrimitive("none")) })
                }
            }))
        },
    ).toByteArray(Charsets.UTF_8)
    val v = buildJsonObject {
        put("variant", JsonObject(variant.mapValues { JsonPrimitive(it.value) }))
        put("payload", buildJsonObject { put("size", jsonInt(payload.size.toLong())); put("sha256", JsonPrimitive(payloadSha)) })
        put("full", ref(payload))
        put("files", JsonObject(ref(index) + mapOf("format" to JsonPrimitive("pkey-files/1"), "layout" to JsonPrimitive("tree"))))
    }
    val jws = signer.sign("pkey-release+jws", record(packId, version, seq, type, listOf(v), extra), kid)
    val objects = LinkedHashMap<String, ByteArray>()
    objects[sha256Of(index)] = index
    objects[sha256Of(payload)] = payload
    for (e in sorted) objects[sha256Of(e.value)] = e.value
    return BuiltPack(packId, version, seq, jws, objects, payloadSha, payload.size.toLong(), payload)
}

/** A zstd `--patch-from` frame turning [base] into [target] (the base as a raw-content dictionary). */
fun patchFrom(base: ByteArray, target: ByteArray): ByteArray = ZstdCompressCtx().use { c ->
    c.loadDict(base)
    c.setLevel(3)
    c.setContentSize(true)
    c.compress(target)
}

/** A `container` pack of [payload] (one file, no gaps), with optional payload [deltas] (`from`, frame). */
fun containerPack(
    packId: String,
    version: String,
    seq: Long,
    payload: ByteArray,
    type: String = "custom.blob",
    deltas: List<Pair<ByteArray, ByteArray>> = emptyList(),
): BuiltPack {
    val payloadSha = sha256Of(payload)
    val index = canonicalJson(
        buildJsonObject {
            put("format", JsonPrimitive("pkey-files/1"))
            put("layout", JsonPrimitive("container"))
            put("payload", buildJsonObject { put("size", jsonInt(payload.size.toLong())); put("sha256", JsonPrimitive(payloadSha)) })
            put("files", JsonArray(listOf(buildJsonObject {
                put("path", JsonPrimitive("blob.bin"))
                put("size", jsonInt(payload.size.toLong()))
                put("sha256", JsonPrimitive(payloadSha))
                put("blob", buildJsonObject { put("sha256", JsonPrimitive(payloadSha)); put("bytes", jsonInt(payload.size.toLong())); put("codec", JsonPrimitive("none")) })
                put("offset", jsonInt(0))
            })))
        },
    ).toByteArray(Charsets.UTF_8)
    val gaps = ByteArray(0)
    val objects = LinkedHashMap<String, ByteArray>()
    val deltaJson = deltas.map { (base, frame) ->
        objects[sha256Of(frame)] = frame
        buildJsonObject {
            put("method", JsonPrimitive("zstd-patch-from"))
            put("scope", JsonPrimitive("payload"))
            put("from", JsonPrimitive(sha256Of(base)))
            put("memBytes", jsonInt((base.size + payload.size).toLong()))
            put("artifact", buildJsonObject { put("sha256", JsonPrimitive(sha256Of(frame))); put("bytes", jsonInt(frame.size.toLong())) })
        }
    }
    val v = buildJsonObject {
        put("variant", JsonObject(emptyMap()))
        put("payload", buildJsonObject { put("size", jsonInt(payload.size.toLong())); put("sha256", JsonPrimitive(payloadSha)) })
        put("full", ref(payload))
        put("files", JsonObject(ref(index) + mapOf("format" to JsonPrimitive("pkey-files/1"), "layout" to JsonPrimitive("container"), "gaps" to ref(gaps))))
        if (deltaJson.isNotEmpty()) put("deltas", JsonArray(deltaJson))
    }
    val jws = PackFixtures.release.sign("pkey-release+jws", record(packId, version, seq, type, listOf(v), emptyMap()))
    objects[sha256Of(index)] = index
    objects[sha256Of(payload)] = payload
    objects[sha256Of(gaps)] = gaps
    return BuiltPack(packId, version, seq, jws, objects, payloadSha, payload.size.toLong(), payload)
}

/** A content stamp pinning [packs] and expecting them as required [delivery]. */
fun stampOf(vararg packs: BuiltPack, required: Boolean = false, delivery: String = "on-demand"): AppContent =
    AppContent(1, packs.map { it.contentPin }, packs.map { ContentExpect(it.packId, required, delivery) })

/** A revocation of [target], signed by the release key, and the feed entry it verifies against. */
fun revocationOf(target: BuiltPack, issuedAt: Long = PackFixtures.issuedAt + 1000, replacement: BuiltPack? = null): LearnedRevocation {
    val payload = buildJsonObject {
        put("schemaVersion", jsonInt(1))
        put("aud", JsonPrimitive(PackFixtures.product))
        put("deliverable", JsonPrimitive(target.packId))
        put("kind", JsonPrimitive("revocation"))
        put("version", JsonPrimitive(target.version))
        put("seq", jsonInt(target.seq))
        put("issuedAt", jsonInt(issuedAt))
        put("revokes", JsonPrimitive(target.sha256))
        put("reason", JsonPrimitive("broken"))
        replacement?.let { put("replacement", it.pin.json) }
    }
    val jws = PackFixtures.release.sign("pkey-release+jws", payload)
    val entry = FeedRevocation(recordHash(jws), target.packId, target.sha256, target.version, target.seq)
    val v = verifyRevocation(jws, VerifyRevocationOptions(PackFixtures.releaseKeys, PackFixtures.productTrust, PackFixtures.product, entry)).revocation
        ?: error("the fixture revocation does not verify")
    return LearnedRevocation(v, jws)
}

/** A fake byte server: records by hash, objects by hash, `Range` honoured; every request counted. */
class ByteServer(vararg packs: BuiltPack) {
    val records = HashMap<String, String>()
    val objects = HashMap<String, ByteArray>()
    val objectRequests = ArrayList<ObjectRequest>()
    val recordRequests = ArrayList<String>()
    /** Objects that answer 404. */
    val missing = HashSet<String>()
    /** Cut the next transfer of this object after this many bytes (an interrupted download). */
    val cutAfter = HashMap<String, Int>()

    init {
        for (p in packs) add(p)
    }

    fun add(p: BuiltPack) {
        records[p.sha256] = p.jws
        objects.putAll(p.objects)
    }

    val fetchRecord: RecordFetch = { sha ->
        synchronized(this) { recordRequests += sha }
        records[sha]?.let { RecordFetchResult.Ok(it) } ?: RecordFetchResult.Failed("not_found")
    }

    val fetchObject: ObjectFetch = { req ->
        synchronized(this) { objectRequests += req }
        val b = objects[req.sha256]
        if (b == null || req.sha256 in missing) {
            ObjectResponse(404, null, null, ByteStream.empty)
        } else {
            val end = req.length?.let { minOf(b.size.toLong(), req.offset + it) } ?: b.size.toLong()
            val part = b.copyOfRange(req.offset.toInt(), end.toInt())
            val status = if (req.offset > 0 || req.length != null) 206 else 200
            val range = if (status == 206) "bytes ${req.offset}-${end - 1}/${b.size}" else null
            val cut = synchronized(this) { cutAfter.remove(req.sha256) }
            val body = if (cut != null) {
                object : ByteStream {
                    private var sent = false
                    override suspend fun next(): ByteArray? {
                        if (sent) throw java.io.IOException("connection reset")
                        sent = true
                        return part.copyOf(minOf(cut, part.size))
                    }
                    override fun close() {}
                }
            } else ByteStream.of(part)
            ObjectResponse(status, range, "\"${req.sha256}\"", body)
        }
    }

    fun fetchedObjects(): List<String> = synchronized(this) { objectRequests.map { it.sha256 } }
}

private val planSeq = AtomicInteger()

/** A container handler for the `custom.blob` test type. */
class BlobHandler(override val activation: String = "hot") : PackHandler {
    override val type: String get() = "custom.blob"
    override val layout: String get() = "container"
    val active = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun supports(formatVersion: Long): Boolean = formatVersion == 1L
    override suspend fun activate(install: PackInstall, payload: PackPayloadReader) {
        active[install.packId] = install.recordSha256
    }
    override suspend fun deactivate(install: PackInstall) {
        active.remove(install.packId)
    }
}

/** An engine over [server] and [storage] (memory by default). */
fun engineOf(
    server: ByteServer,
    stamp: AppContent?,
    storage: PackStorage = MemoryPackStorage(),
    state: PackStateStore = MemoryPackStateStore(),
    revocations: PackStateStore? = MemoryPackStateStore(),
    handlers: List<PackHandler> = listOf(BlobHandler()),
    feedDeltas: (() -> im.plrs.key.core.FeedDeltas?)? = null,
    entitlements: Set<String>? = null,
    holds: List<im.plrs.key.core.ContentHold> = emptyList(),
): PackEngine = PackEngine(
    PackEngineOptions(
        product = PackFixtures.product,
        releaseKeys = PackFixtures.releaseKeys,
        productTrust = { PackFixtures.productTrust },
        stamp = stamp,
        zstd = LibZstd(),
        patchMethods = listOf("zstd-patch-from"),
        memBudget = 1L shl 30,
        storage = storage,
        state = state,
        fetchRecord = server.fetchRecord,
        fetchObject = server.fetchObject,
        revocations = revocations,
        entitlements = { entitlements },
        now = { PackFixtures.issuedAt + 10_000 },
        newPlanId = { "plan${planSeq.incrementAndGet()}" },
        handlers = handlers,
        feedDeltas = feedDeltas,
        holds = holds,
    ),
)
