// MergeRequest: the one conflict a person or an app is asked to settle (plans/U-08.md sections 2.2 to 2.4; WIRE-CONTRACT-V5
// section 11.5). `revision` is the only policy that asks. Two sources feed one registry: the machine's record requests
// (`w:<collection>/<record>`, journalled by the machine) and the saves layer's requests (`w:saves/<id>`, memory only: S5).
//
// A request is a live object: its members read the current state, so a host that holds one sees it reopen after a failed
// keep. `keep` never throws; a refusal is [MergeOutcome.Refused]. A port of client-core's `sync/merge.ts`.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.sync.CallResult
import im.plrs.key.core.sync.MachineConflict
import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.MergeSide
import im.plrs.key.core.sync.RecordRow
import im.plrs.key.core.sync.SyncEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** How a [MergeRequest.keep] came out. */
public sealed interface MergeOutcome {
    /** The choice was applied. [kept] is `local`, `remote`, `both` or `value`; [copyId] is the slot a `both` copy went to. */
    public data class Kept(val kept: String, val version: Long?, val copyId: String? = null) : MergeOutcome

    /** The choice was refused with [code]; [reopened] says the request is open again. */
    public data class Refused(val code: String, val reopened: Boolean) : MergeOutcome
}

/** The request a host holds: `keep` answers it. */
public class MergeRequest internal constructor(
    internal var view: MergeView,
    private val registry: MergeRegistry,
    internal val backend: MergeBackend?,
) {
    /** `w:<collection>/<record>`; stable while the request is open. */
    public val id: String get() = view.id

    /** `write` (a `revision` write met a newer copy) or `accountMerge`. */
    public val cause: String get() = view.cause
    public val collection: String get() = view.collection

    /** The plain record id (never sent). */
    public val record: String get() = view.record

    /** This device's copy; a record's value, or a save's metadata. Null: it was deleted since (accountMerge only). */
    public val local: MergeSide? get() = view.local

    /** The cloud's copy; null: deleted elsewhere. */
    public val remote: MergeSide? get() = view.remote

    /** What `keep` accepts: `local`, `remote`, `value` for a record; `local`, `remote` and (a free slot) `both` for a save. */
    public val choices: List<String> get() = view.choices

    /** Which copy is newer by `savedAt` (display only); null unless both carry one and they differ. */
    public val newer: String? get() = newerOf(view.local, view.remote)

    /** `open` or `applying`. */
    public val state: String get() = view.state

    /** The last keep's failure code. */
    public val error: String? get() = view.error

    /** Set once the request is closed; `keep` on it answers `sync-merge-closed`. */
    @Volatile internal var closed: Boolean = false

    /** Answer the request. Never throws. */
    public suspend fun keep(choice: MergeKeep): MergeOutcome = registry.keepRequest(this, choice)

    internal companion object {
        @Suppress("ReturnCount")
        fun newerOf(local: MergeSide?, remote: MergeSide?): String? {
            val l = local?.savedAt ?: return null
            val r = remote?.savedAt ?: return null
            return if (l == r) {
                null
            } else if (l > r) {
                "local"
            } else {
                "remote"
            }
        }
    }
}

/** What a source gives the registry for one request. */
internal data class MergeView(
    val id: String,
    val cause: String,
    val collection: String,
    val record: String,
    val local: MergeSide?,
    val remote: MergeSide?,
    val choices: List<String>,
    val state: String,
    val error: String?,
)

/** The saves layer's side of a request: settles `keep` (the request is `applying` meanwhile). */
internal fun interface MergeBackend {
    suspend fun keep(choice: MergeKeep): MergeOutcome
}

/** The machine as the registry uses it. */
internal interface MergeMachinePort {
    suspend fun conflicts(): List<MachineConflict>

    suspend fun keep(id: String, choice: MergeKeep): CallResult

    suspend fun records(collection: String): List<RecordRow>
}

/** A listener; a returned choice decides the request inline. */
public fun interface ConflictListener {
    public fun onConflict(request: MergeRequest): MergeKeep?
}

/** What a registered listener gives back to stop listening. */
public fun interface MergeSubscription {
    public fun cancel()
}

/** A MergeRequest event for the cloudSync stream. */
internal sealed interface MergeStreamEvent {
    class Opened(val request: MergeRequest) : MergeStreamEvent

    class Closed(val id: String, val how: String) : MergeStreamEvent
}

