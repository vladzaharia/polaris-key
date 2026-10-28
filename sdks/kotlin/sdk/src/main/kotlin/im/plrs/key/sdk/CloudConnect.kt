// `client.cloudConnect` -- the Cloud Connect API an app calls (CC-12.15; WIRE-CONTRACT-V5 section 15). A
// facade over the identity client, the LAN service, the relay and the sessions they open. Mirrors Node's
// `client.cloudConnect` (packages/sdk-node/src/connect/cloudConnect.ts) and Python's `client.cloud_connect`.
//
//   start(options)   get the identity (making and registering the device keys on first use), listen and
//                    browse on the LAN, then connect to the relay unless the host or the product turned it off
//   peers()          the person's other devices that can be reached now, with the paths each has
//   devices()        the person's devices as the Worker lists them (display data)
//   open(id)         a session to one device: LAN first, the relay after a bounded LAN attempt
//   onChannel(fn)    sessions other devices opened to this one, on either path
//   stop()           close the sessions, the relay and the LAN service
//
// Rules this file keeps:
//  - the order is LAN, then relay. The LAN attempt is bounded (`lanAttemptSeconds`, default 4); when it
//    fails or runs out of time and the relay is on, the relay is tried. A device not seen on the LAN goes
//    straight to the relay. `session.path` says which path was used;
//  - the relay stays off, with no socket and no ticket asked for, when the host turned it off and when
//    discovery says so: `services.connect.relay` is false, or the ticket endpoint is null (G21).
//    `status().relayReason` says which;
//  - the relay carries mode `a` only; modes `v` and `p` are not reachable through this API;
//  - an inbound session with no `onChannel` listener is closed with `peer_bye` (G9);
//  - a failure on one path is never swallowed: when no path works the last typed error is thrown
//    ([LanException] or [RelayException]);
//  - `stop()` waits a bounded time (R-6P S6): a host callback that blocks does not hold sign-out;
//  - sign-out stops Connect before the credential goes (G18); a stop that times out is swallowed there;
//  - a trust manifest a peer pushed is applied only when trust refresh is on, then persisted.
//
// Threads: `start`, `stop`, `open`, `devices` and `refreshPeers` are suspend calls and run on the caller's
// dispatcher. The services run on their own scopes (Dispatchers.Default and IO), so `onChannel`, `onNotice`
// and a session's `onMessage` callbacks run on those threads: keep them short and never block in one. A
// callback that throws is ignored and never ends a session. No key, ticket or certificate is in a
// `toString` or a status.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.PeerTrustResult
import im.plrs.key.core.ProductDiscoveryDocument
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.ServiceSlug
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.util.concurrent.CopyOnWriteArrayList

/** How long a LAN attempt may take before the relay is tried (seconds). */
public const val CLOUD_LAN_ATTEMPT_SECONDS: Double = 4.0

/** How long `stop()` waits for the teardown (milliseconds). */
public const val CLOUD_STOP_MILLIS: Long = 15_000

/** How long one session may take to close during teardown (milliseconds). */
internal const val SESSION_CLOSE_MILLIS: Long = 2_000

/** Why a pushed trust manifest was refused when the host turned trust refresh off. */
public const val PEER_TRUST_REFRESH_OFF: String = "trust_refresh_off"

/**
 * What `start` brings up. [lan] false skips the LAN service; [lanOptions] tunes it (including the
 * `mdns` adapter, the `interfaces` override and the suspend `lanPermission` hook an Android host
 * supplies). [relay] false keeps the relay off. [lanAttemptSeconds] bounds the LAN attempt of `open`.
 */
public class CloudConnectOptions @JvmOverloads constructor(
    public val lan: Boolean = true,
    public val lanOptions: LanOptions = LanOptions(),
    public val relay: Boolean = true,
    public val lanAttemptSeconds: Double = CLOUD_LAN_ATTEMPT_SECONDS,
) {
    /** Test seam: the relay's options (an injected opener and clock). */
    internal var relayOptions: RelayOptions? = null

    override fun toString(): String = "CloudConnectOptions"
}

