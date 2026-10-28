// WIRE-CONTRACT-V5 section 15.4, G5: the JVM mDNS adapter (CC-12.11). Our own bounded codec and one
// `MulticastSocket` on 5353 (decision D-1: no new dependency). Mirrors sdk-node's `connect/mdns.ts`
// and the Python `MulticastDnsAdapter`.
//
// Rules this file keeps:
// - the host name in the advert is the instance name (`p1-....local`), never the machine's name;
// - a browse hit is dropped unless its instance name has the advert shape, it names exactly one SRV
//   and one TXT, and it has an address in a private (or, opt-in, loopback) range;
// - an A record is believed only when its address is the packet's own UDP source, so a neighbour cannot
//   point another device's name at an address of its choosing; each name keeps at most four addresses
//   and the first one seen is dialled (no ordering a neighbour can steer);
// - the tables of instances and addresses hold at most 256 entries each, an entry expires five minutes
//   after it was last refreshed, and when a table is full the least recently refreshed entry is
//   evicted, so a flood cannot stop discovery;
// - query replies go out at most once a second; the packet parser's own limits live in the codec.
//
// The socket is IPv4 only. It is bound with address reuse and joins 224.0.0.251 on every interface
// that is up, multicast-capable, not loopback, and has a private IPv4 address; `interfaces` (the
// `lan.interfaces` option) names the addresses to use instead.

package im.plrs.key.core.peer.lan

import im.plrs.key.core.peer.isInstanceName
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

public const val MDNS_GROUP: String = "224.0.0.251"
public const val MDNS_PORT: Int = 5353

/** Instances and addresses held. */
public const val MDNS_MAX_INSTANCES: Int = 256

/** Addresses kept per host name. */
public const val MDNS_MAX_ADDRS: Int = 4

/** Seconds a learned record is believed after it was last refreshed. */
public const val MDNS_ENTRY_TTL_SECONDS: Double = 5 * 60.0

private const val REPLY_GAP_SECONDS = 1.0
private const val TTL = 120L
private const val TXT_TTL = 4500L
private const val ASK_QUESTIONS = 32
private const val AGAIN_MILLIS = 1000L
private const val ASK_EVERY_MILLIS = 30_000L
private const val MULTICAST_TTL = 255
private const val RECEIVE_BUFFER = MDNS_MAX_PACKET + 1
private val INSTANCE_FQDN = Regex("(p1-[a-z2-7]{16})\\._pkeypeer\\._tcp\\.local")

private class Entry(var at: Double) {
    var port: Int? = null
    var target: String? = null
    var txt: List<String>? = null
    var up: String? = null
}

private class Addrs(var at: Double) {
    val ips = ArrayList<String>()
}

private fun fqdn(instance: String) = "$instance.$PEER_SERVICE"

private fun hostOf(instance: String) = "$instance.local"

/** The IPv4 addresses of the interfaces mDNS would use: up, multicast-capable, private (not loopback unless allowed). */
public fun lanInterfaces(allowLoopback: Boolean = false): List<Pair<NetworkInterface, String>> {
    val out = ArrayList<Pair<NetworkInterface, String>>()
    val all = try {
        NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    } catch (e: IOException) {
        emptyList()
    }
    for (ni in all) {
        val ok = try {
            ni.isUp && ni.supportsMulticast() && (allowLoopback || !ni.isLoopback)
        } catch (e: IOException) {
            false
        }
        if (!ok) continue
        for (a in ni.inetAddresses) {
            val ip = (a as? Inet4Address)?.hostAddress ?: continue
            if (isLanAddress(ip, allowLoopback)) out += ni to ip
        }
    }
    return out
}

/** The real socket: one `MulticastSocket` on 5353, joined to the group on each interface, read on a daemon thread. */
private class JvmMdnsSocket(private val sock: MulticastSocket, private val ifaces: List<NetworkInterface>) : MdnsSocket {
    @Volatile
    private var closed = false

