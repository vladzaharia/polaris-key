// The v3 pack-type handlers (CONTENT §4.2, §13; P4-16): `data.json` and `l10n.table` (built in) and
// `ml.model` (registered by the host with its budget and load test), ports of client-core's
// `packs/handlers/` (Swift's `TypeHandlers.swift` the structural model), held to
// `packages/client-core/test/fixtures/pack-type-cases.json`.
//
// Every one is a tree, hot (a versioned directory and a pointer swap), and checks a newly staged
// payload before it commits (`PackHandler.check`, `pack-type-check-failed`). They PARSE untrusted
// bytes and never evaluate them. Content is judged by bytes, never by name. Files are looked up by
// exact index path only.

package im.plrs.key.packs

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.longValue
import im.plrs.key.core.wireInteger
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** The default per-file limit of a `data.json` or `l10n.table` payload: 16 MiB. */
public const val PACK_TEXT_MAX_FILE_BYTES: Long = 16L shl 20

/** The largest `model.json` read. */
public const val PACK_DESCRIPTOR_MAX_BYTES: Long = 65536

/** A token (`^[a-z][a-z0-9-]{0,31}$`): a runtime, a quantisation, a middleware name. */
internal fun isPackToken(s: String): Boolean {
    if (s.isEmpty() || s.length > 32 || s[0] !in 'a'..'z') return false
    return s.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }
}

private fun payloadFiles(payload: PackPayloadReader): List<InstalledFile> = payload.read()?.files ?: emptyList()

// ── data.json ───────────────────────────────────────────────────────────────────────────────────

/** One parsed `data.json` document. */
public data class DataDocument(val path: String, val value: JsonElement)

/**
 * `data.json` (CONTENT §4.2): JSON documents, hot. Every file is strict JSON (V4 §1.2), whatever its
 * name; its `formatVersion` must be one it lists.
 */
public class DataJsonHandler(
    public val formatVersions: List<Long> = listOf(1),
    public val maxFileBytes: Long = PACK_TEXT_MAX_FILE_BYTES,
    private val onActivate: (suspend (String, List<DataDocument>) -> Unit)? = null,
    private val onDeactivate: (suspend (String) -> Unit)? = null,
) : PackHandler {
    override val type: String get() = "data.json"
    override val layout: String get() = "tree"
    override val activation: String get() = "hot"
    private val active = ConcurrentHashMap<String, List<DataDocument>>()

    override fun supports(formatVersion: Long): Boolean = formatVersion in formatVersions

    /** The active release's documents, in index order; null when none is active. */
    public fun documents(packId: String): List<DataDocument>? = active[packId]

    override suspend fun check(staged: StagedPack): PackCheckRefusal? {
        for (f in staged.files) {
            if (f.size > maxFileBytes) return PackCheckRefusal("size", f.path)
            if (strictParse(readAll(f.source)) == null) return PackCheckRefusal("json", f.path)
        }
        return null
    }

    override suspend fun activate(install: PackInstall, payload: PackPayloadReader) {
        val docs = ArrayList<DataDocument>()
        for (f in payloadFiles(payload)) {
            val v = strictParse(readAll(f.source))?.value
                ?: throw PackException(ErrorCode.packTypeCheckFailed, "${install.packId}'s ${f.path} is not strict JSON.", "json", f.path, install.packId)
            docs += DataDocument(f.path, v)
        }
        active[install.packId] = docs
        onActivate?.invoke(install.packId, docs)
    }

    override suspend fun deactivate(install: PackInstall) {
        active.remove(install.packId)
        onDeactivate?.invoke(install.packId)
    }
}

// ── l10n.table ──────────────────────────────────────────────────────────────────────────────────

