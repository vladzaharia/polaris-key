// Inter-account links, `client.cloudConnect.links` (CC-19.8; WIRE-CONTRACT-V5 section 15.10): pair two devices of
// two accounts once, in person, and open sessions to the contact later without a new pairing, on the LAN first
// and then through the contact relay. Mirrors sdk-node's `connect/links.ts`.
//
//   pair(options)          open the pairing window: show each code, `confirm()` or `decline()`, and a link is
//                          stored on both devices. LAN only (mode p)
//   list()                 the links this device holds
//   remove(id)             delete a link: its secret goes, open sessions with it hear `peer_revoked`, the other
//                          device finds the link "not reachable"
//   setReachable(id, on)   advertise a link on the LAN and keep a relay room for it, or stop
//   open(id)               a session to the contact: LAN first, the contact relay after a failed or timed-out LAN
//                          attempt (unless the host turned the relay off)
//   onLink(fn)             called with each session a contact opened to this device
//   interAccount()         the cached discovery answer links are gated on
//
// Rules this file keeps:
// - links are the developer's opt-in in every transport (D-12): `pair`, the adverts and the mode-`c` answer need
//   the cached discovery `interAccount` to be true. Without it `pair` and `open` throw [LinksDisabledException]
//   (code `connect_links_disabled`), nothing is advertised and no mode `c` is answered; when a refresh says false
//   the adverts and rooms are withdrawn and the open contact sessions end with `peer_bye`;
// - a link is a secret and a key on this device only. [ContactInfo] carries neither; a deleted contact's secret is
//   gone from the record before `remove` returns;
// - the order is LAN, then the contact relay, as for the person's own devices ([CloudConnect]).

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.CopyOnWriteArrayList

private const val MILLIS = 1000

/** Links between accounts are off for this product (the typed N/A, code `connect_links_disabled`). */
public class LinksDisabledException(what: String) :
    PolarisException(
        ErrorCode.connectLinksDisabled,
        "Links between accounts are off for this product ($what).",
        detail = "Links between accounts are off for this product ($what).",
        unsupported = Unsupported(Feature.connectLinks, UnsupportedReason.product, "Links between accounts are off for this product ($what)."),
    ) {
    override fun toString(): String = "LinksDisabledException($code)"
}

