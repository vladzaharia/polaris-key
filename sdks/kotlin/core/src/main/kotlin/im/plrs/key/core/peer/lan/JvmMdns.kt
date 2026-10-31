// WIRE-CONTRACT-V5 section 15.4, G5: the JVM mDNS adapter (CC-12.11). Our own bounded codec and one
// `MulticastSocket` on 5353 (decision D-1: no new dependency). Mirrors sdk-node's `connect/mdns.ts`
// and the Python `MulticastDnsAdapter`.
//
// Rules this file keeps:
// - the host name in the advert is the instance name (`p1-....local`), never the machine's name;
// - a browse hit is dropped unless its instance name has the advert shape and it names exactly one SRV
//   and one TXT;
// - a response is ignored, before it is parsed, unless its source is inside a connected subnet of the
//   interfaces in use (RFC 6762 section 11; a link-local IPv6 source is on-link by definition). The
//   JVM does not say which interface an IPv4 or global IPv6 datagram arrived on, so the subnets of all
//   the interfaces in use count (tunnel and point-to-point interfaces do not): a source on another
//   connected subnet passes, which costs at most one blind connect, never a trusted address. A
//   link-local source carries its arrival interface as the zone (the kernel reports it with the
//   source, and the JVM turns it into the scoped address); one with no zone, or a zone that is not a
//   link in use, is dropped and teaches nothing;
// - no source owns a name: the PTR, SRV, TXT and address records of a held name from another source are
//   judged by the rules here, and the addresses are dialled in first-seen order;
// - only an instance the service accepts (a name its roster can announce) enters the tables, for the
//   PTR, SRV, TXT and address records alike. Names compare by ASCII fold and are held in lower case;
// - an SRV record is believed only with a port from 1024 to 65535 and the instance's own `.local` as
//   its target;
// - a response sent to a unicast address (not to the multicast group) cannot be told apart here:
//   `DatagramPacket` does not report the destination of a datagram, and the socket is not bound to
//   the group because it serves both families (so it is not portable to Windows). Such a response is
//   judged like any other; the residual is a unicast response that passes every test above;
// - an A or AAAA record is believed only when its address is the packet's own UDP source (an
//   IPv4-mapped source counts as its IPv4 address), so a neighbour cannot point another device's name
//   at an address of its choosing; there is no address filter when it is learned, the dial-time
//   `lanVerdict` decides what is dialled. A record with TTL 0 removes its address. Each name keeps at
//   most four addresses in the order they were first seen ([MdnsAddressBook], 15.4 Addresses);
// - the tables of instances and addresses hold at most 256 entries each, an entry expires five
//   minutes after it was last refreshed, and when a table is full the least recently refreshed entry
//   is evicted, so a flood cannot stop discovery;
// - one source may add at most [MDNS_NEW_PER_MINUTE] new names a minute (instances and host names alike), so
//   a neighbour cannot churn the tables (its own entries, or the least recently refreshed real ones) by
//   naming faster than that;
// - query replies go out at most once a second; the packet parser's own limits live in the codec;
// - a query from a port other than 5353 is a legacy query (RFC 6762 section 6.7): the answer goes by unicast
//   to the querier's address and port, with the query's ID, the matching questions repeated, no cache-flush
//   bit and a TTL of 10 s. A query is dropped, before it is parsed, unless its source is one the response
//   rules above would hear, and a legacy one also unless its port is 1024 or higher, so the responder
//   cannot be aimed at an off-link address or a service port; it counts against the same once-a-second
//   gap. An IPv4 source gets the A records, an IPv6 one the AAAA records of the link it is on.
//
// One `MulticastSocket` on 5353 serves both families. It is bound with address reuse and joins
// 224.0.0.251 on every interface that is up, multicast-capable, not loopback, and has a private IPv4
// address, and ff02::fb on at most eight interfaces that are up, multicast-capable and have an fe80
// address. An A record leaves on the IPv4 group, an AAAA record on its own interface's IPv6 link, so a
// browser sees an address equal to the packet's source. `interfaces` (the `lan.interfaces` option)
// names the IPv4 addresses whose interfaces to use instead.

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
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

/** Instances and addresses held. */
public const val MDNS_MAX_INSTANCES: Int = 256

