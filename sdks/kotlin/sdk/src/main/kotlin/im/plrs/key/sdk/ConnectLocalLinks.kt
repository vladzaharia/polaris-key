// Pairing with a code, with no account, `client.cloudConnect.localLinks` (CC-29.13; WIRE-CONTRACT-V5 section 15.12): two
// devices of one app on one LAN pair by an 8-digit code or a QR. One device shows ([pair], the responder: `LocalShower.kt`),
// the other types or scans ([join], the initiator: `LocalJoiner.kt`). CPace turns the code into a key, mode `q` runs
// Noise over it, both people confirm, and each side stores a link in `pkey.connect.local.v1` (`ConnectLocalState.kt`).
// Mirrors sdk-node's `connect/localLinks.ts`.
//
// Nothing here needs a signed-in device: no identity, no K_disc, no certificate. Pairing needs no `start()` either; the later
// sessions (mode `l`) ride the LAN service `cloudConnect.start()` runs, which with no account serves local links alone
// (sections 15.5 and 15.12 "Mode l"):
//
//   list()                the links this device holds
//   rename(id, label)     change the label on this device only; it is never sent
//   remove(id)            forget a link: its keys and secret go, open sessions hear `peer_revoked`
//   setReachable(id, on)  advertise the link's `m=l` name on the LAN (at most 8), or stop
//   open(id)              a session to the peer, found by its advert on the LAN (no relay)
//   onLink(fn)            called with each session a local link opened to this device
//
// Rules this file keeps:
// - `pair`, `join` and every accept and dial need the cached discovery answer `localPairing: true` (section 15.12 "Gates");
//   without it they throw the typed N/A [LocalPairingOffException] (`local-pairing-off`), and a read that clears it closes the
//   window and every join, ends the open sessions `peer_bye` and withdraws the adverts. Managing links (`list`, `rename`,
//   `remove`, `setReachable`) is never gated;
// - one window per device and product, its slot taken before the first suspension, so two calls that race open one window;
//   a device that holds `MAX_LOCAL_LINKS` answers `local-links-full` before anything is advertised or dialled;
// - the joiner's dials are counted per typed nameplate across joins and clients, in memory, per product for the whole process
//   (an app that makes a new client per screen meets the same budget);
// - `open` is one dial per link at a time (callers share it); a dial that reached the network and failed is not repeated for
//   3 to 5 s, and the wait doubles with each failure in a row, to 60 s;
// - links are kept in the state directory; with no state directory, or with memory-only device keys, they are memory-only and
//   lost when the process ends. The SDK logger (`im.plrs.key`, WARNING) says so once per client;
// - a session nobody takes (no `onLink` listener and no transfer taker) is closed `peer_bye`; one whose link was forgotten, or
//   whose gate went off, while its handshake ran is closed before the host sees it.

@file:Suppress(
    "MagicNumber",
    "ReturnCount",
    "SwallowedException",
    "ThrowsCount",
    "TooGenericExceptionCaught",
    "TooManyFunctions",
)

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.peer.DialBudget
import im.plrs.key.core.peer.MAX_LIVE_LOCAL_ADVERTS
import im.plrs.key.core.peer.MAX_LOCAL_LINKS
import im.plrs.key.core.peer.cleanLocalLabel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** A dial to one link is not repeated sooner than this (seconds): a base, with jitter, doubled after each failure up to the cap. */
private const val DIAL_COOLDOWN_S = 3.0
private const val DIAL_COOLDOWN_JITTER_S = 2.0
private const val DIAL_BACKOFF_CAP_S = 60.0
private const val LABEL_MAX = 64

/**
 * The joiner's dial budgets, one per product for the whole process: an app that makes a new client per screen or per retry
 * meets the same budget, so retries cannot multiply a fake advert's guesses. In memory only (a restart resets it, as section
 * 15.12 allows).
 */
private val BUDGETS = ConcurrentHashMap<String, DialBudget>()

private fun budgetOf(slug: String): DialBudget = BUDGETS.getOrPut(slug) { DialBudget() }

