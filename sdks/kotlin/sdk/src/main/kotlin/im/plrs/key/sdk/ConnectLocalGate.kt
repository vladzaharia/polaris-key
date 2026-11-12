// What local links read of the client (CC-29.13; WIRE-CONTRACT-V5 section 15.12): the gate, the store, the live links.
// Mirrors the local half of sdk-node's `connect/client.ts` and `client.ts`.
//
// The gate (section 15.12 "Gates") is the cached discovery answer `services.connect.localPairing`:
// - no cached document is off, and offline a cached `true` keeps working: a read that is neither a document nor a
//   not-found changes nothing;
// - reads apply in the order they began (a sequence number from `CoreContext.discover`): an older answer never overwrites
//   a newer one, and the applied number advances only on a document or a not-found, never on an error;
// - the gate is applied before anything else a read does, so a fault in a store cannot leave a cleared gate "on";
// - a read that says nothing (an error, an invalid body) while the gate is on is read again in 5 minutes, then 10, then every
//   15, so the operator's switch-off reaches a host whose first re-read failed;
// - while the gate is on, discovery is read again every 1 to 4 hours (random, so a fleet does not move together): a
//   withdrawal reaches an idle host in hours, not at the next start;
// - a read that clears a cached `true` closes the windows and joins, ends the open sessions `peer_bye` and withdraws the
//   adverts.

@file:Suppress(
    "LongParameterList",
    "MagicNumber",
    "SwallowedException",
    "TooGenericExceptionCaught",
)

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ProductDiscoveryDocument
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.boolValue
import im.plrs.key.core.peer.GateEffect
import im.plrs.key.core.peer.GateState
import im.plrs.key.core.peer.LocalPairingGate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 3_600_000L
private const val HOUR_SECONDS = 3_600L
private val RETRY_MINUTES = longArrayOf(5, 10, 15)

/** `services.connect.localPairing` of a discovery document: true only as `true` while the connect service is enabled. */
internal fun localPairingOf(doc: ProductDiscoveryDocument): Boolean {
    val f = doc.services[ServiceSlug.connect] ?: return false
    return f.enabled && f.extras["localPairing"].boolValue == true
}

/** The enforcement of the operator gate from the discovery document the client cached. */
internal class LocalGateKeeper(
    /** Milliseconds until discovery is read again while the gate is on: 1 to 4 hours, random. A test passes its own. */
    private val rereadMs: () -> Long = { HOUR_MS + (Math.random() * 3 * HOUR_MS).toLong() },
    /** Minutes until the next retry after a read that said nothing. A test passes its own. */
    private val retryMinutes: (Int) -> Long = { RETRY_MINUTES[minOf(it, RETRY_MINUTES.size - 1)] },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()
    val gate = LocalPairingGate()
    private var applied = 0L
    private var retryStep = 0
    private var retry: Job? = null
    private var reread: Job? = null

    @Volatile
    private var closed = false

    /** Reads discovery again (the client's own `discover()`). Set once by the client. */
    @Volatile
    var discover: suspend () -> Unit = {}

    /** A read cleared a cached `true`: the windows and joins close and the sessions end. Set by the links facade. */
    @Volatile
    var onCleared: suspend () -> Unit = {}

    /** The gate moved either way: the listener and the adverts follow. Set by the client. */
    @Volatile
    var onMoved: () -> Unit = {}

    override fun toString(): String = "LocalGateKeeper(${gate.state})"

    /** One discovery read finished. [seq] is the number it was given when it began. */
    suspend fun read(result: DiscoveryResult, seq: Long) {
        try {
            apply(result, seq)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // the gate's own fault never keeps the discovery document from being stored
        }
    }

    private suspend fun apply(result: DiscoveryResult, seq: Long) {
        if (closed) return
        val wasOn = gate.allowed
        var effects: List<GateEffect> = emptyList()
        synchronized(lock) {
            if (seq > applied) {
                when (result) {
                    is DiscoveryResult.Ok -> {
                        applied = seq
                        retryStep = 0
                        effects = gate.readOk(localPairingOf(result.document))
                    }

                    DiscoveryResult.NotFound -> {
                        applied = seq
                        effects = gate.readNotFound()
                    }

                    // An error or an invalid body changes nothing and does not advance the applied number.
                    else -> Unit
                }
            }
        }
        armReread()
        // The windows, joins and sessions close beside the read, not inside it: a slow close never holds discovery up.
        if (effects.isNotEmpty()) {
            scope.launch {
                try {
                    onCleared()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // a fault in a close never keeps the gate from moving
                }
            }
        }
        if (wasOn != gate.allowed) onMoved()
        if (result !is DiscoveryResult.Ok && result != DiscoveryResult.NotFound) armRetry()
    }

    private fun armReread() {
        synchronized(lock) {
            reread?.cancel()
            reread = null
            if (closed || !gate.allowed) return
            reread = scope.launch {
                delay(rereadMs())
                synchronized(lock) { reread = null }
                try {
                    discover()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    armReread()
                }
            }
        }
    }

    private fun armRetry() {
        synchronized(lock) {
            if (closed || retry != null || !gate.allowed) return
            val minutes = retryMinutes(retryStep++)
            retry = scope.launch {
                delay(minutes * MINUTE_MS)
                synchronized(lock) { retry = null }
                try {
                    discover()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // the next read that says something ends it
                }
            }
        }
    }

    /** Cancel the timers. */
    fun close() {
        synchronized(lock) {
            closed = true
            reread?.cancel()
            retry?.cancel()
            reread = null
            retry = null
        }
        scope.cancel()
    }
}

