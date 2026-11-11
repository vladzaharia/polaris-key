// @pkey-feature connect.local
package im.plrs.key.android

import android.content.Context
import android.net.Network
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.core.peer.LocalTxtResult
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.localInstance
import im.plrs.key.core.peer.pairingInstance
import im.plrs.key.core.peer.parseLocalTxt
import im.plrs.key.platform.KeystoreSealer
import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsdListener
import im.plrs.key.platform.Subnet
import im.plrs.key.sdk.ConnectOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowNetwork
import java.io.File
import java.net.InetAddress
import javax.net.SocketFactory

/**
 * CC-29b.A: the sealed store for `pkey.connect.local.v1` and the pairing and link adverts through [AndroidMdns]. The
 * record's rows, the cap and the gate are :sdk's (`ConnectLocalSealedStoreTest`, `ConnectLocalLinksTest`).
 */
@RunWith(RobolectricTestRunner::class)
class ConnectLocalAndroidTest {
    @get:Rule val tmp = TemporaryFolder()

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val keys = SoftKeyProvider()
    private val product = "djdl"
    private val file get() = File(tmp.root, "pkey/$product/local-links.bin")

    private fun storage() = androidLocalStorage(ctx, product, keys, file)

    @Test
    fun theRecordIsASealedFileUnderItsOwnAliasAndReadsBackAfterAReload() = runBlocking {
        val record = """{"schema":"pkey.connect.local.v1","secret":"link-secret-never-in-the-clear"}""".toByteArray()
        storage().put(record)
        assertTrue(file.exists())
        assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains("link-secret"))
        assertEquals(setOf("pkey:$product:locallinks"), keys.keys.keys)
        assertEquals(KeystoreSealer.localAliasFor(product), "pkey:$product:locallinks")
        assertEquals(record.toList(), storage().get()!!.toList())
    }

    @Test
    fun theDefaultLocationIsTheNoBackupDirectory() {
        val dir = ctx.noBackupFilesDir
        val target = File(dir, "pkey/$product/local-links.bin")
        runBlocking { androidLocalStorage(ctx, product, keys).put(byteArrayOf(1, 2, 3)) }
        assertTrue(target.exists())
        assertTrue(target.canonicalPath.startsWith(dir.canonicalPath))
    }

    @Test
    fun clearingTheRecordDestroysOnlyTheLocalAlias() = runBlocking {
        androidSyncRootStorage(ctx, product, keys, File(tmp.root, "pkey/$product/sync-root.bin")).put(ByteArray(32) { 3 })
        val s = storage()
        s.put(ByteArray(40) { 9 })
        s.deleteRecord()
        assertFalse(file.exists())
        assertNull(storage().get())
        assertNull(keys.keys[KeystoreSealer.localAliasFor(product)])
        assertNotNull(keys.keys[KeystoreSealer.rootAliasFor(product)])
    }

    @Test
    fun theClientDefaultsFillTheLocalStoreAndKeepTheHostsChoice() {
        val filled = ConnectOptions().withAndroidDefaults(ctx, product, keys)
        assertNotNull(filled.localState)
        val mine = im.plrs.key.core.InMemoryDeviceKeyStorage()
        assertSame(mine, ConnectOptions(localState = mine).withAndroidDefaults(ctx, product, keys).localState)
    }

    @Test
    fun aRecordWhoseKeyIsGoneIsDeletedAndTheStoreStartsEmpty() = runBlocking {
        storage().put(byteArrayOf(1, 2, 3))
        keys.keys.remove(KeystoreSealer.localAliasFor(product))
        val s = storage()
        assertNull(s.get())
        assertFalse(file.exists())
        // It takes a new record, under a new key.
        s.put(byteArrayOf(4, 5))
        assertEquals(listOf<Byte>(4, 5), storage().get()!!.toList())
        // An update meets the same lost key the same way.
        keys.keys.remove(KeystoreSealer.localAliasFor(product))
        assertTrue(storage().update { current -> if (current == null) byteArrayOf(9) else null })
        assertEquals(listOf<Byte>(9), storage().get()!!.toList())
    }

    @Test
    fun aRecordThatFailsUnderALiveKeyIsKeptAndRefused() = runBlocking {
        storage().put(byteArrayOf(1, 2, 3))
        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        file.writeBytes(bytes)
        val refused = runCatching { storage().get() }.exceptionOrNull()
        assertTrue(refused is im.plrs.key.core.DeviceKeysUnreadableException)
        assertTrue(file.exists())
        assertEquals(bytes.toList(), file.readBytes().toList())
        assertNotNull(keys.keys[KeystoreSealer.localAliasFor(product)])
    }

    // -- the adverts: the exact calls the shower and the LAN service make -------------------------------

    private class FakeNsd : NsdPort {
        class Reg(val instance: String, val port: Int, val txt: Map<String, ByteArray>) {
            var stopped = false
        }

        val regs = ArrayList<Reg>()
        var browser: PeerNsdListener? = null
        val watchers = LinkedHashMap<String, PeerNsdListener>()
        var accepted: ((String) -> Boolean)? = null

        override fun supported() = true

        override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): NsdStop {
            val r = Reg(instance, port, txt)
            regs += r
            onResult(NsdAdvertResult.Registered)
            return NsdStop { r.stopped = true }
        }

        override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): NsdStop {
            browser = listener
            accepted = accept
            return NsdStop {}
        }

        override fun watch(instance: String, listener: PeerNsdListener): NsdStop {
            watchers[instance] = listener
            return NsdStop {}
        }
    }

    private class FakeNet : NetworkPort {
        override fun subnetsOf(network: Network) = listOf(Subnet(InetAddress.getByName("192.168.1.5"), 24))

        override fun factoryOf(network: Network): SocketFactory = SocketFactory.getDefault()

        override fun isNotVpn(network: Network) = true

        override fun onDefaultNetworkChange(onChange: () -> Unit) = NsdStop {}
    }

    private val wifi: Network = ShadowNetwork.newInstance(100)

    @Test
    fun aPairingWindowAndALocalLinkAdvertiseWithTheirOwnTxtAndWithdrawOnStop() = runBlocking {
        val nsd = FakeNsd()
        val mdns = AndroidMdns(nsd, FakeNet())
        val q = mdns.advertise(MdnsAdvert(pairingInstance(ByteArray(10) { it.toByte() }), 4001, listOf("v=1", "m=q", "h=abcd")))
        val l = mdns.advertise(MdnsAdvert(localInstance(ByteArray(32) { 1 }, ByteArray(32) { 2 }, 77L), 4002, listOf("v=1", "m=l")))
        assertEquals(listOf("q", "l"), nsd.regs.map { String(it.txt.getValue("m")) })
        assertEquals(setOf("v", "m", "h"), nsd.regs[0].txt.keys)
        assertEquals(setOf("v", "m"), nsd.regs[1].txt.keys)
        assertTrue(nsd.regs.all { it.instance.startsWith("p1-") && it.instance.length == 3 + 16 })
        l.stop()
        assertTrue(nsd.regs[1].stopped)
        assertFalse(nsd.regs[0].stopped)
        q.stop()
        assertTrue(nsd.regs.all { it.stopped })
    }

    @Test
    fun aPeersLocalAdvertIsReportedWithItsTxtForTheServiceToJudge() {
        val nsd = FakeNsd()
        val seen = ArrayList<MdnsFound>()
        runBlocking { AndroidMdns(nsd, FakeNet()).browse({ seen += it }, {}, { true }) }
        val name = localInstance(ByteArray(32) { 1 }, ByteArray(32) { 3 }, 77L)
        nsd.browser!!.onFound(name)
        nsd.watchers.getValue(name).onResolved(
            NsdResolved(name, listOf("192.168.1.20"), 4000, mapOf("v" to "1".toByteArray(), "m" to "l".toByteArray()), wifi),
        )
        val f = seen.single()
        assertEquals(name, f.instance)
        assertTrue(parseLocalTxt(f.txt) is LocalTxtResult.Ok)
        assertFalse(parseLocalTxt(listOf("v=1", "m=c")) is LocalTxtResult.Ok)
    }
}