/** Addresses kept per host name. */
public const val MDNS_MAX_ADDRS: Int = 4

/** New names one source may add per minute. */
public const val MDNS_NEW_PER_MINUTE: Int = 16

private const val BIRTH_WINDOW_SECONDS = 60.0

/** Seconds a learned record is believed after it was last refreshed. */
public const val MDNS_ENTRY_TTL_SECONDS: Double = 5 * 60.0

private const val REPLY_GAP_SECONDS = 1.0
private const val NETS_REFRESH_SECONDS = 10.0
private const val TTL = 120L

/** The TTL of a legacy unicast answer (RFC 6762 section 6.7: at most 10 s). */
private const val LEGACY_TTL = 10L

/** A legacy query is answered only from a port at or above this one. */
private const val MIN_LEGACY_PORT = 1024

/** Questions a legacy answer repeats, at most: the reply stays small whatever the query holds. */
private const val MAX_REPEATED = 4
private const val TXT_TTL = 4500L
private const val ASK_QUESTIONS = 32
private const val AGAIN_MILLIS = 1000L
private const val ASK_EVERY_MILLIS = 30_000L
private val INSTANCE_FQDN = Regex("(p1-[a-z2-7]{16})\\._pkeypeer\\._tcp\\.local")

private class Entry(var at: Double) {
    var port: Int? = null
    var target: String? = null
    var txt: List<String>? = null
    var up: String? = null
}

private fun fqdn(instance: String) = "$instance.$PEER_SERVICE"

private fun hostOf(instance: String) = "$instance.local"

/**
 * What the adapter reads of the machine, replaceable by a test: [addresses] are the IPv4 addresses to put
 * in an advert (default: those of the chosen interfaces); [subnets] are the connected subnets (CIDR text) a
 * response must come from (RFC 6762 section 11; default: those of the interfaces in use); [links] are the
 * IPv6 links to use (default: the real ones, except when a socket factory is injected, which means the test
 * chose its sockets; an empty list is IPv4 only); [clock] is monotonic seconds.
 */
public class MdnsEnvironment(
    public val addresses: (() -> List<String>)? = null,
    public val subnets: (() -> List<String>)? = null,
    public val links: (() -> List<Mdns6Interface>)? = null,
    public val clock: () -> Double = { System.nanoTime() / 1e9 },
)

/**
 * The adapter. [create] makes a socket (default: the real one). [interfaces] are the IPv4 addresses of
 * the networks to use; without them every up, multicast-capable, private interface is used.
 * [allowLoopback] accepts (and advertises) 127.0.0.0/8, for tests and same-host peers only. [env] is what
 * a test replaces.
 */