/** The open requests of one client, from the machine and from the saves layer. */
@Suppress("TooManyFunctions")
internal class MergeRegistry(
    private val scope: CoroutineScope,
    private val machine: MergeMachinePort? = null,
    /** Called once per registry when a request opens and nobody listens (the dev-mode notice). */
    private val notice: (MergeRequest) -> Unit = {},
) {
    private val lock = Any()
    private val machineReqs = LinkedHashMap<String, MergeRequest>()
    private val extra = LinkedHashMap<String, MergeRequest>()
    private val listeners = ArrayList<ConflictListener>()
    private val watchers = ArrayList<(MergeStreamEvent) -> Unit>()
    private val pending = HashMap<String, CompletableDeferred<MergeOutcome>>()
    private var noticed = false

    /** The open requests in id order. */
    suspend fun conflicts(): List<MergeRequest> {
        refresh()
        return all()
    }

    /** Count of the saves layer's open requests (the machine counts its own in `status`). */
    fun extraCount(): Int = synchronized(lock) { extra.size }

    /** Listen for requests as they open; the ones already open are replayed. */
    suspend fun onConflict(fn: ConflictListener): MergeSubscription {
        synchronized(lock) { listeners.add(fn) }
        refresh()
        for (r in all()) if (r.state == "open") offer(fn, r)
        return MergeSubscription { synchronized(lock) { listeners.remove(fn) } }
    }

    /** `conflictOpened` / `conflictClosed` on the cloudSync stream. */
    fun onEvent(fn: (MergeStreamEvent) -> Unit): MergeSubscription {
        synchronized(lock) { watchers.add(fn) }
        return MergeSubscription { synchronized(lock) { watchers.remove(fn) } }
    }

    /** The machine's events, after `takeEvents`: opens, closes and settled keeps. */
    suspend fun feed(events: List<SyncEvent>) {
        for (e in events) {
            when (e) {
                is SyncEvent.Conflict -> machineOpened(e.id)
                is SyncEvent.ConflictClosed -> machineClosed(e.id, e.how)
                else -> {}
            }
        }
        settleFromState()
    }

    // -- the saves layer ---------------------------------------------------------------------------------------

    fun find(id: String): MergeRequest? = synchronized(lock) { extra[id] }

    /** Open a request, or reopen the one with that id (its sides and choices replaced). A listener may decide it inline. */
    fun open(view: MergeView, backend: MergeBackend): MergeRequest {
        val r = synchronized(lock) {
            val have = extra[view.id]
            (have ?: MergeRequest(view, this, backend)).also {
                it.view = view
                extra[view.id] = it
            }
        }
        announce(r)
        return r
    }

    /** Replace what an open request shows (a later write replaced the local copy; the state moved). */
    fun update(id: String, change: (MergeView) -> MergeView) {
        synchronized(lock) { extra[id]?.let { it.view = change(it.view) } }
    }

    /** Tell the listeners again that a saves request is open (a keep conflicted again). */
    fun reannounce(id: String) {
        find(id)?.let { announce(it) }
    }

    /** Close a saves request. No-op when it is not open. */
    fun close(id: String, how: String) {
        val r = synchronized(lock) { extra.remove(id) } ?: return
        r.closed = true
        emit(MergeStreamEvent.Closed(id, how))
    }

    /** Close every saves request (the person's data is gone). */
    fun closeAllExtra() {
        val ids = synchronized(lock) { extra.keys.toList() }
        for (id in ids) close(id, "superseded")
    }

    // -- keep --------------------------------------------------------------------------------------------------

    @Suppress("ReturnCount")
    suspend fun keepRequest(r: MergeRequest, choice: MergeKeep): MergeOutcome {
        refresh()
        if (r.closed) return closedOutcome()
        if (r.view.state == "applying") return badRequest()
        if (choice.choice !in r.view.choices) return badRequest()
        r.backend?.let { return it.keep(choice) }
        return keepMachine(r, choice)
    }

    @Suppress("ReturnCount")
    private suspend fun keepMachine(r: MergeRequest, choice: MergeKeep): MergeOutcome {
        val m = machine ?: return closedOutcome()
        val remoteVersion = r.view.remote?.version
        val waiter = CompletableDeferred<MergeOutcome>()
        // Registered before the keep reaches the machine: its closing event cannot arrive first.
        synchronized(lock) { pending[r.id] = waiter }
        val res = m.keep(r.id, choice)
        if (res is CallResult.Failed) {
            synchronized(lock) { pending.remove(r.id) }
            return MergeOutcome.Refused(res.error, reopened = false)
        }
        // `remote` is settled by the machine at once; the closing event arrives with the next batch.
        if (choice is MergeKeep.Remote) {
            synchronized(lock) {
                pending.remove(r.id)
                machineReqs.remove(r.id)
            }
            r.closed = true
            return MergeOutcome.Kept("remote", remoteVersion)
        }
        refresh()
        return waiter.await()
    }

    // -- machine requests --------------------------------------------------------------------------------------

    private fun machineView(c: MachineConflict) = MergeView(c.id, c.cause, c.collection, c.record, c.local, c.remote, c.choices, c.state, c.error)

    /** Bring the machine's requests in line with its state (a request that vanished is closed). */
    private suspend fun refresh() {
        val m = machine ?: return
        val live = m.conflicts().associateBy { it.id }
        synchronized(lock) {
            for ((id, r) in machineReqs.entries.toList()) {
                val c = live[id]
                if (c != null) {
                    r.view = machineView(c)
                } else {
                    r.closed = true
                    machineReqs.remove(id)
                }
            }
            for ((id, c) in live) if (id !in machineReqs) machineReqs[id] = MergeRequest(machineView(c), this, null)
        }
    }

    private fun all(): List<MergeRequest> = synchronized(lock) { (machineReqs.values + extra.values).sortedBy { it.id } }

    private suspend fun machineOpened(id: String) {
        val m = machine ?: return
        val c = m.conflicts().firstOrNull { it.id == id } ?: return
        val (r, waiter) = synchronized(lock) {
            val have = machineReqs[id]
            val req = have?.also { it.view = machineView(c) } ?: MergeRequest(machineView(c), this, null).also { machineReqs[id] = it }
            req to pending.remove(id)
        }
        // A keep of this request conflicted again: it reopens for the person.
        waiter?.complete(MergeOutcome.Refused("conflict", reopened = true))
        announce(r)
    }

    private suspend fun machineClosed(id: String, how: String) {
        val (r, waiter) = synchronized(lock) { machineReqs.remove(id) to pending.remove(id) }
        r?.closed = true
        if (waiter != null) {
            waiter.complete(if (how == "superseded") closedOutcome() else MergeOutcome.Kept(how, versionOf(r?.view?.collection, r?.view?.record)))
        }
        emit(MergeStreamEvent.Closed(id, how))
    }

    private suspend fun versionOf(collection: String?, record: String?): Long? {
        val m = machine
        if (m == null || collection == null || record == null) return null
        return m.records(collection).firstOrNull { it.id == record }?.version
    }

    /** A keep whose set was refused for good reopens the request with the failure code. */
    private suspend fun settleFromState() {
        if (synchronized(lock) { pending.isEmpty() }) return
        refresh()
        val settled = synchronized(lock) {
            pending.entries.toList().mapNotNull { (id, w) ->
                val r = machineReqs[id]
                when {
                    r == null -> pending.remove(id).let { w to closedOutcome() }
                    r.view.state == "open" -> pending.remove(id).let { w to MergeOutcome.Refused(r.view.error ?: "conflict", reopened = true) }
                    else -> null
                }
            }
        }
        for ((w, o) in settled) w.complete(o)
    }

    // -- announcing --------------------------------------------------------------------------------------------

    private fun announce(r: MergeRequest) {
        emit(MergeStreamEvent.Opened(r))
        val ls = synchronized(lock) { listeners.toList() }
        if (ls.isEmpty()) {
            val first = synchronized(lock) { (!noticed).also { noticed = true } }
            if (first) runCatching { notice(r) }
            return
        }
        for (fn in ls) {
            if (r.view.state != "open" || r.closed) break
            offer(fn, r)
        }
    }

    /** Hand a request to a listener; a returned choice decides it at once. */
    @Suppress("TooGenericExceptionCaught", "SwallowedException")
    private fun offer(fn: ConflictListener, r: MergeRequest) {
        val answer = try {
            fn.onConflict(r)
        } catch (e: Exception) {
            return // A listener's failure is its own.
        } ?: return
        scope.launch { runCatching { keepRequest(r, answer) } }
    }

    @Suppress("TooGenericExceptionCaught", "SwallowedException")
    private fun emit(e: MergeStreamEvent) {
        val ws = synchronized(lock) { watchers.toList() }
        for (fn in ws) {
            try {
                fn(e)
            } catch (x: Exception) {
                // A listener's failure never reaches the machine.
            }
        }
    }

    private fun closedOutcome() = MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false)

    private fun badRequest() = MergeOutcome.Refused("bad_request", reopened = false)
}