    fun startReader(onPacket: (ByteArray, String) -> Unit) {
        val t = Thread {
            val buf = ByteArray(RECEIVE_BUFFER)
            while (!closed) {
                try {
                    val p = DatagramPacket(buf, buf.size)
                    sock.receive(p)
                    val src = p.address?.hostAddress ?: continue
                    try {
                        onPacket(p.data.copyOfRange(p.offset, p.offset + p.length), src)
                    } catch (e: Exception) {
                        // a bad packet or a host callback never stops the socket
                    }
                } catch (e: IOException) {
                    if (closed) break
                }
            }
        }
        t.isDaemon = true
        t.name = "polaris-key-mdns"
        t.start()
    }

    override fun send(data: ByteArray) {
        if (closed) return
        val dest = InetSocketAddress(InetAddress.getByName(MDNS_GROUP), MDNS_PORT)
        val targets: List<NetworkInterface?> = ifaces.ifEmpty { listOf(null) }
        for (ni in targets) {
            try {
                if (ni != null) sock.networkInterface = ni
                sock.send(DatagramPacket(data, data.size, dest))
            } catch (e: IOException) {
                continue
            }
        }
    }

    override fun close() {
        closed = true
        sock.close()
    }
}

/**
 * The adapter. [create] makes a socket (default: the real one). [interfaces] are the IPv4 addresses of
 * the networks to use; without them every up, multicast-capable, private interface is used. [addresses]
 * are the addresses to put in an advert (default: those of the chosen interfaces). [allowLoopback]
 * accepts (and advertises) 127.0.0.0/8, for tests and same-host peers only. [clock] is monotonic seconds.
 */
