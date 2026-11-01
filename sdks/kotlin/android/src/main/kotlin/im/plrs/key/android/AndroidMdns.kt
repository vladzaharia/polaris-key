// The LAN discovery adapter on Android (CC-12b.4; plans CC-12b D-1, D-5, D-6, D-7): `MdnsAdapter` over
// :platform's PeerNsd (NsdManager, API 34 and up), so the LAN service, nearby approval and (later) contact
// adverts need no mDNS code of their own here. One registration per advert, on the listener's port.
//
//   - a name is filtered by the caller's `accept` BEFORE it is watched, so a stranger's names cannot crowd out
//     a real one (PeerNsd bounds the watches at 64 and the found names at 256);
//   - each address a watch learns is judged twice before `onUp`: `lanVerdict` (private, link-local or ULA only)
//     and the subnets of the Network the service was learned on, so an address the resolver took from an
//     on-link host but that is not on this link never reaches a dial. A service with no known Network, or with
//     no acceptable address, is not reported (and is reported down if it had been);
//   - a dial uses the found network's socket factory, so it never leaves through a VPN route: a service whose
//     network is a VPN (or has no factory) is not reported, and a factory that fails ends the dial;
//   - NSD hands TXT over as a map: a repeated key cannot be seen (V5 refuses the whole advert), and a value
//     that is not UTF-8 drops the advert. This is a stated residual of the Android resolver;
//   - the OS renaming an instance (a name conflict) refuses the advert: two devices must not answer to one name.
//     After a network change the advert is registered again, and a rename then is retried with a bounded backoff;
//   - a default-network change registers the adverts again on the new network. There is no auto-pause on
//     background: the host owns the lifecycle (it stops the handle).

package im.plrs.key.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.lan.MdnsUnavailableException
import im.plrs.key.core.peer.lan.lanVerdict
import im.plrs.key.platform.NetworkSubnets
import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsd
import im.plrs.key.platform.PeerNsdHandle
import im.plrs.key.platform.PeerNsdListener
import im.plrs.key.platform.Subnet
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/** Ends an advert, a browse, a watch or a network subscription; a second call does nothing. */
internal fun interface NsdStop {
    fun stop()
}

/** What [AndroidMdns] needs of NSD: [PeerNsd]'s surface with plain handles, so a test replaces it. */
internal interface NsdPort {
    fun supported(): Boolean

    fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): NsdStop

    /** Only a name [accept] allows takes a place in the found table. */
    fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): NsdStop

    fun watch(instance: String, listener: PeerNsdListener): NsdStop
}

/** What [AndroidMdns] needs to know about a [Network]. */
internal interface NetworkPort {
    /** The connected subnets of [network]; empty when it is unknown. */
    fun subnetsOf(network: Network): List<Subnet>

    /** The factory that opens sockets on [network]. */
    fun factoryOf(network: Network): SocketFactory?

    /** True only when [network] is known not to be a VPN (the NOT_VPN capability is present). */
    fun isNotVpn(network: Network): Boolean

    /** Calls [onChange] when the default network changes (not for the one current at the start). */
    fun onDefaultNetworkChange(onChange: () -> Unit): NsdStop
}

private class PeerNsdPort(private val nsd: PeerNsd) : NsdPort {
    private fun PeerNsdHandle.asStop() = NsdStop { stop() }

    override fun supported(): Boolean = nsd.isSupported()

    override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): NsdStop =
        nsd.advertise(instance, port, txt, onResult).asStop()

    override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): NsdStop = nsd.browse(listener, accept).asStop()

    override fun watch(instance: String, listener: PeerNsdListener): NsdStop = nsd.watch(instance, listener).asStop()
}

private class ConnectivityNetworkPort(private val context: Context) : NetworkPort {
    override fun subnetsOf(network: Network): List<Subnet> = NetworkSubnets.of(context, network)

    override fun factoryOf(network: Network): SocketFactory? = network.socketFactory

