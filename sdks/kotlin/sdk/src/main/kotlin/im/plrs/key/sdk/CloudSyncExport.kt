// `client.cloudSync.export()` (U-51.7; WIRE-CONTRACT-V5 section 13.12, `pkey-sync-export/1`): a readable, decrypted zip of what an
// app synced, made on this device. The core ([SyncExport]) plans and writes the archive; this file is everything around it: the
// preconditions, the flush and the pulls, the file source over the retrying transfer engine, and the destination.
//
//  - Preconditions. Sync on (the typed `product` N/A), one export per client (`sync-export-failed`, reason `busy`), a signed-in
//    person (`account_required`), the pin (`sync-encryption-pinned`) and the unlocked root in end-to-end mode (`sync-locked`).
//    Nothing is read before they hold.
//  - What is read. The export sends what is waiting ([CloudSyncClient.flush]), then reads what the Worker holds with its own pulls;
//    edits still pending (offline, parked) are counted in `unsynced`, not written.
//  - Cancellation is the coroutine's: a cancelled export removes its partial file and leaves the old destination as it was.
//
// The SDK has no consent gate (the app already holds this data and decides when to export), never picks a location, never writes
// to shared storage on its own and never logs a value, an id or a path.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_EXPORT_RETRY_AFTER_MAX_MS
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.sync.ExportCaps
import im.plrs.key.core.sync.ExportFileCodec
import im.plrs.key.core.sync.ExportInput
import im.plrs.key.core.sync.SyncExport
import im.plrs.key.core.sync.SyncExportException
import im.plrs.key.core.sync.SyncState
import im.plrs.key.core.sync.SyncStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/** What one export does beyond its destination. */
public class CloudSyncExportOptions @JvmOverloads constructor(
    /** Also write each record's kept revisions of its file (the live file always is). Off by default. */
    public val includeRevisions: Boolean = false,
    /** Called as file bytes are written and as a wait starts or ends. Runs on the export's own thread: keep it short. */
    public val onProgress: ((CloudSyncExportProgress) -> Unit)? = null,
)

/** [done] of [total] plaintext file bytes written so far; [waiting] while the export waits out a rate limit or a retry. */
public class CloudSyncExportProgress(public val done: Long, public val total: Long, public val waiting: Boolean)

/** Something the export could not write, as `data.json` lists it: a [kind] of `setting`, `record` or `file`, and why ([code]). */
public class CloudSyncExportSkipped(
    public val kind: String,
    public val code: String,
    public val collection: String? = null,
    /** The entry of a partial file. */
    public val entry: String? = null,
    /** The file was written as far as it checked, and is not whole. */
    public val partial: Boolean = false,
)

/** What an export wrote. [path] is the destination for a path export, null for a stream. */
@Suppress("LongParameterList")
public class CloudSyncExport(
    public val path: Path?,
    /** The archive's size in bytes. */
    public val bytes: Long,
    public val entries: Int,
    public val settings: Int,
    public val records: Int,
    public val files: Int,
    public val skipped: List<CloudSyncExportSkipped>,
    /** Edits not yet pushed when the export ran: they are not in it. */
    public val unsynced: Int,
) {
    override fun toString(): String = "CloudSyncExport(entries=$entries, bytes=$bytes)"
}

private fun skipOf(o: JsonObject): CloudSyncExportSkipped {
    fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return CloudSyncExportSkipped(s("kind") ?: "", s("code") ?: "", s("collection"), s("entry"), o["partial"]?.toString() == "true")
}

private const val MS_PER_SECOND = 1000.0

