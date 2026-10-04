// The pack engine's ports and value types (CONTENT §4, §9, §10; plans/P4-01.md §2.13; client-core
// `packs/engine.ts`; Swift's `Engine.swift` the structural model, P6-08): the handler contract,
// the object and record transports, the storage the engine stages and commits into, and what the
// engine reports. `Engine.kt` is the pipeline over them.

package im.plrs.key.packs

import im.plrs.key.core.FeedDeltas
import im.plrs.key.core.TrustSet
import im.plrs.key.core.ContentHold
import im.plrs.key.core.VerifiedRevocation
import im.plrs.key.core.compareUtf8Bytes

/** A pack type's handler (CONTENT §4.1). `files.tree`, `data.json` and `l10n.table` are built in. */
public interface PackHandler {
    public val type: String

    /** The layout of the payloads it installs: `tree` or `container`. */
    public val layout: String

    /** The activation when the record names none: `hot` or `restart`. */
    public val activation: String

    /** Whether it can install and activate this `formatVersion`. */
    public fun supports(formatVersion: Long): Boolean

    /**
     * The type's own check of a newly staged payload (CONTENT §4.1 `verify`; P4-16): after the engine
     * verified the payload and moved it into the store, before the state commit and activation. A
     * refusal abandons the install (`pack-type-check-failed`). Parse the bytes; never evaluate them.
     */
    public suspend fun check(staged: StagedPack): PackCheckRefusal? = null

    /** A committed install becomes live, with its payload at hand (read lazily). */
    public suspend fun activate(install: PackInstall, payload: PackPayloadReader) {}

    /** A live `hot` install is replaced or rolled back. */
    public suspend fun deactivate(install: PackInstall) {}
}

/** A newly staged payload as a handler's `check` sees it: files in index (path byte) order. */
public class StagedPack(
    public val packId: String,
    public val record: PackRecordDoc,
    public val variant: PackVariant,
    public val location: String,
    public val files: List<InstalledFile>,
    /** A container's whole payload (null for a tree). */
    public val payload: ByteSource?,
) {
    /** The file at exactly this index path. */
    public fun file(path: String): InstalledFile? = files.firstOrNull { it.path == path }
}

/** A handler's refusal: `pack-type-check-failed` with this `detail` token and `path`. */
public data class PackCheckRefusal(val detail: String, val path: String? = null, val message: String? = null)

/** Reads an install's payload on demand (`PackStorage.installed`), files in index order. */
public class PackPayloadReader(private val reader: () -> InstalledPayload?) {
    public fun read(): InstalledPayload? = reader()?.let { sortedPayload(it) }
}

/** An installed payload with its files in index (path byte) order. */
internal fun sortedPayload(p: InstalledPayload): InstalledPayload =
    InstalledPayload(p.payload, p.files?.sortedWith { a, b -> compareUtf8Bytes(a.path, b.path) })

/** `files.tree` (CONTENT §4.2): a directory tree, hot, format version 1. */
public object FilesTreeHandler : PackHandler {
    override val type: String get() = "files.tree"
    override val layout: String get() = "tree"
    override val activation: String get() = "hot"
    override fun supports(formatVersion: Long): Boolean = formatVersion == 1L
}

/** An object download as the engine reads it (the host adapts its HTTP client). */
public class ObjectResponse(
    public val status: Int,
    /** `Content-Range`, or null. */
    public val contentRange: String?,
    /** `ETag`, or null when the host does not report it. */
    public val etag: String? = null,
    public val body: ByteStream,
)

/**
 * `GET` of one stored object by its SHA-256, from `offset`; `ifRange` is the strong ETag whenever
 * `offset > 0`. With `length` (P4-11's chunk runs) the request is the single bounded range
 * `Range: bytes=<offset>-<offset+length-1>` with `Accept-Encoding: identity`, never a multi-range.
 */
public data class ObjectRequest(val sha256: String, val offset: Long, val ifRange: String?, val length: Long? = null)

public typealias ObjectFetch = suspend (ObjectRequest) -> ObjectResponse

/** `GET` of one release record by hash: the body, or the failure's code. */
public sealed interface RecordFetchResult {
    public data class Ok(val body: String) : RecordFetchResult
    public data class Failed(val code: String) : RecordFetchResult
}

public typealias RecordFetch = suspend (String) -> RecordFetchResult

/** One object being staged for a plan. */
public interface StagedObject {
    public fun size(): Long
    public fun source(): ByteSource
    public fun append(bytes: ByteArray)
    public fun reset()
}

/** An install's bytes, for reuse as a delta base or a file seed. */
public class InstalledPayload(
    /** A container's whole payload. */
    public val payload: ByteSource?,
    /** Its files, from the index kept at install (or, for an embedded tree, its listing). */
    public val files: List<InstalledFile>?,
)

/** The plan's output area: a byte sink for a container, a tree sink for a tree. */
public class PackOutput(
    public val sink: ByteSink? = null,
    public val tree: TreeSink? = null,
    public val read: ((offset: Long, length: Int) -> ByteArray)? = null,
)

/** The seed-index store (P4-11; `<packs root>/index/<sha256>`). */
public interface ChunkIndexStore {
    public fun get(sha256: String): ByteArray?

    /** Atomic (temp + rename). */
    public fun put(sha256: String, bytes: ByteArray)
    public fun list(): List<String>
    public fun remove(sha256: String)
}

/** The chunk strategy's run journal (P4-11): `staging/<planId>/journal.json`. */
public interface RunJournalStore {
    public fun read(planId: String): String?

    /** Atomic (temp + rename). */
    public fun write(planId: String, text: String)
}

/** Where a host keeps staging and the store. Locations and plan ids are opaque to the engine. */
public interface PackStorage {
    public fun stagedObject(planId: String, sha256: String): StagedObject