    // The one call that needs ACCESS_NETWORK_STATE is behind the run-time check below, which lint cannot follow.
    @SuppressLint("MissingPermission")
    override fun isNotVpn(network: Network): Boolean {
        // The app grants ACCESS_NETWORK_STATE (the library declares none): without it the network is not known to be
        // free of a VPN, which is the answer for an unknown network.
        val granted = context.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) == PackageManager.PERMISSION_GRANTED
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val caps = if (granted) runCatching { cm?.getNetworkCapabilities(network) }.getOrNull() else null
        return caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) == true
    }

    // The library declares no permission (the app decides); a refusal is caught below. Lint cannot see that for a normal permission.
    @SuppressLint("MissingPermission")
    @Suppress("SwallowedException")
    override fun onDefaultNetworkChange(onChange: () -> Unit): NsdStop {
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return NsdStop {}
        val callback = object : ConnectivityManager.NetworkCallback() {
            private var primed = false
            private var known: Network? = null

            override fun onAvailable(network: Network) {
                val changed = synchronized(this) {
                    val c = primed && network != known
                    primed = true
                    known = network
                    c
                }
                if (changed) onChange()
            }

            override fun onLost(network: Network) {
                synchronized(this) { if (known == network) known = null }
            }
        }

        // Without the right to watch the network the adverts keep their first registration. The platform signals an
        // exhausted request budget with an unnamed RuntimeException subclass, so that is the narrowest type to catch.
        @Suppress("TooGenericExceptionCaught")
        val watching = try {
            cm.registerDefaultNetworkCallback(callback)
            true
        } catch (e: SecurityException) {
            false
        } catch (e: RuntimeException) {
            false
        }
        return NsdStop { if (watching) runCatching { cm.unregisterNetworkCallback(callback) } }
    }
}

/**
 * `_pkeypeer._tcp` discovery over the Android NSD stack. API 34 and up ([isSupported]); below that the
 * adapter is not installed, and LAN answers `unsupported` while the relay still works.
 */