@Suppress("LongParameterList")
internal class CloudSyncExporter(
    private val core: CoreContext,
    /** Attaches the machine and answers the started host, or null when none runs. */
    private val startedHost: suspend () -> CloudSyncHost?,
    private val flush: suspend () -> SyncStatus,
    private val fileCodec: (collection: String, e2e: Boolean) -> FileCodec,
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val caps: ExportCaps? = null,
) {
    private val busy = AtomicBoolean(false)

    private class Ready(val e2e: Boolean, val subject: String, val clientId: String)

    suspend fun export(destination: ExportDestination, path: Path?, options: CloudSyncExportOptions): CloudSyncExport {
        core.requireService(ServiceSlug.sync, Feature.syncExport)
        if (!busy.compareAndSet(false, true)) throw SyncExportException(SyncExportException.BUSY)
        try {
            return withContext(Dispatchers.IO) { run(destination, path, options) }
        } finally {
            busy.set(false)
        }
    }

    private suspend fun run(destination: ExportDestination, path: Path?, options: CloudSyncExportOptions): CloudSyncExport {
        currentCoroutineContext().ensureActive()
        val host = startedHost() ?: throw SyncExportException(SyncExportException.NETWORK)
        val ready = preconditions(host)
        destination.prepare()
        val progress = Progress(options.onProgress)
        val budget = ExportBudget(progress::waiting, sleeper)
        val transport = HttpFileTransport(core) { ready.subject }
        val engine = FileTransferEngine(
            transport,
            MemoryJournal(),
            sleeper = { budget.sleep(it) },
            maxRetryAfterSeconds = SYNC_EXPORT_RETRY_AFTER_MAX_MS / MS_PER_SECOND,
        )
        // Send what is waiting, then read what the Worker holds.
        val unsynced = flush().pending
        currentCoroutineContext().ensureActive()
        val changes = ExportPull(core, ready.subject, budget).all(ready.clientId)
        val input = ExportInput(
            product = core.product,
            exportedAt = clock(),
            unsynced = unsynced,
            includeRevisions = options.includeRevisions,
            changes = changes,
            files = HttpExportSource(transport, engine),
            codec = if (ready.e2e) host.syncCodec else null,
            fileCodec = { collection -> FileExportCodec(fileCodec(collection, ready.e2e)) },
            caps = caps,
            onProgress = progress::bytes,
        )
        var committed = false
        try {
            val summary = SyncExport.run(input, destination)
            currentCoroutineContext().ensureActive()
            destination.commit()
            committed = true
            return CloudSyncExport(
                path,
                summary.bytes,
                summary.entries,
                summary.settings,
                summary.records,
                summary.files,
                summary.skipped.map(::skipOf),
                unsynced,
            )
        } finally {
            if (!committed) destination.discard()
        }
    }

    /** Progress as the app sees it: the bytes written and whether a wait is on. */
    private class Progress(private val to: ((CloudSyncExportProgress) -> Unit)?) {
        private var done = 0L
        private var total = 0L
        private var waiting = false

        fun bytes(done: Long, total: Long) {
            this.done = done
            this.total = total
            to?.invoke(CloudSyncExportProgress(done, total, waiting))
        }

        fun waiting(on: Boolean) {
            waiting = on
            to?.invoke(CloudSyncExportProgress(done, total, on))
        }
    }

    /** What stops an export before anything is read, or null when it may go on. */
    private fun refusal(st: SyncStatus, subject: String?, current: String?, locked: Boolean): Exception? {
        val refused = st.state == SyncState.Blocked && st.reason == "account_required"
        return when {
            st.code == ErrorCode.syncEncryptionPinned -> PolarisException(
                ErrorCode.syncEncryptionPinned,
                "Cloud Sync is pinned to end-to-end encryption",
            )

            subject == null || st.state == SyncState.Local || refused -> accountRequired()

            // An unknown stored subject is not proof of another person.
            current != null && current != subject -> accountRequired()

            locked -> PolarisException(ErrorCode.syncLocked, "Cloud Sync is locked: there is no root")

            st.state == SyncState.Blocked -> SyncExportException(SyncExportException.NETWORK)

            else -> null
        }
    }

    private suspend fun preconditions(host: CloudSyncHost): Ready {
        class Snap(val status: SyncStatus, val e2e: Boolean, val subject: String?, val journal: JsonObject)
        val snap = host.withMachine { m -> Snap(m.status(), m.encryptionMode() == "e2e", m.subject, m.journal()) }
        val current = runCatching { core.storedSubject() }.getOrNull()
        val refusal = refusal(snap.status, snap.subject, current, snap.e2e && host.syncCodec.locked)
        if (refusal != null) throw refusal
        val subject = snap.subject!!
        val clientId = ((snap.journal[subject] as? JsonObject)?.get("clientId") as? JsonPrimitive)?.takeIf { it.isString }?.content
        return Ready(snap.e2e, subject, clientId ?: throw SyncExportException(SyncExportException.NETWORK))
    }

    private fun accountRequired() = PolarisException(ErrorCode.accountRequired, "Cloud Sync needs a signed-in account")
}
