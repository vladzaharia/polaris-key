package im.plrs.key.platform

import android.annotation.SuppressLint
import android.content.Context
import android.net.Network
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.util.concurrent.Executor

/** What `advertise` reports: the name was registered as asked, or the advert was refused. */
public sealed class NsdAdvertResult {
    public data object Registered : NsdAdvertResult()

    /** [reason] is `renamed` (the OS changed the instance name, a conflict) or `failed`. */
    public data class Refused(val reason: String) : NsdAdvertResult()
}

/**
 * A resolved service. [addresses] are text literals in first-seen order, at most [PeerNsd.MAX_ADDRESSES];
 * a link-local IPv6 one carries its `%zone`. [attributes] is what the OS hands over: a map, so a repeated
 * TXT key cannot be seen here. [network] is the network the service was learned on, null when unknown.
 */
public class NsdResolved(
    public val instance: String,
    public val addresses: List<String>,
    public val port: Int,
    public val attributes: Map<String, ByteArray?>,
    public val network: Network?,
) {
    override fun toString(): String = "NsdResolved(port=$port, addresses=${addresses.size})"
}

/** Callbacks of [PeerNsd.browse] and [PeerNsd.watch]; they run on the executor given to [PeerNsd]. */
public interface PeerNsdListener {
    public fun onFound(instance: String) {}

    public fun onLost(instance: String) {}

    public fun onResolved(resolved: NsdResolved) {}

    /** A watch or a browse could not start or was ended by the OS. */
    public fun onFailed(reason: String) {}
}

/** Ends an advert, a browse or a watch; a second call does nothing. */
public class PeerNsdHandle internal constructor(private val stopper: () -> Unit) {
    private var done = false

    public fun stop() {
        synchronized(this) {
            if (done) return
            done = true
        }
        stopper()
    }
}

/** What the OS offers, in plain types: the seam a test replaces. Tokens are opaque. */
internal interface NsdApi {
    fun register(instance: String, type: String, port: Int, txt: Map<String, ByteArray>, onResult: (String?) -> Unit): Any

    fun unregister(token: Any)

    fun discover(type: String, onFound: (String) -> Unit, onLost: (String) -> Unit, onFailed: (String) -> Unit): Any

    fun stopDiscovery(token: Any)

    fun watch(instance: String, type: String, executor: Executor, onResolved: (NsdResolved) -> Unit, onLost: () -> Unit, onFailed: (String) -> Unit): Any

    fun unwatch(token: Any)
}

/**
 * Multicast DNS service discovery for `_pkeypeer._tcp` over Android's NsdManager (CC-12b.1). It needs API 34
 * (`registerServiceInfoCallback`, `getHostAddresses`); below that [isSupported] is false and nothing here
 * is called. Standalone: plain types, no coroutines, no SDK module. It decides nothing about which
 * address may be dialled; the caller judges each one.
 *
 * Bounds: [MAX_WATCHED] watched names, [MAX_FOUND] found names, [MAX_ADDRESSES] addresses per name.
 */
public class PeerNsd internal constructor(private val api: NsdApi, private val executor: Executor, private val sdkInt: Int) {
    public constructor(context: Context, executor: Executor) : this(RealNsdApi(context), executor, Build.VERSION.SDK_INT)

    private val lock = Any()
    private val watched = HashSet<String>()

    /** True from Android 14 (API 34). */
    public fun isSupported(): Boolean = sdkInt >= MIN_SDK