/** A device of the person's that can be reached now. */
public data class CloudPeer(
    val deviceId: String,
    /** Seen on this network right now. */
    val lan: Boolean,
    /** Online in the relay room right now. */
    val relay: Boolean,
)

/**
 * What Connect is doing. [lan] is `off`, `on` or `failed` (see [lanError]); [lanReason] says why it is
 * off: `host` (turned off) or `unsupported` (no discovery adapter on this platform). [relay] is `off` or
 * the relay's state (`connecting`, `open`, `backoff`, `unavailable`, `blocked`, `stopped`); [relayReason]
 * says why it is off: `host`, `product` (discovery says no relay) or `no_ticket`.
 */
public data class CloudConnectStatus(
    val running: Boolean,
    val lan: String,
    val lanError: Throwable?,
    val relay: String,
    val relayError: RelayException?,
    val lanReason: String? = null,
    val relayReason: String? = null,
)

/** `null` when discovery allows the relay, else why not (G21). An unknown discovery allows it: the ticket route answers for itself. */
internal fun relayWanted(doc: ProductDiscoveryDocument?): String? {
    val f = doc?.services?.get(ServiceSlug.connect) ?: return null
    if (!f.enabled) return null // Connect itself being off is identity()'s refusal
    val flag = (f.extras["relay"] as? JsonPrimitive)?.booleanOrNull
    if (flag == false) return "product"
    // The Worker publishes `endpoints.ticket: null` while the relay is off; a null is not kept in the map.
    if (f.endpoints.isNotEmpty() && "ticket" !in f.endpoints) return "no_ticket"
    return null
}