    /** With [resume] (P4-11's chunk strategy) a container keeps what an earlier attempt wrote. */
    public fun output(planId: String, layout: String, resume: Boolean = false): PackOutput

    /** P4-11's seed-index store. Null: no payload is a seed and the chunk strategy is never planned. */
    public val chunkIndexes: ChunkIndexStore? get() = null

    /** P4-11's run journal. Null: a resumed chunk plan refetches every run. */
    public val runJournal: RunJournalStore? get() = null

    /** Move the plan's verified output into the store (keeping the files index beside it); its location. */
    public fun commit(planId: String, packId: String, payloadSha256: String, layout: String, index: FilesIndexDoc?): String

    /** The install's bytes, or null when its payload is gone. */
    public fun installed(install: PackInstall): InstalledPayload?

    /** Re-check an install's payload on load: false when missing or different; throws when unreadable. */
    public fun verify(install: PackInstall): Boolean
    public fun remove(location: String)
    public fun removeStaging(planId: String)

    /** Every stored location and staging plan. Never a partial answer: an unreadable directory throws. */
    public fun list(): Pair<List<String>, List<String>>
    public fun freeDisk(): Long
}

/** An embedded baseline the host ships: its marker's bytes and its measured payload. */
public class EmbeddedBaseline(public val marker: ByteArray, public val payload: EmbeddedPayload, public val location: String)

/** One progress event. `state-issue` is emitted once at `load` when the state cannot be trusted. */
public data class PackProgress(
    val packId: String,
    /** `download`, `apply`, `done` or `state-issue`. */
    val phase: String,
    val done: Long,
    val total: Long,
    /** `torn` or `unreadable`, on `state-issue`. */
    val issue: String? = null,
)

/** The strategies an engine costs unless told otherwise (`chunk` from P4-11). */
public val PACK_DEFAULT_STRATEGIES: List<String> = listOf("delta", "chunk", "file", "full")

/** The engine's options. */
public class PackEngineOptions(
    /** The product: every record's `aud`. */
    public val product: String,
    /** The PINNED release keys, the only keys a pack record verifies against. */
    public val releaseKeys: TrustSet,
    /** The effective product trust set (a release key also in it is refused). */
    public val productTrust: suspend () -> TrustSet,
    /** The running build's content stamp, or null: no packs. */
    public val stamp: AppContent?,
    public val prefs: VariantPrefs = VariantPrefs(),
    public val zstd: ZstdPort,
    /** `zstd-patch-from` when the decoder passed its start-up probe; empty otherwise. */
    public val patchMethods: List<String>,
    /** The memory budget for one delta frame (`memBytes`). */
    public val memBudget: Long,
    public val storage: PackStorage,
    public val state: PackStateStore,
    public val fetchRecord: RecordFetch,
    public val fetchObject: ObjectFetch,
    public val strategies: List<String> = PACK_DEFAULT_STRATEGIES,
    public val transports: List<String> = listOf("pkey-cdn"),
    /** The sibling `revocations.json`. Null: revocations live in memory for the process only. */
    public val revocations: PackStateStore? = null,
    /** Whether [fetchObject] honours a bounded range with `Content-Range` and `ETag` (P4-11). */
    public val supportsRange: Boolean = true,
    /** The licence's granted flags, or null when the product runs no License service. */
    public val entitlements: suspend () -> Set<String>? = { null },
    /** Epoch seconds. */
    public val now: suspend () -> Long = { System.currentTimeMillis() / 1000 },
    /** Fresh plan ids (`[A-Za-z0-9_-]{1,64}`). */
    public val newPlanId: () -> String = { java.util.UUID.randomUUID().toString().replace("-", "") },
    public val handlers: List<PackHandler> = emptyList(),
    /** Write the journal every this many staged bytes (default 8 MiB). */
    public val checkpointBytes: Long = 8L shl 20,
    /** The most one buffered decode may hold; a larger `full` candidate is dropped when the port cannot stream. */
    public val oneShotBudget: Long? = null,
    /** The stamp's holds: a hold's release never takes the delegated path (plans/P4-19.md §2.4). */
    public val holds: List<ContentHold> = emptyList(),
    /** plans/P4-29.md §2.4: the delta menu of the most recently committed feed, or null. */
    public val feedDeltas: (() -> FeedDeltas?)? = null,
)

/** The error the pipeline raises when it cannot proceed. [code] is a registered client code. */
public class PackException(
    public val code: String,
    message: String,
    public val detail: String? = null,
    public val path: String? = null,
    public val packId: String? = null,
) : Exception(message) {
    override fun toString(): String = "PackException($code): $message"
}

/** What `state()` reports. */
public data class PacksSnapshot(
    val active: Map<String, PackInstall>,
    val previous: Map<String, PackInstall>,
    val inflight: Map<String, Inflight>,
    /** The pack releases activated in this process (embedded baselines included). */
    val running: Map<String, PackInstall>,
    val confirmedBootSeq: Long,
    val bootSeq: Long,
    /** `torn`, `unreadable`, or null. */
    val stateIssue: String?,
) {
    public data class Inflight(val planId: String, val strategy: String, val done: Long, val total: Long)
}

/** What `revocations()` reports (plans/P4-13.md §2.5). */
public data class RevocationsSnapshot(
    val revoked: Map<String, StoredRevocation>,
    val verified: Map<String, VerifiedRevocation>,
    val relearn: List<String>,
    val issue: String?,
)

/** What `estimate` reports for a set of packs (the consent dialog's size disclosure). */
public data class PackEstimate(
    val bytes: Long = 0,
    val packs: List<String> = emptyList(),
    /** Packs that cannot be planned, with the code `ensure` would raise. */
    val refused: List<Pair<String, String>> = emptyList(),
)
