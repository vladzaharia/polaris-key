// The Cloud Sync machine: the facade over its collaborators. The reference client state machine, ported
// from client-core's `cloud-sync.ts` by way of the Python `machine.py`. It does no I/O and imports no
// catalog: the host derives the setting routes (SyncRoutes) and passes them in. It owns a fake-able
// clock (`advance`), queues the requests it would send (`takeRequests`) and the events it would emit
// (`takeEvents`). At most one request is in flight. Nothing here touches licence state.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonObject

/** The collaborators of one machine, built once and wired through this holder (they reference one another lazily). */
internal class MachineParts(val core: MachineCore) {
    val routing = MachineRouting(core)
    val layers = MachineLayers(this)
    val journal = MachineJournal(this)
    val pump = MachinePump(this)
    val edits = MachineEdits(this)
    val reads = MachineReads(this)
    val session = MachineSession(this)
    val rows = MachineRows(this)
    val results = MachineResults(this)
    val exchange = MachineExchange(this)
    val receiver = MachineReceive(this)
    val records = MachineRecords(this)
    val puts = MachineRecordPuts(this)
    val contact = MachineContact(this)
    val recordResults = MachineRecordResults(this)

    /** The constructor's tail: the subject's partition, expiry, and the first pull. */
    fun start() {
        core.s.partitions.getOrPut(LOCAL_PARTITION) { SyncPartition(null) }
        core.s.subject?.let { core.partitionFor(it) }
        session.expirePartitions()
        core.pullWanted = true
        pump.kick()
    }
}

public class CloudSyncMachine private constructor(private val parts: MachineParts) :
    SyncEdits by parts.edits,
    SyncReads by parts.reads,
    SyncSession by parts.session,
    SyncExchange by parts.receiver,
    SyncRecords by parts.records {
    /** A machine for [opts], restored from [persisted] (a relaunch) when given. */
    public constructor(opts: CloudSyncOptions, persisted: MachineState? = null) : this(
        MachineParts(
            MachineCore(
                opts,
                persisted?.deepCopy() ?: fresh(opts),
            ),
        ),
    ) {
        parts.start()
    }

    /** Who the machine holds signed in, or null (a signed-out device). */
    public val subject: String? get() = parts.core.s.subject

    /** The machine's clock. */
    public val now: Long get() = parts.core.now

    /** `online` or `offline`. */
    public val networkState: String get() = parts.core.network

    /** What survives a relaunch (the drafts are committed first, as the exit flush does). */
    public fun persist(): MachineState {
        parts.journal.commitAllDrafts()
        return parts.core.s.deepCopy()
    }

    /** The requests the machine would send, since the last call. */
    public fun takeRequests(): List<JsonObject> = parts.core.outbox.toList().also { parts.core.outbox.clear() }

    /** The events the machine would emit, since the last call. */
    public fun takeEvents(): List<SyncEvent> = parts.core.events.toList().also { parts.core.events.clear() }

    public companion object {
        private fun fresh(opts: CloudSyncOptions): MachineState =
            MachineState(opts.subject, linkedMapOf(LOCAL_PARTITION to SyncPartition(null))).also {
                it.offsetMs = opts.offsetMs
                it.contacted = opts.contacted
                it.deviceLocal.putAll(opts.deviceLocal)
                it.imported = opts.imported
            }

        /**
         * Relaunch: persist, then restore with the same host options. With [journalLost] the journal is dropped; the
         * device binding (the subject) is device state and survives, and so does the device-local store.
         */
        public fun relaunch(machine: CloudSyncMachine, opts: CloudSyncOptions, journalLost: Boolean = false): CloudSyncMachine {
            val saved = machine.persist()
            val next = opts.copyWith(machine.now, machine.networkState)
            if (!journalLost) return CloudSyncMachine(next, saved)
            next.offsetMs = 0
            next.contacted = false
            next.subject = saved.subject
            next.deviceLocal = saved.deviceLocal.toMap()
            next.imported = saved.imported
            return CloudSyncMachine(next)
        }
    }
}