/** `l10n.table` (CONTENT §4.2): PO, CSV or JSON tables (`L10n.kt`), hot. */
public class L10nTableHandler(
    public val formatVersions: List<Long> = listOf(1),
    public val maxFileBytes: Long = PACK_TEXT_MAX_FILE_BYTES,
    private val onActivate: (suspend (String, List<L10nTable>) -> Unit)? = null,
    private val onDeactivate: (suspend (String, List<L10nTable>) -> Unit)? = null,
) : PackHandler {
    override val type: String get() = "l10n.table"
    override val layout: String get() = "tree"
    override val activation: String get() = "hot"
    private val active = ConcurrentHashMap<String, List<L10nTable>>()

    override fun supports(formatVersion: Long): Boolean = formatVersion in formatVersions

    /** The active release's tables, in index order; null when none is active. */
    public fun tables(packId: String): List<L10nTable>? = active[packId]

    /** The check over files in index order: the first refusal, or the tables. */
    public fun checkFiles(files: List<Pair<String, ByteArray>>, variant: Map<String, String>): Result<List<L10nTable>> {
        val out = ArrayList<L10nTable>()
        for ((path, bytes) in files) {
            if (bytes.size > maxFileBytes) return Result.failure(PackCheckException(PackCheckRefusal("size", path)))
            when (val r = parseL10nFile(path, bytes)) {
                is L10nParse.Failed -> return Result.failure(PackCheckException(PackCheckRefusal(r.detail, path)))
                is L10nParse.Ok -> {
                    val want = variant["locale"]
                    val t = if (want != null) r.tables.firstOrNull { !sameLocale(it.locale, want) } else null
                    if (t != null) return Result.failure(PackCheckException(PackCheckRefusal("locale", path, "$path is a ${t.locale} table in the $want variant.")))
                    out += r.tables
                }
            }
        }
        return Result.success(out)
    }

    override suspend fun check(staged: StagedPack): PackCheckRefusal? {
        val files = ArrayList<Pair<String, ByteArray>>()
        for (f in staged.files) {
            if (f.size > maxFileBytes) return PackCheckRefusal("size", f.path)
            files += f.path to readAll(f.source)
        }
        return (checkFiles(files, staged.variant.variant).exceptionOrNull() as? PackCheckException)?.refusal
    }

    override suspend fun activate(install: PackInstall, payload: PackPayloadReader) {
        val tables = ArrayList<L10nTable>()
        for (f in payloadFiles(payload)) {
            val r = parseL10nFile(f.path, readAll(f.source)) as? L10nParse.Ok
                ?: throw PackException(ErrorCode.packTypeCheckFailed, "${install.packId}'s ${f.path} is not a table.", "table", f.path, install.packId)
            tables += r.tables
        }
        active[install.packId] = tables
        onActivate?.invoke(install.packId, tables)
    }

    override suspend fun deactivate(install: PackInstall) {
        val was = active.remove(install.packId) ?: emptyList()
        onDeactivate?.invoke(install.packId, was)
    }
}

/** A [PackCheckRefusal] carried through a [Result]. */
public class PackCheckException(public val refusal: PackCheckRefusal) : Exception(refusal.detail)

// ── ml.model ────────────────────────────────────────────────────────────────────────────────────

/** An `ml.model` payload's `model.json`. */
public data class MlModelDescriptor(
    val runtime: String,
    /** The model file: exactly an index path. */
    val file: String,
    /** The RAM the model needs, in bytes. */
    val memBytes: Long,
    val vramBytes: Long?,
    val quantization: String?,
)

/** What a host's load test is given: the staged model file and its descriptor. */
public class MlModelLoadTest(public val packId: String, public val location: String, public val file: InstalledFile, public val descriptor: MlModelDescriptor)

/** The active release of an `ml.model` pack. */
public data class MlModel(val packId: String, val path: String, val location: String, val descriptor: MlModelDescriptor)