/** Forget every dial budget. For tests. */
internal fun resetLocalBudgets() = BUDGETS.clear()

/** What a missing discovery adapter is: the typed N/A of this runtime. */
private fun noAdapter(platformMissing: Boolean): PolarisException {
    val detail = if (platformMissing) NO_ADAPTER else "Pairing needs Android 14 or later."
    return PolarisException(
        ErrorCode.unsupported,
        "Pairing with a code is not available here.",
        detail = detail,
        unsupported = Unsupported(Feature.connectLocal, UnsupportedReason.runtime, detail),
    )
}

private const val NO_ADAPTER = "This runtime has no local-network discovery adapter; pass one in the options."

/** What the facade needs of the rest of the SDK. */
internal class LocalHooks(
    /** A session the links opened or accepted (Direct Transfer takes it). */
    val adopt: (ConnectSession) -> Unit = {},
    /** True while Direct Transfer has a handler, so a device with no `onLink` listener keeps its inbound sessions. */
    val transferAccepting: () -> Boolean = { false },
    /** Links were forgotten: their peers' link keys (32 raw bytes each). */
    val removed: (List<ByteArray>) -> Unit = {},
    /** A number in [0, 1) for the cooldown's jitter. */
    val random: () -> Double = { Math.random() },
)

public class CloudLocalLinks internal constructor(private val src: LocalSource, private val hooks: LocalHooks = LocalHooks()) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()
    private val budget: DialBudget = budgetOf(src.slug)

    @Volatile
    private var lan: LanService? = null
    private val unsub = ArrayList<() -> Unit>()
    private val sessions = HashSet<ConnectSession>()
    private val onLinkFns = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private var shower: LocalShower? = null

    /** The window that is being opened: the slot is taken before the first suspension. */
    private var starting: CompletableDeferred<Unit>? = null

    /** Bumped by `closeAll`: a window that began opening before it must not outlive it. */
    @Volatile
    private var epoch = 0
    private val joins = HashSet<JoinHandle>()

    /** One dial per link at a time: a second `open` for the same link joins it. */
    private val dials = HashMap<String, Deferred<ConnectSession>>()

    /** Per link: no dial before `until` (monotonic seconds), and the failures in a row. */
    private val cool = HashMap<String, Pair<Double, Int>>()
    private val unChange: () -> Unit = src.onChange { scope.launch { quiet { reconcile() } } }

    private class JoinHandle {
        @Volatile var cancelled = false

        @Volatile var joiner: LocalJoiner? = null

        fun cancel() {
            cancelled = true
            joiner?.cancel()
        }
    }

    override fun toString(): String = "CloudLocalLinks"

    /** The cached discovery answer `services.connect.localPairing` (sections 15.9 and 15.12). False before discovery. */
    public fun localPairing(): Boolean = src.allowed()

    private fun requireOn(what: String) {
        if (!src.allowed()) throw LocalPairingOffException(what)
    }

    /** The local links this device holds. Listing is not gated. */
    public suspend fun list(): List<LocalLinkInfo> = infoOfLocal(src.store.rows())

    /**
     * Show a code and a QR and wait for the other device (the responder). Throws [LocalPairingOffException] while the gate is
     * off, `local-links-full` at the cap, and [LanException] `bad_type` for options that break a rule or when this product
     * already has a window open. The handle closes the window ([LocalPairHandle.stop]); it also closes by itself after
     * [LocalPairOptions.seconds] (at most 300), after the fifth failed guess and once a link is made.
     */
    public suspend fun pair(options: LocalPairOptions): LocalPairHandle {
        requireOn("pair")
        checkLocalOptions(options)
        if (!(options.seconds > 0)) throw localBad("seconds must be above 0.")
        // The slot is taken before the first suspension: two calls that race open one window.
        val slot = CompletableDeferred<Unit>()
        val mine = synchronized(lock) {
            if (shower?.open == true || starting != null) throw localBad("A pairing window is already open.")
            starting = slot
            epoch
        }
        try {
            if (src.store.count() >= MAX_LOCAL_LINKS) throw localFull()
            val adapter = platformMdnsFor(options.mdns, ConnectPlatforms.android, ConnectPlatforms.installed, ::noAdapter)
            val holder = java.util.concurrent.atomic.AtomicReference<LocalShower?>()
            val made = LocalShower.start(src, if (adapter === options.mdns) options else options.withMdns(adapter)) {
                synchronized(lock) { if (shower === holder.get()) shower = null }
            }
            holder.set(made)
            synchronized(lock) { shower = if (made.open) made else null }
            // The gate was cleared while the window was opening: it closes before anyone sees a code.
            if (mine != epoch || !src.allowed()) {
                quiet { made.stop() }
                throw LocalPairingOffException("pair")
            }
            return made
        } finally {
            synchronized(lock) { if (starting === slot) starting = null }
            slot.complete(Unit)
        }
    }

    /**
     * Type or scan the other device's code (the initiator). Returns the link when both people confirmed and both devices stored
     * it. Throws `pairing-code-failed` (the code did not parse, the QR was not this app's, the dial budget for this code is
     * spent, or an attempt failed after the other device answered), `pairing-not-found` (no matching advert in 15 s, or every
     * attempt ended before an answer) and `peer-closed` (the session ended first); [LocalPairingOffException] and
     * `local-links-full` are thrown before anything is browsed.
     */
    public suspend fun join(options: LocalJoinOptions): LocalPaired {
        requireOn("join")
        checkLocalOptions(options)
        if ((options.code == null) == (options.qr == null)) throw localBad("Give exactly one of code and qr.")
        if (!(options.browseSeconds > 0)) throw localBad("browseSeconds must be above 0.")
        // Registered before the first suspension, so a gate-clearing read can cancel it.
        val handle = JoinHandle()
        synchronized(lock) { joins += handle }
        try {
            if (src.store.count() >= MAX_LOCAL_LINKS) throw localFull()
            if (handle.cancelled || !src.allowed()) throw LocalPairingOffException("join")
            val adapter = platformMdnsFor(options.mdns, ConnectPlatforms.android, ConnectPlatforms.installed, ::noAdapter)
            val j = LocalJoiner(src, budget, if (adapter === options.mdns) options else options.withMdns(adapter))
            handle.joiner = j
            if (handle.cancelled) j.cancel()
            return j.run()
        } finally {
            synchronized(lock) { joins -= handle }
        }
    }

    /**
     * Change a link's label on this device only; it is never sent. False when [id] names no link. Throws [LanException]
     * `bad_type` for a label that is empty once cleaned or longer than 64 characters.
     */
    public suspend fun rename(id: String, label: String): Boolean {
        val clean = cleanLocalLabel(label)
        if (clean == null || clean.codePointCount(0, clean.length) > LABEL_MAX) throw localBad("The label is not valid.")
        return change(id) { r, _ -> r.copy(label = clean) }
    }

    /**
     * Advertise a link's `m=l` name on the LAN (at most 8 at once), or stop. False when [id] names no link. A new link is
     * reachable already; turning a ninth on throws `local-links-full`. The adverts run while `cloudConnect.start()` does and
     * the gate is on.
     */
    public suspend fun setReachable(id: String, reachable: Boolean): Boolean {
        var refused = false
        val found = change(id) { r, rows ->
            // At most MAX_LIVE_LOCAL_ADVERTS links are advertised: a ninth is refused, not left silently unadvertised (section
            // 15.12, "Reachable by default").
            if (reachable && !r.reachable && rows.count { it.reachable } >= MAX_LIVE_LOCAL_ADVERTS) {
                refused = true
                r
            } else {
                r.copy(reachable = reachable)
            }
        }
        if (refused) throw localFull("Eight local links are already reachable on this network; turn one off first.")
        return found
    }

    private suspend fun change(id: String, f: (LocalLinkRow, List<LocalLinkRow>) -> LocalLinkRow): Boolean {
        var found = false
        src.store.update { rows ->
            found = rows.any { it.id == id }
            if (found) rows.map { if (it.id == id) f(it, rows) else it } else null
        }
        if (found) src.notify()
        return found
    }

    /**
     * Forget a link: its keys and secret leave the record before this returns, an open session under it is closed
     * `peer_revoked`, a handshake in progress under it is closed before the host sees it, and the partial files kept for its
     * peer are deleted. False when [id] names no link.
     */
    public suspend fun remove(id: String): Boolean {
        val gone = ArrayList<ByteArray>()
        src.store.update { rows ->
            val hit = rows.firstOrNull { it.id == id } ?: return@update null
            Base64Url.decode(hit.peerKey)?.let { gone += it }
            rows.filter { it.id != id }
        }
        if (gone.isEmpty()) return false
        // The listener drops the link before this returns: a dial or a handshake that starts after `remove` cannot use it.
        quiet { lan?.forgetLocal(id) }
        src.notify()
        reconcile()
        try {
            hooks.removed(gone)
        } finally {
            for (k in gone) k.fill(0)
        }
        return true
    }

    /** Called with each session a local link opened to this device. Returns the unsubscribe. */
    public fun onLink(fn: (ConnectSession) -> Unit): () -> Unit {
        onLinkFns += fn
        return { onLinkFns -= fn }
    }

    /**
     * A session to the peer of a link, found by its `m=l` advert on the LAN (mode `l`; the relay is never used). Throws
     * [LocalPairingOffException] while the gate is off, [LanException] `not_started` before `cloudConnect.start()`,
     * `unknown_peer` for an id that is no link or a peer not seen on this network, `busy` for a dial that failed a moment ago,
     * and `handshake_failed` when the peer does not answer under the link (it forgot it: "Not reachable").
     */
    public suspend fun open(id: String): ConnectSession {
        // One dial per link at a time; a caller that comes while one runs gets the same session.
        val d = synchronized(lock) {
            dials[id] ?: scope.async(start = CoroutineStart.LAZY) { dial(id) }.also { run ->
                // Stored and watched before it starts: a dial that fails at once is still removed, never cached.
                dials[id] = run
                run.invokeOnCompletion { synchronized(lock) { if (dials[id] === run) dials.remove(id) } }
                run.start()
            }
        }
        return d.await()
    }

    private suspend fun dial(id: String): ConnectSession {
        requireOn("open")
        val l = lan ?: throw LanException(LanErrorReason.not_started, "Cloud Connect is not started.")
        if (src.store.rows().none { it.id == id }) throw LanException(LanErrorReason.unknown_peer, "That is not a local link on this device.")
        // A dial that failed is not repeated at once, and the wait grows with each failure in a row: a peer that closes on a
        // message 1 (it is busy, or it forgot the link) is not hammered.
        val cooling = synchronized(lock) { cool[id] }
        if (cooling != null && src.mono() < cooling.first) {
            throw LanException(LanErrorReason.busy, "That device did not answer a moment ago; try again shortly.")
        }
        val s = try {
            l.connectLocal(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The gate was cleared while the dial ran.
            if (!src.allowed()) throw LocalPairingOffException("open")
            // Only a dial that reached the network is held off: "not seen yet" is no attempt.
            val reason = (e as? LanException)?.reason
            if (reason == LanErrorReason.unknown_peer || reason == LanErrorReason.not_started) throw e
            val fails = (cooling?.second ?: 0) + 1
            val base = DIAL_COOLDOWN_S + DIAL_COOLDOWN_JITTER_S * hooks.random()
            synchronized(lock) { cool[id] = minOf(DIAL_BACKOFF_CAP_S, base * (1L shl minOf(fails - 1, 20))) + src.mono() to fails }
            throw e
        }
        synchronized(lock) { cool.remove(id) }
        // Adopted (Direct Transfer takes it) and tracked only once the link is known to be held.
        if (!stillHeld(s)) {
            if (!src.allowed()) throw LocalPairingOffException("open")
            throw LanException(LanErrorReason.unknown_peer, "That link was removed.")
        }
        track(s)
        return s
    }

    /** Whether a link is held. */
    internal suspend fun has(id: String): Boolean = src.store.rows().any { it.id == id }

    // -- wiring (CloudConnect.start and stop) ----------------------------------------------------

    /** The LAN service the sessions come from. The previous one's sessions are ended first. */
    internal suspend fun attach(lan: LanService) {
        detach()
        this.lan = lan
        synchronized(lock) { unsub += lan.onLocalSession { inbound(it) } }
    }

    /** Ends the sessions; the transport is CloudConnect's. */
    internal suspend fun detach() {
        val offs = synchronized(lock) { unsub.toList().also { unsub.clear() } }
        for (u in offs) u()
        lan = null
        val mine = synchronized(lock) { sessions.toList() }
        for (s in mine) quiet { s.close("peer_bye") }
        // Only what this call ended: a session of a newer attach is left alone.
        synchronized(lock) { sessions.removeAll(mine.toSet()) }
    }

    internal fun shutdown() {
        unChange()
        scope.cancel()
    }

    private fun track(s: ConnectSession) {
        hooks.adopt(s)
        synchronized(lock) { sessions += s }
        s.onClose { synchronized(lock) { sessions -= s } }
    }

    private fun inbound(s: ConnectSession) {
        // The handshake may have begun before the link was forgotten or the gate went off: the session is delivered only while
        // the link (same secret) is held and the gate is on.
        scope.launch {
            if (!stillHeld(s)) return@launch
            val subs = onLinkFns.toList()
            // A session nobody takes is ended, not left open and untracked: the peer dials again.
            if (subs.isEmpty() && !hooks.transferAccepting()) {
                quiet { s.close("peer_bye") }
                return@launch
            }
            track(s)
            for (f in subs) {
                try {
                    f(s)
                } catch (e: Exception) {
                    // a host callback never ends a session
                }
            }
        }
    }

    /** Close [s] (`peer_revoked`, or `peer_bye` when the gate is off) unless its link is still held. */
    private suspend fun stillHeld(s: ConnectSession): Boolean {
        val ref = s.local ?: return true
        val on = src.allowed()
        val held = on && (
            try {
                src.store.rows()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                emptyList()
            }
            ).any { it.id == ref.id && localTag(Base64Url.decode(it.secret) ?: ByteArray(0)) == ref.tag }
        if (held) return true
        quiet { s.close(if (on) "peer_revoked" else "peer_bye") }
        return false
    }

    /** The gate or the list moved: a closed gate ends every session (`peer_bye`), a forgotten link's ends `peer_revoked`. */
    private suspend fun reconcile() {
        val open = synchronized(lock) { sessions.toList() }
        if (open.isEmpty()) return
        if (!src.allowed()) {
            for (s in open) quiet { s.close("peer_bye") }
            return
        }
        val held = (
            try {
                src.store.rows()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                emptyList()
            }
            ).map { "${it.id}|${localTag(Base64Url.decode(it.secret) ?: ByteArray(0))}" }.toSet()
        for (s in open) {
            val r = s.local
            if (r != null && "${r.id}|${r.tag}" !in held) quiet { s.close("peer_revoked") }
        }
    }

    /**
     * The gate was cleared by a discovery read: close the window and every join, and end every open session with `peer_bye`
     * (section 15.12 "Gates"). The adverts are withdrawn by the LAN service, which the client tells at the same time.
     */
    internal suspend fun closeAll() {
        val (w, js, pending) = synchronized(lock) {
            epoch++
            Triple(shower, joins.toList(), starting)
        }
        for (j in js) j.cancel()
        quiet { w?.stop() }
        // A window still opening is stopped by its own start, which sees the new epoch.
        pending?.await()
        val open = synchronized(lock) { sessions.toList() }
        for (s in open) quiet { s.close("peer_bye") }
    }

    private suspend inline fun quiet(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // best effort
        }
    }
}
