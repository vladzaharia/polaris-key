// @pkey-feature connect.lan
//
// Which interfaces count for the mDNS source test, the join and the unions of subnets (WIRE-CONTRACT-V5
// section 15.4, Addresses): up, loopback only when allowed, and no tunnel, point-to-point or
// pseudo-interface.

package im.plrs.key.core.peer.lan

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LanInterfacesTest {
    private val ok = IfaceFacts(
        up = true,
        multicast = true,
        loopback = false,
        pointToPoint = false,
        name = "en0",
        hasHardware = true,
        hardwareKnown = true,
    )

    private fun counts(f: IfaceFacts, allowLoopback: Boolean = false) = countsAsLan(f, allowLoopback)

    @Test
    fun anOrdinaryUpMulticastInterfaceCounts() {
        assertTrue(counts(ok))
        assertTrue(counts(ok.copy(name = "wlan0")))
        assertFalse(counts(ok.copy(up = false)))
        assertFalse(counts(ok.copy(multicast = false)))
    }

    @Test
    fun loopbackCountsOnlyWhenAllowed() {
        val lo = ok.copy(name = "lo0", loopback = true, hasHardware = false)
        assertFalse(counts(lo))
        assertTrue(counts(lo, allowLoopback = true))
    }

    @Test
    fun tunnelsAndPointToPointInterfacesNeverCount() {
        assertFalse(counts(ok.copy(name = "ppp0", pointToPoint = true)))
        for (n in listOf("utun3", "tun0", "ppp1", "wg0", "ipsec0", "gif0", "stf0")) assertFalse(n, counts(ok.copy(name = n)))
        // a tunnel that has a hardware address and a plain name still has the point-to-point flag
        assertFalse(counts(ok.copy(name = "vpn", pointToPoint = true)))
    }

    @Test
    fun anInterfaceWithNoHardwareAddressIsTakenAsATunnelWhereThePlatformReportsOne() {
        assertFalse(counts(ok.copy(name = "vpn0", hasHardware = false)))
        // Android hides hardware addresses from apps (11 and later): the flags and the name decide
        val hidden = ok.copy(name = "wlan0", hasHardware = false, hardwareKnown = false)
        assertTrue(counts(hidden))
        assertFalse(counts(hidden.copy(name = "tun0")))
        assertFalse(counts(hidden.copy(pointToPoint = true)))
    }
}