/** `model.json` read from an index, or null (the `descriptor` refusal). */
internal fun mlModelDescriptor(files: List<InstalledFile>): MlModelDescriptor? {
    val f = files.firstOrNull { it.path == "model.json" } ?: return null
    if (f.size > PACK_DESCRIPTOR_MAX_BYTES) return null
    val parsed = strictParse(readAll(f.source)) ?: return null
    val o = parsed.value
    val runtime = (o["runtime"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    if (!isPackToken(runtime)) return null
    val file = (o["file"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    if (file == "model.json" || files.none { it.path == file }) return null
    val mem = o["memBytes"].longValue ?: return null
    if (!wireInteger(mem, "/memBytes", 0, parsed.nonWire)) return null
    var vram: Long? = null
    if (o.containsKey("vramBytes")) {
        val n = o["vramBytes"].longValue ?: return null
        if (!wireInteger(n, "/vramBytes", 0, parsed.nonWire)) return null
        vram = n
    }
    var quant: String? = null
    if (o.containsKey("quantization")) {
        val q = (o["quantization"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        if (!isPackToken(q)) return null
        quant = q
    }
    return MlModelDescriptor(runtime, file, mem, vram, quant)
}

/**
 * `ml.model` (CONTENT §4.2): a model and its `model.json`, hot: the path swaps only after the host's
 * load test passes. Not built in: the host registers one with what it can run (TensorFlow Lite, ONNX
 * Runtime) and the memory a model may need. Throws `invalid-options` unless [runtimes] is non-empty
 * and the budgets are non-negative.
 */
public class MlModelHandler(
    public val runtimes: List<String>,
    public val ramBytes: Long,
    public val vramBytes: Long = 0,
    public val quantizations: List<String>? = null,
    private val loadTest: (suspend (MlModelLoadTest) -> Boolean)? = null,
    private val onActivate: (suspend (MlModel) -> Unit)? = null,
    private val onDeactivate: (suspend (String) -> Unit)? = null,
    public val formatVersions: List<Long> = listOf(1),
) : PackHandler {
    init {
        if (runtimes.isEmpty() || ramBytes < 0 || vramBytes < 0) {
            throw PackException(ErrorCode.invalidOptions, "MlModelHandler needs {runtimes: a non-empty list, ramBytes: a non-negative integer, vramBytes: a non-negative integer}.")
        }
    }

    override val type: String get() = "ml.model"
    override val layout: String get() = "tree"
    override val activation: String get() = "hot"
    private val active = ConcurrentHashMap<String, MlModel>()

    override fun supports(formatVersion: Long): Boolean = formatVersion in formatVersions

    /** The active release's model, or null. */
    public fun model(packId: String): MlModel? = active[packId]

    override suspend fun check(staged: StagedPack): PackCheckRefusal? {
        val files = staged.files
        val d = mlModelDescriptor(files) ?: return PackCheckRefusal("descriptor", "model.json")
        if (d.runtime !in runtimes) return PackCheckRefusal("runtime", "model.json", "this host runs ${runtimes.joinToString(", ")}, not ${d.runtime}.")
        val qs = quantizations
        if (qs != null && (d.quantization == null || d.quantization !in qs)) return PackCheckRefusal("quantization", "model.json")
        if (d.memBytes > ramBytes || (d.vramBytes ?: 0) > vramBytes) {
            return PackCheckRefusal(
                "memory", "model.json",
                "the model needs ${d.memBytes} B of RAM and ${d.vramBytes ?: 0} B of VRAM; the budget is $ramBytes B and $vramBytes B.",
            )
        }
        val test = loadTest
        if (test != null) {
            val file = files.first { it.path == d.file }
            val passed = try {
                test(MlModelLoadTest(staged.packId, staged.location, file, d))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (!passed) return PackCheckRefusal("load-test", d.file)
        }
        return null
    }

    override suspend fun activate(install: PackInstall, payload: PackPayloadReader) {
        val d = mlModelDescriptor(payloadFiles(payload))
            ?: throw PackException(ErrorCode.packTypeCheckFailed, "${install.packId}'s model.json cannot be read.", "descriptor", "model.json", install.packId)
        val m = MlModel(install.packId, d.file, install.location, d)
        active[install.packId] = m
        onActivate?.invoke(m)
    }

    override suspend fun deactivate(install: PackInstall) {
        active.remove(install.packId)
        onDeactivate?.invoke(install.packId)
    }
}