/** What local pairing reads of the client. */
internal class LocalSource(
    val slug: String,
    /** Seconds since the epoch. */
    val now: () -> Long,
    /** Monotonic seconds. */
    val mono: () -> Double,
    /** The cached discovery answer `localPairing` is true (section 15.12 "Gates"). */
    val allowed: () -> Boolean,
    val store: LocalLinkStore,
    /** The links changed (renamed, re-marked, forgotten): the listener and the adverts follow. */
    val notify: () -> Unit,
    /** Called by [notify] and when the gate moves. Returns the unsubscribe. */
    val onChange: (() -> Unit) -> (() -> Unit),
    /**
     * The host-facing change feed (`localLinks.onChange`): a pairing was stored, a link was renamed, forgotten, re-marked or
     * seen, or the gate flipped. Returns the unsubscribe.
     */
    val onView: (() -> Unit) -> (() -> Unit),
    /** The links with their keys decoded, or none while the gate is off or the store cannot be used. The caller wipes them. */
    val live: suspend () -> List<LiveLocal>,
    /** A session opened under a link: its last-seen time moves (hourly). */
    val touch: suspend (LocalRef) -> Unit,
) {
    override fun toString(): String = "LocalSource"
}

/** Callbacks that are told together: a fault in one never stops the others. */
internal class Subscribers {
    private val fns = CopyOnWriteArrayList<() -> Unit>()

    /** Subscribe [fn]; returns the unsubscribe. */
    fun add(fn: () -> Unit): () -> Unit {
        fns += fn
        return { fns -= fn }
    }

    fun fire() {
        for (f in fns.toList()) {
            try {
                f()
            } catch (e: Exception) {
                // a listener cannot stop the others
            }
        }
    }
}

/** The client's local-link support: the gate, the store, the change listeners. */
internal class LocalSupport(private val core: CoreContext, private val options: ConnectOptions) {
    val gate = LocalGateKeeper()
    private val listeners = Subscribers()

    /** The host-facing feed of `localLinks.onChange`. */
    private val viewers = Subscribers()
    private var storage: DeviceKeyStorage? = null
    private val warned = java.util.concurrent.atomic.AtomicBoolean(false)

    val store = LocalLinkStore(core.product) { open() }

    init {
        gate.onMoved = { notifyChanged() }
    }

    override fun toString(): String = "LocalSupport"

    /** The cached discovery answer `localPairing` (section 15.9, 15.12). False before discovery. */
    fun allowed(): Boolean = gate.gate.allowed

    fun notifyChanged() {
        viewers.fire()
        listeners.fire()
    }

    fun onChange(fn: () -> Unit): () -> Unit = listeners.add(fn)

    /**
     * The record's home: the file store in the state directory, or memory when there is no directory or the host's device
     * keys are memory-only. A storage the host passed ([ConnectOptions.localState]) wins. Android needs one (the
     * Keystore-sealed store `PolarisKeyAndroid.client` installs): a plain file there would hold the link secrets unsealed, so it is refused.
     */
    private suspend fun open(): DeviceKeyStorage {
        storage?.let { return it }
        val dir: File? = core.store.stateDirectory
        val memory = options.deviceKeys?.persistence() == DeviceKeyPersistence.memory
        val s = options.localState ?: when {
            RuntimeFamily.isAndroid -> throw PolarisException(
                ErrorCode.invalidOptions,
                "Local links need a sealed store on Android: pass ConnectOptions.localState, or use PolarisKeyAndroid.client.",
            )

            dir == null || memory -> {
                warnMemoryOnly()
                InMemoryDeviceKeyStorage()
            }

            else -> FileDeviceKeyStorage(File(dir, LOCAL_STATE_FILE), null, "pkey-connect-local-state/1".toByteArray(Charsets.UTF_8))
        }
        storage = s
        return s
    }

    /** Once per client: local links with no state directory (or memory-only device keys) end with the process. */
    private fun warnMemoryOnly() {
        if (warned.compareAndSet(false, true)) {
            java.util.logging.Logger.getLogger("im.plrs.key").warning(
                "Local links are kept in memory only (no state directory, or memory-only device keys): they are lost when the process ends.",
            )
        }
    }

    /**
     * The links with their keys and secrets decoded, in held order. Empty while the gate is off, and on a store that cannot
     * be used: the listener then serves nothing and the record is never replaced. The caller wipes the list it gets.
     */
    suspend fun live(): List<LiveLocal> {
        if (!allowed()) return emptyList()
        return try {
            store.rows().map(::liveOfLocal)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emptyList()
        }
    }

    /** `lastSeen` moves only when the hour is newer, and is stored coarsened to the hour. */
    suspend fun touch(ref: LocalRef) {
        val bucket = core.now() / HOUR_SECONDS * HOUR_SECONDS
        try {
            var wrote = false
            store.update { rows ->
                val row = rows.firstOrNull { it.id == ref.id }
                if (row == null || bucket <= (row.lastSeen ?: 0L)) {
                    null
                } else {
                    wrote = true
                    rows.map { if (it.id == ref.id) it.copy(lastSeen = bucket) else it }
                }
            }
            // The host's list shows the time; the adverts and sessions do not depend on it.
            if (wrote) viewers.fire()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // a last-seen time is not worth a failed session
        }
    }

    fun source(): LocalSource = LocalSource(
        slug = core.product,
        now = { System.currentTimeMillis() / 1000 },
        mono = { System.nanoTime() / 1e9 },
        allowed = ::allowed,
        store = store,
        notify = ::notifyChanged,
        onChange = ::onChange,
        onView = viewers::add,
        live = ::live,
        touch = ::touch,
    )

    fun close() {
        gate.close()
    }

    /** For tests: the gate's state. */
    val state: GateState get() = gate.gate.state
}