public class JvmMdns(
    private val scope: CoroutineScope,
    private val create: MdnsSocketFactory? = null,
    private val allowLoopback: Boolean = false,
    private val interfaces: List<String>? = null,
    private val env: MdnsEnvironment = MdnsEnvironment(),
) : MdnsAdapter {
    override fun toString(): String = "JvmMdns"

    private fun own(): List<String> {
        val found = env.addresses?.invoke() ?: interfaces ?: lanInterfaces(allowLoopback).map { it.second }
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

    private fun byAddress(ip: String): NetworkInterface? =
        inetAddressOfLiteral(ip)?.let { runCatching { NetworkInterface.getByInetAddress(it) }.getOrNull() }

    /** The IPv6 links in use: the injected list, none when a test chose its sockets, else the real ones (limited by `interfaces`). */
    private fun links6(): List<Mdns6Interface> {
        val names = interfaces?.mapNotNull { byAddress(it)?.name }?.toSet()
        val injected = env.links
        return when {
            injected != null -> injected().take(MDNS_MAX_INTERFACES)
            create != null -> emptyList()
            names == null -> lanInterfaces6(allowLoopback)
            else -> lanInterfaces6(allowLoopback).filter { it.name in names }
        }
    }

    /** The subnets a response must come from: every IPv4 subnet in use and every IPv6 subnet of [links]. */
    private fun connected(links: List<Mdns6Interface>): List<String> {
        env.subnets?.let { return it() }
        val picked = if (interfaces != null) selectedInterfaces() else null
        return subnets4(allowLoopback, picked) + links.flatMap { it.nets }
    }

    /**
     * RFC 6762 section 11: a source is on a connected subnet of an interface in use, or is link-local
     * (on-link by definition) with the zone of a link in use. The zone is the arrival interface: the
     * kernel reports it with a link-local source, so a source with none, or with an interface we did
     * not join, is not ours. It gates a response we learn from and a query we answer alike.
     */
    private inner class Heard(val links: List<Mdns6Interface>) {
        private val lock = Any()
        private var nets: List<String> = emptyList()
        private var netsAt = Double.NEGATIVE_INFINITY

        fun onLink(src: LanAddr): Boolean {
            val g = src.v6
            return if (g != null && isLinkLocal(g)) src.zone != null && links.any { it.zone == src.zone } else inConnectedSubnet(src.text())
        }

        private fun inConnectedSubnet(text: String): Boolean {
            val now = env.clock()
            val current = synchronized(lock) {
                if (now - netsAt > NETS_REFRESH_SECONDS) {
                    nets = connected(links)
                    netsAt = now
                }
                nets
            }
            return current.any { cidrContains(it, text) }
        }
    }

    private suspend fun openSocket(links: List<Mdns6Interface>, onPacket: (ByteArray, String, Int) -> Unit): MdnsSocket {
        create?.let { return it.open(onPacket) }
        return openMulticastSocket(selectedInterfaces(), links, interfaces == null, onPacket)
    }

    // -- advertise -------------------------------------------------------------------------------

    override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
        require(isInstanceName(advert.instance)) { "instance name" }
        require(advert.port in 1..MAX_PORT) { "port" }
        val addrs = own()
        val links = links6()
        val fq = fqdn(advert.instance)
        val host = hostOf(advert.instance)
        val txt = advert.txt.toList()
        val lock = Any()
        var lastReply = Double.NEGATIVE_INFINITY
        var closed = false
        var sock: MdnsSocket? = null

        fun records(ttl: Long, address: List<MdnsRecord>): List<MdnsRecord> = buildList {
            add(MdnsRecord(PEER_SERVICE, MdnsType.PTR, ttl, MdnsData.Ptr(fq)))
            add(MdnsRecord(fq, MdnsType.SRV, ttl, MdnsData.Srv(advert.port, host, 0, 0)))
            // A legacy answer's TTL is short for every record; a normal one keeps the long TXT TTL.
            add(MdnsRecord(fq, MdnsType.TXT, if (ttl == 0L || ttl == LEGACY_TTL) ttl else TXT_TTL, MdnsData.Txt(txt)))
            addAll(address)
        }

        fun attempt(f: () -> Unit) {
            try {
                f()
            } catch (e: IllegalArgumentException) {
                // an advert that cannot be built is not sent
            } catch (e: IOException) {
                // the network is gone for now
            }
        }

        // An A record leaves on the IPv4 group and an AAAA on its own link: a browser believes an
        // address only when it equals the packet's source.
        fun sendRecords(ttl: Long) {
            val s = synchronized(lock) { if (closed) null else sock } ?: return
            if (addrs.isNotEmpty()) {
                attempt { s.send(buildMdnsResponse(records(ttl, addrs.map { MdnsRecord(host, MdnsType.A, ttl, MdnsData.Address(it)) }))) }
            }
            for (l in links) {
                if (l.addresses.isEmpty()) continue
                val aaaa = l.addresses.take(MDNS_MAX_ADDRS).map { MdnsRecord(host, MdnsType.AAAA, ttl, MdnsData.Address(it)) }
                attempt { s.send6(buildMdnsResponse(records(ttl, aaaa)), l.zone) }
            }
        }

        // RFC 6762 section 6.7: to the querier alone, with its ID, the questions we answer, no cache-flush
        // bit and a short TTL. A v4 source gets the A records; a v6 one the AAAA records of the link it is on.
        fun answerLegacy(p: MdnsPacket, src: LanAddr, port: Int, mine: List<MdnsQuestion>) {
            val s = synchronized(lock) { if (closed) null else sock } ?: return
            val v6 = src.v6
            val address = if (v6 == null) {
                addrs.map { MdnsRecord(host, MdnsType.A, LEGACY_TTL, MdnsData.Address(it)) }
            } else {
                val link = links.firstOrNull { if (isLinkLocal(v6)) it.zone == src.zone else it.nets.any { n -> cidrContains(n, src.text()) } }
                link?.addresses?.take(MDNS_MAX_ADDRS)?.map { MdnsRecord(host, MdnsType.AAAA, LEGACY_TTL, MdnsData.Address(it)) }.orEmpty()
            }
            if (address.isEmpty()) return
            val to = if (v6 != null && isLinkLocal(v6)) "${src.text()}%${src.zone}" else src.text()
            attempt { s.sendTo(buildMdnsResponse(records(LEGACY_TTL, address), p.id, mine.take(MAX_REPEATED), flush = false), to, port) }
        }

        val names = setOf(PEER_SERVICE, fq, host)
        val heard = Heard(links)
        val opened = openSocket(links) { data, srcText, port ->
            // A query from off the link, or from a privileged port that is not 5353, is dropped before it
            // is parsed: it is answered by nobody.
            val src = parseLanAddress(srcText)
            val legacy = port != MDNS_PORT
            val p = if (src == null || !heard.onLink(src) || (legacy && port < MIN_LEGACY_PORT)) {
                null
            } else {
                try {
                    parseMdnsPacket(data)
                } catch (e: MdnsPacketError) {
                    null
                }
            }
            val mine = p?.questions?.filter { foldName(it.name) in names }.orEmpty()
            if (p != null && src != null && !p.isResponse && mine.isNotEmpty()) {
                val t = env.clock()
                val reply = synchronized(lock) {
                    if (closed || t - lastReply < REPLY_GAP_SECONDS) {
                        false
                    } else {
                        lastReply = t
                        true
                    }
                }
                if (reply && legacy) answerLegacy(p, src, port, mine) else if (reply) sendRecords(TTL)
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

    private class Browse(
        val onUp: (MdnsFound) -> Unit,
        val onDown: (String) -> Unit,
        val accept: (String) -> Boolean,
        val heard: Heard,
    ) {
        val lock = Any()
        val seen = LinkedHashMap<String, Entry>()
        val book = MdnsAddressBook()
        val births = LinkedHashMap<String, ArrayDeque<Double>>()
        var sock: MdnsSocket? = null
        var closed = false
        val jobs = ArrayList<Job>()
    }

    override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle {
        val links = links6()
        val b = Browse(onUp, onDown, accept, Heard(links))
        b.sock = openSocket(links) { data, src, _ -> onPacket(b, data, src) }
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

    private fun onPacket(b: Browse, data: ByteArray, srcText: String) {
        // A neighbour on the link only: an off-link datagram is never parsed.
        val src = parseLanAddress(srcText) ?: return
        if (!b.heard.onLink(src)) return
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

    /** True when [src] may create another entry now; counts it. The table of sources is bounded too. */
    private fun allowBirth(b: Browse, src: String, now: Double): Boolean {
        val q = b.births.remove(src) ?: ArrayDeque()
        while (q.isNotEmpty() && now - q.first() > BIRTH_WINDOW_SECONDS) q.removeFirst()
        val ok = q.size < MDNS_NEW_PER_MINUTE
        if (ok) q.addLast(now)
        b.births[src] = q
        while (b.births.size > MDNS_MAX_INSTANCES) b.births.remove(b.births.keys.first())
        return ok
    }

    /** An address record of an accepted instance's host name goes to the address book, which keeps only an address equal to [src]. */
    private fun learnAddress(b: Browse, r: MdnsRecord, src: LanAddr, from: String, now: Double) {
        val host = foldName(r.name)
        val inst = host.removeSuffix(".local")
        if (!host.endsWith(".local") || !isInstanceName(inst) || !b.accept(inst)) return
        b.book.learn(r, src.text(), src.zone, now) { allowBirth(b, from, now) }
    }

    private fun learn(b: Browse, records: List<MdnsRecord>, source: LanAddr, ups: MutableList<MdnsFound>, downs: MutableList<String>) {
        val now = env.clock()
        // The source as a key: a link-local address keeps its zone, as the address book holds it.
        val src = if (source.v6 != null && source.zone != null && isLinkLocal(source.v6)) {
            "${source.text()}%${source.zone}"
        } else {
            source.text()
        }
        for (r in records) {
            if (r.type == MdnsType.A || r.type == MdnsType.AAAA) {
                learnAddress(b, r, source, src, now)
                continue
            }
            val ptr = r.data as? MdnsData.Ptr
            val name = if (r.type == MdnsType.PTR) ptr?.name else r.name
            val inst = name?.let { INSTANCE_FQDN.matchEntire(foldName(it))?.groupValues?.get(1) } ?: continue
            if (r.type == MdnsType.PTR && foldName(r.name) != PEER_SERVICE) continue
            if (!b.accept(inst)) continue
            // An SRV record is believed only with a port a random listen can have drawn and the
            // instance's own host name as its target.
            if (r.type == MdnsType.SRV && !srvBelieved(r.data as? MdnsData.Srv, inst)) continue
            if (r.type == MdnsType.PTR && r.ttl == 0L) {
                if (b.seen.remove(inst) != null) downs += inst
                continue
            }
            var e = b.seen.remove(inst)
            if (e == null) {
                // No source owns a name; each may add MDNS_NEW_PER_MINUTE new ones a minute.
                if (!allowBirth(b, src, now)) continue
                if (b.seen.size >= MDNS_MAX_INSTANCES) trimSeen(b, now, downs)
                e = Entry(now)
            }
            e.at = now
            b.seen[inst] = e
            when (val d = r.data) {
                is MdnsData.Srv -> {
                    e.port = d.port
                    e.target = hostOf(inst)
                }

                is MdnsData.Txt -> e.txt = d.entries.toList()

                else -> Unit
            }
        }
        for ((inst, e) in b.seen) report(b, inst, e, now, ups, downs)
    }

    /** An SRV record is believed with a port from 1024 to 65535 and the instance's own host name as its target. */
    private fun srvBelieved(srv: MdnsData.Srv?, inst: String): Boolean =
        srv != null && srv.port in MIN_PORT..MAX_PORT && foldName(srv.target) == hostOf(inst)

    /** Report an instance whose port, TXT and host name are known: up with its addresses, or down when every address was withdrawn. */
    private fun report(b: Browse, inst: String, e: Entry, now: Double, ups: MutableList<MdnsFound>, downs: MutableList<String>) {
        val port = e.port
        val txt = e.txt
        val ips = e.target?.let { b.book.hosts(it, now) }
        if (port == null || txt == null || ips == null) return
        if (ips.isEmpty()) {
            // The peer cannot be dialled until an address is learned again.
            if (e.up != null) downs += inst
            e.up = null
            return
        }
        // First-seen order: no source owns the name, so none is dialled first.
        val hosts = ips
        val sig = "${hosts.joinToString(",")}|$port|${txt.joinToString("\n")}"
        if (e.up != sig) {
            e.up = sig
            ups += MdnsFound(inst, hosts[0], port, txt.toList(), hosts)
        }
    }

    private fun ask(b: Browse) {
        val downs = ArrayList<String>()
        val packet: ByteArray
        val s: MdnsSocket
        synchronized(b.lock) {
            s = b.sock ?: return
            if (b.closed) return
            val now = env.clock()
            val it = b.seen.entries.iterator()
            while (it.hasNext()) {
                val (k, v) = it.next()
                if (now - v.at > MDNS_ENTRY_TTL_SECONDS) {
                    it.remove()
                    if (v.up != null) downs += k
                }
            }
            b.book.expire(now)
            val qs = ArrayList<MdnsQuestion>()
            qs += MdnsQuestion(PEER_SERVICE, MdnsType.PTR)
            for ((inst, e) in b.seen) {
                if (e.up == null) {
                    qs += MdnsQuestion(fqdn(inst), MdnsType.SRV)
                    qs += MdnsQuestion(fqdn(inst), MdnsType.TXT)
                    qs += MdnsQuestion(hostOf(inst), MdnsType.A)
                    qs += MdnsQuestion(hostOf(inst), MdnsType.AAAA)
                }
            }
            packet = buildMdnsQuery(qs.take(ASK_QUESTIONS))
        }
        for (d in downs) safely { b.onDown(d) }
        try {
            s.send(packet)
            for (l in b.heard.links) s.send6(packet, l.zone)
        } catch (e: IOException) {
            // the network is gone for now
        }
    }

    private companion object {
        const val MIN_PORT = 1024
        const val MAX_PORT = 65535
    }
}