    /**
     * Publish [instance] on [port] with [txt]. [onResult] runs once. If the OS renames the instance the
     * advert is withdrawn and [NsdAdvertResult.Refused] is reported: two devices must not answer to one name.
     */
    public fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): PeerNsdHandle {
        check(isSupported()) { "unsupported" }
        require(port in 1..65535) { "port" }
        var token: Any? = null
        var stopped = false
        var withdrawn = false
        val lockObj = Any()
        val t = api.register(instance, SERVICE_TYPE, port, txt) { actual ->
            executor.execute {
                when {
                    actual == null -> onResult(NsdAdvertResult.Refused("failed"))
                    actual != instance -> {
                        // The token may not be set yet when the OS answers at once; then it is withdrawn below.
                        val tk = synchronized(lockObj) { withdrawn = true; token }
                        if (tk != null) runCatching { api.unregister(tk) }
                        onResult(NsdAdvertResult.Refused("renamed"))
                    }
                    else -> onResult(NsdAdvertResult.Registered)
                }
            }
        }
        val late = synchronized(lockObj) { token = t; withdrawn }
        if (late) runCatching { api.unregister(t) }
        return PeerNsdHandle {
            val tk = synchronized(lockObj) { if (stopped) null else token.also { stopped = true } }
            if (tk != null) runCatching { api.unregister(tk) }
        }
    }

    /**
     * Report each service name that appears or goes; the first [MAX_FOUND] names are tracked. A name
     * [accept] refuses is dropped before it takes a slot, so names a caller does not know cannot crowd out
     * the ones it does.
     */
    public fun browse(listener: PeerNsdListener, accept: (String) -> Boolean = { true }): PeerNsdHandle {
        check(isSupported()) { "unsupported" }
        val found = HashSet<String>()
        val token = api.discover(
            SERVICE_TYPE,
            onFound = { name ->
                val fresh = accept(name) && synchronized(found) { found.size < MAX_FOUND && found.add(name) }
                if (fresh) executor.execute { listener.onFound(name) }
            },
            onLost = { name ->
                val was = synchronized(found) { found.remove(name) }
                if (was) executor.execute { listener.onLost(name) }
            },
            onFailed = { why -> executor.execute { listener.onFailed(why) } },
        )
        return PeerNsdHandle { runCatching { api.stopDiscovery(token) } }
    }

    /**
     * Watch one found [instance]: [PeerNsdListener.onResolved] for each update (addresses, port, attributes,
     * network), [PeerNsdListener.onLost] when it goes. At most [MAX_WATCHED] names at once; a further one
     * gets [PeerNsdListener.onFailed] with `limit`.
     */
    public fun watch(instance: String, listener: PeerNsdListener): PeerNsdHandle {
        check(isSupported()) { "unsupported" }
        val admitted = synchronized(lock) { watched.size < MAX_WATCHED && watched.add(instance) }
        if (!admitted) {
            executor.execute { listener.onFailed("limit") }
            return PeerNsdHandle {}
        }
        val token = api.watch(
            instance,
            SERVICE_TYPE,
            executor,
            onResolved = { listener.onResolved(it) },
            onLost = { listener.onLost(instance) },
            onFailed = { why -> listener.onFailed(why) },
        )
        return PeerNsdHandle {
            synchronized(lock) { watched.remove(instance) }
            runCatching { api.unwatch(token) }
        }
    }

    public companion object {
        public const val MIN_SDK: Int = 34
        public const val SERVICE_TYPE: String = "_pkeypeer._tcp"
        public const val MAX_WATCHED: Int = 64
        public const val MAX_FOUND: Int = 256
        public const val MAX_ADDRESSES: Int = 4
    }
}

/** The NsdManager-backed [NsdApi]. Only built on a device; its calls need API 34 and are guarded by [PeerNsd.isSupported]. */
private class RealNsdApi(context: Context) : NsdApi {
    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager

    private fun bare(type: String?): String = type.orEmpty().trimEnd('.')

    override fun register(instance: String, type: String, port: Int, txt: Map<String, ByteArray>, onResult: (String?) -> Unit): Any {
        val info = NsdServiceInfo().apply {
            serviceName = instance
            serviceType = type
            this.port = port
            for ((k, v) in txt) setAttribute(k, String(v, Charsets.UTF_8))
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = onResult(info.serviceName)

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) = onResult(null)

            override fun onServiceUnregistered(info: NsdServiceInfo) {}

            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        return listener
    }

    override fun unregister(token: Any) = nsd.unregisterService(token as NsdManager.RegistrationListener)

