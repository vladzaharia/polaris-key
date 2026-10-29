// @pkey-feature connect.lan
//
// The LAN address rule (WIRE-CONTRACT-V5 section 15.4.1; CC-IPV6.5a) beyond the shared `lanAddresses`
// rows (the :conformance PeerMatrixLanTest runs all of them): the literal parser never resolves a name,
// and the helpers that turn a verdict's text into a socket address and back.

package im.plrs.key.core.peer.lan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Inet6Address
import java.net.InetAddress

class LanAddressTest {
    private fun dial(remote: String, local: String? = null, loop: Boolean = false) = lanVerdict(remote, local, loop)

    @Test
    fun aNameIsNotAnAddressAndNothingIsResolved() {
        for (name in listOf("localhost", "example.com", "printer.local", "10.0.0.1.example.com", "0xa000001", "167772161", "10.1", "")) {
            assertEquals(name, LanVerdict(false, null), dial(name, loop = true))
        }
    }

    @Test
    fun theSpellingIsStrict() {
        val tooLongZone = "fe80::1%" + "x".repeat(16)
        val spellings = listOf(
            "10.0.0.1\n", "10.0.0.1 ", " 10.0.0.1", "10.0.0.1\u0000", "10.0.0.1:80", "010.0.0.1", "10.0.0.1.", "[fe80::1]",
            "fe80::1/64", "fe80::1%", "fe80::1%a%b", "fe80::1%en 0", "10.0.0.1%en0", "::ffff:10.0.0.1%en0", "fe80:::1",
            "1:2:3:4:5:6:7:8:9", tooLongZone,
        )
        for (bad in spellings) {
            assertFalse(bad, dial(bad).dial)
        }
        assertEquals(LanVerdict(true, "fe80::1%en0"), dial("fe80::1%en0"))
        val longestZone = "fe80::1%" + "x".repeat(15)
        assertEquals(LanVerdict(true, longestZone), dial(longestZone))
    }

    @Test
    fun aMappedAddressIsJudgedAsItsIpv4AddressAndKeepsThatKey() {
        assertEquals(LanVerdict(true, "10.0.0.1"), dial("::ffff:10.0.0.1"))
        assertEquals(LanVerdict(true, "192.168.1.20"), dial("::ffff:c0a8:114"))
        assertFalse(dial("::ffff:8.8.8.8").dial)
        assertFalse(dial("::ffff:127.0.0.1").dial)
        assertTrue(dial("::ffff:127.0.0.1", loop = true).dial)
    }

    @Test
    fun aGlobalOrUniqueLocalAddressNeedsItsLocalAddressInTheSameSlash64() {
        assertFalse(dial("2001:db8:1::7").dial) // no local address: refused
        assertTrue(dial("2001:db8:1::7", "2001:db8:1::2").dial)
        assertFalse(dial("2001:db8:1::7", "2001:db8:2::2").dial)
        assertFalse(dial("2001:db8:1::7", "192.168.1.2").dial)
        assertTrue(dial("fd12::7").dial) // a ULA with no local address is judged on its own
        assertFalse(dial("fd12::7", "fd13::2").dial)
        assertFalse(dial("2001:0:1::7", "2001:0:1::2").dial) // Teredo
        assertFalse(dial("2002:1::7", "2002:1::2").dial) // 6to4
        assertFalse(dial("::").dial)
        assertFalse(dial("ff02::fb").dial)
    }

    @Test
    fun theKeysCarryTheZoneOnlyForLinkLocalAddresses() {
        assertEquals("fe80::1%en0", dial("FE80:0:0:0:0:0:0:1%en0").key)
        assertEquals("fd12::7", dial("fd12::7%en0").key)
        assertEquals("fe80::/64%en0", lanGroupKey("fe80::1%en0"))
        assertEquals("fe80::/64%en1", lanGroupKey("fe80::1%en1"))
        assertEquals("2001:db8:1:2::/64", lanGroupKey("2001:db8:1:2::9"))
        assertNull(lanGroupKey("10.0.0.1"))
        assertNull(lanGroupKey(null))
    }

    @Test
    fun cidrMembershipIsByPrefix() {
        assertTrue(cidrContains("192.168.1.9/24", "192.168.1.200"))
        assertFalse(cidrContains("192.168.1.9/24", "192.168.2.1"))
        assertTrue(cidrContains("fe80::1/64", "fe80::dead:beef"))
        assertFalse(cidrContains("fe80::1/64", "fe80:0:0:1::1"))
        assertFalse(cidrContains("10.0.0.1/8", "fe80::1"))
        assertTrue(cidrContains("10.0.0.1/8", "::ffff:10.2.3.4"))
        assertFalse(cidrContains("10.0.0.1/33", "10.0.0.1"))
        assertFalse(cidrContains("10.0.0.1", "10.0.0.1"))
    }

    @Test
    fun socketAddressesRoundTripThroughTheLiteralHelpers() {
        val v4 = inetAddressOfLiteral("192.168.1.20")!!
        assertEquals("192.168.1.20", literalOfInetAddress(v4))
        val lo = inetAddressOfLiteral("::1")!!
        assertEquals("::1", literalOfInetAddress(lo))
        assertEquals("fd12::7", literalOfInetAddress(InetAddress.getByAddress(inetAddressOfLiteral("fd12::7")!!.address)))
        assertNull(inetAddressOfLiteral("localhost"))
        assertNull(inetAddressOfLiteral("fe80::1%no-such-interface-0"))
        // A scoped link-local address keeps its scope as the zone.
        val ifc = java.net.NetworkInterface.getNetworkInterfaces().toList().firstOrNull { it.isUp }
        if (ifc != null) {
            val scoped = inetAddressOfLiteral("fe80::1%${ifc.name}") as Inet6Address
            assertEquals(ifc.index, scoped.scopeId)
            assertEquals("fe80::1%${ifc.name}", literalOfInetAddress(scoped))
        }
    }
}
