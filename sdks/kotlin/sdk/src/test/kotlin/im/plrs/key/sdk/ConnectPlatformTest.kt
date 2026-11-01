// @pkey-feature connect.lan
package im.plrs.key.sdk

import im.plrs.key.core.PolarisException
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectPlatformTest {
    private object Quiet : MdnsAdapter {
        override suspend fun advertise(advert: MdnsAdvert) = MdnsHandle {}

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean) = MdnsHandle {}
    }

    private class Platform(override val mdns: MdnsAdapter?, var verdict: LocalNetworkVerdict = LocalNetworkVerdict.Ok) : ConnectPlatform {
        override suspend fun localNetwork() = verdict
    }

    @Test
    fun offAndroidOrWithTheHostsAdapterTheOptionsAreUntouched() {
        val plain = LanOptions()
        assertSame(plain, androidLanOptions(plain, android = false, platform = Platform(Quiet)))
        val own = LanOptions(mdns = Quiet)
        assertSame(own, androidLanOptions(own, android = true, platform = Platform(null)))
    }

    @Test
    fun androidWithNoPlatformOrNoAdapterIsUnsupported() {
        assertNull(androidLanOptions(LanOptions(), android = true, platform = null))
        assertNull(androidLanOptions(LanOptions(), android = true, platform = Platform(null)))
    }

    @Test
    fun androidTakesThePlatformAdapterAndKeepsTheOtherOptions() {
        val base = LanOptions(port = 4242, label = "Pixel", allowLoopback = true, maxSessions = 3)
        val o = androidLanOptions(base, android = true, platform = Platform(Quiet))!!
        assertNotSame(base, o)
        assertSame(Quiet, o.mdns)
        assertEquals(4242, o.port)
        assertEquals("Pixel", o.label)
        assertTrue(o.allowLoopback)
        assertEquals(3, o.maxSessions)
    }

    @Test
    fun thePermissionIsReadBeforeTheHostsOwnHook() = runBlocking {
        val p = Platform(Quiet)
        var asked = 0
        val o = androidLanOptions(
            LanOptions(lanPermission = {
                asked++
                true
            }),
            android = true,
            platform = p,
        )!!
        assertTrue(o.lanPermission())
        assertEquals(1, asked)
        p.verdict = LocalNetworkVerdict.Denied
        assertFalse(o.lanPermission())
        assertEquals(1, asked)
        p.verdict = LocalNetworkVerdict.NotDeclared
        val e = assertThrows(PolarisException::class.java) { runBlocking { o.lanPermission() } }
        assertEquals("not-configured", e.code)
        assertEquals(1, asked)
    }
}