public class AndroidMdns internal constructor(
    private val nsd: NsdPort,
    private val net: NetworkPort,
    private val schedule: (Long, () -> Unit) -> NsdStop = ::scheduleLater,
) : MdnsAdapter {
    public constructor(context: Context, executor: Executor = defaultExecutor()) :
        this(PeerNsdPort(PeerNsd(context, executor)), ConnectivityNetworkPort(context))

    /** True from Android 14 (API 34). */
    public fun isSupported(): Boolean = nsd.supported()

    override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
        if (!nsd.supported()) throw MdnsUnavailableException("Local-network discovery needs Android 14 or later.")
        val txt = txtMap(advert.txt) ?: throw MdnsUnavailableException("The advert's TXT entries are not valid.")
        val registration = Registration(nsd, advert.instance, advert.port, txt, schedule)
        val first = CompletableDeferred<NsdAdvertResult>()
        registration.start { first.complete(it) }
        val change = net.onDefaultNetworkChange { registration.restart() }
        val result = withTimeoutOrNull(ADVERT_WAIT_MILLIS) { first.await() }
        if (result is NsdAdvertResult.Refused) {
            change.stop()
            registration.stop()
            throw MdnsUnavailableException("The advert was refused (${result.reason}).")
        }
        return MdnsHandle {
            change.stop()
            registration.stop()
        }
    }

    override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle {
        if (!nsd.supported()) throw MdnsUnavailableException("Local-network discovery needs Android 14 or later.")
        val browser = Browser(nsd, net, onUp, onDown, accept)
        browser.start()
        return MdnsHandle { browser.stop() }
    }

    /**
     * One advert: its registration, again after a network change, withdrawn on [stop]. The first result goes to
     * [start]'s callback; after that a refusal (the OS renamed the instance while the old name was still held)
     * is retried with a growing delay, at most [MAX_RETRIES] times until the next network change.
     */
    private class Registration(
        private val nsd: NsdPort,
        private val instance: String,
        private val port: Int,
        private val txt: Map<String, ByteArray>,
        private val schedule: (Long, () -> Unit) -> NsdStop,
    ) {
        private var stop: NsdStop? = null
        private var pending: NsdStop? = null
        private var stopped = false
        private var report: ((NsdAdvertResult) -> Unit)? = null
        private var generation = 0
        private var reported = false
        private var attempts = 0

        fun start(onResult: (NsdAdvertResult) -> Unit) {
            report = onResult
            register()
        }

        private fun register() {
            val gen = synchronized(this) { ++generation }
            val s = nsd.advertise(instance, port, txt) { result(gen, it) }
            val late = synchronized(this) {
                if (stopped) {
                    true
                } else {
                    stop = s
                    false
                }
            }
            if (late) s.stop()
        }

        private fun result(gen: Int, r: NsdAdvertResult) {
            // 0: nothing, 1: the first result, 2: a refusal to retry.
            val action = synchronized(this) {
                when {
                    stopped || gen != generation -> 0
                    !reported -> 1.also { reported = true }
                    r is NsdAdvertResult.Refused -> 2
                    else -> 0.also { attempts = 0 }
                }
            }
            when (action) {
                1 -> report?.invoke(r)
                2 -> retryLater()
            }
        }

        private fun retryLater() {
            val delay = synchronized(this) {
                if (stopped || attempts >= MAX_RETRIES) null else (RETRY_BASE_MILLIS shl attempts++).coerceAtMost(RETRY_MAX_MILLIS)
            }
            if (delay != null) {
                val h = schedule(delay) { again() }
                val late = synchronized(this) {
                    if (stopped) {
                        true
                    } else {
                        pending = h
                        false
                    }
                }
                if (late) h.stop()
            }
        }

        private fun again() {
            val old = synchronized(this) { if (stopped) return else stop.also { stop = null } }
            old?.stop()
            register()
        }

        fun restart() {
            val (old, wait) = synchronized(this) {
                if (stopped) return
                attempts = 0
                stop.also { stop = null } to pending.also { pending = null }
            }
            wait?.stop()
            old?.stop()
            register()
        }

        fun stop() {
            val (old, wait) = synchronized(this) {
                if (stopped) return
                stopped = true
                stop.also { stop = null } to pending.also { pending = null }
            }
            wait?.stop()
            old?.stop()
        }
    }

    /** One browse: the names it watches, and which of them are reported up. */
    private class Browser(
        private val nsd: NsdPort,
        private val net: NetworkPort,
        private val onUp: (MdnsFound) -> Unit,
        private val onDown: (String) -> Unit,
        private val accept: (String) -> Boolean,
    ) {
        private val lock = Any()
        private val watches = HashMap<String, NsdStop>()
        private val up = HashSet<String>()
        private var browse: NsdStop? = null
        private var stopped = false

        fun start() {
            // The name is judged inside the found table's gate, so a stranger's names never fill it.
            val b = nsd.browse(
                object : PeerNsdListener {
                    override fun onFound(instance: String) = watch(instance)

                    override fun onLost(instance: String) = drop(instance)
                },
                accept,
            )
            val late = synchronized(lock) {
                if (stopped) {
                    true
                } else {
                    browse = b
                    false
                }
            }
            if (late) b.stop()
        }

        private fun watch(instance: String) {
            // The name is judged before anything is kept for it.
            if (!accept(instance)) return
            val admitted = synchronized(lock) { !stopped && instance !in watches }
            if (!admitted) return
            val w = nsd.watch(
                instance,
                object : PeerNsdListener {
                    override fun onResolved(resolved: NsdResolved) = publish(resolved)

                    override fun onLost(instance: String) = drop(instance)

                    override fun onFailed(reason: String) = drop(instance)
                },
            )
            val late = synchronized(lock) {
                if (stopped || instance in watches) {
                    true
                } else {
                    watches[instance] = w
                    false
                }
            }
            if (late) w.stop()
        }

        private fun publish(r: NsdResolved) {
            val found = found(r)
            if (found != null) {
                val live = synchronized(lock) {
                    if (stopped) {
                        false
                    } else {
                        up += r.instance
                        true
                    }
                }
                if (live) onUp(found)
            } else {
                val was = synchronized(lock) { up.remove(r.instance) }
                if (was) onDown(r.instance)
            }
        }

        private fun found(r: NsdResolved): MdnsFound? {
            // A VPN is not a LAN, and a network with no socket factory cannot be dialled without leaving it.
            val network = r.network?.takeIf { net.isNotVpn(it) && r.port in 1..MAX_PORT }
            val factory = network?.let { net.factoryOf(it) }
            val hosts = if (network == null) emptyList() else onLink(r.addresses, net.subnetsOf(network))
            val txt = txtList(r.attributes)
            return if (factory == null || hosts.isEmpty() || txt == null) null else MdnsFound(r.instance, hosts[0], r.port, txt, hosts, factory)
        }

        // A global IPv6 address has no local address to be compared with here, so it is refused.
        private fun onLink(addresses: List<String>, subnets: List<Subnet>): List<String> =
            addresses.filter { lanVerdict(it, null, false).dial && NetworkSubnets.any(subnets, it) }.take(PeerNsd.MAX_ADDRESSES)

        private fun drop(instance: String) {
            val (w, was) = synchronized(lock) { watches.remove(instance) to up.remove(instance) }
            w?.stop()
            if (was) onDown(instance)
        }

        fun stop() {
            val (b, ws) = synchronized(lock) {
                if (stopped) return
                stopped = true
                val ws = watches.values.toList()
                watches.clear()
                up.clear()
                browse.also { browse = null } to ws
            }
            b?.stop()
            for (w in ws) w.stop()
        }
    }

    internal companion object {
        const val ADVERT_WAIT_MILLIS: Long = 5_000
        private const val MAX_PORT = 65535
        private const val IDLE_SECONDS = 30L
        const val MAX_RETRIES = 5
        const val RETRY_BASE_MILLIS = 1_000L
        const val RETRY_MAX_MILLIS = 30_000L

        private val timer by lazy {
            java.util.concurrent.ScheduledThreadPoolExecutor(1) { r -> Thread(r, "pkey-mdns-retry").apply { isDaemon = true } }
                .apply { removeOnCancelPolicy = true }
        }

        /** Runs [task] once after [delayMillis]; the handle cancels it. */
        fun scheduleLater(delayMillis: Long, task: () -> Unit): NsdStop {
            val f = timer.schedule({ runCatching { task() } }, delayMillis, TimeUnit.MILLISECONDS)
            return NsdStop { f.cancel(false) }
        }

        /** One thread, in order, that lets go after 30 idle seconds. */
        fun defaultExecutor(): Executor = ThreadPoolExecutor(1, 1, IDLE_SECONDS, TimeUnit.SECONDS, LinkedBlockingQueue()) { r ->
            Thread(r, "pkey-mdns").apply { isDaemon = true }
        }.apply { allowCoreThreadTimeOut(true) }

        /** `key=value` entries as the map NSD wants; null for an entry with no key or a repeated key. */
        fun txtMap(entries: List<String>): Map<String, ByteArray>? {
            val out = LinkedHashMap<String, ByteArray>()
            val ok = entries.all { e ->
                val i = e.indexOf('=')
                val key = if (i < 0) e else e.substring(0, i)
                val fresh = key.isNotEmpty() && key !in out
                if (fresh) out[key] = if (i < 0) ByteArray(0) else e.substring(i + 1).toByteArray(Charsets.UTF_8)
                fresh
            }
            return if (ok) out else null
        }

        private fun utf8(v: ByteArray): String? = runCatching {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(v))
                .toString()
        }.getOrNull()

        /** The map back to `key=value` entries; null when a value is not UTF-8 (the advert is dropped). */
        fun txtList(attributes: Map<String, ByteArray?>): List<String>? {
            val out = attributes.map { (k, v) -> if (v == null) k else utf8(v)?.let { "$k=$it" } }
            return if (out.any { it == null }) null else out.filterNotNull()
        }
    }
}
