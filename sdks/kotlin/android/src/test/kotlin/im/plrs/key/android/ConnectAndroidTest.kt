// @pkey-feature connect.lan
package im.plrs.key.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.platform.KeystoreSealer
import im.plrs.key.platform.LocalNetworkState
import im.plrs.key.sdk.ConnectOptions
import im.plrs.key.sdk.LocalNetworkVerdict
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
import java.io.File

/** CC-12b.5: the Connect state and the platform edge. */
@RunWith(RobolectricTestRunner::class)
class ConnectAndroidTest {
    @get:Rule val tmp = TemporaryFolder()

    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val keys = SoftKeyProvider()
    private val product = "diceroll"
    private val file get() = File(tmp.root, "pkey/$product/connect-state.bin")

    private fun state() = androidConnectStateStorage(ctx, product, keys, File(tmp.root, "pkey/$product/connect-state.bin"))

    @Test
    fun theStateIsASealedFileUnderItsOwnAlias() = runBlocking {
        val secret = "k_disc-bytes-never-in-the-clear".toByteArray()
        val s = state()
        s.put(secret)
        assertTrue(file.exists())
        assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains("k_disc"))
        assertEquals(setOf("pkey:$product:connect"), keys.keys.keys)
        assertEquals(secret.toList(), state().get()!!.toList())
        assertEquals(KeystoreSealer.connectAliasFor(product), "pkey:$product:connect")
    }

    @Test
    fun deletingTheRecordDestroysOnlyTheConnectAlias() = runBlocking {
        val device = DeviceKeyStore(
            im.plrs.key.core.FileDeviceKeyStorage(
                File(tmp.root, "pkey/$product/device-keys.bin"),
                AndroidDeviceKeySealer(KeystoreSealer(keys, KeystoreSealer.aliasFor(product))),
                "pkey-device-keys/1/$product".toByteArray(),
            ),
        )
        val before = device.ensure()
        androidSyncRootStorage(ctx, product, keys, File(tmp.root, "pkey/$product/sync-root.bin")).put(ByteArray(32) { 3 })
        val s = state()
        s.put(ByteArray(40) { 9 })
        s.deleteRecord() // what ConnectClient.leave() calls
        assertFalse(file.exists())
        assertNull(state().get())
        assertNull(keys.keys[KeystoreSealer.connectAliasFor(product)])
        assertNotNull(keys.keys[KeystoreSealer.aliasFor(product)])
        assertNotNull(keys.keys[KeystoreSealer.rootAliasFor(product)])
        assertEquals(before, device.publicKeys())
    }

    @Test
    fun theClientDefaultsFillBothTheDeviceKeysAndTheStateAndKeepTheHostsChoice() {
        val filled = ConnectOptions().withAndroidDefaults(ctx, product, keys)
        assertNotNull(filled.deviceKeys)
        assertNotNull(filled.state)
        val mineKeys = DeviceKeyStore(im.plrs.key.core.InMemoryDeviceKeyStorage())
        val mineState = im.plrs.key.core.InMemoryDeviceKeyStorage()
        val kept = ConnectOptions(deviceKeys = mineKeys, state = mineState).withAndroidDefaults(ctx, product, keys)
        assertSame(mineKeys, kept.deviceKeys)
        assertSame(mineState, kept.state)
    }

    @Test
    fun theClientInstallsTheAndroidPlatformAndLeavesAHostsOwn() {
        val own = object : im.plrs.key.sdk.ConnectPlatform {
            override val mdns: MdnsAdapter? = null

            override suspend fun localNetwork() = LocalNetworkVerdict.Ok
        }
        try {
            im.plrs.key.sdk.ConnectPlatforms.installed = own
            installConnectPlatform(ctx)
            assertSame(own, im.plrs.key.sdk.ConnectPlatforms.installed)
            im.plrs.key.sdk.ConnectPlatforms.installed = null
            installConnectPlatform(ctx)
            assertTrue(im.plrs.key.sdk.ConnectPlatforms.installed is AndroidConnectPlatform)
            val first = im.plrs.key.sdk.ConnectPlatforms.installed
            installConnectPlatform(ctx)
            assertTrue(im.plrs.key.sdk.ConnectPlatforms.installed is AndroidConnectPlatform)
            assertFalse(first === im.plrs.key.sdk.ConnectPlatforms.installed)
        } finally {
            im.plrs.key.sdk.ConnectPlatforms.installed = null
        }
    }

    @Test
    fun thePlatformMapsTheLocalNetworkStateAndBuildsTheAdapterOnce() = runBlocking {
        var state = LocalNetworkState.Ok
        var built = 0
        val adapter = AndroidMdns(
            object : NsdPort {
                override fun supported() = true

                override fun advertise(
                    instance: String,
                    port: Int,
                    txt: Map<String, ByteArray>,
                    onResult: (im.plrs.key.platform.NsdAdvertResult) -> Unit,
                ) = NsdStop {}

                override fun browse(listener: im.plrs.key.platform.PeerNsdListener) = NsdStop {}

                override fun watch(instance: String, listener: im.plrs.key.platform.PeerNsdListener) = NsdStop {}
            },
            object : NetworkPort {
                override fun subnetsOf(network: android.net.Network) = emptyList<im.plrs.key.platform.Subnet>()

                override fun factoryOf(network: android.net.Network) = null

                override fun onDefaultNetworkChange(onChange: () -> Unit) = NsdStop {}
            },
        )
        val p = AndroidConnectPlatform({
            built++
            adapter
        }, { state })
        assertEquals(0, built)
        assertSame(adapter, p.mdns)
        assertSame(adapter, p.mdns)
        assertEquals(1, built)
        assertEquals(LocalNetworkVerdict.Ok, p.localNetwork())
        state = LocalNetworkState.NotDeclared
        assertEquals(LocalNetworkVerdict.NotDeclared, p.localNetwork())
        state = LocalNetworkState.Denied
        assertEquals(LocalNetworkVerdict.Denied, p.localNetwork())
    }

    @Test
    fun belowApi34ThePlatformHasNoAdapter() {
        // Robolectric runs at the SDK the build picks; the real constructor must answer null under 34.
        val p = AndroidConnectPlatform(ctx)
        if (android.os.Build.VERSION.SDK_INT < 34) assertNull(p.mdns) else assertNotNull(p.mdns)
    }
}