public class CloudConnect internal constructor(
    private val connect: ConnectClient,
    private val core: CoreContext,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    /** Epoch seconds on the trust clock floor, non-suspend: certificate, roster and `peer_expired` checks. */
    private val floored: () -> Long = { core.flooredNow() },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val gate = Mutex()
    private val lock = Any()

    @Volatile
    private var lan: LanService? = null

    @Volatile
    private var relay: RelayService? = null

    /** Test seam: the bound `stop()` waits ([CLOUD_STOP_MILLIS]). */
    @Volatile
    internal var stopMillis: Long = CLOUD_STOP_MILLIS

    @Volatile
    private var dyingLan: LanService? = null

    @Volatile
    private var dyingRelay: RelayService? = null

    @Volatile
    private var lanFailed: Throwable? = null

    @Volatile
    private var lanReason: String? = null

    @Volatile
    private var relayReason: String? = null

    @Volatile
    private var self = ""

    @Volatile
    private var running = false

    @Volatile
    private var touched = false

    @Volatile
    private var lanAttempt = CLOUD_LAN_ATTEMPT_SECONDS
    private val channelFns = CopyOnWriteArrayList<(ConnectSession) -> Unit>()
    private val noticeFns = CopyOnWriteArrayList<(ConnectNotice) -> Unit>()
    private val unsub = ArrayList<() -> Unit>()
    private val sessions = HashSet<ConnectSession>()

    // -- the API -----------------------------------------------------------------------------------

    /** What Connect is doing now. */
    public fun status(): CloudConnectStatus {
        val r = relay
        val st = r?.status
        return CloudConnectStatus(
            running = running,
            lan = if (lan != null) {
                "on"
            } else if (lanFailed != null) {
                "failed"
            } else {
                "off"
            },
            lanError = lanFailed,
            relay = st?.state?.name ?: "off",
            relayError = st?.error,
            lanReason = if (lan == null && lanFailed == null) lanReason else null,
            relayReason = if (st == null) relayReason else st.reason,
        )
    }

    /**
     * Get the identity and bring the transports up. Throws what `client.connect.identity()` throws
     * (`no-token`, `connect-unavailable`, `invalid-options`...). A LAN service that cannot start is not fatal
     * while the relay is on (`status().lanError` says why); with the relay off the LAN error is thrown.
     */
    public suspend fun start(options: CloudConnectOptions = CloudConnectOptions()) {
        touched = true
        gate.withLock { startLocked(options) }
    }

    private suspend fun startLocked(o: CloudConnectOptions) {
        if (running) return
        val ident = connect.identity()
        self = ident.deviceId
        lanAttempt = o.lanAttemptSeconds
        lanFailed = null
        lanReason = null
        relayReason = null
        val reason = if (!o.relay) "host" else relayWanted(core.discoveryDocument())
        val relayOn = reason == null
        val src = lanSource(connect, now = now, floored = floored, applyTrust = { applyPeerTrust(it) })
        try {
            if (!o.lan) {
                lanReason = "host"
            } else if (RuntimeFamily.isAndroid && o.lanOptions.mdns == null) {
                lanReason = "unsupported" // the :android glue supplies the adapter (CC-12b); the relay still works
            } else {
                try {
                    val svc = LanService.start(src, o.lanOptions, onSession = { inbound(it) })
                    lan = svc
                    unsub += svc.onNotice { notice(it) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    lanFailed = e
                    if (!relayOn) throw e
                }
            }
            if (relayOn) {
                val ro = o.relayOptions ?: RelayOptions(caps = o.lanOptions.caps, label = o.lanOptions.label)
                val svc = RelayService(src, { connect.relayTicket() }, ro)
                relay = svc
                unsub += svc.onSession { inbound(it) }
                unsub += svc.onNotice { notice(it) }
                svc.start()
            } else {
                relayReason = reason
            }
            running = true
        } catch (e: Throwable) {
            teardown()
            throw e
        }
    }

    /**
     * Close the sessions, the relay socket and the LAN service. Safe to call more than once, and before
     * `start` (it then does nothing). Waits at most [CLOUD_STOP_MILLIS]: when a callback or a socket holds
     * the teardown up, it stays queued and this throws `LanException(closed)`, so a caller such as sign-out
     * does not wait on the host's code (R-6P S6).
     */
    public suspend fun stop() {
        if (!touched) return
        val job = scope.async { gate.withLock { teardown() } }
        if (withTimeoutOrNull(stopMillis) { job.await() } == null) {
            // Past the bound: cancel what is left and let go of the transports, so sign-out goes on (D-12).
            job.cancel()
            abortLeft()
            throw LanException(LanErrorReason.closed, "Cloud Connect did not stop in time: a callback is blocking it.")
        }
    }

    /** What teardown is still holding when `stop()` gives up on it. */
    private suspend fun abortLeft() {
        val l = dyingLan
        val r = dyingRelay
        dyingLan = null
        dyingRelay = null
        running = false
        lan = null
        relay = null
        synchronized(lock) { unsub.clear() }
        quietly { l?.abort() }
        quietly { r?.abort() }
        val open = synchronized(lock) { sessions.toList().also { sessions.clear() } }
        for (s in open) quietly { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { s.close() } }
    }

    private suspend inline fun quietly(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // best effort on the way out
        }
    }

    private suspend fun teardown() {
        running = false
        val offs = synchronized(lock) { unsub.toList().also { unsub.clear() } }
        for (u in offs) u()
        val l = lan
        val r = relay
        lan = null
        relay = null
        dyingLan = l
        dyingRelay = r
        // The services first: each bounds itself and closes its own sessions and sockets, so a host
        // callback that blocks a session close cannot keep the listener or the relay socket up.
        quietly { l?.stop() }
        quietly { r?.stop() }
        dyingLan = null
        dyingRelay = null
        val open = synchronized(lock) { sessions.toList().also { sessions.clear() } }
        for (s in open) quietly { withTimeoutOrNull(SESSION_CLOSE_MILLIS) { s.close() } }
    }

    /** Sign-out and `close()`: stop, never fail. A timeout is swallowed; the teardown stays queued. */
    internal suspend fun stopForSignOut() {
        try {
            stop()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // sign-out goes on; the credential must not outlive the user's decision
        }
    }

    /** The client's `close()`: tear down in the background, then release the facade's scope. */
    internal fun shutdown() {
        if (!touched) {
            scope.cancel()
            return
        }
        scope.launch { gate.withLock { teardown() } }.invokeOnCompletion { scope.cancel() }
    }

    /** The person's other devices that can be reached now, with the paths each has. */
    public fun peers(): List<CloudPeer> {
        val out = LinkedHashMap<String, BooleanArray>()
        lan?.peers()?.forEach { out[it.deviceId] = booleanArrayOf(true, false) }
        relay?.members()?.forEach { d -> if (d != self) out.getOrPut(d) { booleanArrayOf(false, false) }[1] = true }
        return out.map { (d, v) -> CloudPeer(d, v[0], v[1]) }
    }

    /** Ask the relay room who is online now, so `peers()` includes devices that joined since. A no-op without the relay. */
    public suspend fun refreshPeers(): List<CloudPeer> {
        relay?.refreshMembers()
        return peers()
    }

    /** `GET /<p>/connect/devices`: the person's devices, display data only. */
    public suspend fun devices(): List<ConnectDevice> = connect.listDevices()

    /**
     * A session to one of the person's devices. LAN first when the device was seen on the network, the
     * relay after a failed or timed-out LAN attempt (unless [relay] is false). Throws [LanException] or
     * [RelayException]; `session.path` tells which path an open session took.
     */
    @JvmOverloads
    public suspend fun open(deviceId: String, relay: Boolean = true, lanAttemptSeconds: Double? = null): ConnectSession {
        if (!running) throw LanException(LanErrorReason.not_started, "Cloud Connect is not started.")
        val l = lan
        val r = this.relay
        val relayOk = r != null && relay
        var lanError: Exception? = null
        val peer = l?.peers()?.firstOrNull { it.deviceId == deviceId }
        if (l != null && peer != null) {
            val attempt = scope.async { l.connect(peer) }
            val ms = ((lanAttemptSeconds ?: lanAttempt) * 1000).toLong()
            if (withTimeoutOrNull(ms) { attempt.join() } != null) {
                try {
                    return track(attempt.await())
                } catch (e: CancellationException) {
                    if (!attempt.isCancelled) throw e
                    lanError = LanException(LanErrorReason.closed, "The LAN attempt was cancelled.")
                } catch (e: Exception) {
                    if (!relayOk) throw e
                    lanError = e
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
                lanError = LanException(LanErrorReason.connect_failed, "The LAN attempt took too long; trying the relay.")
            }
            if (!relayOk) throw lanError
        }
        if (!relayOk) {
            if (lanError != null) throw lanError
            if (r == null ||
                !relay
            ) {
                throw LanException(LanErrorReason.unknown_peer, "That device was not found on this network, and the relay is off.")
            }
            throw RelayException(RelayErrorReason.not_connected, "The relay is not connected.")
        }
        return track(r!!.dial(deviceId))
    }

    /**
     * Called with each session another device opened to this one, on either path (on a service thread).
     * Without a listener an inbound session is closed with `peer_bye` (G9). Returns the unsubscribe.
     */
    public fun onChannel(fn: (ConnectSession) -> Unit): () -> Unit {
        channelFns += fn
        return { channelFns -= fn }
    }

    /** Called when a roster or trust manifest a peer pushed is stored, applied or refused. Returns the unsubscribe. */
    public fun onNotice(fn: (ConnectNotice) -> Unit): () -> Unit {
        noticeFns += fn
        return { noticeFns -= fn }
    }

    // -- internals ---------------------------------------------------------------------------------

    private fun inbound(s: ConnectSession) {
        val subs = channelFns.toList()
        if (subs.isEmpty()) {
            scope.launch {
                try {
                    s.close() // nobody to hand it to (G9)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // already gone
                }
            }
            return
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

    private fun notice(n: ConnectNotice) {
        for (f in noticeFns.toList()) {
            try {
                f(n)
            } catch (e: Exception) {
                // a host callback never ends a notice
            }
        }
    }

    private fun track(s: ConnectSession): ConnectSession {
        synchronized(lock) { sessions += s }
        s.onClose { synchronized(lock) { sessions -= s } }
        return s
    }

    /** A trust manifest a peer pushed: the custodian verifies it, then it is persisted; refused while trust refresh is off. */
    internal suspend fun applyPeerTrust(jws: String): PeerTrustResult {
        if (!core.trustRefreshEnabled) return PeerTrustResult(false, PEER_TRUST_REFRESH_OFF)
        val r = core.acceptPeer(jws)
        if (r.applied) core.persistPeerTrust(jws)
        return r
    }
}
