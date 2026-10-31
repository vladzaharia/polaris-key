// WIRE-CONTRACT-V5 section 15.4, Addresses: the addresses learned for each host name (CC-IPV6.5a). It
// mirrors sdk-node's `AddressBook` and the `mdnsAnswers` rows of peer-matrix.json. The rule is the
// whole of learning:
//   - an A or AAAA record counts only when its address equals the packet's source address (an
//     IPv4-mapped source counts as its IPv4 address), whatever the address is: there is no filter on
//     the address itself, the dial-time `lanVerdict` decides what may be dialled;
//   - a link-local address is held with the zone of the interface the packet arrived on
//     (`fe80::1%en0`), and one with no known arrival zone is dropped and teaches nothing; any other
//     address has no zone;
//   - an address record with TTL 0 removes that address, and only when it passes the same equality
//     test; it learns nothing;
//   - names fold by ASCII (`A` to `Z` only) and are held in lower case;
//   - a name keeps at most [MDNS_MAX_ADDRS] addresses, of any family, in first-seen order; a repeat is
//     not a second address. The table holds at most [MDNS_MAX_INSTANCES] names and, when full, drops
//     the expired and then the least recently refreshed;
//   - an address not seen for [MDNS_ENTRY_TTL_SECONDS] lapses and frees its place, whether or not the
//     name itself was refreshed since.
// The source-subnet check of RFC 6762 section 11 happens before a record reaches this class.

package im.plrs.key.core.peer.lan

/** One `{name, address}` entry of the table. */
public data class MdnsAddress(val name: String, val address: String)

/** The table of learned addresses. Not thread-safe: the caller holds its own lock. */
public class MdnsAddressBook(private val maxNames: Int = MDNS_MAX_INSTANCES) {
    private class Names(var at: Double) {
        val ips = ArrayList<String>()
        val seen = HashMap<String, Double>()
    }

    private val names = LinkedHashMap<String, Names>()

    /**
     * Apply one A or AAAA record ([record]) from a packet sent by [source] and received on [zone]
     * (null: none) at [now] (monotonic seconds). Other record types are ignored. [admit] is asked before a
     * new name takes a place (the per-source limit on new names).
     */
    public fun learn(record: MdnsRecord, source: String, zone: String?, now: Double, admit: () -> Boolean = { true }) {
        val address = believed(record, source, zone) ?: return
        val name = foldName(record.name)
        if (record.ttl == 0L) withdraw(name, address) else add(name, address, now, admit)
    }

    /** The text the record's address is held under when it equals the source, else null. */
    private fun believed(record: MdnsRecord, source: String, zone: String?): String? {
        val got = (record.data as? MdnsData.Address)?.ip?.takeIf { record.type == MdnsType.A || record.type == MdnsType.AAAA }
        val rec = got?.let { parseLanAddress(it, foldMapped = false) }
        // The source as the equality sees it: no zone, a mapped address as its IPv4.
        val src = parseLanAddress(source.substringBefore('%'))
        // fe80 text alone does not name a host: a link-local address with no arrival zone is dropped.
        return when {
            rec == null || src == null -> null
            rec.zone != null || src.text() != rec.text() -> null
            rec.v6 != null && isLinkLocal(rec.v6) -> zone?.let { "${rec.text()}%$it" }
            else -> rec.text()
        }
    }

    private fun withdraw(name: String, address: String) {
        val e = names[name] ?: return
        e.ips.remove(address)
        e.seen.remove(address)
        if (e.ips.isEmpty()) names.remove(name)
    }

    private fun add(name: String, address: String, now: Double, admit: () -> Boolean) {
        val held = names.remove(name)
        if (held == null && !admit()) return
        if (held == null && names.size >= maxNames) trim(now)
        val e = held ?: Names(now)
        lapse(e, now)
        if (address !in e.ips && e.ips.size < MDNS_MAX_ADDRS) e.ips += address
        if (address in e.ips) e.seen[address] = now
        e.at = now
        names[name] = e // most recently refreshed last
    }

    /** Drops the addresses of [e] not seen for [MDNS_ENTRY_TTL_SECONDS]. */
    private fun lapse(e: Names, now: Double) {
        e.ips.removeAll { a ->
            (now - (e.seen[a] ?: e.at) > MDNS_ENTRY_TTL_SECONDS).also { if (it) e.seen.remove(a) }
        }
    }

    /**
     * The addresses held for [name], first seen first. With [now], an address not seen for
     * [MDNS_ENTRY_TTL_SECONDS] is left out.
     */
    public fun hosts(name: String, now: Double? = null): List<String> {
        val e = names[foldName(name)]
        return e?.ips?.filter { now == null || now - (e.seen[it] ?: e.at) <= MDNS_ENTRY_TTL_SECONDS }.orEmpty()
    }

    /** Seed the table (a conformance row's `prior`). */
    public fun hold(name: String, address: String, now: Double = 0.0) {
        val e = names.getOrPut(foldName(name)) { Names(now) }
        e.ips += address
        e.seen[address] = now
    }

    /** The table as entries, grouped by name, each name first seen first. */
    public fun table(): List<MdnsAddress> = names.flatMap { (n, e) -> e.ips.map { MdnsAddress(n, it) } }

    /** Drop the names not refreshed for [MDNS_ENTRY_TTL_SECONDS]. */
    public fun expire(now: Double) {
        names.entries.removeAll { now - it.value.at > MDNS_ENTRY_TTL_SECONDS }
        names.values.forEach { lapse(it, now) }
        names.entries.removeAll { it.value.ips.isEmpty() }
    }

    /** Drop expired entries, then the least recently refreshed while the table is full. */
    public fun trim(now: Double) {
        expire(now)
        while (names.size >= maxNames) names.remove(names.keys.first())
    }
}

/** ASCII fold: `A` to `Z` become `a` to `z` and nothing else changes. */
public fun foldName(name: String): String = buildString(name.length) {
    for (c in name) append(if (c in 'A'..'Z') c + ('a' - 'A') else c)
}
