// @pkey-feature connect.lan
package im.plrs.key.platform

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.InetAddress

@RunWith(RobolectricTestRunner::class)
class LocalNetworkAccessTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun notEnforcedBelow37OrWhenTargetingLower() {
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.decide(36, 37, declared = false, granted = false))
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.decide(37, 36, declared = false, granted = false))
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.decide(34, 34, declared = false, granted = false))
    }

    @Test
    fun enforcedAt37() {
        assertEquals(LocalNetworkState.NotDeclared, LocalNetworkAccess.decide(37, 37, declared = false, granted = false))
        assertEquals(LocalNetworkState.NotDeclared, LocalNetworkAccess.decide(37, 37, declared = false, granted = true))
        assertEquals(LocalNetworkState.Denied, LocalNetworkAccess.decide(37, 37, declared = true, granted = false))
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.decide(37, 37, declared = true, granted = true))
    }

    @Test
    @Config(sdk = [34])
    fun okOnApi34() {
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.check(ctx))
    }

    @Test
    @Config(sdk = [35])
    fun okOnApi35EvenWithoutDeclaration() {
        assertEquals(LocalNetworkState.Ok, LocalNetworkAccess.check(ctx))
    }

    @Test
    fun subnetContainsIpv4() {
        val s = Subnet(InetAddress.getByName("192.168.1.20"), 24)
        assertTrue(s.contains("192.168.1.99"))
        assertFalse(s.contains("192.168.2.1"))
        assertFalse(s.contains("fe80::1"))
        assertFalse(s.contains("not an address"))
    }

    @Test
    fun subnetContainsIpv6AndIgnoresZone() {
        val s = Subnet(InetAddress.getByName("fe80::1"), 64)
        assertTrue(s.contains("fe80::2%wlan0"))
        assertFalse(s.contains("fe80:0:0:1::2"))
        assertFalse(s.contains("192.168.1.1"))
    }

    @Test
    fun subnetHandlesAPrefixThatIsNotAByteMultiple() {
        val s = Subnet(InetAddress.getByName("10.0.0.0"), 20)
        assertTrue(s.contains("10.0.15.255"))
        assertFalse(s.contains("10.0.16.0"))
    }

    @Test
    fun noSubnetsHoldNothing() {
        assertFalse(NetworkSubnets.any(emptyList(), "192.168.1.1"))
        assertTrue(NetworkSubnets.any(listOf(Subnet(InetAddress.getByName("192.168.1.1"), 24)), "192.168.1.7"))
    }
}