    override fun discover(type: String, onFound: (String) -> Unit, onLost: (String) -> Unit, onFailed: (String) -> Unit): Any {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}

            override fun onServiceFound(info: NsdServiceInfo) {
                if (bare(info.serviceType) == type) onFound(info.serviceName)
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                if (bare(info.serviceType) == type) onLost(info.serviceName)
            }

            override fun onDiscoveryStopped(serviceType: String) {}

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = onFailed("discovery_$errorCode")

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
        return listener
    }

    override fun stopDiscovery(token: Any) = nsd.stopServiceDiscovery(token as NsdManager.DiscoveryListener)

    // Only reached through PeerNsd.watch, which refuses below MIN_SDK (API 34).
    @SuppressLint("NewApi")
    override fun watch(
        instance: String,
        type: String,
        executor: Executor,
        onResolved: (NsdResolved) -> Unit,
        onLost: () -> Unit,
        onFailed: (String) -> Unit,
    ): Any {
        val info = NsdServiceInfo().apply {
            serviceName = instance
            serviceType = type
        }
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = onFailed("watch_$errorCode")

            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                // Every address the OS knows, the dialable kinds first, so the cut at MAX_ADDRESSES drops
                // the link-local ones (which need a zone) and never the IPv4 one.
                val addresses = candidateAddresses(serviceInfo.hostAddresses)
                onResolved(NsdResolved(instance, addresses, serviceInfo.port, serviceInfo.attributes, serviceInfo.network))
            }

            override fun onServiceLost() = onLost()

            override fun onServiceInfoCallbackUnregistered() {}
        }
        nsd.registerServiceInfoCallback(info, executor, callback)
        return callback
    }

    @SuppressLint("NewApi")
    override fun unwatch(token: Any) = nsd.unregisterServiceInfoCallback(token as NsdManager.ServiceInfoCallback)
}

/**
 * The address texts a watch reports: the ones [lanCandidate] allows, IPv4 first, then at most
 * [PeerNsd.MAX_ADDRESSES]. The policy comes before the cut, so a refused address never takes a usable one's place.
 */
internal fun candidateAddresses(all: List<InetAddress>): List<String> {
    val ordered = orderAddresses(all.filter { lanCandidate(it) })
    return ordered.map { a ->
        val text = a.hostAddress.orEmpty()
        // A link-local IPv6 address keeps the zone the OS gave it; Inet6Address prints it.
        if (a is Inet6Address && !text.contains('%') && a.scopeId != 0) "$text%${a.scopeId}" else text
    }.filter { it.isNotEmpty() }.distinct().take(PeerNsd.MAX_ADDRESSES)
}

/** [addresses] with IPv4 first, then IPv6 that is not link-local, then link-local (a stable sort). */
internal fun orderAddresses(a: List<InetAddress>): List<InetAddress> = a.sortedBy { rank(it) }

private fun rank(a: InetAddress): Int = when {
    a is Inet4Address -> 0
    a.isLinkLocalAddress -> 2
    else -> 1
}

/**
 * Whether the LAN address policy could let [a] through: private IPv4 (10/8, 172.16/12, 192.168/16),
 * IPv6 link-local or unique-local. This is the LAN rule (section 15.4.1) with no local address known:
 * global unicast needs a local address in the same /64, which a resolved service does not give, so it is
 * refused here as in every other SDK. Everything else (global IPv6, carrier-grade NAT, IPv4 link-local,
 * public IPv4, loopback, multicast) is dropped before the cut at
 * [PeerNsd.MAX_ADDRESSES], so a refused address never takes the place of a usable one.
 */
internal fun lanCandidate(a: InetAddress): Boolean {
    val b = a.address.map { it.toInt() and 0xff }
    if (a is Inet4Address) return b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168)
    if (a !is Inet6Address) return false
    val g0 = (b[0] shl 8) or b[1]
    return (g0 and 0xffc0) == 0xfe80 || (g0 and 0xfe00) == 0xfc00
}