public class JvmMdns(
    private val scope: CoroutineScope,
    private val create: MdnsSocketFactory? = null,
    private val addresses: (() -> List<String>)? = null,
    private val allowLoopback: Boolean = false,
    private val interfaces: List<String>? = null,
    private val clock: () -> Double = { System.nanoTime() / 1e9 },
) : MdnsAdapter {
    override fun toString(): String = "JvmMdns"

    private fun own(): List<String> {
        val found = addresses?.invoke() ?: interfaces ?: lanInterfaces(allowLoopback).map { it.second }
        return found.filter { isLanAddress(it, allowLoopback) }.distinct()
    }

    private fun selectedInterfaces(): List<NetworkInterface> {
        val wanted = interfaces
        val pairs = lanInterfaces(allowLoopback)
        return if (wanted != null) {
            wanted.mapNotNull { ip -> pairs.firstOrNull { it.second == ip }?.first ?: byAddress(ip) }.distinct()
        } else {
            pairs.map { it.first }.distinct()
        }
    }

    private fun byAddress(ip: String): NetworkInterface? = try {
        NetworkInterface.getByInetAddress(InetAddress.getByName(ip))
    } catch (e: IOException) {
        null
    }

    private suspend fun openSocket(onPacket: (ByteArray, String) -> Unit): MdnsSocket {
        create?.let { return it.open(onPacket) }
        val ifaces = selectedInterfaces()
        val sock = try {
            MulticastSocket(null as InetSocketAddress?).also {
                it.reuseAddress = true
                it.bind(InetSocketAddress(MDNS_PORT))
                it.timeToLive = MULTICAST_TTL
                val group = InetSocketAddress(InetAddress.getByName(MDNS_GROUP), MDNS_PORT)
                var joined = 0
                for (ni in ifaces) {
                    try {
                        it.joinGroup(group, ni)
                        joined++
                    } catch (e: IOException) {
                        continue
                    }
                }
                if (joined == 0 && interfaces == null) it.joinGroup(group, null)
            }
        } catch (e: IOException) {
            throw MdnsUnavailableException("The mDNS socket could not be opened; LAN discovery is off.", e)
        }
        return JvmMdnsSocket(sock, ifaces).also { it.startReader(onPacket) }
    }

    // -- advertise -------------------------------------------------------------------------------

    override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
        require(isInstanceName(advert.instance)) { "instance name" }
        require(advert.port in 1..MAX_PORT) { "port" }
        val addrs = own()
        val fq = fqdn(advert.instance)
        val host = hostOf(advert.instance)
        val txt = advert.txt.toList()
        val lock = Any()
        var lastReply = Double.NEGATIVE_INFINITY
        var closed = false
        var sock: MdnsSocket? = null

        fun records(ttl: Long): List<MdnsRecord> = buildList {
            add(MdnsRecord(PEER_SERVICE, MdnsType.PTR, ttl, MdnsData.Ptr(fq)))
            add(MdnsRecord(fq, MdnsType.SRV, ttl, MdnsData.Srv(advert.port, host, 0, 0)))
            add(MdnsRecord(fq, MdnsType.TXT, if (ttl == 0L) 0 else TXT_TTL, MdnsData.Txt(txt)))
            for (ip in addrs) add(MdnsRecord(host, MdnsType.A, ttl, MdnsData.Address(ip)))
        }

        fun sendRecords(ttl: Long) {
            val s = synchronized(lock) { if (closed) null else sock } ?: return
            if (addrs.isEmpty()) return
            try {
                s.send(buildMdnsResponse(records(ttl)))
            } catch (e: IllegalArgumentException) {
                // an advert that cannot be built is not sent
            } catch (e: IOException) {
                // the network is gone for now
            }
        }

        val names = setOf(PEER_SERVICE, fq, host)
        val opened = openSocket { data, _ ->
            val p = try {
                parseMdnsPacket(data)
            } catch (e: MdnsPacketError) {
                null
            }
            if (p != null && !p.isResponse && p.questions.any { it.name in names }) {
                val t = clock()
                val reply = synchronized(lock) {
                    if (closed || t - lastReply < REPLY_GAP_SECONDS) {
                        false
                    } else {
                        lastReply = t
                        true
                    }
                }
                if (reply) sendRecords(TTL)
            }
        }
        synchronized(lock) { sock = opened }
        sendRecords(TTL)
        val again: Job = scope.launch {
            delay(AGAIN_MILLIS)
            sendRecords(TTL)
        }
        return MdnsHandle {
            again.cancel()
            sendRecords(0)
            synchronized(lock) { closed = true }
            opened.close()
        }
    }

    // -- browse ----------------------------------------------------------------------------------

    private class Browse(val onUp: (MdnsFound) -> Unit, val onDown: (String) -> Unit) {
        val lock = Any()
        val seen = LinkedHashMap<String, Entry>()
        val addr = LinkedHashMap<String, Addrs>()
        var sock: MdnsSocket? = null
        var closed = false
        val jobs = ArrayList<Job>()
    }

    override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit): MdnsHandle {
        val b = Browse(onUp, onDown)
        b.sock = openSocket { data, src -> onPacket(b, data, src) }
        ask(b)
        b.jobs += scope.launch {
            delay(AGAIN_MILLIS)
            ask(b)
        }
        b.jobs += scope.launch {
            while (true) {
                delay(ASK_EVERY_MILLIS)
                ask(b)
            }
        }
        return MdnsHandle {
            val s = synchronized(b.lock) {
                b.closed = true
                b.sock
            }
            b.jobs.forEach { it.cancel() }
            s?.close()
        }
    }

    private fun onPacket(b: Browse, data: ByteArray, src: String) {
        val p = try {
            parseMdnsPacket(data)
        } catch (e: MdnsPacketError) {
            return
        }
        if (!p.isResponse) return
        val ups = ArrayList<MdnsFound>()
        val downs = ArrayList<String>()
        synchronized(b.lock) {
            if (b.closed) return
            learn(b, p.answers, src, ups, downs)
        }
        for (d in downs) safely { b.onDown(d) }
        for (u in ups) safely { b.onUp(u) }
    }

    private inline fun safely(f: () -> Unit) {
        try {
            f()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // a host callback never stops discovery
        }
    }

    private fun trimSeen(b: Browse, now: Double, downs: MutableList<String>) {
        val it = b.seen.entries.iterator()
        while (it.hasNext()) {
            val (k, v) = it.next()
            if (now - v.at > MDNS_ENTRY_TTL_SECONDS) {
                it.remove()
                if (v.up != null) downs += k
            }
        }
        while (b.seen.size >= MDNS_MAX_INSTANCES) {
            val first = b.seen.entries.first()
            b.seen.remove(first.key)
            if (first.value.up != null) downs += first.key
        }
    }

    private fun trimAddr(b: Browse, now: Double) {
        b.addr.entries.removeAll { now - it.value.at > MDNS_ENTRY_TTL_SECONDS }
        while (b.addr.size >= MDNS_MAX_INSTANCES) b.addr.remove(b.addr.keys.first())
    }

    private fun learnA(b: Browse, r: MdnsRecord, src: String, now: Double) {
        // Only the sender's own address, and only a LAN one.
        val ip = (r.data as? MdnsData.Address)?.ip ?: return
        if (ip != src || !isLanAddress(ip, allowLoopback)) return
        val e = b.addr.remove(r.name) ?: run {
            if (b.addr.size >= MDNS_MAX_INSTANCES) trimAddr(b, now)
            Addrs(now)
        }
        if (ip !in e.ips && e.ips.size < MDNS_MAX_ADDRS) e.ips += ip
        e.at = now
        b.addr[r.name] = e // most recently refreshed last
    }

    private fun learn(b: Browse, records: List<MdnsRecord>, src: String, ups: MutableList<MdnsFound>, downs: MutableList<String>) {
        val now = clock()
        for (r in records) {
            if (r.type == MdnsType.A) {
                learnA(b, r, src, now)
                continue
            }
            val ptr = r.data as? MdnsData.Ptr
            val name = if (r.type == MdnsType.PTR) ptr?.name else r.name
            val inst = name?.let { INSTANCE_FQDN.matchEntire(it)?.groupValues?.get(1) } ?: continue
            if (r.type == MdnsType.PTR && r.name != PEER_SERVICE) continue
            if (r.type == MdnsType.PTR && r.ttl == 0L) {
                if (b.seen.remove(inst) != null) downs += inst
                continue
            }
            val e = b.seen.remove(inst) ?: run {
                if (b.seen.size >= MDNS_MAX_INSTANCES) trimSeen(b, now, downs)
                Entry(now)
            }
            e.at = now
            b.seen[inst] = e
            when (val d = r.data) {
                is MdnsData.Srv -> {
                    if (d.port !in 1..MAX_PORT) continue
                    e.port = d.port
                    // Only our own host name shape: the target is the instance's `.local` name.
                    if (d.target == hostOf(inst)) e.target = d.target
                }

                is MdnsData.Txt -> e.txt = d.entries.toList()

                else -> Unit
            }
        }
        for ((inst, e) in b.seen) {
            val ips = e.target?.let { b.addr[it]?.ips }
            val port = e.port
            val txt = e.txt
            if (port == null || txt == null || ips.isNullOrEmpty()) continue
            val host = ips[0]
            val sig = "$host|$port|${txt.joinToString("\n")}"
            if (e.up == sig) continue
            e.up = sig
            ups += MdnsFound(inst, host, port, txt.toList())
        }
    }

    private fun ask(b: Browse) {
        val downs = ArrayList<String>()
        val packet: ByteArray
        val s: MdnsSocket
        synchronized(b.lock) {
            s = b.sock ?: return
            if (b.closed) return
            val now = clock()
            val it = b.seen.entries.iterator()
            while (it.hasNext()) {
                val (k, v) = it.next()
                if (now - v.at > MDNS_ENTRY_TTL_SECONDS) {
                    it.remove()
                    if (v.up != null) downs += k
                }
            }
            b.addr.entries.removeAll { now - it.value.at > MDNS_ENTRY_TTL_SECONDS }
            val qs = ArrayList<MdnsQuestion>()
            qs += MdnsQuestion(PEER_SERVICE, MdnsType.PTR)
            for ((inst, e) in b.seen) {
                if (e.up == null) {
                    qs += MdnsQuestion(fqdn(inst), MdnsType.SRV)
                    qs += MdnsQuestion(fqdn(inst), MdnsType.TXT)
                    qs += MdnsQuestion(hostOf(inst), MdnsType.A)
                }
            }
            packet = buildMdnsQuery(qs.take(ASK_QUESTIONS))
        }
        for (d in downs) safely { b.onDown(d) }
        try {
            s.send(packet)
        } catch (e: IOException) {
            // the network is gone for now
        }
    }

    private companion object {
        const val MAX_PORT = 65535
    }
}