public class CloudLinks internal constructor(private val connect: ConnectClient) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Any()

    @Volatile
    private var lan: LanService? = null

    @Volatile
    private var relay: ContactRelay? = null

    @Volatile
    private var lanAttempt = CLOUD_LAN_ATTEMPT_SECONDS

    @Volatile
    private var relayOn = false
    private val unsub = ArrayList<() -> Unit>()
    private val sessions = HashSet<ConnectSession>()
    private val onLinkFns = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private val pairings = HashSet<LinkPairHandle>()

    /** Called with each contact session the SDK holds (Direct Transfer binds to it). */
    @Volatile
    internal var onSession: (ConnectSession) -> Unit = {}

    /** Called with the agreeKey of each link that was deleted (Direct Transfer purges its partial files). */
    @Volatile
    internal var onRemoved: (String) -> Unit = {}

    override fun toString(): String = "CloudLinks"

    /**
     * The cached discovery answer `services.connect.interAccount`: true only while the product's setting,
     * `launch.connectLinks` and the service are on (section 15.9). False before discovery.
     */
    public suspend fun interAccount(): Boolean = connect.interAccount()

    private suspend fun requireOn(what: String) {
        if (!connect.interAccount()) throw LinksDisabledException(what)
    }

    /** The links this device holds. */
    public suspend fun list(): List<ContactInfo> = infoOf(connect.contactRows())

    /**
     * Delete a link (and a re-pair waiting on it). Its secret is dropped from the record, and an open session with
     * that contact is closed with `peer_revoked`. False when [id] names no link.
     */
    public suspend fun remove(id: String): Boolean {
        var found = false
        val gone = ArrayList<String>()
        connect.updateContacts { rows, _ ->
            val next = rows.filter { contactId(it.agreeKey) != id }
            found = next.size != rows.size
            gone.clear()
            gone += rows.filter { contactId(it.agreeKey) == id }.map { it.agreeKey }
            if (found) next else null
        }
        if (found) {
            for (k in gone) onRemoved(k)
            reconcile()
        }
        return found
    }

    /** Advertise a link on the LAN and keep a relay room for it (at most 8 at once), or stop. False when [id] names no link. */
    public suspend fun setReachable(id: String, reachable: Boolean): Boolean {
        var found = false
        connect.updateContacts { rows, _ ->
            found = rows.any { contactId(it.agreeKey) == id }
            if (found) rows.map { if (contactId(it.agreeKey) == id) it.copy(reachable = reachable) else it } else null
        }
        return found
    }

    /** Called with each session a contact opened to this device, on either path (on a service thread). Returns the unsubscribe. */
    public fun onLink(fn: (ConnectSession) -> Unit): () -> Unit {
        onLinkFns += fn
        return { onLinkFns -= fn }
    }

    /**
     * Open the pairing window. Both people do it; each device advertises, finds the other and runs the code. Throws
     * [LinksDisabledException] while links are off, [LanException] for bad options or no identity, and what
     * `identity()` throws. The returned handle closes the window ([LinkPairHandle.stop]); it also closes by itself
     * after `seconds` (at most 300) and once a link is made.
     */
    public suspend fun pair(options: LinkPairOptions): LinkPairHandle {
        requireOn("pair")
        connect.identity()
        val src = PairSource(
            slug = connect.productSlug(),
            now = { System.currentTimeMillis() / MILLIS },
            agreeKey = { connect.ownAgreeKey() },
            held = { connect.contactRows().filter { it.pendingSince == null }.map { it.agreeKey } },
            store = { key, secret, label, cats ->
                var out: StoredLink? = null
                connect.updateContacts { rows, now ->
                    val v = storeRow(rows, key, secret, label, cats, now) ?: return@updateContacts null
                    out = StoredLink(contactId(key), v.pending)
                    v.rows
                }
                out
            },
            allowed = { connect.interAccount() },
        )
        val h = LinkPairing.start(src, options)
        synchronized(lock) { pairings += h }
        return h
    }

    /**
     * A session to a contact: LAN first when it was seen on the network, the contact relay after a failed or timed-out
     * LAN attempt (unless [relay] is false). A pending contact (a re-pair) is tried before the held one. Throws
     * [LinksDisabledException] while links are off, [LanException] `not_started` before `cloudConnect.start()`, and the
     * last [LanException] or [RelayException] when no path works.
     */
    @JvmOverloads
    public suspend fun open(id: String, relay: Boolean = true, lanAttemptSeconds: Double? = null): ConnectSession {
        requireOn("open")
        val l = lan
        val r = this.relay
        if (l == null && r == null) throw LanException(LanErrorReason.not_started, "Cloud Connect is not started.")
        val rows = connect.contactRows().filter { contactId(it.agreeKey) == id }
        if (rows.isEmpty()) throw LanException(LanErrorReason.unknown_peer, "That is not a link on this device.")
        // The newest secret first: the pending one of a re-pair, then the held one.
        val order = rows.filter { it.pendingSince != null }.map { true } + rows.filter { it.pendingSince == null }.map { false }
        var last: Exception? = null
        for (pending in order) {
            if (l != null && l.contactPeerIds().any { it.first == id && it.second == pending }) {
                val attempt = scope.async { l.connectContact(id, pending) }
                val ms = ((lanAttemptSeconds ?: lanAttempt) * MILLIS).toLong()
                if (withTimeoutOrNull(ms) { attempt.join() } != null) {
                    try {
                        return track(attempt.await())
                    } catch (e: CancellationException) {
                        if (!attempt.isCancelled) throw e
                        last = LanException(LanErrorReason.closed, "The LAN attempt was cancelled.")
                    } catch (e: Exception) {
                        last = e
                    }
                } else {
                    // A late attempt that still succeeds is closed: the caller has moved on.
                    scope.launch {
                        try {
                            attempt.await().close()
                        } catch (e: CancellationException) {
                            // the facade is closing
                        } catch (e: Exception) {
                            // the attempt failed after all
                        }
                    }
                    last = LanException(LanErrorReason.connect_failed, "The LAN attempt took too long; trying the relay.")
                }
            }
            if (r != null && relay && relayOn) {
                try {
                    return track(r.dial(id, pending))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    last = e
                }
            }
        }
        throw last ?: LanException(LanErrorReason.unknown_peer, "That contact was not found on this network, and the relay is off.")
    }

    // -- wiring (CloudConnect.start and stop) ------------------------------------------------------

    internal fun attach(lan: LanService?, relay: ContactRelay?, lanAttemptSeconds: Double, relayOn: Boolean) {
        detachWiring()
        this.lan = lan
        this.relay = relay
        this.lanAttempt = lanAttemptSeconds
        this.relayOn = relayOn
        synchronized(lock) {
            if (lan != null) unsub += lan.onContactSession { inbound(it) }
            if (relay != null) unsub += relay.onSession { inbound(it) }
            // The list or the gate moved: end the sessions that no longer have a footing.
            unsub += connect.onContactsChanged { scope.launch { reconcile() } }
        }
    }

    private fun detachWiring() {
        val offs = synchronized(lock) { unsub.toList().also { unsub.clear() } }
        for (u in offs) u()
        lan = null
        relay = null
    }

    /** Stops the pairing windows and the contact sessions; the transports are [CloudConnect]'s. */
    internal suspend fun detach() {
        detachWiring()
        val pairs = synchronized(lock) { pairings.toList().also { pairings.clear() } }
        val open = synchronized(lock) { sessions.toList().also { sessions.clear() } }
        for (p in pairs) quiet { p.stop() }
        for (s in open) quiet { s.close() }
    }

    internal fun shutdown() {
        scope.cancel()
    }

    private suspend fun closePairings() {
        val pairs = synchronized(lock) { pairings.toList().also { pairings.clear() } }
        for (p in pairs) quiet { p.stop() }
    }

    private fun inbound(s: ConnectSession) {
        track(s)
        for (f in onLinkFns.toList()) {
            try {
                f(s)
            } catch (e: Exception) {
                // a host callback never ends a session
            }
        }
    }

    private fun track(s: ConnectSession): ConnectSession {
        synchronized(lock) { sessions += s }
        s.onClose { synchronized(lock) { sessions -= s } }
        onSession(s)
        return s
    }

    /** The gate or the list moved: a closed gate ends every contact session (`peer_bye`), a deleted contact's ends `peer_revoked`. */
    private suspend fun reconcile() {
        if (!connect.interAccount()) {
            for (s in synchronized(lock) { sessions.toList() }) quiet { s.close("peer_bye") }
            closePairings()
            return
        }
        val have = connect.contactRows().map { contactId(it.agreeKey) }.toSet()
        for (s in synchronized(lock) { sessions.toList() }) {
            val c = s.contact
            if (c != null && c.id !in have) quiet { s.close("peer_revoked") }
        }
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
