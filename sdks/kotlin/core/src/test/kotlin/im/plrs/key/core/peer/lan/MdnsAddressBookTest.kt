// @pkey-feature connect.lan
// The address book's lapse: an address not seen for five minutes frees its place, even while the name is
// refreshed by another address.

package im.plrs.key.core.peer.lan

import org.junit.Assert.assertEquals
import org.junit.Test

class MdnsAddressBookTest {
    private fun a(ip: String, ttl: Long = 120) = MdnsRecord("host.local", MdnsType.A, ttl, MdnsData.Address(ip))

    private fun MdnsAddressBook.see(ip: String, now: Double) = learn(a(ip), ip, null, now)

    @Test
    fun anAddressNotSeenForFiveMinutesLapsesAndFreesItsPlace() {
        val book = MdnsAddressBook()
        val first = (1..MDNS_MAX_ADDRS).map { "192.168.1.$it" }
        first.forEach { book.see(it, 0.0) }
        assertEquals(first, book.hosts("host.local"))
        // A fifth address finds the places taken.
        book.see("192.168.1.9", 10.0)
        assertEquals(first, book.hosts("host.local"))
        val later = MDNS_ENTRY_TTL_SECONDS + 1
        book.see("192.168.1.9", later)
        assertEquals(listOf("192.168.1.9"), book.hosts("host.local"))
    }

    @Test
    fun aRefreshedNameDoesNotKeepAnUnseenAddress() {
        val book = MdnsAddressBook()
        book.see("192.168.1.1", 0.0)
        book.see("192.168.1.2", 0.0)
        var t = 0.0
        while (t < MDNS_ENTRY_TTL_SECONDS + 60) {
            t += 60.0
            book.see("192.168.1.2", t)
        }
        assertEquals(listOf("192.168.1.2"), book.hosts("host.local", t))
        book.expire(t)
        assertEquals(listOf("192.168.1.2"), book.table().map { it.address })
    }
}
